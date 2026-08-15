/**
 * SyncSpace AI — frontend rendering suite.
 *
 *   npm run test:ai
 *
 * Uses the existing test-support/loader.mjs so .jsx compiles on the fly and
 * react-konva is stubbed. React elements are rendered with
 * react-dom/server's renderToStaticMarkup: that runs every component body,
 * every hook that runs during render, and the full parser — which is exactly
 * what we are testing. What it cannot do is paint pixels, which is not what we
 * are testing either.
 *
 * The property that gets the most attention here is STREAMING SAFETY: the
 * renderer is handed every prefix of a realistic answer, one character at a
 * time, and must never throw and never show raw fence characters.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { parseMarkdown, parseInline } from './src/ai/markdown.js';
import { tokenizeCode, normalizeFence, labelForFence } from './src/ai/highlight.js';
import MarkdownView from './src/ai/Markdown.jsx';
import AIMessage from './src/ai/AIMessage.jsx';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const section = (t) => console.log(`\n— ${t}`);

const render = (content, streaming = false) =>
  renderToStaticMarkup(createElement(MarkdownView, { content, streaming }));

const types = (md) => parseMarkdown(md).map((b) => b.type);

console.log('\nSyncSpace AI — response rendering\n');

// ================================================================== blocks
section('block parsing');

check('paragraphs', types('hello\n\nworld').join() === 'paragraph,paragraph');
check('headings at every level',
  parseMarkdown('# a\n## b\n### c\n#### d\n##### e\n###### f')
    .every((b) => b.type === 'heading') &&
  parseMarkdown('###### f')[0].level === 6);
check('fenced code with an info string', (() => {
  const [b] = parseMarkdown('```java\nint x = 1;\n```');
  return b.type === 'code' && b.lang === 'java' && b.text === 'int x = 1;';
})());
check('tilde fences', parseMarkdown('~~~python\nx=1\n~~~')[0].lang === 'python');
check('unordered list', (() => {
  const [b] = parseMarkdown('- one\n- two');
  return b.type === 'list' && !b.ordered && b.items.length === 2;
})());
check('ordered list keeps its start number', (() => {
  const [b] = parseMarkdown('3. three\n4. four');
  return b.ordered && b.start === 3 && b.items.length === 2;
})());
check('nested list', (() => {
  const [b] = parseMarkdown('- outer\n  - inner\n  - inner2');
  return b.items[0].nested.length === 1 && b.items[0].nested[0].items.length === 2;
})());
check('blockquote', types('> quoted').join() === 'quote');
check('horizontal rule', types('---').join() === 'hr');
check('table with alignment', (() => {
  const [b] = parseMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |');
  return b.type === 'table' && b.aligns[0] === 'left' && b.aligns[1] === 'right' && b.rows.length === 1;
})());
check('a list is not mistaken for a hr', types('- a\n- b').join() === 'list');
check('code fences win over everything inside them', (() => {
  const [b] = parseMarkdown('```\n# not a heading\n- not a list\n```');
  return b.type === 'code' && b.text.includes('# not a heading');
})());

// ================================================================== inline
section('inline parsing');

const inlineTypes = (s) => parseInline(s).map((n) => n.type);

check('bold', inlineTypes('a **b** c').join() === 'text,bold,text');
check('italic', inlineTypes('a *b* c').join() === 'text,italic,text');
check('strikethrough', inlineTypes('a ~~b~~ c').join() === 'text,strike,text');
check('inline code', inlineTypes('use `x` here').join() === 'text,code,text');
check('markdown inside inline code stays literal',
  parseInline('`**not bold**`')[0].text === '**not bold**');
check('link', (() => {
  const [node] = parseInline('[docs](https://example.com)');
  return node.type === 'link' && node.href === 'https://example.com';
})());
check('bare url autolinks', parseInline('see https://a.dev now')[1].type === 'link');
check('snake_case is not italicised',
  inlineTypes('my_var_name').join() === 'text');

// ================================================================== security
section('rendering safety');

check('raw HTML is shown as text, never executed',
  !render('<script>alert(1)</script>').includes('<script>alert'));
// The payload survives as visible TEXT (escaped), which is correct — what must
// not survive is a real element. React escapes it; assert on the tag, not the
// substring.
check('img onerror payload is escaped to text, not an element', (() => {
  const html = render('<img src=x onerror=alert(1)>');
  return !html.includes('<img') && html.includes('&lt;img');
})());
check('javascript: link is not clickable',
  !render('[click](javascript:alert(1))').includes('href="javascript'));
check('data: link is not clickable',
  !render('[x](data:text/html,<script>1</script>)').includes('href="data:'));
check('http links get rel=noopener',
  render('[x](https://a.dev)').includes('rel="noopener noreferrer nofollow"'));

// ================================================================== streaming
section('streaming safety (every prefix of a real answer)');

const ANSWER = `Here is the program.

\`\`\`java
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
\`\`\`

Compile it with \`javac Main.java\`, then run **java Main**.

| step | command |
|------|---------|
| build | javac |
| run | java |
`;

let threw = null;
let rawFenceSeen = null;

for (let i = 1; i <= ANSWER.length; i++) {
  const prefix = ANSWER.slice(0, i);
  let html;
  try {
    html = render(prefix, true);
  } catch (error) {
    threw = `at ${i} chars: ${error.message}`;
    break;
  }
  // Once the opening fence exists, the user must never see literal backticks.
  if (prefix.includes('```java\n') && html.includes('```') && rawFenceSeen === null) {
    rawFenceSeen = `at ${i} chars`;
  }
}

check('never throws on any prefix of a streaming answer', threw === null, threw || '');
check('never shows a raw ``` fence mid-stream', rawFenceSeen === null, rawFenceSeen || '');

check('an unterminated fence renders as an open code block', (() => {
  const [b] = parseMarkdown('```java\npublic class M {');
  return b.type === 'code' && b.open === true && b.lang === 'java';
})());
check('a closed fence is not marked open',
  parseMarkdown('```java\nx\n```')[0].open === false);
check('open code blocks get the streaming class',
  render('```java\nint x', true).includes('md-code streaming'));

// ================================================================== malformed
section('malformed input must not break the page');

const NASTY = [
  '```',
  '```java',
  '|||',
  '| a |\n|---',
  '- ',
  '> ',
  '#',
  '**unclosed',
  '`unclosed',
  '[link](',
  '~~~',
  '***',
  '1. ',
  '\u0000\u0001',
  '```\n```\n```',
  '- a\n  - b\n    - c\n      - d\n        - e',
  '*'.repeat(500),
  '`'.repeat(500),
  '#'.repeat(200),
  '| a | b |\n'.repeat(200)
];

let nastyFail = null;
for (const input of NASTY) {
  try {
    render(input);
  } catch (error) {
    nastyFail = `${JSON.stringify(input.slice(0, 24))}: ${error.message}`;
    break;
  }
}
check('20 malformed inputs all render without throwing', nastyFail === null, nastyFail || '');

check('non-string content does not crash the renderer', (() => {
  try {
    render(undefined); render(null); render(12345);
    return true;
  } catch { return false; }
})());

// ================================================================== highlight
section('syntax highlighting');

const tokenTypes = (code, lang) => {
  const set = new Set(tokenizeCode(code, lang).map((t) => t.type));
  return set;
};

check('java keywords and strings are tokenized', (() => {
  const t = tokenTypes('public class Main { }', 'java');
  return t.has('keyword') && t.has('type');
})());
check('java string literal', tokenTypes('String s = "hi";', 'java').has('string'));
check('python def is a keyword',
  tokenizeCode('def f(x):', 'python').some((t) => t.type === 'keyword' && t.text === 'def'));
check('python # comment', tokenTypes('# note\nx=1', 'python').has('comment'));
check('c // comment', tokenTypes('// note\nint x;', 'c').has('comment'));
check('c /* block */ comment', tokenTypes('/* a\nb */ int x;', 'c').has('comment'));
check('c preprocessor line', tokenTypes('#include <stdio.h>', 'c').has('meta'));
check('numbers are tokenized', tokenTypes('int x = 42;', 'java').has('number'));
check('function calls are tokenized',
  tokenizeCode('System.out.println("x");', 'java').some((t) => t.type === 'fn'));
check('unterminated string does not swallow the file', (() => {
  const tokens = tokenizeCode('String s = "unclosed\nint x = 1;', 'java');
  return tokens.some((t) => t.type === 'keyword' && t.text === 'int');
})());
check('unknown language still tokenizes strings and comments',
  tokenTypes('// hi\nlet x = "y"', 'brainfuck').has('string'));
check('empty code is safe', tokenizeCode('', 'java').length === 0);

check('fence aliases normalize',
  normalizeFence('js') === 'javascript' &&
  normalizeFence('py') === 'python' &&
  normalizeFence('c++') === 'cpp' &&
  normalizeFence('C#') === 'csharp');
check('labels are human-readable',
  labelForFence('cpp') === 'C++' && labelForFence('java') === 'Java' && labelForFence('csharp') === 'C#');

// ================================================= the reported bug, rendered
section('the reported bug, end to end in the DOM');

const javaAnswer = '```java\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}\n```';
const javaHtml = render(javaAnswer);

// The label is rendered as "Java"; ai.css uppercases it visually via
// text-transform, so the DOM text is the human label.
check('a Java answer is labelled Java, not JavaScript',
  javaHtml.includes('md-code-lang">Java<') && !javaHtml.includes('md-code-lang">JavaScript<'));
check('  ...renders as a code block, not raw markdown', !javaHtml.includes('```'));
// The tokenizer emits indentation in its own plain span, so assert the
// whitespace run survives rather than expecting it glued to the next token.
check('  ...keeps its indentation', javaHtml.includes('<span>\n        </span>'));
check('  ...is syntax highlighted', javaHtml.includes('tok-keyword') && javaHtml.includes('tok-string'));
check('  ...offers a copy button', javaHtml.includes('md-copy'));

check('a JavaScript answer is still labelled JavaScript',
  render('```javascript\nconsole.log(1);\n```').includes('md-code-lang">JavaScript<'));

// ============================================================ AIMessage shell
section('message component');

const msg = (m) => renderToStaticMarkup(createElement(AIMessage, { message: m }));

check('user text is NOT markdown-rendered', (() => {
  const html = msg({ id: '1', role: 'user', content: '**literal asterisks**' });
  return html.includes('**literal asterisks**');
})());
check('assistant text IS markdown-rendered',
  msg({ id: '2', role: 'assistant', content: '**bold**' }).includes('<strong>'));
check('the resolved language badge is shown',
  msg({ id: '3', role: 'assistant', content: 'x', meta: { languageLabel: 'Java', languageSource: 'user-request' } })
    .includes('Java'));
check('a conversion shows source → target',
  msg({ id: '4', role: 'assistant', content: 'x', meta: { languageLabel: 'Java', targetLanguageLabel: 'Python' } })
    .includes('→ Python'));
check('an empty pending message shows the thinking indicator',
  msg({ id: '5', role: 'assistant', content: '', pending: true }).includes('ai-loading'));
check('an error is surfaced to the user',
  msg({ id: '6', role: 'assistant', content: '', error: 'Rate limited.' }).includes('Rate limited.'));
check('a partial answer is kept when an error follows', (() => {
  const html = msg({ id: '7', role: 'assistant', content: 'partial text', error: 'connection lost' });
  return html.includes('partial text') && html.includes('connection lost');
})());
check('latency stats render when present',
  msg({ id: '8', role: 'assistant', content: 'x', stats: { totalMs: 900, timeToFirstTokenMs: 210 } })
    .includes('first token 210 ms'));

// ============================================================== performance
section('performance');

const BIG = ANSWER.repeat(40);
const t0 = performance.now();
for (let i = 0; i < 50; i++) parseMarkdown(BIG);
const perParse = (performance.now() - t0) / 50;
console.log(`    parse of a ${BIG.length.toLocaleString()}-char answer: ${perParse.toFixed(2)} ms`);
check('a large answer parses in well under one frame (16 ms)', perParse < 16, `${perParse.toFixed(2)} ms`);

const t1 = performance.now();
for (let i = 0; i < 20; i++) render(BIG);
const perRender = (performance.now() - t1) / 20;
console.log(`    full render of the same answer:              ${perRender.toFixed(2)} ms`);
check('full render stays interactive', perRender < 120, `${perRender.toFixed(2)} ms`);

// ================================================================== summary
console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\n  Failing:');
  failures.forEach((f) => console.log('   - ' + f));
}
console.log(`${'='.repeat(60)}\n`);
process.exit(fail ? 1 : 0);
