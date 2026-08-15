import { useState, useRef, useEffect, useCallback } from 'react';
import AIMessage from './AIMessage.jsx';

function getPlaceholder(action) {
  switch (action) {
    case 'explain': return 'Paste the code you want me to explain...';
    case 'generate': return 'Describe the code you want to generate...';
    case 'error': return 'Paste the error message or stack trace...';
    case 'debug': return 'Paste the code that is misbehaving...';
    case 'tests': return 'Paste the function or class to test...';
    case 'optimize': return 'Paste the code you want to optimize...';
    case 'convert': return 'Paste the code you want to convert...';
    case 'document': return 'Paste the code you want documented...';
    default: return 'Ask SyncSpace AI...';
  }
}

export default function AIChat({
  activeAction,
  onSubmit,
  onCancel,
  status,
  messages,
  wantsErrorField,
  isCodeAction
}) {
  const [input, setInput] = useState('');
  const [errorInput, setErrorInput] = useState('');

  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);

  const busy = status !== 'idle';

  /**
   * Autoscroll that respects the reader.
   *
   * Following the tail is right until someone scrolls up to read an earlier
   * part of a long answer — yanking them back down every frame would make a
   * streaming response unreadable. We only stick to the bottom while they are
   * already near it.
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = useCallback(() => {
    const value = input.trim();
    if (!value || busy) return;
    setInput('');
    const extra = errorInput.trim();
    setErrorInput('');
    onSubmit(value, extra);
  }, [input, errorInput, busy, onSubmit]);

  const handleSubmit = (event) => {
    event.preventDefault();
    submit();
  };

  /** Ctrl/Cmd+Enter sends, matching the IDE's Run shortcut. */
  const handleKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section className="ai-chat">
      <div className="ai-messages" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="ai-empty">
            <div className="ai-empty-icon">✦</div>
            <h2>How can SyncSpace AI help?</h2>
            <p>Ask a programming question, or pick a tool above. Say the language in your request and I'll follow it.</p>
          </div>
        ) : (
          messages.map((message) => <AIMessage key={message.id} message={message} />)
        )}
      </div>

      <form className="ai-input-area" onSubmit={handleSubmit}>
        {wantsErrorField && (
          <textarea
            className="ai-error-input"
            value={errorInput}
            onChange={(event) => setErrorInput(event.target.value)}
            placeholder="Error message or stack trace (optional)"
            rows={2}
            maxLength={8000}
          />
        )}

        <div className="ai-input-row">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholder(activeAction)}
            rows={isCodeAction ? 5 : 3}
            /* Never disabled: a user must be able to type their next question
               while the current answer is still streaming. */
            maxLength={30000}
          />

          {busy ? (
            <button type="button" className="ai-stop" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>

        <div className="ai-input-hint">
          {busy
            ? status === 'connecting' ? 'Connecting…' : 'Generating…'
            : 'Ctrl+Enter to send'}
        </div>
      </form>
    </section>
  );
}
