import { useEffect, useRef, useState, useMemo, useCallback } from 'react';

const MAX_MESSAGE_LENGTH = 2000;
const MESSAGE_CAP = 100;

/**
 * Workspace Chat Panel
 *
 * A real-time collaborative chat sidebar. Messages are stored in a Yjs array
 * inside the same ydoc the canvas and editor use, so they sync over the
 * existing Socket.io relay and persist in the same snapshot — no new server
 * code, no new dependencies.
 *
 *   - ydoc.getArray('chatMessages')   shared message history (capped at 100)
 *   - awareness 'chatTyping' field    who is typing right now
 *
 * Each message record:
 *   { id, at, username, color, role, text }
 */
export default function ChatPanel({ ydoc, awareness, session, onClose }) {
  const messagesArr = useMemo(() => ydoc.getArray('chatMessages'), [ydoc]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState([]); // who's typing
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const typingTimer = useRef(null);

  const me = session?.username || 'anon';
  const myColor = awareness.getLocalState()?.user?.color || '#6366f1';

  // ---- observe shared messages -------------------------------------------
  useEffect(() => {
    const sync = () => setMessages(messagesArr.toArray());
    sync();
    messagesArr.observe(sync);
    return () => messagesArr.unobserve(sync);
  }, [messagesArr]);

  // auto-scroll to newest message
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // ---- observe typing indicators from awareness --------------------------
  useEffect(() => {
    const onChange = () => {
      const list = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return;
        if (state.chatTyping && state.user) {
          list.push({ clientId, name: state.user.name, color: state.user.color });
        }
      });
      setTyping(list);
    };
    awareness.on('change', onChange);
    onChange();
    return () => awareness.off('change', onChange);
  }, [awareness, ydoc]);

  // ---- send a message ----------------------------------------------------
  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || text.length > MAX_MESSAGE_LENGTH) return;

    // Clear typing indicator
    awareness.setLocalStateField('chatTyping', undefined);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;

    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      username: me,
      color: myColor,
      role: session?.role || 'member',
      text
    };

    ydoc.transact(() => {
      messagesArr.push([msg]);
      if (messagesArr.length > MESSAGE_CAP) {
        messagesArr.delete(0, messagesArr.length - MESSAGE_CAP);
      }
    });

    setInput('');
    inputRef.current?.focus();
  }, [input, me, myColor, session, ydoc, messagesArr, awareness]);

  // ---- typing indicator (debounced) --------------------------------------
  const onInputChange = (e) => {
    const val = e.target.value;
    if (val.length > MAX_MESSAGE_LENGTH) return;
    setInput(val);

    // Broadcast typing state
    if (val.trim()) {
      awareness.setLocalStateField('chatTyping', true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        awareness.setLocalStateField('chatTyping', undefined);
      }, 2000);
    } else {
      awareness.setLocalStateField('chatTyping', undefined);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
  };

  // ---- key handler -------------------------------------------------------
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Escape') {
      onClose?.();
    }
  };

  // Cleanup typing on unmount
  useEffect(() => {
    return () => {
      awareness.setLocalStateField('chatTyping', undefined);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [awareness]);

  // ---- format timestamp --------------------------------------------------
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  };

  return (
    <aside className="chat-panel">
      <div className="chat-head">
        <div className="chat-head-left">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 10 C3 5 6 2 10 2 C14 2 17 5 17 10 C17 15 14 18 10 18 C8 18 6 17 5 16 L3 17 L4 15 C3.5 14 3 12 3 10 Z" />
          </svg>
          <span>Chat</span>
          <span className="chat-count">{messages.length}</span>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close chat">&#10005;</button>
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>No messages yet.<br />Say hello to your team!</p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={'chat-msg' + (msg.username === me ? ' mine' : '')}>
            <div className="chat-msg-top">
              <span className="chat-msg-author" style={{ color: msg.color }}>{msg.username}</span>
              {msg.role === 'admin' && <span className="tag admin" style={{ fontSize: 9, padding: '1px 5px' }}>admin</span>}
              <span className="chat-msg-time">{fmtTime(msg.at)}</span>
            </div>
            <div className="chat-msg-text">{msg.text}</div>
          </div>
        ))}

        {typing.length > 0 && (
          <div className="chat-typing">
            {typing.slice(0, 3).map((t) => (
              <span key={t.clientId} className="chat-typing-name" style={{ color: t.color }}>{t.name}</span>
            ))}
            {typing.length > 3 && <span className="chat-typing-name">+{typing.length - 3} others</span>}
            <span className="chat-typing-dots">
              <span className="dot-1">.</span><span className="dot-2">.</span><span className="dot-3">.</span>
            </span>
          </div>
        )}
      </div>

      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={onInputChange}
          onKeyDown={onKeyDown}
          placeholder="Type a message…"
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          autoFocus
        />
        <button
          className="chat-send-btn"
          onClick={sendMessage}
          disabled={!input.trim()}
          title="Send (Enter)"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
            <path d="M2 18 L19 10 L2 2 L2 8 L15 10 L2 12 Z" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

