import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import { api } from '../utils/api';
import { saveSession } from '../utils/session';

/**
 * The signed-in user's workspace dashboard. Lists every workspace the account
 * belongs to and lets them open one with a single click (no password needed —
 * the server re-checks membership directly).
 */
export default function Dashboard() {
  const { account, ready, logout } = useAuth();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(null);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    if (!ready) return;
    if (!account?.token) {
      navigate('/login');
      return;
    }
    let alive = true;
    (async () => {
      try {
        const data = await api.me(account.token);
        if (alive) setWorkspaces(data.workspaces || []);
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ready, account, navigate]);

  const open = async (item) => {
    if (!account?.token) return;
    const ws = item.workspace || item;
    const member = item.member || {};
    setOpening(ws.workspaceId);
    setError('');
    try {
      const res = await api.enterWorkspace(ws.workspaceId, account.token);
      saveSession(ws.workspaceId, {
        token: res.token,
        username: res.workspace?.adminUsername || account.username,
        role: member.role || (ws.adminUsername === account.username ? 'admin' : 'member')
      });
      navigate(`/workspace/${ws.workspaceId}`);
    } catch (err) {
      setError(err.message);
      setOpening(null);
    }
  };

  const membershipRole = (item) => (item.member?.role || item.role || 'member');

  const handleDelete = async (item) => {
    const ws = item.workspace || item;
    if (membershipRole(item) !== 'admin' || !account?.token || !window.confirm(`Delete "${ws.name}"? Everyone will lose access to it immediately.`)) {
      return;
    }

    setDeleting(ws.workspaceId);
    setError('');
    try {
      // Dashboard authentication identifies the account, but deletion requires
      // a workspace access token. Re-enter first so the server can verify this
      // account is still the administrator of this exact workspace.
      const access = await api.enterWorkspace(ws.workspaceId, account.token);
      await api.deleteWorkspace(ws.workspaceId, access.token);
      setWorkspaces((current) => current.filter((entry) => (entry.workspace || entry).workspaceId !== ws.workspaceId));
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(null);
    }
  };

  if (!ready) {
    return (
      <div className="centered">
        <div className="card">
          <div className="spinner" />
          <h1>Loading…</h1>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dash-head">
        <Link to="/" className="brand">SyncSpace</Link>
        <div className="dash-user">
          <span className="dash-greeting">Hi, {account?.username}</span>
          <button className="ed-btn" onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="dash-main">
        <div className="dash-title-row">
          <div>
            <h1>Your workspaces</h1>
            <p className="sub">Re-open any workspace you've joined with one click.</p>
          </div>
          <div className="dash-actions">
            <button className="landing-btn ghost" onClick={() => navigate('/create')}>
              + Create
            </button>
            <button className="landing-btn ghost" onClick={() => navigate('/join')}>
              Join
            </button>
          </div>
        </div>

        {error && <div className="alert error">{error}</div>}

        {loading ? (
          <div className="dash-loading"><div className="spinner" /></div>
        ) : workspaces.length === 0 ? (
          <div className="dash-empty">
            <p>No workspaces yet.</p>
            <p className="dash-empty-sub">
              Create a new one or join with an ID and secret code — it will show
              up here afterwards.
            </p>
          </div>
        ) : (
          <div className="dash-grid">
            {workspaces.map((item) => {
              const ws = item.workspace || item;
              return (
                <div key={ws.workspaceId} className="dash-card">
                  <div className="dash-card-head">
                    <span className="dash-card-name">{ws.name}</span>
                    <span className={'policy-chip ' + (ws.permissionMode || 'permission')}>
                      {ws.permissionMode === 'password' ? 'Password' : 'Approval'}
                    </span>
                  </div>
                  <code className="ws-id">{ws.workspaceId}</code>
                  <div className="dash-card-meta">
                    <span className="tag admin">{membershipRole(item)}</span>
                    <span>{(ws.members && ws.members.length) || ws.memberCount || 1} member(s)</span>
                  </div>
                  <div className="dash-card-actions">
                    <button
                      className="btn"
                      onClick={() => open(item)}
                      disabled={opening === ws.workspaceId}
                    >
                      {opening === ws.workspaceId ? 'Opening…' : 'Open workspace'}
                    </button>
                    {membershipRole(item) === 'admin' && (
                      <button
                        className="btn-remove danger"
                        onClick={() => handleDelete(item)}
                        disabled={deleting === ws.workspaceId}
                      >
                        {deleting === ws.workspaceId ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
