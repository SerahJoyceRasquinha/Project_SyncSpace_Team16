import bcrypt from 'bcryptjs';
import { createUser, findUserByEmail, findUserById } from './userStore.js';
import { findWorkspacesByUser } from './workspaceStore.js';
import { newId } from '../utils/ids.js';
import { signUserToken } from '../utils/token.js';
import { rateLimit } from '../utils/validate.js';

/**
 * User-account business rules. Completely separate from the per-workspace
 * access-token system: an account proves WHO you are, a workspace token proves
 * you may collaborate in THAT room. Logging in never grants access to a room
 * by itself — membership is still checked server-side on every enter.
 */

const fail = (status, message) => ({ ok: false, status, message });

export function publicUser(u) {
  return {
    userId: u.userId,
    email: u.email,
    username: u.username,
    workspaces: u.workspaces || []
  };
}

export async function signup({ email, username, password }) {
  const existing = await findUserByEmail(email);
  if (existing) return fail(409, 'An account with that email already exists.');

  const userId = newId();
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUser({
    userId,
    email,
    username,
    passwordHash,
    workspaces: []
  });

  const token = signUserToken({ userId, email, username });
  return { ok: true, token, user: publicUser(user) };
}

export async function login({ email, password }) {
  const limited = rateLimit(`login:${email}`, { max: 12, windowMs: 60_000 });
  if (!limited.ok) return fail(429, limited.message);

  const user = await findUserByEmail(email);
  if (!user) return fail(401, 'Incorrect email or password.');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return fail(401, 'Incorrect email or password.');

  const token = signUserToken({ userId: user.userId, email: user.email, username: user.username });
  return { ok: true, token, user: publicUser(user) };
}

/** Full account read for /api/auth/me — includes the enriched workspace list. */
export async function getUser(userId) {
  const user = await findUserById(userId);
  if (!user) return fail(404, 'Account not found.');
  const workspaces = await findWorkspacesByUser(userId);
  return { ok: true, user: publicUser(user), workspaces };
}

