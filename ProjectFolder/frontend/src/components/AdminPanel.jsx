import { useState } from 'react';

const timeAgo = (iso) => {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  return `${Math.floor(secs / 3600)} h ago`;
};

/**
 * Everything the administrator can do, in one drawer. Rendered only for admins —
 * but note that hiding the UI is NOT the security boundary. Every action below is
 * re-authorised on the server from the signed token, so a member who forges the
 * socket event still gets refused.
 */
export default function AdminPanel({
  workspaceId,
  workspace,
  pendingRequests,
  peers,
  admin,
  onClose,
  toast
}) {
  const [busy, setBusy] = useState(null);
  const mode = workspace?.permissionMode || 'permission';
  const members = workspace?.members || [];

  const run = async (key, fn, successMsg) => {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (res.ok) toast(successMsg, 'success');
    else toast(res.message || 'That did not work.', 'error');
  };

  return (
    <aside className="admin-panel">
      <div className="admin-head">
        <h2>Workspace settings</h2>
        <button className="icon-btn" onClick={onClose} title="Close">&#10005;</button>
      </div>

      {/* -------- join requests -------- */}
      <section className="admin-section">
        <h3>
          Join requests
          {pendingRequests.length > 0 && <span className="badge">{pendingRequests.length}</span>}
        </h3>

        {pendingRequests.length === 0 ? (
          <p className="empty">
            {mode === 'password'
              ? 'This workspace is in password mode, so nobody needs approval right now.'
              : 'Nobody is waiting.'}
          </p>
        ) : (
          <ul className="request-list">
            {pendingRequests.map((r) => (
              <li key={r.requestId} className="request">
                <div className="request-info">
                  <strong>{r.username}</strong>
                  <span className="request-meta">
                    {timeAgo(r.requestedAt)} · {workspaceId} · pending
                  </span>
                </div>
                <div className="request-actions">
                  <button
                    className="btn-approve"
                    disabled={busy === r.requestId}
                    onClick={() => run(r.requestId, () => admin.approve(r.requestId), `${r.username} approved.`)}
                  >
                    Approve
                  </button>
                  <button
                    className="btn-reject"
                    disabled={busy === r.requestId}
                    onClick={() => run(r.requestId, () => admin.reject(r.requestId), `${r.username} rejected.`)}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* -------- access policy -------- */}
      <section className="admin-section">
        <h3>Access policy</h3>
        <div className="mode-toggle">
          <button
            className={'mode' + (mode === 'permission' ? ' active' : '')}
            disabled={busy === 'policy'}
            onClick={() => run('policy', () => admin.setPolicy('permission'), 'Now approving every joiner by hand.')}
          >
            <strong>Permission based</strong>
            <span>Every joiner waits for your approval.</span>
          </button>
          <button
            className={'mode' + (mode === 'password' ? ' active' : '')}
            disabled={busy === 'policy'}
            onClick={() => run('policy', () => admin.setPolicy('password'), 'Correct code now grants immediate access.')}
          >
            <strong>Join using password</strong>
            <span>Correct code, immediate access.</span>
          </button>
        </div>
        <p className="empty tight">
          Changing this affects only future joiners. People already inside stay
          connected, and anyone already waiting stays waiting until you decide.
        </p>
      </section>

      {/* -------- members -------- */}
      <section className="admin-section">
        <h3>Members <span className="badge muted">{members.length}</span></h3>
        <ul className="member-list">
          {members.map((m) => {
            const online = peers.some((p) => p.name === m.username);
            return (
              <li key={m.userId} className="member">
                <span className={'presence ' + (online ? 'on' : 'off')} />
                <span className="member-name">{m.username}</span>
                {m.role === 'admin' ? (
                  <span className="tag admin">admin</span>
                ) : (
                  <button
                    className="btn-remove"
                    disabled={busy === m.userId}
                    onClick={() => run(m.userId, () => admin.removeUser(m.userId), `${m.username} removed.`)}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* -------- info -------- */}
      <section className="admin-section">
        <h3>Workspace</h3>
        <div className="kv"><span>ID</span><code>{workspaceId}</code></div>
        <div className="kv"><span>Name</span><span>{workspace?.name || '—'}</span></div>
        <div className="kv"><span>Admin</span><span>{workspace?.adminUsername || '—'}</span></div>
        <div className="kv"><span>Online now</span><span>{peers.length}</span></div>
        <button
          className="btn-copy"
          onClick={() => {
            navigator.clipboard?.writeText(workspaceId);
            toast('Workspace ID copied.', 'success');
          }}
        >
          Copy workspace ID
        </button>
      </section>
    </aside>
  );
}
