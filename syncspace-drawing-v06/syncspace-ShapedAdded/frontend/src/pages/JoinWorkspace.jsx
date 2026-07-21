import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { saveSession, saveTicket } from '../utils/session';

export default function JoinWorkspace() {
  const [form, setForm] = useState({ workspaceId: '', password: '', username: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const submit = async () => {
    setError('');
    setBusy(true);
    const workspaceId = form.workspaceId.trim().toUpperCase();

    try {
      const res = await api.joinWorkspace(workspaceId, {
        username: form.username.trim(),
        password: form.password
      });

      if (res.status === 'approved') {
        // Password mode: the code was enough. Straight in.
        saveSession(workspaceId, {
          token: res.token,
          username: form.username.trim(),
          role: 'member'
        });
        navigate(`/workspace/${workspaceId}`);
        return;
      }

      // Permission mode: we hold a lobby ticket, not an access token.
      // It gets us into the waiting room and nowhere else.
      saveTicket({
        workspaceId,
        requestId: res.requestId,
        ticket: res.ticket,
        username: form.username.trim()
      });
      navigate(`/waiting/${workspaceId}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <div className="card">
        <Link to="/" className="back">&larr; Back</Link>
        <h1>Join a workspace</h1>
        <p className="sub">You will need the ID and the secret code from its administrator.</p>

        {error && <div className="alert error">{error}</div>}

        <label>Workspace ID</label>
        <input
          value={form.workspaceId}
          onChange={set('workspaceId')}
          placeholder="WS-7K2M9Q"
          className="mono-input"
          maxLength={20}
        />

        <label>Secret code</label>
        <input
          type="password"
          value={form.password}
          onChange={set('password')}
          placeholder="••••••••"
          maxLength={128}
        />

        <label>Your username</label>
        <input
          value={form.username}
          onChange={set('username')}
          placeholder="Thanushree"
          maxLength={24}
          onKeyDown={(e) => e.key === 'Enter' && !busy && submit()}
        />

        <button className="btn" onClick={submit} disabled={busy}>
          {busy ? 'Checking…' : 'Join'}
        </button>

        <p className="hint">
          Depending on how the administrator configured this workspace, you may be
          placed in a waiting room for approval.
        </p>
      </div>
    </div>
  );
}
