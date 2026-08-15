/**
 * A minimal syntax tokenizer for AI code blocks.
 *
 * Scope check before writing this: highlight.js is ~90 kB gzipped for the
 * common bundle, Prism ~40 kB plus per-language files, and both want a DOM
 * string (innerHTML) rather than a token list. SyncSpace already carries Monaco
 * — but Monaco is an *editor*: mounting one per code block in a chat transcript
 * costs a model, a view, and a layout pass each, which is absurd for a
 * five-line Hello World and would stutter badly while streaming.
 *
 * What is actually needed is: comments, strings, numbers, keywords, types and
 * function names, for the handful of languages this IDE deals with. That is
 * ~120 lines of regex and it emits tokens, not HTML, so the renderer stays on
 * React elements and never touches dangerouslySetInnerHTML.
 *
 * Unknown languages fall through to a generic profile rather than failing —
 * a Kotlin block still gets its strings and comments coloured.
 */

/** Keyword sets. Kept small: the common shape of the language, not its spec. */
const KEYWORDS = {
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null',
  javascript: 'async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined',
  typescript: 'any as asserts async await boolean break case catch class const continue declare default delete do else enum export extends finally for from function if implements import in infer instanceof interface keyof let namespace never new number of private protected public readonly return static string super switch this throw try type typeof unknown var void while yield true false null undefined',
  python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self match case',
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL',
  cpp: 'alignas alignof auto bool break case catch char class const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while',
  csharp: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false make new len cap append',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  sql: 'select from where group by having order limit offset insert into values update set delete create table drop alter add primary key foreign references join inner left right outer on as and or not null distinct union all count sum avg min max case when then else end',
  bash: 'if then else elif fi for while do done case esac in function return local export echo cd exit set unset source read',
  ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts require',
  php: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list namespace new or print private protected public require return static switch throw trait try unset use var while xor yield true false null',
  kotlin: 'as break by class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while private public internal protected suspend data sealed companion',
  swift: 'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil rethrows self super throw throws true try'
};

/** Comment and string syntax per family. */
const PROFILES = {
  hash: { line: /#/, block: null, strings: ['"', "'"], triple: false },
  slash: { line: /\/\//, block: ['/*', '*/'], strings: ['"', "'", '`'], triple: false },
  python: { line: /#/, block: null, strings: ['"', "'"], triple: true },
  sql: { line: /--/, block: ['/*', '*/'], strings: ["'", '"'], triple: false },
  dash: { line: /--/, block: null, strings: ['"', "'"], triple: false }
};

const FAMILY = {
  java: 'slash', javascript: 'slash', typescript: 'slash', c: 'slash', cpp: 'slash',
  csharp: 'slash', go: 'slash', rust: 'slash', php: 'slash', kotlin: 'slash',
  swift: 'slash', scala: 'slash', dart: 'slash', css: 'slash', json: 'slash',
  python: 'python', ruby: 'hash', bash: 'hash', yaml: 'hash', perl: 'hash',
  r: 'hash', verilog: 'slash', vhdl: 'dash', matlab: 'hash', lua: 'dash',
  sql: 'sql', haskell: 'dash', asm: 'hash', powershell: 'hash'
};

/** Aliases the model may emit in a fence that are not our canonical ids. */
const FENCE_ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c',
  'c#': 'csharp', cs: 'csharp',
  golang: 'go', rs: 'rust', rb: 'ruby', kt: 'kotlin',
  sh: 'bash', shell: 'bash', zsh: 'bash',
  yml: 'yaml', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  plaintext: 'text', txt: 'text', console: 'text', output: 'text'
};

export function normalizeFence(lang) {
  const id = String(lang || '').trim().toLowerCase();
  if (!id) return '';
  return FENCE_ALIASES[id] || id;
}

/** Human label shown on the code-block header. */
const LABELS = {
  javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', java: 'Java',
  c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go', rust: 'Rust', ruby: 'Ruby',
  php: 'PHP', kotlin: 'Kotlin', swift: 'Swift', sql: 'SQL', bash: 'Bash',
  html: 'HTML', css: 'CSS', json: 'JSON', yaml: 'YAML', verilog: 'Verilog',
  vhdl: 'VHDL', matlab: 'MATLAB', dart: 'Dart', asm: 'Assembly', text: 'Text',
  powershell: 'PowerShell', scala: 'Scala', perl: 'Perl', lua: 'Lua', haskell: 'Haskell'
};

export function labelForFence(lang) {
  const id = normalizeFence(lang);
  if (!id) return 'Code';
  return LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1);
}

const keywordSetCache = new Map();
function keywordSet(id) {
  if (keywordSetCache.has(id)) return keywordSetCache.get(id);
  const words = KEYWORDS[id];
  const set = words ? new Set(words.split(/\s+/)) : null;
  keywordSetCache.set(id, set);
  return set;
}

/**
 * Tokenize one line-oriented source blob.
 *
 * Returns a flat array of { type, text }. `type` is one of:
 * comment | string | number | keyword | type | fn | punct | plain
 *
 * A single left-to-right scan, so it is linear and safe to re-run on every
 * streamed chunk. State that must survive a line break (block comments, triple
 * quotes) is carried across lines by the caller loop below.
 */
export function tokenizeCode(code, lang) {
  const id = normalizeFence(lang);
  const family = FAMILY[id] || 'slash';
  const profile = PROFILES[family] || PROFILES.slash;
  const keywords = keywordSet(id);

  const src = String(code ?? '');
  const tokens = [];
  let i = 0;
  let buffer = '';

  const flush = () => { if (buffer) { tokens.push({ type: 'plain', text: buffer }); buffer = ''; } };
  const push = (type, text) => { flush(); tokens.push({ type, text }); };

  const isIdentStart = (ch) => /[A-Za-z_$]/.test(ch);
  const isIdent = (ch) => /[A-Za-z0-9_$]/.test(ch);

  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    // block comment
    if (profile.block && rest.startsWith(profile.block[0])) {
      const end = src.indexOf(profile.block[1], i + profile.block[0].length);
      const stop = end === -1 ? src.length : end + profile.block[1].length;
      push('comment', src.slice(i, stop));
      i = stop;
      continue;
    }

    // line comment
    if (profile.line && profile.line.test(rest.slice(0, 2))) {
      const marker = family === 'sql' || family === 'dash' ? '--' : family === 'slash' ? '//' : '#';
      if (rest.startsWith(marker)) {
        let end = src.indexOf('\n', i);
        if (end === -1) end = src.length;
        push('comment', src.slice(i, end));
        i = end;
        continue;
      }
    }

    // triple-quoted strings (python docstrings)
    if (profile.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3);
      const end = src.indexOf(quote, i + 3);
      const stop = end === -1 ? src.length : end + 3;
      push('string', src.slice(i, stop));
      i = stop;
      continue;
    }

    // strings
    if (profile.strings.includes(ch)) {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j++; break; }
        // An unterminated string must not swallow the rest of the file.
        if (src[j] === '\n' && ch !== '`') break;
        j++;
      }
      push('string', src.slice(i, j));
      i = j;
      continue;
    }

    // preprocessor / annotation / attribute
    if ((ch === '#' && family === 'slash') || ch === '@') {
      let j = i + 1;
      while (j < src.length && isIdent(src[j])) j++;
      if (j > i + 1) { push('meta', src.slice(i, j)); i = j; continue; }
    }

    // numbers
    if (/[0-9]/.test(ch) && !(i > 0 && isIdent(src[i - 1]))) {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXbBoO._']/.test(src[j])) j++;
      push('number', src.slice(i, j));
      i = j;
      continue;
    }

    // identifiers
    if (isIdentStart(ch)) {
      let j = i;
      while (j < src.length && isIdent(src[j])) j++;
      const word = src.slice(i, j);

      let k = j;
      while (k < src.length && src[k] === ' ') k++;
      const callish = src[k] === '(';

      if (keywords && keywords.has(word)) push('keyword', word);
      else if (callish) push('fn', word);
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) push('type', word);
      else buffer += word;

      i = j;
      continue;
    }

    if (/[{}()[\];,.<>+\-*/%=!&|^~?:]/.test(ch)) {
      push('punct', ch);
      i++;
      continue;
    }

    buffer += ch;
    i++;
  }

  flush();
  return tokens;
}
