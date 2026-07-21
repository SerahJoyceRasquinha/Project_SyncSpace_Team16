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
 */

const FALLBACK_LANGUAGES = [
  { id: 'javascript', label: 'JavaScript (Node)', monaco: 'javascript' },
  { id: 'python', label: 'Python 3', monaco: 'python' },
  { id: 'java', label: 'Java', monaco: 'java' },
  { id: 'cpp', label: 'C++ (g++)', monaco: 'cpp' },
  { id: 'c', label: 'C (gcc)', monaco: 'c' }
];

const HISTORY_CAP = 20;

const STARTER = {
  javascript: '// SyncSpace IDE — JavaScript\n// Everyone in this room shares this file. Pick a language, hit Run.\n\nconst name = (require("fs").readFileSync(0, "utf8").trim()) || "world";\nconsole.log(`hello, ${name}`);\n',
  python: '# SyncSpace IDE — Python\nimport sys\nname = sys.stdin.read().strip() or "world"\nprint(f"hello, {name}")\n'
};

export default function Editor({ ydoc, awareness, workspaceId, session }) {
  const bindingRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);

  const meta = useMemo(() => ydoc.getMap('editorMeta'), [ydoc]);
  const runHistory = useMemo(() => ydoc.getArray('runHistory'), [ydoc]);

  const [languages, setLanguages] = useState(FALLBACK_LANGUAGES);
  const [language, setLanguage] = useState(meta.get('language') || 'javascript');
  const [history, setHistory] = useState([]);
  const [runningNow, setRunningNow] = useState(false);
  const [stdin, setStdin] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const [theme, setTheme] = useState('vs-dark');
  const [fullscreen, setFullscreen] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [consoleHeight, setConsoleHeight] = useState(180);
  const consoleRef = useRef(null);
  const dragRef = useRef(null);

  // ---- ask the server which toolchains it actually has ------------------
  useEffect(() => {
    let alive = true;
    api.languages(workspaceId, session?.token)
      .then((d) => { if (alive && d.languages?.length) setLanguages(d.languages); })
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
      if (model && monaco && def) monaco.editor.setModelLanguage(model, def.monaco);
    };
    meta.observe(sync);
    sync();
    return () => meta.unobserve(sync);
  }, [meta, languages]);

  const changeLanguage = (id) => {
    ydoc.transact(() => meta.set('language', id)); // shared: switches for everyone
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
    if (ytext.length === 0) ytext.insert(0, STARTER.javascript);

    bindingRef.current = new MonacoBinding(ytext, editor.getModel(), new Set([editor]), awareness);

    const def = languages.find((x) => x.id === (meta.get('language') || 'javascript'));
    if (def) monaco.editor.setModelLanguage(editor.getModel(), def.monaco);

    editor.onDidChangeCursorPosition((e) =>
      setCursor({ line: e.position.lineNumber, col: e.position.column }));

    // Ctrl/Cmd+Enter runs — the muscle-memory shortcut of every online IDE
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    // Ctrl/Cmd+G — go to line (find/replace ship with Monaco on Ctrl+F/H)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () =>
      editor.getAction('editor.action.gotoLine')?.run());
  };

  useEffect(() => () => bindingRef.current?.destroy(), []);

  // ---- run --------------------------------------------------------------
  const appendResult = useCallback((entry) => {
    ydoc.transact(() => {
      runHistory.push([entry]);
      if (runHistory.length > HISTORY_CAP) runHistory.delete(0, runHistory.length - HISTORY_CAP);
    });
  }, [ydoc, runHistory]);

  const run = useCallback(async () => {
    const code = editorRef.current?.getValue() ?? '';
    if (!code.trim() || runningNow) return;
    setRunningNow(true);
    try {
      const { result } = await api.execute(workspaceId, session?.token, {
        language, code, stdin
      });
      appendResult({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: Date.now(),
        by: session?.username || 'someone',
        ...result
      });
    } catch (err) {
      appendResult({
        id: `${Date.now()}-err`,
        at: Date.now(),
        by: session?.username || 'someone',
        ok: false,
        phase: 'setup',
        language,
        stderr: err.message
      });
    } finally {
      setRunningNow(false);
    }
  }, [language, stdin, runningNow, workspaceId, session, appendResult]);
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  const clearConsole = () => {
    ydoc.transact(() => runHistory.delete(0, runHistory.length));
  };

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

  const langLabel = languages.find((l) => l.id === language)?.label || language;

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
          {languages.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>

        <button className="run-btn" onClick={run} disabled={runningNow} title="Run (Ctrl+Enter)">
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
          <span className="console-lang">{langLabel}</span>
          <div className="ed-spacer" />
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
          {runningNow && <div className="console-running">running…</div>}
        </div>
      </div>

      <div className="editor-footer">
        <span>Ln {cursor.line}, Col {cursor.col}</span>
        <span className="ed-hints">Ctrl+Enter run · Ctrl+F find · Ctrl+H replace · Ctrl+G go to line</span>
      </div>
    </div>
  );
}

/** One entry in the shared console. */
function RunResult({ r }) {
  const time = new Date(r.at).toLocaleTimeString();
  const status =
    r.phase === 'compile' ? 'compile error'
    : r.phase === 'setup' ? 'error'
    : r.timedOut ? 'timed out'
    : r.exitCode === 0 ? 'finished'
    : `exit ${r.exitCode}`;

  return (
    <div className={'run-entry' + (r.ok ? ' ok' : ' fail')}>
      <div className="run-meta">
        <span className={'run-status' + (r.ok ? ' ok' : ' fail')}>{status}</span>
        <span>{r.language}</span>
        {typeof r.durationMs === 'number' && <span>{r.durationMs} ms</span>}
        {typeof r.exitCode === 'number' && r.phase === 'run' && <span>exit {r.exitCode}</span>}
        <span className="run-by">{r.by} · {time}</span>
      </div>
      {r.compileOutput && <pre className="run-block compile">{r.compileOutput}</pre>}
      {r.stdout && <pre className="run-block">{r.stdout}</pre>}
      {r.stderr && <pre className="run-block err">{r.stderr}</pre>}
      {!r.stdout && !r.stderr && !r.compileOutput && (
        <pre className="run-block muted">(no output)</pre>
      )}
      {r.truncated && <div className="run-note">output truncated at 64 KB</div>}
    </div>
  );
}
