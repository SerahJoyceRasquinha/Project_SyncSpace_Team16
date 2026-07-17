import { useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useCollaboration } from '../hooks/useCollaboration';
import { useToasts } from '../hooks/useToasts';
import { loadSession, clearSession } from '../utils/session';
import Canvas from '../components/Canvas.jsx';
import Editor from '../components/Editor.jsx';
import AdminPanel from '../components/AdminPanel.jsx';
import { Toaster } from '../components/Toast.jsx';

export default function Workspace() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const session = loadSession(workspaceId);

  const [panelOpen, setPanelOpen] = useState(false);
  const { toasts, toast, dismiss } = useToasts();

  const {
    ydoc,
    awareness,
    connected,
    peers,
    pendingRequests,
    workspace,
    fatal,
    admin
  } = useCollaboration(workspaceId, session);

  const isAdmin = session?.role === 'admin';

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

        {isAdmin && (
          <button className="admin-btn" onClick={() => setPanelOpen((o) => !o)}>
            Admin
            {pendingRequests.length > 0 && (
              <span className="badge pulse">{pendingRequests.length}</span>
            )}
          </button>
        )}

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

      <Toaster toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
