import User from '../models/User.js';

/**
 * Thin repository in front of the User model, mirroring workspaceStore.js:
 * the whole account system works with or without MongoDB, and flipping
 * setPersistence(true) moves it onto the same database as everything else.
 */

let persistent = false;
export function setPersistence(flag) {
  persistent = flag;
  console.log(`[store] users -> ${flag ? 'MongoDB' : 'in-memory'}`);
}

// ---- in-memory fallback -------------------------------------------------
const memory = new Map();   // userId -> plain object
const byEmail = new Map();  // email  -> userId

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);

// ---- API ----------------------------------------------------------------

export async function createUser(doc) {
  if (persistent) {
    const created = await User.create(doc);
    return created.toObject();
  }
  const record = { ...doc, createdAt: new Date(), updatedAt: new Date() };
  memory.set(doc.userId, record);
  byEmail.set(String(doc.email).toLowerCase(), doc.userId);
  return clone(record);
}

export async function findUserByEmail(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  if (persistent) return await User.findOne({ email: key }).lean();
  const id = byEmail.get(key);
  return id ? clone(memory.get(id)) : null;
}

export async function findUserById(userId) {
  if (!userId) return null;
  if (persistent) return await User.findOne({ userId }).lean();
  return clone(memory.get(userId));
}

/**
 * Record a workspace membership on the account. Idempotent: joining the same
 * workspace twice never creates a duplicate entry. Authorisation still comes
 * from Workspace.members; this array is the dashboard index.
 */
export async function addMembership(userId, workspaceId, role = 'member') {
  if (!userId || !workspaceId) return null;

  if (persistent) {
    const doc = await User.findOne({ userId });
    if (!doc) return null;
    if (!(doc.workspaces || []).some((w) => w.workspaceId === workspaceId)) {
      doc.workspaces.push({ workspaceId, role });
      await doc.save();
    }
    return doc.toObject();
  }

  const record = memory.get(userId);
  if (!record) return null;
  if (!(record.workspaces || []).some((w) => w.workspaceId === workspaceId)) {
    record.workspaces.push({ workspaceId, role });
    record.updatedAt = new Date();
  }
  return clone(record);
}

export async function removeMembership(userId, workspaceId) {
  if (!userId || !workspaceId) return null;

  if (persistent) {
    const doc = await User.findOne({ userId });
    if (!doc) return null;
    doc.workspaces = (doc.workspaces || []).filter((w) => w.workspaceId !== workspaceId);
    await doc.save();
    return doc.toObject();
  }

  const record = memory.get(userId);
  if (!record) return null;
  record.workspaces = (record.workspaces || []).filter((w) => w.workspaceId !== workspaceId);
  record.updatedAt = new Date();
  return clone(record);
}

export async function removeMembershipForWorkspace(workspaceId) {
  if (!workspaceId) return 0;

  if (persistent) {
    const result = await User.updateMany(
      { 'workspaces.workspaceId': workspaceId },
      { $pull: { workspaces: { workspaceId } } }
    );
    return result.modifiedCount || 0;
  }

  let removed = 0;
  for (const record of memory.values()) {
    const before = record.workspaces?.length || 0;
    record.workspaces = (record.workspaces || []).filter((w) => w.workspaceId !== workspaceId);
    if ((record.workspaces || []).length !== before) removed += (before - (record.workspaces || []).length);
    record.updatedAt = new Date();
  }
  return removed;
}

