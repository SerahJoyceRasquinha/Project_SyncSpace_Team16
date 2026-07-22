import bcrypt from 'bcryptjs';
import {
  createWorkspace,
  findWorkspace,
  updateWorkspace,
  publicView,
  pendingOf,
  isUsernameTaken,
  findMember
} from './workspaceStore.js';
import { generateWorkspaceId, newId } from '../utils/ids.js';
import { signAccessToken, signLobbyTicket } from '../utils/token.js';
import * as rt from './realtime.js';

/**
 * All workspace business rules live here — ONE implementation, called by both the
 * REST controllers and the socket handlers. No parallel logic, no drift.
 *
 * Every function returns { ok, ... } or { ok: false, status, message } so callers
 * can translate to HTTP or to a socket error without duplicating the rules.
 */

const fail = (status, message) => ({ ok: false, status, message });

// ---------------------------------------------------------------- create

export async function createNewWorkspace({ name, password, username, permissionMode }) {
  // Retry on the (astronomically unlikely) ID collision rather than crash.
  let workspaceId;
  for (let i = 0; i < 5; i++) {
    workspaceId = generateWorkspaceId();
    if (!(await findWorkspace(workspaceId))) break;
    workspaceId = null;
  }
  if (!workspaceId) return fail(500, 'Could not allocate a workspace ID. Please try again.');

  const adminId = newId();
  const passwordHash = await bcrypt.hash(password, 10);

  const workspace = await createWorkspace({
    workspaceId,
    name,
    passwordHash,
    adminId,
    adminUsername: username,
    permissionMode,
    status: 'active',
    members: [{ userId: adminId, username, role: 'admin', joinedAt: new Date() }],
    pendingRequests: []
  });

  const token = signAccessToken({
    workspaceId,
    userId: adminId,
    username,
    role: 'admin'
  });

  return { ok: true, workspace: publicView(workspace), token };
}

// ------------------------------------------------------------------ join

export async function requestJoin({ workspaceId, username, password }) {
  const workspace = await findWorkspace(workspaceId);

  // Deliberately identical message for "no such workspace" and "wrong password":
  // otherwise this endpoint becomes a workspace-ID oracle.
  if (!workspace) return fail(404, 'Workspace not found, or the secret code is incorrect.');
  if (workspace.status === 'closed') {
    return fail(410, 'This workspace has been closed by its administrator.');
  }

  const passwordOk = await bcrypt.compare(password, workspace.passwordHash);
  if (!passwordOk) return fail(401, 'Workspace not found, or the secret code is incorrect.');

  if (isUsernameTaken(workspace, username)) {
    return fail(409, `The name "${username}" is already taken in this workspace. Please pick another.`);
  }

  // ---- Mode 2: password is enough. Straight in.
  if (workspace.permissionMode === 'password') {
    const userId = newId();
    const { workspace: saved } = await updateWorkspace(workspaceId, (ws) => {
      ws.members.push({ userId, username, role: 'member', joinedAt: new Date() });
    });
    if (!saved) return fail(404, 'Workspace not found.');

    const token = signAccessToken({ workspaceId, userId, username, role: 'member' });
    rt.toAdmin(workspaceId, 'workspace:updated', { workspace: publicView(saved) });

    return { ok: true, status: 'approved', token, workspace: publicView(saved) };
  }

  // ---- Mode 1: permission based. Into the waiting room.
  const requestId = newId();
  const request = {
    requestId,
    username,
    requestedAt: new Date(),
    status: 'pending'
  };

  const { workspace: saved } = await updateWorkspace(workspaceId, (ws) => {
    ws.pendingRequests.push(request);
  });
  if (!saved) return fail(404, 'Workspace not found.');

  const ticket = signLobbyTicket({ workspaceId, requestId, username });

  // Wake the admin up, wherever they are.
  rt.toAdmin(workspaceId, 'join:requested', { request });

  return { ok: true, status: 'pending', requestId, ticket };
}

// --------------------------------------------------------------- approve

export async function approveRequest({ workspaceId, requestId }) {
  const userId = newId();
  let approved = null;

  const { workspace: saved, result } = await updateWorkspace(workspaceId, (ws) => {
    const req = (ws.pendingRequests || []).find((r) => r.requestId === requestId);
    if (!req) return { error: 'That request no longer exists.' };
    if (req.status !== 'pending') return { error: `That request was already ${req.status}.` };

    // Guard the race: someone may have taken the name while they waited.
    if (isUsernameTaken({ members: ws.members, pendingRequests: [] }, req.username)) {
      return { error: `The name "${req.username}" was taken while they waited.` };
    }

    req.status = 'approved';
    req.resolvedAt = new Date();
    ws.members.push({ userId, username: req.username, role: 'member', joinedAt: new Date() });
    approved = { requestId, username: req.username };
    return { ok: true };
  });

  if (!saved) return fail(404, 'Workspace not found.');
  if (result?.error) return fail(409, result.error);

  const token = signAccessToken({
    workspaceId,
    userId,
    username: approved.username,
    role: 'member'
  });

  // Push the access token straight down the waiting user's open socket.
  rt.toLobby(workspaceId, requestId, 'join:approved', {
    token,
    workspace: publicView(saved)
  });
  rt.toAdmin(workspaceId, 'join:resolved', { requestId, status: 'approved' });
  rt.toWorkspace(workspaceId, 'workspace:updated', { workspace: publicView(saved) });

  return { ok: true, request: approved };
}

// ---------------------------------------------------------------- reject

export async function rejectRequest({ workspaceId, requestId, reason }) {
  const { workspace: saved, result } = await updateWorkspace(workspaceId, (ws) => {
    const req = (ws.pendingRequests || []).find((r) => r.requestId === requestId);
    if (!req) return { error: 'That request no longer exists.' };
    if (req.status !== 'pending') return { error: `That request was already ${req.status}.` };
    req.status = 'rejected';
    req.resolvedAt = new Date();
    return { ok: true, username: req.username };
  });

  if (!saved) return fail(404, 'Workspace not found.');
  if (result?.error) return fail(409, result.error);

  rt.toLobby(workspaceId, requestId, 'join:rejected', {
    reason: reason || 'The administrator declined your request to join.'
  });
  rt.toAdmin(workspaceId, 'join:resolved', { requestId, status: 'rejected' });

  return { ok: true, request: { requestId, username: result.username } };
}

// ----------------------------------------------------------------- policy

export async function setPermissionMode({ workspaceId, permissionMode }) {
  const { workspace: saved } = await updateWorkspace(workspaceId, (ws) => {
    ws.permissionMode = permissionMode;
  });
  if (!saved) return fail(404, 'Workspace not found.');

  // Existing collaborators keep working — this only changes what happens to the
  // NEXT person who tries to join. Anyone already in the waiting room stays there
  // and can still be approved by hand.
  rt.toWorkspace(workspaceId, 'workspace:policy-changed', { permissionMode });

  return { ok: true, workspace: publicView(saved) };
}

// ---------------------------------------------------------------- members

export async function removeMember({ workspaceId, userId, actorId }) {
  if (userId === actorId) return fail(400, 'You cannot remove yourself.');

  const { workspace: saved, result } = await updateWorkspace(workspaceId, (ws) => {
    const member = findMember(ws, userId);
    if (!member) return { error: 'That person is not in this workspace.' };
    if (member.role === 'admin') return { error: 'The administrator cannot be removed.' };
    ws.members = ws.members.filter((m) => m.userId !== userId);
    return { ok: true, username: member.username };
  });

  if (!saved) return fail(404, 'Workspace not found.');
  if (result?.error) return fail(409, result.error);

  rt.disconnectUser(workspaceId, userId, 'The administrator removed you from this workspace.');
  rt.toWorkspace(workspaceId, 'workspace:updated', { workspace: publicView(saved) });

  return { ok: true, removed: result.username };
}

export async function closeWorkspace({ workspaceId }) {
  const { workspace: saved } = await updateWorkspace(workspaceId, (ws) => {
    ws.status = 'closed';
  });
  if (!saved) return fail(404, 'Workspace not found.');

  rt.toWorkspace(workspaceId, 'workspace:closed', {
    reason: 'The administrator closed this workspace.'
  });
  for (const req of pendingOf(saved)) {
    rt.toLobby(workspaceId, req.requestId, 'join:rejected', {
      reason: 'This workspace was closed while you were waiting.'
    });
  }

  return { ok: true };
}

// -------------------------------------------------------------- read side

export async function getPending(workspaceId) {
  const ws = await findWorkspace(workspaceId);
  if (!ws) return fail(404, 'Workspace not found.');
  return { ok: true, requests: pendingOf(ws) };
}

export async function getRequestStatus({ workspaceId, requestId }) {
  const ws = await findWorkspace(workspaceId);
  if (!ws) return fail(404, 'Workspace not found.');
  const req = (ws.pendingRequests || []).find((r) => r.requestId === requestId);
  if (!req) return fail(404, 'That request no longer exists.');
  return { ok: true, request: req, workspace: ws };
}
