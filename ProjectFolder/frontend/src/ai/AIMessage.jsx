import { memo } from 'react';
import MarkdownView from './Markdown.jsx';

/**
 * One row in the transcript.
 *
 * The previous version rendered `{content}` as a bare string into a div with
 * white-space: pre-wrap — which is why the screenshot shows literal `**` and
 * literal ``` fences. Assistant text now goes through the Markdown renderer.
 *
 * User text deliberately does NOT: a user pasting a code sample wants to see
 * exactly what they pasted, not have their asterisks interpreted.
 */
function AIMessage({ message }) {
  const { role, content, pending, meta, stats, error, cancelled } = message;
  const isUser = role === 'user';

  if (isUser) {
    return (
      <div className="ai-message-row user">
        <div className="ai-message-label">You</div>
        <div className="ai-message-content ai-user-text">{content}</div>
      </div>
    );
  }

  const waiting = pending && !content;

  return (
    <div className="ai-message-row assistant">
      <div className="ai-message-label">
        SyncSpace AI
        {/* The resolved language, straight from the server. This is the visible
            answer to "did it actually understand I said Java?" */}
        {meta?.languageLabel && (
          <span className="ai-badge" title={`Language resolved from: ${meta.languageSource}`}>
            {meta.languageLabel}
            {meta.targetLanguageLabel ? ` → ${meta.targetLanguageLabel}` : ''}
          </span>
        )}
        {meta?.model && <span className="ai-badge subtle">{meta.model}</span>}
      </div>

      <div className="ai-message-content">
        {waiting ? (
          <div className="ai-loading" aria-label="Thinking">
            <span /><span /><span />
          </div>
        ) : (
          <MarkdownView content={content} streaming={Boolean(pending)} />
        )}

        {cancelled && <div className="ai-note">Stopped.</div>}

        {error && (
          <div className="ai-error" role="alert">
            <strong>{content ? 'The answer was cut short: ' : ''}</strong>{error}
          </div>
        )}
      </div>

      {stats?.totalMs != null && (
        <div className="ai-stats">
          {stats.timeToFirstTokenMs != null && `first token ${stats.timeToFirstTokenMs} ms · `}
          {`total ${stats.totalMs} ms`}
          {stats.thinkingLevel ? ` · thinking: ${stats.thinkingLevel}` : ''}
        </div>
      )}
    </div>
  );
}

export default memo(AIMessage);
