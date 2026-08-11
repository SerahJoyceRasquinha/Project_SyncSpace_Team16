import { useEffect, useState, useCallback } from 'react';
import { api } from '../utils/api';
import { loadAccount, saveAccount, clearAccount } from '../utils/session';

/**
 * Account auth state (optional, powers the dashboard).
 *
 * A user may use SyncSpace entirely anonymously — accounts are an OPTIONAL
 * convenience that lets someone keep a list of the workspaces they belong to.
 * Because the account token only identifies WHO you are (it grants no
 * workspace access by itself, each workspace still issues its own token),
 * treating it as a normal React state that starts from localStorage is safe.
 */
export function useAuth() {
  const [account, setAccount] = useState(() => loadAccount());
  const [ready, setReady] = useState(false);

  // On mount, re-validate a stored token against /auth/me. If it is stale we
  // quietly sign the user out rather than leaving a dead token in storage.
  useEffect(() => {
    let alive = true;
    (async () => {
      const stored = loadAccount();
      if (!stored?.token) {
        if (alive) setReady(true);
        return;
      }
      try {
        const data = await api.me(stored.token);
        if (!alive) return;
        const user = data.user || {};
        const fresh = { ...stored, username: user.username, email: user.email };
        saveAccount(fresh);
        setAccount(fresh);
      } catch {
        if (alive) {
          clearAccount();
          setAccount(null);
        }
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async ({ email, password }) => {
    const data = await api.login({ email, password });
    const u = data.user || {};
    const user = { token: data.token, username: u.username, email: u.email || email };
    saveAccount(user);
    setAccount(user);
    return user;
  }, []);

  const signup = useCallback(async ({ username, email, password }) => {
    const data = await api.signup({ username, email, password });
    const u = data.user || {};
    const user = { token: data.token, username: u.username || username, email: u.email || email };
    saveAccount(user);
    setAccount(user);
    return user;
  }, []);

  const logout = useCallback(() => {
    clearAccount();
    setAccount(null);
  }, []);

  return { account, ready, login, signup, logout };
}
