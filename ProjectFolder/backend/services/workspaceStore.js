import Workspace from '../models/Workspace.js';

/**
 * A thin repository in front of the Workspace model.
 *
 * WHY: your MongoDB install is not working yet, and the original project already
 * degraded gracefully to memory-only mode. This keeps that promise — every route
 * and socket handler below talks to `store`, never to Mongoose directly, so the
 * whole permission system works with or without a database.
 *
 * Flip `setPersistence(true)` (server.js does this when Mongo connects) and the
 * exact same calls hit MongoDB instead. No caller changes.
 */

let persistent = false;
export function setPersistence(flag) {
  persistent = flag;
  console.log(`[store] workspaces -> ${flag ? 'MongoDB' : 'in-memory'}`);
}

// ---- in-memory fallback -------------------------------------------------
const memory = new Map(); // workspaceId -> plain object

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);

// ---- API ----------------------------------------------------------------

export async function createWorkspace(doc) {
  if (persistent) {
    const created = await Workspace.create(doc);
    return created.toObject();
  }
  const record = { ...doc, createdAt: new Date(), updatedAt: new Date() };
  memory.set(doc.workspaceId, record);
  return clone(record);
}

export async function findWorkspace(workspaceId) {
  if (!workspaceId) return null;
  if (persistent) {
    return await Workspace.findOne({ workspaceId }).lean();
  }
  return clone(memory.get(workspaceId));
}

export async function workspaceExists(workspaceId) {
  return Boolean(await findWorkspace(workspaceId));
}

/**
 * Apply a mutation function to a workspace and persist the result.
 * `mutate(ws)` receives a plain object, mutates it, and may return a value
 * which is handed back to the caller. This gives us one single write path,
 * which is what keeps concurrent joins from clobbering each other.
 */
export async function updateWorkspace(workspaceId, mutate) {
  if (persistent) {
    const doc = await Workspace.findOne({ workspaceId });
    if (!doc) return { workspace: null, result: null };
    const result = mutate(doc);
    await doc.save();
    return { workspace: doc.toObject(), result };
  }
  const record = memory.get(workspaceId);
  if (!record) return { workspace: null, result: null };
  const result = mutate(record);
  record.updatedAt = new Date();
  memory.set(workspaceId, record);
  return { workspace: clone(record), result };
}

// ---- helpers used by controllers + sockets ------------------------------

/** Everything that is safe to send to a browser. NEVER includes passwordHash. */
export function publicView(ws) {
  if (!ws) return null;
  return {
    workspaceId: ws.workspaceId,
    name: ws.name,
    permissionMode: ws.permissionMode,
    status: ws.status,
    adminUsername: ws.adminUsername,
    createdAt: ws.createdAt,
    members: (ws.members || []).map((m) => ({
      userId: m.userId,
      username: m.username,
      role: m.role,
      joinedAt: m.joinedAt
    }))
  };
}

/** The minimum a stranger is allowed to learn before authenticating. */
export function teaserView(ws) {
  if (!ws) return null;
  return { workspaceId: ws.workspaceId, name: ws.name, status: ws.status };
}

export function pendingOf(ws) {
  return (ws.pendingRequests || []).filter((r) => r.status === 'pending');
}

export function isUsernameTaken(ws, username) {
  const u = String(username).trim().toLowerCase();
  const inMembers = (ws.members || []).some(
    (m) => m.username.toLowerCase() === u
  );
  const inPending = pendingOf(ws).some((r) => r.username.toLowerCase() === u);
  return inMembers || inPending;
}

export function findMember(ws, userId) {
  return (ws.members || []).find((m) => m.userId === userId) || null;
}
