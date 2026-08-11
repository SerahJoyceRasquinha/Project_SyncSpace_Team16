import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { MonacoBinding } from 'y-monaco';
import { api } from '../utils/api.js';
import '../monaco-setup'; // must run before the editor mounts

/**
 * The collaborative IDE pane.
 *
 * Collaboration model (all shared state lives in the SAME ydoc the canvas uses,
 * so it syncs over the existing socket relay and persists in the same snapshot):
 *
 *   - ydoc.getText('monaco')        the code buffer (y-monaco binding, as before)
 *   - ydoc.getMap('editorMeta')     'language' — the active language, shared so
 *                                   everyone's editor + dropdown switch together
 *   - ydoc.getArray('runHistory')   the console: every run result is appended
 *                                   here (capped), so ALL collaborators see the
 *                                   same output, live, and it survives reloads
 *
 * Execution is a plain authenticated POST to the backend's execution service —
 * the socket layer is untouched, and only workspace members can run code.
 *
 * The stdin box is local (each user experiments with their own input); the
 * results that come back are shared, tagged with who ran them.
 *
 * Two things the shared console has to respect:
 *   1. a run result is replicated to every peer AND persisted, so the raw 64 KB
 *      a program may emit is trimmed to SHARED_STREAM_CAP before it goes into
 *      the ydoc — otherwise one print-loop bloats the snapshot for everyone;
 *   2. long output is collapsed in the DOM behind "show all", so a 8 000-line
 *      result cannot lock up the browser.
 */

/**
 * Used only until the server's catalog arrives (or if it never does). Matches
 * the backend registry exactly — same ids, same Monaco grammar names.
 * `available: true` is optimistic: the real answer comes from /execute/languages.
 */
const FALLBACK_LANGUAGES = [
  { id: 'javascript', label: 'JavaScript (Node)', monaco: 'javascript', extension: '.js', available: true },
  { id: 'python', label: 'Python 3', monaco: 'python', extension: '.py', available: true },
  { id: 'c', label: 'C (gcc)', monaco: 'c', extension: '.c', available: true },
  { id: 'cpp', label: 'C++ (g++)', monaco: 'cpp', extension: '.cpp', available: true },
  { id: 'java', label: 'Java', monaco: 'java', extension: '.java', available: true }
];

const HISTORY_CAP = 20;
/** Per stream, per entry, before it is written into the shared document. */
const SHARED_STREAM_CAP = 8 * 1024;
/** How much of a block is shown before the "show all" toggle appears. */
const PREVIEW_CHARS = 1500;

const DEFAULT_STARTER =
  '// SyncSpace IDE\n// Everyone in this room shares this file. Pick a language, hit Run.\n';

/** Trim one stream for the shared doc, telling the reader it was trimmed. */
function capForShare(text) {
  if (typeof text !== 'string' || text.length <= SHARED_STREAM_CAP) return text || '';
  return (
    text.slice(0, SHARED_STREAM_CAP) +
    `\n… ${text.length - SHARED_STREAM_CAP} more characters not shown (output trimmed before sharing)`
  );
}

export default function Editor({ ydoc, awareness, workspaceId, session }) {
  const bindingRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);

  const meta = useMemo(() => ydoc.getMap('editorMeta'), [ydoc]);
  const runHistory = useMemo(() => ydoc.getArray('runHistory'), [ydoc]);

  const [languages, setLanguages] = useState(FALLBACK_LANGUAGES);
  const [provider, setProvider] = useState('');
  const [language, setLanguage] = useState(meta.get('language') || 'javascript');
  const [history, setHistory] = useState([]);
  const [runningNow, setRunningNow] = useState(false);
  const [stdin, setStdin] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [autoClear, setAutoClear] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const [theme, setTheme] = useState('vs-dark');
  const [fullscreen, setFullscreen] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [consoleHeight, setConsoleHeight] = useState(180);
  const consoleRef = useRef(null);
  const dragRef = useRef(null);

  // A ref, not the state flag: two Ctrl+Enter presses inside one React batch
  // both read the OLD `runningNow`, so the state guard alone let duplicate
  // executions through. The ref flips synchronously.
  const runningRef = useRef(false);
  const abortRef = useRef(null);
  const languagesRef = useRef(languages);
  useEffect(() => { languagesRef.current = languages; }, [languages]);

  const active = languages.find((l) => l.id === language);
  const unavailable = active ? active.available === false : false;

  // ---- ask the server which toolchains it actually has ------------------
  useEffect(() => {
    let alive = true;
    api.languages(workspaceId, session?.token)
      .then((d) => {
        if (!alive) return;
        if (d.languages?.length) setLanguages(d.languages);
        // Code executes in a remote sandbox; nothing is compiled on this
        // machine or on the server, so surface which service is doing it.
        const reachable = d.providers?.probed?.find((x) => x.reachable);
        setProvider(reachable?.label || d.providers?.configured?.[0] || '');
      })
      .catch(() => {}); // offline / old backend: fall back to the static list
    return () => { alive = false; };
  }, [workspaceId, session?.token]);

  // ---- shared language: observe the meta map ---------------------------
  useEffect(() => {
    const sync = () => {
      const l = meta.get('language') || 'javascript';
      setLanguage(l);
      const model = editorRef.current?.getModel();
      const monaco = monacoRef.current;
      const def = languages.find((x) => x.id === l);
      // syntax highlighting follows the dropdown for EVERY collaborator
      if (model && monaco && def) monaco.editor.setModelLanguage(model, def.monaco);
    };
    meta.observe(sync);
    sync();
    return () => meta.unobserve(sync);
  }, [meta, languages]);

  /** Is the buffer still an untouched template (or empty)? */
  const isTemplate = useCallback((text) => {
    const t = (text || '').trim();
    if (!t) return true;
    if (t === DEFAULT_STARTER.trim()) return true;
    return languagesRef.current.some((l) => (l.starter || '').trim() === t);
  }, []);

  const changeLanguage = (id) => {
    const def = languagesRef.current.find((l) => l.id === id);
    ydoc.transact(() => {
      meta.set('language', id); // shared: switches for everyone
      // Swap in the new language's template only while nobody has written
      // anything yet — never destroy real work to "help".
      const ytext = ydoc.getText('monaco');
      if (def?.starter && isTemplate(ytext.toString())) {
        ytext.delete(0, ytext.length);
        ytext.insert(0, def.starter);
      }
    });
  };

  // ---- shared console: observe the run history -------------------------
  useEffect(() => {
    const sync = () => setHistory(runHistory.toArray());
    runHistory.observe(sync);
    sync();
    return () => runHistory.unobserve(sync);
  }, [runHistory]);

  useEffect(() => {
    // keep the newest result in view
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, runningNow]);

  // ---- mount: bind Yjs, register cursor + shortcuts --------------------
  const handleMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const ytext = ydoc.getText('monaco');
    if (ytext.length === 0) {
      const id = meta.get('language') || 'javascript';
      const def = languagesRef.current.find((x) => x.id === id);
      ytext.insert(0, def?.starter || DEFAULT_STARTER);
    }

    bindingRef.current = new MonacoBinding(ytext, editor.getModel(), new Set([editor]), awareness);

    const def = languagesRef.current.find((x) => x.id === (meta.get('language') || 'javascript'));
    if (def) monaco.editor.setModelLanguage(editor.getModel(), def.monaco);

    editor.onDidChangeCursorPosition((e) =>
      setCursor({ line: e.position.lineNumber, col: e.position.column }));

    // Ctrl/Cmd+Enter runs — the muscle-memory shortcut of every online IDE
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    // Ctrl/Cmd+G — go to line (find/replace ship with Monaco on Ctrl+F/H)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () =>
      editor.getAction('editor.action.gotoLine')?.run());
  };

  useEffect(() => () => {
    bindingRef.current?.destroy();
    abortRef.current?.abort(); // never leave a request running after unmount
  }, []);

  // ---- run --------------------------------------------------------------
  const appendResult = useCallback((entry) => {
    ydoc.transact(() => {
      runHistory.push([entry]);
      if (runHistory.length > HISTORY_CAP) runHistory.delete(0, runHistory.length - HISTORY_CAP);
    });
  }, [ydoc, runHistory]);

  const clearConsole = useCallback(() => {
    ydoc.transact(() => runHistory.delete(0, runHistory.length));
  }, [ydoc, runHistory]);

  const run = useCallback(async () => {
    if (runningRef.current) return; // synchronous re-entrancy guard
    const code = editorRef.current?.getValue() ?? '';
    const def = languagesRef.current.find((l) => l.id === language);

    const stamp = () => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      by: session?.username || 'someone',
      language
    });

    // Refuse locally for the two cases the server would only repeat back, so
    // nothing in the dropdown can ever produce an "unsupported language" error.
    if (def && def.available === false) {
      appendResult({ ...stamp(), ok: false, phase: 'setup', stderr: def.note || `${def.label} is not installed on this server.` });
      return;
    }
    if (!code.trim()) {
      appendResult({ ...stamp(), ok: false, phase: 'setup', stderr: 'There is no code to run.' });
      return;
    }

    runningRef.current = true;
    setRunningNow(true);
    if (autoClear) clearConsole();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { result } = await api.execute(
        workspaceId, session?.token,
        { language, code, stdin },
        { signal: controller.signal }
      );
      appendResult({
        ...stamp(),
        ...result,
        stdout: capForShare(result?.stdout),
        stderr: capForShare(result?.stderr),
        compileOutput: capForShare(result?.compileOutput)
      });
    } catch (err) {
      // Network failure, timeout, 429, auth — all end up here as one readable
      // line. The editor itself keeps working either way.
      appendResult({ ...stamp(), ok: false, phase: 'setup', stderr: err.message });
    } finally {
      abortRef.current = null;
      runningRef.current = false;
      setRunningNow(false);
    }
  }, [language, stdin, autoClear, workspaceId, session, appendResult, clearConsole]);

  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  // ---- console resize (drag the divider) --------------------------------
  const onDividerDown = (e) => {
    e.preventDefault();
    dragRef.current = { y: e.clientY, h: consoleHeight };
    const move = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      setConsoleHeight(Math.min(420, Math.max(80, d.h + (d.y - ev.clientY))));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const langLabel = active?.label || language;

  return (
    <div className={'pane editor-pane' + (fullscreen ? ' fullscreen' : '')}>
      <div className="pane-header editor-header">
        <span>Code Editor</span>

        <select
          className="lang-select"
          value={language}
          onChange={(e) => changeLanguage(e.target.value)}
          title="Language (shared with everyone in the room)"
        >
          {languages.map((l) => (
            <option key={l.id} value={l.id} disabled={l.available === false}>
              {l.label}{l.available === false ? ' — unavailable' : ''}
            </option>
          ))}
        </select>

        <button
          className="run-btn"
          onClick={run}
          disabled={runningNow || unavailable}
          title={unavailable ? (active?.note || 'This toolchain is not installed on the server.') : 'Run (Ctrl+Enter)'}
        >
          {runningNow ? <span className="run-spinner" /> : '▶'} {runningNow ? 'Running…' : 'Run'}
        </button>

        <button
          className={'ed-btn' + (showInput ? ' on' : '')}
          onClick={() => setShowInput((v) => !v)}
          title="Program input (stdin)"
        >stdin</button>

        <div className="ed-spacer" />

        <button className={'ed-btn' + (wordWrap ? ' on' : '')}
          onClick={() => setWordWrap((v) => !v)} title="Word wrap">↩</button>
        <button className="ed-btn"
          onClick={() => setTheme((t) => (t === 'vs-dark' ? 'light' : 'vs-dark'))}
          title="Toggle editor theme">◐</button>
        <button className="ed-btn" onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen editor'}>
          {fullscreen ? '⤡' : '⤢'}
        </button>
      </div>

      {unavailable && (
        <div className="editor-warn">
          {active?.note || `${langLabel} is not installed on this server.`}
        </div>
      )}

      <div className="editor-body">
        <MonacoEditor
          height="100%"
          theme={theme}
          onMount={handleMount}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            automaticLayout: true,
            wordWrap: wordWrap ? 'on' : 'off',
            folding: true,
            lineNumbers: 'on',
            bracketPairColorization: { enabled: true },
            autoIndent: 'full',
            wordBasedSuggestions: 'currentDocument',
            scrollBeyondLastLine: false
          }}
        />
      </div>

      {showInput && (
        <div className="stdin-wrap">
          <label className="stdin-label">stdin — sent to your program when you press Run</label>
          <textarea
            className="stdin-box"
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
            placeholder="Type input for your program here…"
            spellCheck={false}
          />
        </div>
      )}

      <div className="console-divider" onMouseDown={onDividerDown} title="Drag to resize" />

      <div className="console" style={{ height: consoleHeight }}>
        <div className="console-head">
          <span>Output</span>
          <span className="console-lang">{langLabel}{provider ? ` · runs on ${provider}` : ''}</span>
          <div className="ed-spacer" />
          <button
            className={'ed-btn' + (autoClear ? ' on' : '')}
            onClick={() => setAutoClear((v) => !v)}
            title="Clear the console automatically before each run"
          >auto-clear</button>
          <button className="ed-btn" onClick={clearConsole}
            disabled={!history.length} title="Clear output for everyone">Clear</button>
        </div>
        <div className="console-scroll" ref={consoleRef}>
          {!history.length && !runningNow && (
            <div className="console-empty">
              Press <b>Run</b> (or Ctrl+Enter) to execute the code. Output appears here
              for everyone in the room.
            </div>
          )}
          {history.map((r) => <RunResult key={r.id} r={r} />)}
          {runningNow && (
            <div className="console-running">
              {active?.compiled ? 'compiling and running…' : 'running…'}
            </div>
          )}
        </div>
      </div>

      <div className="editor-footer">
        <span>Ln {cursor.line}, Col {cursor.col}</span>
        <span className="ed-hints">Ctrl+Enter run · Ctrl+F find · Ctrl+H replace · Ctrl+G go to line</span>
      </div>
    </div>
  );
}

/** A long stream, collapsed until asked for — a 60 000-line dump must not stall the tab. */
function OutputBlock({ text, className }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > PREVIEW_CHARS;
  const shown = long && !open ? text.slice(0, PREVIEW_CHARS) : text;
  return (
    <>
      <pre className={className}>{shown}{long && !open ? '…' : ''}</pre>
      {long && (
        <button className="run-more" onClick={() => setOpen((v) => !v)}>
          {open ? 'show less' : `show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </>
  );
}

/** One entry in the shared console. Identical for every language and provider. */
function RunResult({ r }) {
  const time = new Date(r.at).toLocaleTimeString();

  // Driven entirely by the canonical `status` field, so the panel looks and
  // behaves the same whether the code ran on Judge0, Piston or paiza.io.
  const status =
    r.status === 'ok' ? 'finished'
      : r.status === 'compile_error' ? 'compile error'
        : r.status === 'timeout' ? 'timed out'
          : r.status === 'runtime_error'
            ? (r.signal ? `crashed (${r.signal})` : `exit ${r.exitCode}`)
            : r.status === 'rate_limited' ? 'rate limited'
              : r.status === 'unavailable' ? 'service unavailable'
                : r.status === 'invalid_request' ? 'not run'
                  : 'error';

  return (
    <div className={'run-entry' + (r.ok ? ' ok' : ' fail')}>
      <div className="run-meta">
        <span className={'run-status' + (r.ok ? ' ok' : ' fail')}>{status}</span>
        <span>{r.language}</span>
        {r.providerLabel && <span className="run-provider">{r.providerLabel}</span>}
        {typeof r.durationMs === 'number' && <span>{r.durationMs} ms</span>}
        {r.memoryKb > 0 && <span>{Math.round(r.memoryKb / 1024)} MB</span>}
        {r.queuedMs > 50 && <span>queued {Math.round(r.queuedMs)} ms</span>}
        {r.attempts > 1 && <span>{r.attempts} providers tried</span>}
        <span className="run-by">{r.by} · {time}</span>
      </div>

      {r.warnings?.map((w, i) => <div className="run-warn" key={i}>{w}</div>)}
      {!r.ok && r.statusText && <div className="run-note">{r.statusText}</div>}

      <OutputBlock text={r.compileOutput} className="run-block compile" />
      <OutputBlock text={r.stdout} className="run-block" />
      <OutputBlock text={r.stderr} className="run-block err" />
      {!r.stdout && !r.stderr && !r.compileOutput && (
        <pre className="run-block muted">(no output)</pre>
      )}
      {r.truncated && <div className="run-note">output was truncated at 64 KB</div>}
    </div>
  );
}
