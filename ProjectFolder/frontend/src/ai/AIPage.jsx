import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { streamAI, sendAI, supportsStreaming, AIError } from './aiApi.js';
import AIChat from './AIChat.jsx';
import AIToolbar from './AIToolbar.jsx';
import { loadSession, loadAiContext } from '../utils/session';
import './ai.css';

/**
 * SyncSpace AI.
 *
 * The old version of this file is where the reported bug lived. Every action
 * called its own aiApi wrapper with the literal string "javascript" pinned in
 * the argument list — eight times — and `convert` was hardcoded
 * "javascript" -> "python". There was no language state on this page at all,
 * and no route by which the editor's real language could reach it.
 *
 * Now: language is a first-class piece of page state, seeded from whatever the
 * editor was actually set to, editable by the user, and sent as *metadata* —
 * a default the server may override when the user's own words disagree with it.
 * Nothing on this page decides the final language; the server resolves it and
 * reports back what it chose, which the UI then displays.
 */

/** Actions whose input is code rather than a question. */
const CODE_ACTIONS = new Set(['explain', 'debug', 'tests', 'optimize', 'convert', 'document']);
/** Actions that also want an error message alongside the code. */
const ERROR_ACTIONS = new Set(['error', 'debug']);

export default function AIPage() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();

  const session = workspaceId ? loadSession(workspaceId) : null;

  // Whatever the IDE was set to when the user pressed ✦ AI. This is a default,
  // not an instruction: see the server-side resolver.
  const editorContext = workspaceId ? loadAiContext(workspaceId) : null;

  const [activeAction, setActiveAction] = useState('chat');
  const [language, setLanguage] = useState(editorContext?.language || '');
  const [targetLanguage, setTargetLanguage] = useState('');
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | connecting | streaming

  const abortRef = useRef(null);

  // ---- streaming buffer -------------------------------------------------
  // Deltas arrive far faster than React should re-render. Text accumulates in
  // a ref and is flushed to state once per animation frame, so a 600-token
  // answer costs ~60 renders instead of ~600 — and the input box does not drop
  // keystrokes while the answer streams in beside it.
  const bufferRef = useRef('');
  const frameRef = useRef(0);
  const activeIdRef = useRef(null);

  const flush = useCallback(() => {
    frameRef.current = 0;
    const id = activeIdRef.current;
    const text = bufferRef.current;
    if (!id) return;
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? (m.content === text ? m : { ...m, content: text }) : m))
    );
  }, []);

  const scheduleFlush = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    abortRef.current?.abort();
  }, []);

  const newId = () =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const patch = useCallback((id, fields) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  }, []);

  /**
   * Build the request body.
   *
   * One builder for all nine actions — the field mapping is data, not a switch
   * with a hardcoded language in every branch. Fields the action does not use
   * are simply absent, so the server never has to guess which of two
   * contradictory hints to believe.
   */
  const buildRequest = useCallback((input, errorInput) => {
    const isCode = CODE_ACTIONS.has(activeAction);

    const body = {
      action: activeAction,
      message: isCode ? (errorInput ? '' : '') : input,
      code: isCode ? input : '',
      error: '',
      // Metadata, explicitly a default. The server outranks it with anything
      // the user actually wrote.
      language,
      targetLanguage: activeAction === 'convert' ? targetLanguage : ''
    };

    if (activeAction === 'error') {
      body.error = input;
      body.code = '';
      body.message = '';
    } else if (activeAction === 'debug') {
      body.code = input;
      body.error = errorInput || '';
    } else if (isCode) {
      // A code action can still carry an instruction ("convert this to Rust").
      body.message = errorInput || '';
    }

    if (editorContext?.filename) {
      body.editorContext = { filename: editorContext.filename };
    }

    return body;
  }, [activeAction, language, targetLanguage, editorContext]);

  const handleSubmit = useCallback(async (input, extra) => {
    if (status !== 'idle') return;

    const userId = newId();
    const assistantId = newId();

    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', content: input, action: activeAction },
      { id: assistantId, role: 'assistant', content: '', pending: true }
    ]);

    bufferRef.current = '';
    activeIdRef.current = assistantId;
    setStatus('connecting');

    const controller = new AbortController();
    abortRef.current = controller;

    const request = buildRequest(input, extra);

    try {
      const run = supportsStreaming() ? streamAI : sendAI;

      const result = await run(request, {
        token: session?.token,
        signal: controller.signal,
        onMeta: (meta) => {
          setStatus('streaming');
          // Show what the server actually decided — this is the visible proof
          // that "in java" beat the JavaScript default.
          patch(assistantId, { meta, pending: true });
        },
        onDelta: (text) => {
          bufferRef.current += text;
          scheduleFlush();
        }
      });

      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }

      // Non-streaming path returns everything at once.
      const finalText = result.text || bufferRef.current;

      patch(assistantId, {
        content: finalText || 'The AI returned an empty answer.',
        meta: result.meta || undefined,
        stats: result.done || undefined,
        pending: false,
        cancelled: Boolean(result.cancelled)
      });
    } catch (error) {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }

      const partial = error instanceof AIError ? error.partialText : '';
      patch(assistantId, {
        content: partial || bufferRef.current || '',
        pending: false,
        error: error?.message || 'Something went wrong talking to the AI.',
        errorCode: error?.code
      });
    } finally {
      activeIdRef.current = null;
      abortRef.current = null;
      setStatus('idle');
    }
  }, [status, activeAction, session, buildRequest, patch, scheduleFlush]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleBack = () => {
    navigate(workspaceId ? `/workspace/${workspaceId}` : '/');
  };

  const handleClear = useCallback(() => {
    if (status !== 'idle') return;
    setMessages([]);
  }, [status]);

  return (
    <main className="ai-page">
      <header className="ai-header">
        <div className="ai-brand">
          <button type="button" className="ai-back" onClick={handleBack} title="Back to workspace">
            ←
          </button>

          <div>
            <h1>✦ SyncSpace AI</h1>
            <p>Independent AI-powered development assistant</p>
          </div>
        </div>

        <div className="ai-header-right">
          {messages.length > 0 && (
            <button type="button" className="ai-clear" onClick={handleClear} disabled={status !== 'idle'}>
              Clear
            </button>
          )}
          {workspaceId && <div className="ai-workspace-info">Workspace: {workspaceId}</div>}
        </div>
      </header>

      <AIToolbar
        activeAction={activeAction}
        onAction={setActiveAction}
        language={language}
        onLanguage={setLanguage}
        targetLanguage={targetLanguage}
        onTargetLanguage={setTargetLanguage}
        editorLanguage={editorContext?.language || ''}
        busy={status !== 'idle'}
      />

      <AIChat
        activeAction={activeAction}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        status={status}
        messages={messages}
        wantsErrorField={ERROR_ACTIONS.has(activeAction) && activeAction === 'debug'}
        isCodeAction={CODE_ACTIONS.has(activeAction)}
      />
    </main>
  );
}
