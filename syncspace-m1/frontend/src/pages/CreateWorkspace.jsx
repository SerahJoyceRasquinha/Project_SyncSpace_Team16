import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { saveSession } from '../utils/session';

export default function CreateWorkspace() {
  const [form, setForm] = useState({
    name: '',
    password: '',
    username: '',
    permissionMode: 'permission'
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const { workspace, token } = await api.createWorkspace(form);
      // The creator IS the administrator — straight into the workspace, no join step.
      saveSession(workspace.workspaceId, {
        token,
        username: form.username.trim(),
        role: 'admin'
      });
      navigate(`/workspace/${workspace.workspaceId}`, {
        state: { justCreated: true, secret: form.password }
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <div className="card wide">
        <Link to="/" className="back">&larr; Back</Link>
        <h1>Create a workspace</h1>
        <p className="sub">You will be its administrator.</p>

        {error && <div className="alert error">{error}</div>}

        <label>Workspace name</label>
        <input
          value={form.name}
          onChange={set('name')}
          placeholder="Design Review — Sprint 12"
          maxLength={60}
        />

        <label>Secret code</label>
        <input
          type="password"
          value={form.password}
          onChange={set('password')}
          placeholder="Anyone joining will need this"
          maxLength={128}
        />
        <p className="hint tight">
          Stored as a bcrypt hash. Nobody — including you — can read it back later,
          so write it down somewhere.
        </p>

        <label>Your username (administrator)</label>
        <input
          value={form.username}
          onChange={set('username')}
          placeholder="Serah"
          maxLength={24}
        />

        <label>Access policy</label>
        <div className="policy-picker">
          <button
            type="button"
            className={'policy' + (form.permissionMode === 'permission' ? ' active' : '')}
            onClick={() => setForm({ ...form, permissionMode: 'permission' })}
          >
            <span className="policy-title">Permission based</span>
            <span className="policy-desc">
              The correct code is not enough. Every joiner waits in a lobby until
              you personally approve them.
            </span>
          </button>

          <button
            type="button"
            className={'policy' + (form.permissionMode === 'password' ? ' active' : '')}
            onClick={() => setForm({ ...form, permissionMode: 'password' })}
          >
            <span className="policy-title">Join using password</span>
            <span className="policy-desc">
              Correct code, straight in. No waiting room, no approval.
            </span>
          </button>
        </div>
        <p className="hint tight">You can switch policy at any time from inside the workspace.</p>

        <button className="btn" onClick={submit} disabled={busy}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </div>
    </div>
  );
}
