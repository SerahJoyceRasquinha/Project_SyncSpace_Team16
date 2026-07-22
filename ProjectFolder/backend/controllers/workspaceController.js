import * as svc from '../services/workspaceService.js';
import { findWorkspace, teaserView, publicView, pendingOf } from '../services/workspaceStore.js';
import {
  validateUsername,
  validateWorkspaceName,
  validatePassword,
  validateMode,
  validateWorkspaceId,
  rateLimit,
  clearRateLimit
} from '../utils/validate.js';

/** Turn a service failure into an HTTP response without leaking internals. */
const send = (res, result, okStatus = 200) => {
  if (!result.ok) return res.status(result.status || 400).json({ error: result.message });
  return res.status(okStatus).json(result);
};

// POST /api/workspaces
export async function create(req, res, next) {
  try {
    const name = validateWorkspaceName(req.body?.name);
    if (!name.ok) return res.status(400).json({ error: name.message });

    const password = validatePassword(req.body?.password);
    if (!password.ok) return res.status(400).json({ error: password.message });

    const username = validateUsername(req.body?.username);
    if (!username.ok) return res.status(400).json({ error: username.message });

    const mode = validateMode(req.body?.permissionMode);
    if (!mode.ok) return res.status(400).json({ error: mode.message });

    const result = await svc.createNewWorkspace({
      name: name.name,
      password: password.password,
      username: username.username,
      permissionMode: mode.permissionMode
    });
    return send(res, result, 201);
  } catch (err) {
    next(err);
  }
}

// GET /api/workspaces/:workspaceId  — the tiny bit a stranger may know
export async function peek(req, res, next) {
  try {
    const id = validateWorkspaceId(req.params.workspaceId);
    if (!id.ok) return res.status(400).json({ error: id.message });

    const ws = await findWorkspace(id.workspaceId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found.' });
    // NOTE: permissionMode is intentionally NOT revealed here. You learn it by
    // authenticating, not by guessing IDs.
    return res.json({ ok: true, workspace: teaserView(ws) });
  } catch (err) {
    next(err);
  }
}

// POST /api/workspaces/:workspaceId/join
export async function join(req, res, next) {
  try {
    const id = validateWorkspaceId(req.params.workspaceId);
    if (!id.ok) return res.status(400).json({ error: id.message });

    const limitKey = `${req.ip}:${id.workspaceId}`;
    const limited = rateLimit(limitKey, { max: 10, windowMs: 60_000 });
    if (!limited.ok) return res.status(429).json({ error: limited.message });

    const username = validateUsername(req.body?.username);
    if (!username.ok) return res.status(400).json({ error: username.message });

    const password = validatePassword(req.body?.password);
    if (!password.ok) return res.status(400).json({ error: 'Please enter the workspace secret code.' });

    const result = await svc.requestJoin({
      workspaceId: id.workspaceId,
      username: username.username,
      password: password.password
    });

    if (result.ok) clearRateLimit(limitKey);
    return send(res, result);
  } catch (err) {
    next(err);
  }
}

// GET /api/workspaces/:workspaceId/me  — used on page reload to re-hydrate
export async function me(req, res) {
  const pending = req.user.role === 'admin' ? pendingOf(req.workspace) : [];
  return res.json({
    ok: true,
    user: { userId: req.user.userId, username: req.user.username, role: req.user.role },
    workspace: publicView(req.workspace),
    pendingRequests: pending
  });
}

// GET /api/workspaces/:workspaceId/requests  (admin)
export async function listRequests(req, res, next) {
  try {
    return send(res, await svc.getPending(req.params.workspaceId));
  } catch (err) {
    next(err);
  }
}

// POST /api/workspaces/:workspaceId/requests/:requestId/approve  (admin)
export async function approve(req, res, next) {
  try {
    return send(
      res,
      await svc.approveRequest({
        workspaceId: req.params.workspaceId,
        requestId: req.params.requestId
      })
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/workspaces/:workspaceId/requests/:requestId/reject  (admin)
export async function reject(req, res, next) {
  try {
    return send(
      res,
      await svc.rejectRequest({
        workspaceId: req.params.workspaceId,
        requestId: req.params.requestId,
        reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 140) : undefined
      })
    );
  } catch (err) {
    next(err);
  }
}

// PATCH /api/workspaces/:workspaceId/policy  (admin)
export async function updatePolicy(req, res, next) {
  try {
    const mode = validateMode(req.body?.permissionMode);
    if (!mode.ok) return res.status(400).json({ error: mode.message });

    return send(
      res,
      await svc.setPermissionMode({
        workspaceId: req.params.workspaceId,
        permissionMode: mode.permissionMode
      })
    );
  } catch (err) {
    next(err);
  }
}

// DELETE /api/workspaces/:workspaceId/members/:userId  (admin)
export async function removeMember(req, res, next) {
  try {
    return send(
      res,
      await svc.removeMember({
        workspaceId: req.params.workspaceId,
        userId: req.params.userId,
        actorId: req.user.userId
      })
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/workspaces/:workspaceId/close  (admin)
export async function close(req, res, next) {
  try {
    return send(res, await svc.closeWorkspace({ workspaceId: req.params.workspaceId }));
  } catch (err) {
    next(err);
  }
}
