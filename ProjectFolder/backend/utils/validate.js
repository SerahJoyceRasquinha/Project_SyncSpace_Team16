/**
 * Input hardening. Every value that arrives from a browser passes through here
 * before it reaches the store.
 */

/** Strip control chars + angle brackets, collapse whitespace, cap length. */
export function clean(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .trim()
    .slice(0, max);
}

const USERNAME_RE = /^[A-Za-z0-9 ._-]{2,24}$/;

export function validateUsername(raw) {
  const username = clean(raw, 24);
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      message:
        'Username must be 2-24 characters and use only letters, numbers, spaces, dots, hyphens or underscores.'
    };
  }
  return { ok: true, username };
}

export function validateWorkspaceName(raw) {
  const name = clean(raw, 60);
  if (name.length < 3) {
    return { ok: false, message: 'Workspace name must be at least 3 characters.' };
  }
  return { ok: true, name };
}

export function validatePassword(raw) {
  const password = typeof raw === 'string' ? raw : '';
  if (password.length < 4 || password.length > 128) {
    return { ok: false, message: 'Secret code must be between 4 and 128 characters.' };
  }
  return { ok: true, password };
}

export function validateMode(raw) {
  if (raw !== 'permission' && raw !== 'password') {
    return { ok: false, message: 'Access policy must be "permission" or "password".' };
  }
  return { ok: true, permissionMode: raw };
}

export function validateWorkspaceId(raw) {
  const workspaceId = clean(raw, 20).toUpperCase();
  if (!/^WS-[A-Z0-9]{4,12}$/.test(workspaceId)) {
    return { ok: false, message: 'That does not look like a valid workspace ID.' };
  }
  return { ok: true, workspaceId };
}

/**
 * Dead-simple in-memory rate limiter, keyed by ip+workspace.
 * Stops someone brute-forcing a 4-character secret code.
 */
const attempts = new Map();

export function rateLimit(key, { max = 10, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  entry.count += 1;
  if (entry.count > max) {
    const wait = Math.ceil((entry.resetAt - now) / 1000);
    return { ok: false, message: `Too many attempts. Try again in ${wait} seconds.` };
  }
  return { ok: true };
}

export function clearRateLimit(key) {
  attempts.delete(key);
}
