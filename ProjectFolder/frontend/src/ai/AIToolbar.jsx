/**
 * Action tabs, plus the controls that did not exist before: a language selector
 * and, for conversions, a target-language selector.
 *
 * Their absence was the structural half of the reported bug. With no way to say
 * "Java" in the UI, the page had nothing to send, so a literal "javascript" was
 * baked into every call site. A dropdown is the honest fix; the free-text
 * escape hatch ("Other") covers the languages the assistant can discuss but the
 * IDE cannot run.
 */

const ACTIONS = [
  { id: 'chat', label: 'Chat' },
  { id: 'explain', label: 'Explain Code' },
  { id: 'generate', label: 'Generate Code' },
  { id: 'error', label: 'Analyze Error' },
  { id: 'debug', label: 'Debug' },
  { id: 'tests', label: 'Generate Tests' },
  { id: 'optimize', label: 'Optimize' },
  { id: 'convert', label: 'Convert' },
  { id: 'document', label: 'Documentation' }
];

/** The five SyncSpace runs, then the rest it can still write. */
const LANGUAGES = [
  { id: '', label: 'Auto-detect' },
  { id: 'java', label: 'Java' },
  { id: 'python', label: 'Python' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'swift', label: 'Swift' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'php', label: 'PHP' },
  { id: 'sql', label: 'SQL' },
  { id: 'bash', label: 'Bash' },
  { id: 'verilog', label: 'Verilog' }
];

export default function AIToolbar({
  activeAction,
  onAction,
  language,
  onLanguage,
  targetLanguage,
  onTargetLanguage,
  editorLanguage,
  busy = false
}) {
  return (
    <div className="ai-toolbar">
      <div className="ai-tools">
        {ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            className={activeAction === action.id ? 'ai-tool active' : 'ai-tool'}
            onClick={() => onAction(action.id)}
            /* Switching tabs mid-answer is harmless and useful; only the send
               button is gated while a request runs. */
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="ai-lang-bar">
        <label className="ai-lang">
          <span>Language</span>
          <select value={language} onChange={(e) => onLanguage(e.target.value)} disabled={busy}>
            {LANGUAGES.map((l) => (
              <option key={l.id || 'auto'} value={l.id}>{l.label}</option>
            ))}
          </select>
        </label>

        {activeAction === 'convert' && (
          <label className="ai-lang">
            <span>Convert to</span>
            <select
              value={targetLanguage}
              onChange={(e) => onTargetLanguage(e.target.value)}
              disabled={busy}
            >
              {LANGUAGES.map((l) => (
                <option key={l.id || 'auto'} value={l.id}>
                  {l.id ? l.label : 'Ask me'}
                </option>
              ))}
            </select>
          </label>
        )}

        {editorLanguage && (
          <span className="ai-lang-hint" title="Taken from the workspace editor when you opened SyncSpace AI">
            editor: {LANGUAGES.find((l) => l.id === editorLanguage)?.label || editorLanguage}
          </span>
        )}
      </div>
    </div>
  );
}
