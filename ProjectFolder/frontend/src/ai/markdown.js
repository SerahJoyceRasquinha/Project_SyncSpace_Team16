/**
 * A small Markdown parser, written for this one job.
 *
 * WHY NOT react-markdown
 * ----------------------
 * It is the obvious answer and it was evaluated first. Three reasons it lost:
 *
 *   1. Weight. react-markdown pulls in the unified/remark/mdast/hast toolchain
 *      — 12+ transitive packages, ~120 kB minified before a syntax highlighter,
 *      and highlight.js or Prism adds 80–300 kB more. SyncSpace already ships
 *      Monaco and Konva; this bundle does not need another parser stack to
 *      render chat bubbles.
 *
 *   2. Streaming. A general parser is built for complete documents. Mid-stream
 *      the text routinely ends inside an unterminated ``` fence, and a strict
 *      parser renders that as literal backticks, so every code block flickers
 *      as raw text until its closing fence arrives. This parser treats an
 *      unterminated fence as an open code block — the single most important
 *      property for a token-by-token UI, and the reason a purpose-built parser
 *      is actually the *better* engineering choice here, not just the lighter one.
 *
 *   3. Safety. react-markdown's HTML passthrough needs rehype-sanitize wired
 *      correctly. This parser emits a token tree that the renderer turns into
 *      React elements — there is no HTML string anywhere, so
 *      dangerouslySetInnerHTML is never needed and raw HTML in a model response
 *      is displayed as text rather than executed.
 *
 * Supported: ATX headings, fenced code (with info string), unordered and
 * ordered lists (nested), blockquotes, horizontal rules, GFM tables, and inline
 * code / bold / italic / strikethrough / links / autolinks.
 *
 * Everything is defensive: malformed input degrades to a paragraph. It never
 * throws, because a half-finished token stream is the normal case here, and a
 * parser exception in a render path takes the whole page down.
 */

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/;
const HEADING_RE = /^(\s{0,3})(#{1,6})\s+(.*)$/;
const HR_RE = /^(\s{0,3})([-*_])(\s*\2){2,}\s*$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^(\s{0,3})>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * Block-level parse. Returns a flat array of block tokens.
 * @param {string} src
 * @returns {Array<object>}
 */
export function parseMarkdown(src) {
  if (typeof src !== 'string' || src === '') return [];

  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ---- fenced code ------------------------------------------------------
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[2][0];
      const minLen = fence[2].length;
      const lang = (fence[3] || '').trim().toLowerCase();
      const body = [];
      let closed = false;
      i++;

      while (i < lines.length) {
        const closeMatch = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (closeMatch && closeMatch[1][0] === marker && closeMatch[1].length >= minLen) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }

      blocks.push({
        type: 'code',
        lang,
        // `open` drives the streaming caret in the renderer: this block is
        // still being written.
        open: !closed,
        text: body.join('\n')
      });
      continue;
    }

    // ---- blank ------------------------------------------------------------
    if (!line.trim()) { i++; continue; }

    // ---- horizontal rule --------------------------------------------------
    if (HR_RE.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    // ---- heading ----------------------------------------------------------
    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[2].length,
        inline: parseInline(heading[3].replace(/\s+#+\s*$/, ''))
      });
      i++;
      continue;
    }

    // ---- blockquote -------------------------------------------------------
    if (QUOTE_RE.test(line)) {
      const quoted = [];
      while (i < lines.length && (QUOTE_RE.test(lines[i]) || (lines[i].trim() && quoted.length && !isBlockStart(lines[i])))) {
        const m = lines[i].match(QUOTE_RE);
        quoted.push(m ? m[2] : lines[i].trim());
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(quoted.join('\n')) });
      continue;
    }

    // ---- table ------------------------------------------------------------
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({
        type: 'table',
        aligns,
        header: header.map(parseInline),
        rows: rows.map((r) => r.map(parseInline))
      });
      continue;
    }

    // ---- lists ------------------------------------------------------------
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const { list, next } = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }

    // ---- paragraph --------------------------------------------------------
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) {
      blocks.push({ type: 'paragraph', inline: parseInline(para.join('\n')) });
    } else {
      i++; // never spin
    }
  }

  return blocks;
}

function isBlockStart(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Split on pipes that are not escaped.
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Lists, including nesting by indentation and lazy continuation lines. */
function parseList(lines, start) {
  const first = lines[start].match(UL_RE) || lines[start].match(OL_RE);
  const ordered = !UL_RE.test(lines[start]);
  const baseIndent = first[1].length;
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const um = line.match(UL_RE);
    const om = line.match(OL_RE);
    const m = um || om;

    if (!m) {
      // A lazy continuation: indented text under the previous bullet.
      if (line.trim() && items.length && line.match(/^\s+/) && !isBlockStart(line)) {
        items[items.length - 1].lines.push(line.trim());
        i++;
        continue;
      }
      break;
    }

    const indent = m[1].length;
    const isOrdered = Boolean(om);

    if (indent < baseIndent) break;

    if (indent > baseIndent) {
      // Nested list: hand the whole run to a recursive call.
      const nested = parseList(lines, i);
      if (items.length) items[items.length - 1].nested.push(nested.list);
      i = nested.next;
      continue;
    }

    // A different marker type at the same level starts a NEW list.
    if (isOrdered !== ordered && items.length) break;

    items.push({ lines: [m[3]], nested: [] });
    i++;
  }

  return {
    list: {
      type: 'list',
      ordered,
      start: ordered ? Number(first[2]) || 1 : 1,
      items: items.map((item) => ({
        inline: parseInline(item.lines.join('\n')),
        nested: item.nested
      }))
    },
    next: i
  };
}

/**
 * Inline parse. Code spans are extracted FIRST and never re-scanned, so
 * `**not bold**` inside backticks stays literal — the usual bug in a
 * hand-rolled inline parser, and one that matters a lot when the text is full
 * of source code.
 */
export function parseInline(text) {
  if (typeof text !== 'string' || !text) return [];

  const out = [];
  let rest = text;

  // Order matters: longest/most-specific delimiters first.
  const RULES = [
    { type: 'code', re: /`([^`]+)`/ },
    { type: 'link', re: /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
    { type: 'bold', re: /\*\*([^*]+)\*\*/ },
    { type: 'bold', re: /__([^_]+)__/ },
    { type: 'strike', re: /~~([^~]+)~~/ },
    { type: 'italic', re: /\*([^*\n]+)\*/ },
    { type: 'italic', re: /(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/ },
    { type: 'autolink', re: /(https?:\/\/[^\s<>()[\]]+)/ }
  ];

  let guard = 0;
  while (rest && guard++ < 5000) {
    let best = null;

    for (const rule of RULES) {
      const m = rest.match(rule.re);
      if (m && (best === null || m.index < best.match.index)) {
        best = { rule, match: m };
      }
    }

    if (!best) break;

    const { rule, match } = best;
    if (match.index > 0) out.push({ type: 'text', text: rest.slice(0, match.index) });

    if (rule.type === 'code') {
      out.push({ type: 'code', text: match[1] });
    } else if (rule.type === 'link') {
      out.push({ type: 'link', href: safeHref(match[2]), children: parseInline(match[1]) });
    } else if (rule.type === 'autolink') {
      out.push({ type: 'link', href: safeHref(match[1]), children: [{ type: 'text', text: match[1] }] });
    } else {
      out.push({ type: rule.type, children: parseInline(match[1]) });
    }

    rest = rest.slice(match.index + match[0].length);
  }

  if (rest) out.push({ type: 'text', text: rest });
  return out;
}

/**
 * Only http(s) and mailto survive. A model can emit `javascript:` in a link and
 * a chat bubble is not the place to find out what it does.
 */
function safeHref(href) {
  const trimmed = String(href || '').trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}
