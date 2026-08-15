import { memo, useMemo, useState, useCallback } from 'react';
import { parseMarkdown } from './markdown.js';
import { tokenizeCode, labelForFence, normalizeFence } from './highlight.js';

/**
 * Renders one assistant message.
 *
 * Every node below is a real React element. There is no HTML string anywhere in
 * this file and therefore no dangerouslySetInnerHTML: raw `<script>` in a model
 * response is displayed as the text `<script>`, which is the only correct
 * behaviour for untrusted generated content.
 *
 * Memoisation matters here more than usual. During streaming this component is
 * re-rendered on every flush, and the parse is O(n) over the whole message each
 * time. `useMemo` on the source string collapses that to one parse per flush,
 * and the per-block `memo()` means blocks that are already finished — every
 * code block above the one still being written — do not re-render at all.
 */
function MarkdownView({ content, streaming = false }) {
  const blocks = useMemo(() => {
    try {
      return parseMarkdown(content);
    } catch {
      // A parser exception in a render path would blank the page. Malformed
      // Markdown degrades to plain text instead.
      return [{ type: 'paragraph', inline: [{ type: 'text', text: String(content ?? '') }] }];
    }
  }, [content]);

  return (
    <div className="md">
      {blocks.map((block, index) => (
        <Block
          key={index}
          block={block}
          last={streaming && index === blocks.length - 1}
        />
      ))}
    </div>
  );
}

const Block = memo(function Block({ block, last }) {
  switch (block.type) {
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} open={block.open} />;

    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}`;
      return <Tag className={`md-h md-h${block.level}`}><Inline nodes={block.inline} /></Tag>;
    }

    case 'list':
      return block.ordered ? (
        <ol className="md-ol" start={block.start}><Items items={block.items} /></ol>
      ) : (
        <ul className="md-ul"><Items items={block.items} /></ul>
      );

    case 'quote':
      return (
        <blockquote className="md-quote">
          {block.blocks.map((b, i) => <Block key={i} block={b} />)}
        </blockquote>
      );

    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.aligns[i] || 'left' }}>
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: block.aligns[c] || 'left' }}>
                      <Inline nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'hr':
      return <hr className="md-hr" />;

    case 'paragraph':
    default:
      return (
        <p className="md-p">
          <Inline nodes={block.inline} />
          {last && <span className="md-caret" aria-hidden="true" />}
        </p>
      );
  }
});

function Items({ items }) {
  return items.map((item, i) => (
    <li key={i} className="md-li">
      <Inline nodes={item.inline} />
      {item.nested?.map((nested, n) =>
        nested.ordered
          ? <ol key={n} className="md-ol" start={nested.start}><Items items={nested.items} /></ol>
          : <ul key={n} className="md-ul"><Items items={nested.items} /></ul>
      )}
    </li>
  ));
}

function Inline({ nodes }) {
  if (!nodes?.length) return null;

  return nodes.map((node, i) => {
    switch (node.type) {
      case 'code':
        return <code key={i} className="md-inline-code">{node.text}</code>;
      case 'bold':
        return <strong key={i}><Inline nodes={node.children} /></strong>;
      case 'italic':
        return <em key={i}><Inline nodes={node.children} /></em>;
      case 'strike':
        return <s key={i}><Inline nodes={node.children} /></s>;
      case 'link':
        // A rejected href (javascript:, data:) renders as plain text, never a
        // clickable link. rel is non-negotiable on model-supplied URLs.
        return node.href ? (
          <a key={i} className="md-link" href={node.href} target="_blank" rel="noopener noreferrer nofollow">
            <Inline nodes={node.children} />
          </a>
        ) : (
          <span key={i}><Inline nodes={node.children} /></span>
        );
      case 'text':
      default:
        return <span key={i}>{node.text}</span>;
    }
  });
}

/**
 * A fenced code block: language label, copy button, highlighted body.
 *
 * `open` means the closing fence has not streamed in yet. The block is rendered
 * as a code block regardless — a half-written Java method should look like Java
 * while it arrives, not like a paragraph of backticks that reflows the instant
 * the fence lands.
 */
const CodeBlock = memo(function CodeBlock({ lang, text, open }) {
  const [copied, setCopied] = useState(false);
  const id = normalizeFence(lang);

  const tokens = useMemo(() => {
    try {
      return tokenizeCode(text, id);
    } catch {
      return [{ type: 'plain', text: String(text ?? '') }];
    }
  }, [text, id]);

  const copy = useCallback(() => {
    // clipboard API is unavailable on insecure origins; fail quietly rather
    // than throwing inside an onClick.
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {}
    );
  }, [text]);

  return (
    <div className={'md-code' + (open ? ' streaming' : '')}>
      <div className="md-code-head">
        <span className="md-code-lang">{labelForFence(lang)}</span>
        <button type="button" className="md-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre className="md-pre">
        <code>
          {tokens.map((token, i) =>
            token.type === 'plain'
              ? <span key={i}>{token.text}</span>
              : <span key={i} className={'tok-' + token.type}>{token.text}</span>
          )}
        </code>
      </pre>
    </div>
  );
});

export default memo(MarkdownView);
