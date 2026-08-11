import { verifyToken } from '../utils/token.js';
import { findWorkspace, findMember } from '../services/workspaceStore.js';

/**
 * Requires a valid ACCESS token whose workspace matches :workspaceId,
 * AND whose user is still a member (so a removed user's token dies instantly).
 */
export async function requireMember(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'You are not signed in to this workspace.' });
  }

  const payload = verifyToken(token);
  if (!payload || payload.kind !== 'access') {
    return res.status(401).json({ error: 'Your session has expired. Please join again.' });
  }

  if (payload.workspaceId !== req.params.workspaceId) {
    return res.status(403).json({ error: 'That session does not belong to this workspace.' });
  }

  const workspace = await findWorkspace(payload.workspaceId);
  if (!workspace) {
    return res.status(404).json({ error: 'This workspace no longer exists.' });
  }
  if (workspace.status === 'closed') {
    return res.status(410).json({ error: 'This workspace has been closed by its administrator.' });
  }

  const member = findMember(workspace, payload.userId);
  if (!member) {
    return res.status(403).json({ error: 'You have been removed from this workspace.' });
  }

  req.workspace = workspace;
  req.user = { ...payload, role: member.role };
  next();
}

/** Everything an admin can do that a member cannot. Checked server-side, always. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only the workspace administrator can do that.' });
  }
  next();
}

/**
 * Requires a valid USER token (the account layer — kind: 'user'). This is a
 * separate identity from workspace membership: it proves who you are, not which
 * rooms you may enter.
 */
export function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'You are not signed in.' });
  }

  const payload = verifyToken(token);
  if (!payload || payload.kind !== 'user') {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }

  req.user = {
    userId: payload.userId,
    email: payload.email,
    username: payload.username
  };
  next();
}

/**
 * Like requireMember, but optional: attaches req.accountId (the linked user
 * account, if any) when a user token is present, and never rejects a request
 * that lacks one. Used by workspace create/join so account holders can attach
 * their memberships without breaking the anonymous flow.
 */
export function optionalUser(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const payload = verifyToken(token);
    if (payload && payload.kind === 'user') {
      req.accountId = payload.userId;
      req.accountEmail = payload.email;
      req.accountUsername = payload.username;
    }
  }
  next();
}
