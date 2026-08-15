import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router';
import { useCollaboration } from '../hooks/useCollaboration';
import { useToasts } from '../hooks/useToasts';
import { loadSession, clearSession, saveAiContext } from '../utils/session';
import Canvas from '../components/Canvas.jsx';
import Editor from '../components/Editor.jsx';
import AdminPanel from '../components/AdminPanel.jsx';
import ReplaySlider from '../components/ReplaySlider.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import { Toaster } from '../components/Toast.jsx';

export default function Workspace() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const session = loadSession(workspaceId);

  const [panelOpen, setPanelOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [chatPopups, setChatPopups] = useState([]);
  const { toasts, toast, dismiss } = useToasts();

  const {
    ydoc,
    awareness,
    connected,
    peers,
    pendingRequests,
    workspace,
    fatal,
    admin,
    replay
  } = useCollaboration(workspaceId, session);

  const isAdmin = session?.role === 'admin';

  const handleDeleteWorkspace = async () => {
    if (!session?.token) return false;
    if (!window.confirm(`Delete "${workspace?.name || 'this workspace'}"? Everyone will lose access immediately.`)) {
      return false;
    }

    try {
      await api.deleteWorkspace(workspaceId, session.token);
      clearSession(workspaceId);
      toast('Workspace deleted.', 'success');
      navigate('/dashboard', { replace: true });
      return true;
    } catch (err) {
      toast(err.message || 'Could not delete this workspace.', 'error');
      return false;
    }
  };

  // No token in this tab -> you were never let in. Do not render the editor at all.
  useEffect(() => {
    if (!session) navigate('/join', { replace: true });
  }, [session, navigate]);

  // Brand-new workspace: show the admin the ID they need to share.
  useEffect(() => {
    if (location.state?.justCreated) {
      toast(`Workspace ${workspaceId} created. Share this ID with your team.`, 'success');
    }
  }, [location.state, workspaceId, toast]);

  // ---- Always-active chat messages observer (even when ChatPanel is closed) ----
  const prevChatCount = useRef(0);
  const me = session?.username || 'anon';

  useEffect(() => {
    if (!ydoc) return;
    const messagesArr = ydoc.getArray('chatMessages');

    const sync = () => {
      const arr = messagesArr.toArray();
      const prevCount = prevChatCount.current;

      if (prevCount > 0 && arr.length > prevCount) {
        const newMsgs = arr.slice(prevCount);
        for (const msg of newMsgs) {
          if (msg.username !== me) {
            setChatUnread((n) => n + 1);
            if (!chatOpen) {
              const popupId = Date.now() + '-' + Math.random().toString(36).slice(2, 5);
              const popup = { id: popupId, username: msg.username, color: msg.color, text: msg.text, role: msg.role };
              setChatPopups((prev) => [...prev.slice(-2), popup]);
              setTimeout(() => {
                setChatPopups((prev) => prev.filter((p) => p.id !== popupId));
              }, 5000);
            }
          }
        }
      }
      prevChatCount.current = arr.length;
    };

    sync();
    messagesArr.observe(sync);
    return () => messagesArr.unobserve(sync);
  }, [ydoc, me, chatOpen]);

  // Someone new is waiting — make sure the admin actually notices.
  useEffect(() => {
    if (isAdmin && pendingRequests.length > 0) setPanelOpen(true);
  }, [isAdmin, pendingRequests.length]);

  if (!session) return null;

  // Removed, closed, or expired: the socket refused us. Say so honestly.
  if (fatal) {
    return (
      <div className="centered">
        <div className="card">
          <div className="state-icon denied">&#10005;</div>
          <h1>Access ended</h1>
          <p className="sub">{fatal}</p>
          <button
            className="btn block"
            onClick={() => {
              clearSession(workspaceId);
              navigate('/');
            }}
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  if (!ydoc) {
    return (
      <div className="centered">
        <div className="card">
          <div className="spinner" />
          <h1>Opening workspace…</h1>
          <p className="sub mono">{workspaceId}</p>
        </div>
      </div>
    );
  }

  const mode = workspace?.permissionMode;

  return (
    <div className="workspace">
      <header className="topbar">
        <Link to="/" className="brand">SyncSpace</Link>

        <span className="ws-name">{workspace?.name || 'Workspace'}</span>
        <code className="ws-id">{workspaceId}</code>

        {mode && (
          <span className={'policy-chip ' + mode}>
            {mode === 'permission' ? 'Approval required' : 'Password only'}
          </span>
        )}

        <span className={'dot ' + (connected ? 'on' : 'off')} />
        <span className="status">{connected ? 'connected' : 'reconnecting…'}</span>

        <div className="peers">
          {peers.map((p) => (
            <span key={p.clientId} className="peer" style={{ background: p.color }}>
              {p.name}
              {p.role === 'admin' && <span className="peer-crown">★</span>}
            </span>
          ))}
        </div>

        <button
          className="admin-btn"
          onClick={() => setReplayOpen(true)}
          disabled={!connected}
          title="Scrub backward through this session's history"
        >
          Replay
        </button>

        {isAdmin && (
          <button className="admin-btn" onClick={() => setPanelOpen((o) => !o)}>
            Admin
            {pendingRequests.length > 0 && (
              <span className="badge pulse">{pendingRequests.length}</span>
            )}
          </button>
        )}

        <button
          className={'chat-btn' + (chatOpen ? ' active' : '')}
          onClick={() => {
            setChatOpen((o) => !o);
            if (!chatOpen) {
              setChatUnread(0);
              setChatPopups([]);
            }
          }}
          title="Workspace chat"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 10 C3 5 6 2 10 2 C14 2 17 5 17 10 C17 15 14 18 10 18 C8 18 6 17 5 16 L3 17 L4 15 C3.5 14 3 12 3 10 Z" />
          </svg>
          Chat
          {chatUnread > 0 && !chatOpen && (
            <span className="badge pulse chat-badge">{chatUnread}</span>
          )}
        </button>
        <button
          className="ai-workspace-btn"
          onClick={() => {
            // Hand the editor's CURRENT language to the AI page. Without this
            // the AI page had no idea what the user was working in, which is
            // why it used to fall back to a hardcoded "javascript".
            try {
              const meta = ydoc.getMap('editorMeta');
              saveAiContext(workspaceId, {
                language: meta.get('language') || '',
                filename: meta.get('filename') || ''
              });
            } catch {
              /* no shared doc yet: the AI page falls back to auto-detect */
            }
            navigate(`/workspace/${workspaceId}/ai`);
          }}
          title="Open SyncSpace AI"
        >
          ✦ AI
        </button>
        <button
          className="leave-btn"
          onClick={() => {
            clearSession(workspaceId);
            navigate('/');
          }}
        >
          Leave
       </button>
      </header>

      <main className={'split' + (panelOpen ? ' with-panel' : '')}>
        <Canvas ydoc={ydoc} awareness={awareness} />
        <Editor ydoc={ydoc} awareness={awareness} workspaceId={workspaceId} session={session} />

        {isAdmin && panelOpen && (
          <AdminPanel
            workspaceId={workspaceId}
            workspace={workspace}
            pendingRequests={pendingRequests}
            peers={peers}
            admin={admin}
            onClose={() => setPanelOpen(false)}
            toast={toast}
          />
        )}
      </main>

      {/* Replay is an overlay, not a pane: it must not reflow the live board
          behind it, and it renders its OWN reconstructed document, so the
          collaborative canvas keeps running untouched underneath. */}
      {replayOpen && (
        <ReplaySlider
          workspaceId={workspaceId}
          fetchLogs={replay.fetchLogs}
          onClose={() => setReplayOpen(false)}
        />
      )}

      {chatOpen && (
        <ChatPanel
          ydoc={ydoc}
          awareness={awareness}
          session={session}
          onClose={() => setChatOpen(false)}
        />
      )}

      {/* Instagram-style chat popups */}
      {chatPopups.length > 0 && !chatOpen && (
        <div className="chat-popup-container">
          {chatPopups.map((popup) => (
            <div
              key={popup.id}
              className="chat-popup"
              onClick={() => {
                setChatOpen(true);
                setChatUnread(0);
                setChatPopups([]);
              }}
            >
              <div className="chat-popup-avatar" style={{ background: popup.color }}>
                {popup.username.charAt(0).toUpperCase()}
              </div>
              <div className="chat-popup-body">
                <div className="chat-popup-name">{popup.username}</div>
                <div className="chat-popup-text">
                  {popup.text.length > 50 ? popup.text.slice(0, 50) + '…' : popup.text}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Toaster toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

