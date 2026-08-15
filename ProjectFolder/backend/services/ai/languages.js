/**
 * Language identity for the AI module.
 *
 * The bug this file exists to kill: the UI sent `language: "javascript"` on
 * every request, the prompt printed it as `PROGRAMMING LANGUAGE: javascript`
 * under the user's own words ("...in java"), and the model — correctly, given
 * two contradictory instructions — followed the structured field. Nothing in
 * the pipeline ever compared the two.
 *
 * So language is now *resolved* before a prompt is built, deterministically, in
 * one place, with an explicit priority order and an explicit conflict rule. No
 * model call is spent deciding what language the user asked for: a regex is
 * both faster and more reliable than an LLM at reading the word "java".
 *
 * The registry is deliberately wider than execution/languages.js. That file
 * lists what SyncSpace can RUN (5 languages); this one lists what the assistant
 * can talk about, which is far more. They agree on the five shared ids
 * (javascript, python, c, cpp, java) so an editor language always resolves.
 */

/**
 * `aliases` are matched case-insensitively on word boundaries. Order inside the
 * registry does not matter — resolution sorts by alias length so that
 * "javascript" always beats "java", and "c++" always beats "c".
 */
export const AI_LANGUAGES = {
  javascript: { label: 'JavaScript', fence: 'javascript', aliases: ['javascript', 'java script', 'js', 'node', 'nodejs', 'node.js', 'ecmascript'] },
  typescript: { label: 'TypeScript', fence: 'typescript', aliases: ['typescript', 'ts'] },
  python:     { label: 'Python',     fence: 'python',     aliases: ['python', 'python3', 'python 3', 'py'] },
  java:       { label: 'Java',       fence: 'java',       aliases: ['java'] },
  c:          { label: 'C',          fence: 'c',          aliases: ['c', 'ansi c', 'c99', 'c11', 'c17'] },
  cpp:        { label: 'C++',        fence: 'cpp',        aliases: ['c++', 'cpp', 'cplusplus', 'c plus plus', 'c++17', 'c++20'] },
  csharp:     { label: 'C#',         fence: 'csharp',     aliases: ['c#', 'csharp', 'c sharp', '.net', 'dotnet'] },
  go:         { label: 'Go',         fence: 'go',         aliases: ['go', 'golang'] },
  rust:       { label: 'Rust',       fence: 'rust',       aliases: ['rust'] },
  ruby:       { label: 'Ruby',       fence: 'ruby',       aliases: ['ruby'] },
  php:        { label: 'PHP',        fence: 'php',        aliases: ['php'] },
  kotlin:     { label: 'Kotlin',     fence: 'kotlin',     aliases: ['kotlin'] },
  swift:      { label: 'Swift',      fence: 'swift',      aliases: ['swift'] },
  scala:      { label: 'Scala',      fence: 'scala',      aliases: ['scala'] },
  r:          { label: 'R',          fence: 'r',          aliases: ['r language', 'rlang'] },
  sql:        { label: 'SQL',        fence: 'sql',        aliases: ['sql', 'mysql', 'postgres', 'postgresql', 'sqlite', 'plsql'] },
  bash:       { label: 'Bash',       fence: 'bash',       aliases: ['bash', 'shell', 'sh', 'shell script', 'zsh'] },
  powershell: { label: 'PowerShell', fence: 'powershell', aliases: ['powershell', 'pwsh'] },
  html:       { label: 'HTML',       fence: 'html',       aliases: ['html', 'html5'] },
  css:        { label: 'CSS',        fence: 'css',        aliases: ['css', 'scss', 'sass'] },
  json:       { label: 'JSON',       fence: 'json',       aliases: ['json'] },
  yaml:       { label: 'YAML',       fence: 'yaml',       aliases: ['yaml', 'yml'] },
  verilog:    { label: 'Verilog',    fence: 'verilog',    aliases: ['verilog', 'systemverilog'] },
  vhdl:       { label: 'VHDL',       fence: 'vhdl',       aliases: ['vhdl'] },
  matlab:     { label: 'MATLAB',     fence: 'matlab',     aliases: ['matlab', 'octave'] },
  dart:       { label: 'Dart',       fence: 'dart',       aliases: ['dart', 'flutter'] },
  perl:       { label: 'Perl',       fence: 'perl',       aliases: ['perl'] },
  lua:        { label: 'Lua',        fence: 'lua',        aliases: ['lua'] },
  haskell:    { label: 'Haskell',    fence: 'haskell',    aliases: ['haskell'] },
  assembly:   { label: 'Assembly',   fence: 'asm',        aliases: ['assembly', 'asm', 'x86', 'risc-v assembly', 'arm assembly'] }
};

/**
 * One flat alias -> id table, longest alias first.
 *
 * This ordering is the entire defence against the reported bug: scanning
 * "javascript" before "java" means the substring can never win. Building it
 * once at module load keeps resolution at zero allocation cost per request.
 */
const ALIAS_TABLE = Object.entries(AI_LANGUAGES)
  .flatMap(([id, def]) => def.aliases.map((alias) => ({ alias: alias.toLowerCase(), id })))
  .sort((a, b) => b.alias.length - a.alias.length);

/** Escape a literal for use inside a RegExp (c++, c#, node.js all need it). */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Word boundaries that understand `+` and `#`.
 *
 * \b is useless here: in "c++" the boundary sits between "c" and "+", so
 * /\bc\b/ happily matches the "c" of "c++" and a request for C++ silently
 * becomes C. These lookarounds instead require that the character on either
 * side is not part of an identifier *or* a language sigil.
 */
function aliasPattern(alias) {
  return new RegExp(`(?<![A-Za-z0-9_+#.])${esc(alias)}(?![A-Za-z0-9_+#])`, 'i');
}

const PATTERNS = ALIAS_TABLE.map(({ alias, id }) => ({ id, alias, re: aliasPattern(alias) }));

/** Canonicalise anything the client sends: "Java", "js", "C++" -> an id. */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (AI_LANGUAGES[v]) return v;
  const hit = ALIAS_TABLE.find((entry) => entry.alias === v);
  return hit ? hit.id : null;
}

export function labelOf(id) {
  return AI_LANGUAGES[id]?.label || id || '';
}

export function fenceOf(id) {
  return AI_LANGUAGES[id]?.fence || 'text';
}

export function isSupportedLanguage(id) {
  return Boolean(AI_LANGUAGES[normalizeLanguage(id)]);
}

/**
 * Every language named in a piece of prose, in the order it appears.
 *
 * Order matters for conversions: "convert this java to python" must yield
 * [java, python], not a set. Each position in the text is claimed by at most
 * one alias — the longest — so "javascript" never also reports "java".
 */
export function findLanguageMentions(text) {
  if (typeof text !== 'string' || !text) return [];

  const claimed = new Array(text.length).fill(false);
  const found = [];

  for (const { id, alias } of ALIAS_TABLE) {
    const re = new RegExp(aliasPattern(alias).source, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      let free = true;
      for (let i = start; i < end; i++) if (claimed[i]) { free = false; break; }
      if (!free) continue;
      for (let i = start; i < end; i++) claimed[i] = true;
      found.push({ id, index: start });
    }
  }

  found.sort((a, b) => a.index - b.index);

  // De-duplicate, keeping first appearance: "java ... java" is one language.
  const seen = new Set();
  return found.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

/**
 * Source and target for a conversion, read out of plain English.
 *
 * "convert this java code to python"      -> java -> python
 * "port to rust"                          -> ? -> rust
 * "from python into c++"                  -> python -> c++
 *
 * Directional words are what make this safe. Without them, two mentioned
 * languages are ambiguous and we say so rather than guessing a direction.
 */
export function detectConversion(text) {
  const mentions = findLanguageMentions(text);
  if (mentions.length === 0) return { from: null, to: null };

  const lower = String(text || '').toLowerCase();

  // A "to"-style keyword sitting before a language marks it as the target.
  const TO_RE = /\b(?:to|into|in ?to|as|toward|towards|→|->)\b/gi;
  const toPositions = [];
  let m;
  while ((m = TO_RE.exec(lower)) !== null) toPositions.push(m.index);

  const FROM_RE = /\b(?:from|out of)\b/gi;
  const fromPositions = [];
  while ((m = FROM_RE.exec(lower)) !== null) fromPositions.push(m.index);

  const nearestBefore = (positions, index) => {
    let best = -1;
    for (const p of positions) if (p < index && p > best && index - p <= 24) best = p;
    return best;
  };

  let to = null;
  let from = null;

  for (const mention of mentions) {
    const toAt = nearestBefore(toPositions, mention.index);
    const fromAt = nearestBefore(fromPositions, mention.index);
    if (toAt > fromAt && !to) to = mention.id;
    else if (fromAt > toAt && !from) from = mention.id;
  }

  // "convert java to python" — java has no keyword before it but is first.
  if (to && !from) {
    const other = mentions.find((x) => x.id !== to);
    if (other) from = other.id;
  }
  if (!to && !from && mentions.length >= 2) {
    // No directional word at all: order is the only signal, and a bare
    // "java python" is too weak to act on. Report the pair, claim nothing.
    return { from: null, to: null, ambiguousPair: mentions.map((x) => x.id) };
  }
  if (!to && from && mentions.length >= 2) {
    const other = mentions.find((x) => x.id !== from);
    if (other) to = other.id;
  }

  return { from, to };
}

/**
 * Cheap structural sniffing of a code blob. Deliberately conservative — this is
 * the LOWEST-priority signal, used only to catch a stale editor default when
 * the user pasted something else entirely.
 */
export function inferLanguageFromCode(code) {
  if (typeof code !== 'string' || code.trim().length < 12) return null;
  const c = code.slice(0, 4000);

  const score = {
    java: 0, python: 0, cpp: 0, c: 0, javascript: 0, typescript: 0,
    csharp: 0, go: 0, rust: 0, php: 0, ruby: 0, sql: 0, bash: 0, html: 0
  };

  const bump = (id, n = 1) => { if (id in score) score[id] += n; };

  if (/\bpublic\s+(static\s+)?(final\s+)?class\b/.test(c)) bump('java', 3);
  if (/System\.out\.print/.test(c)) bump('java', 4);
  if (/\bpublic\s+static\s+void\s+main\s*\(\s*String/.test(c)) bump('java', 5);
  if (/\bimport\s+java\./.test(c)) bump('java', 4);

  if (/^\s*def\s+\w+\s*\(.*\)\s*:/m.test(c)) bump('python', 4);
  if (/^\s*(from\s+[\w.]+\s+)?import\s+[\w.]+/m.test(c) && !/\bimport\s+java\./.test(c)) bump('python', 2);
  if (/\bprint\s*\(/.test(c) && !/System\.out/.test(c)) bump('python', 1);
  if (/\bif\s+__name__\s*==/.test(c)) bump('python', 5);
  if (/\belif\b|\bself\b/.test(c)) bump('python', 2);

  if (/#include\s*<iostream>|std::(cout|cin|vector|string)|\busing\s+namespace\s+std\b/.test(c)) bump('cpp', 5);
  if (/#include\s*<(stdio|stdlib|string)\.h>/.test(c)) bump('c', 4);
  if (/\bprintf\s*\(/.test(c)) bump('c', 2);
  if (/\bmalloc\s*\(|\bfree\s*\(/.test(c)) bump('c', 1);

  if (/\bconsole\.log\s*\(/.test(c)) bump('javascript', 4);
  if (/\b(const|let)\s+\w+\s*=/.test(c)) bump('javascript', 1);
  if (/\bfunction\s+\w+\s*\(|=>\s*\{/.test(c)) bump('javascript', 2);
  if (/\brequire\s*\(|\bmodule\.exports\b/.test(c)) bump('javascript', 3);
  if (/:\s*(string|number|boolean)\b|\binterface\s+\w+\s*\{/.test(c)) bump('typescript', 4);

  if (/\busing\s+System\b|\bnamespace\s+\w+|Console\.WriteLine/.test(c)) bump('csharp', 5);
  if (/\bfunc\s+\w+\s*\(|\bpackage\s+main\b|fmt\.Print/.test(c)) bump('go', 4);
  if (/\bfn\s+main\s*\(|\blet\s+mut\b|println!/.test(c)) bump('rust', 5);
  if (/<\?php|\$\w+\s*=/.test(c)) bump('php', 3);
  if (/\bdef\s+\w+.*\bend\b|\bputs\b/.test(c)) bump('ruby', 3);
  if (/\bSELECT\b[\s\S]*\bFROM\b/i.test(c)) bump('sql', 4);
  if (/^#!.*\b(bash|sh)\b/m.test(c)) bump('bash', 5);
  if (/<!DOCTYPE html>|<html[\s>]/i.test(c)) bump('html', 5);

  let best = null;
  let bestScore = 0;
  for (const [id, s] of Object.entries(score)) {
    if (s > bestScore) { best = id; bestScore = s; }
  }
  return bestScore >= 3 ? best : null;
}

/**
 * THE decision. One function, one priority order, applied to every action.
 *
 *   1. What the user explicitly wrote in this request  ("...in java")
 *   2. Language metadata supplied by the client        (editor dropdown)
 *   3. What the attached code structurally looks like
 *
 * with one override: when (2) wins but (3) firmly disagrees, (3) takes it. That
 * is the stale-default case — the editor still says JavaScript because nobody
 * touched the dropdown, while the user has pasted a Java file. The pasted code
 * is evidence; the dropdown is a leftover.
 *
 * Returns the reasoning too, so the route can log it and the tests can assert
 * on WHY a language was chosen rather than just that it was.
 */
export function resolveLanguage({ message = '', code = '', requestLanguage = '', action = 'chat' } = {}) {
  const fromMessage = findLanguageMentions(message);
  const fromMetadata = normalizeLanguage(requestLanguage);
  const fromCode = inferLanguageFromCode(code);

  // For code-bearing actions the user's prose may name a language that is the
  // *subject* ("explain this java code") — still explicit, still wins.
  const explicit = fromMessage.length === 1
    ? fromMessage[0].id
    : fromMessage.length > 1
      ? fromMessage[0].id   // first named is the subject; convert() handles pairs
      : null;

  if (explicit) {
    return {
      language: explicit,
      source: 'user-request',
      confidence: 'explicit',
      conflict: fromMetadata && fromMetadata !== explicit
        ? { with: fromMetadata, resolvedBy: 'user request wins over editor default' }
        : null,
      candidates: { fromMessage: fromMessage.map((x) => x.id), fromMetadata, fromCode }
    };
  }

  if (fromMetadata) {
    if (fromCode && fromCode !== fromMetadata) {
      return {
        language: fromCode,
        source: 'supplied-code',
        confidence: 'inferred',
        conflict: { with: fromMetadata, resolvedBy: 'pasted code overrides a stale editor default' },
        candidates: { fromMessage: [], fromMetadata, fromCode }
      };
    }
    return {
      language: fromMetadata,
      source: 'editor-metadata',
      confidence: 'supplied',
      conflict: null,
      candidates: { fromMessage: [], fromMetadata, fromCode }
    };
  }

  if (fromCode) {
    return {
      language: fromCode,
      source: 'supplied-code',
      confidence: 'inferred',
      conflict: null,
      candidates: { fromMessage: [], fromMetadata: null, fromCode }
    };
  }

  return {
    language: null,
    source: 'none',
    confidence: 'unknown',
    conflict: null,
    candidates: { fromMessage: [], fromMetadata: null, fromCode: null },
    // `generate` cannot proceed without knowing the language; `chat` and the
    // code-bearing actions can, because the code or the question carries it.
    needsClarification: action === 'generate'
  };
}

/**
 * Conversions need two languages, and getting the direction backwards is worse
 * than asking. Source may be inferred; target must be explicit.
 */
export function resolveConversion({ message = '', code = '', requestLanguage = '', targetLanguage = '' } = {}) {
  const spoken = detectConversion(message);
  const metaFrom = normalizeLanguage(requestLanguage);
  const metaTo = normalizeLanguage(targetLanguage);
  const codeLang = inferLanguageFromCode(code);

  const to = spoken.to || metaTo || null;
  const from = spoken.from || codeLang || metaFrom || null;

  if (!to) {
    return {
      from, to: null,
      needsClarification: true,
      question: spoken.ambiguousPair
        ? `Which direction should I convert — ${labelOf(spoken.ambiguousPair[0])} to ${labelOf(spoken.ambiguousPair[1])}, or the other way round?`
        : 'Which language should I convert this code into?'
    };
  }

  if (!from) {
    return {
      from: null, to,
      needsClarification: true,
      question: `What language is the source code written in? I'll convert it to ${labelOf(to)}.`
    };
  }

  if (from === to) {
    return {
      from, to,
      needsClarification: true,
      question: `The source and target are both ${labelOf(to)}. Which language did you want me to convert it into?`
    };
  }

  return {
    from, to,
    needsClarification: false,
    fromSource: spoken.from ? 'user-request' : codeLang ? 'supplied-code' : 'editor-metadata',
    toSource: spoken.to ? 'user-request' : 'editor-metadata'
  };
}
