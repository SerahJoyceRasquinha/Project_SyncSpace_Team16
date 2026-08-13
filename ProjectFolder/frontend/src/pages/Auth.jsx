import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { useAuth } from '../hooks/useAuth';

/**
 * Combined login / sign-up page. Accounts are optional — they simply power the
 * dashboard, so a signed-in user can see every workspace they belong to and
 * re-open one with a single click. Anonymous usage keeps working unchanged.
 */
export default function Auth({ mode: initialMode = 'login' }) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { login, signup } = useAuth();
  const navigate = useNavigate();

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const switchMode = (m) => {
    setMode(m);
    setError('');
  };

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        await signup({
          username: form.username.trim(),
          email: form.email.trim(),
          password: form.password
        });
      } else {
        await login({ email: form.email.trim(), password: form.password });
      }
      navigate('/dashboard');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <div className="card">
        <Link to="/" className="back">&larr; Back</Link>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="sub">
          {mode === 'login'
            ? 'Sign in to see every SyncSpace workspace you belong to.'
            : 'Sign up to keep all your workspaces in one place.'}
        </p>

        {error && <div className="alert error">{error}</div>}

        {mode === 'signup' && (
          <>
            <label>Username</label>
            <input
              value={form.username}
              onChange={set('username')}
              placeholder="xyz"
              maxLength={24}
            />
          </>
        )}

        <label>Email</label>
        <input
          type="email"
          value={form.email}
          onChange={set('email')}
          placeholder="you@example.com"
          autoComplete="email"
        />

        <label>Password</label>
        <input
          type="password"
          value={form.password}
          onChange={set('password')}
          placeholder="Min 6 characters"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          onKeyDown={(e) => e.key === 'Enter' && !busy && submit()}
        />

        <button className="btn" onClick={submit} disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <p className="hint center-link">
          {mode === 'login' ? (
            <>New here? <button className="link-btn" onClick={() => switchMode('signup')}>Create an account</button></>
          ) : (
            <>Already have an account? <button className="link-btn" onClick={() => switchMode('login')}>Sign in</button></>
          )}
        </p>
        <p className="hint">
          Prefer to stay anonymous? You can still create or join workspaces
          without an account — you just won't get a dashboard.
        </p>
      </div>
    </div>
  );
}
