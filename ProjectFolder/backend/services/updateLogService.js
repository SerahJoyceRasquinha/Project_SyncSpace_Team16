import UpdateLog from '../models/UpdateLog.js';

/**
 * The repository in front of the updatelogs collection.
 *
 * It follows the SAME dual-mode contract as workspaceStore.js: flip
 * setPersistence(true) and every call below hits MongoDB; leave it false and it
 * keeps an identical structure in memory. No caller changes either way.
 *
 * That is not decoration. Local MongoDB will not install on this project's
 * development machine, so if replay only worked against a live database it
 * could not be demonstrated at all. Memory mode keeps the whole feature — the
 * socket events, the slider, the reconstruction — testable and demoable today,
 * and a single .env line promotes it to durable history on Atlas.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CAP TRIMS THE TAIL AND NEVER THE HEAD
 *
 * Yjs updates form a causal chain: an update that edits a shape refers to the
 * update that created it. So a PREFIX of the log (0..k) is always a complete,
 * internally consistent document — that is exactly what replay scrubs through.
 * A SUFFIX is not: drop the early updates and the later ones reference items
 * Yjs has never seen, so it parks them as pending and the board renders blank.
 *
 * A ring buffer would therefore be the one wrong data structure here. When a
 * room hits the ceiling we stop recording and set `capped`, which the UI shows
 * honestly, rather than silently corrupting the history we already have.
 * ---------------------------------------------------------------------------
 */

let persistent = false;
export function setPersistence(flag) {
  persistent = flag;
  console.log(`[replay] update log -> ${flag ? 'MongoDB' : 'in-memory'}`);
}

/** Ceiling per room. ~200 bytes per update, so this is a few MB at worst. */
export const MAX_LOGS_PER_ROOM = 5000;

// roomId -> [{ seq, payload, userId, username, timestamp }]
const memory = new Map();

// roomId -> next seq. Authoritative in memory mode; a lazily-seeded cache in
// Mongo mode. One server process owns a room's Y.Doc (see socketService's
// `rooms` map), so a process-local counter is consistent with the rest of the
// design — the same assumption the authoritative doc already makes.
const nextSeq = new Map();

async function seedSeq(roomId) {
  if (nextSeq.has(roomId)) return nextSeq.get(roomId);
  let start = 0;
  if (persistent) {
    try {
      const last = await UpdateLog.findOne({ roomId }).sort({ seq: -1 }).lean();
      if (last) start = last.seq + 1;
    } catch (err) {
      console.warn('[replay] could not read last seq:', err.message);
    }
  }
  nextSeq.set(roomId, start);
  return start;
}

/**
 * Append one update to the room's history.
 *
 * Deliberately never throws: this is called on the hot path of every single
 * edit, immediately after the update has already been relayed to the other
 * collaborators. Logging is a bonus feature, so a failure here must degrade
 * replay — never break live collaboration for everyone in the room.
 *
 * Returns the stored entry, or null if it was skipped.
 */
export async function appendUpdate(roomId, payload, meta = {}) {
  try {
    if (!roomId || !payload || !payload.length) return null;

    const seq = await seedSeq(roomId);
    if (seq >= MAX_LOGS_PER_ROOM) return null; // capped: keep the head, drop the tail

    const entry = {
      roomId,
      seq,
      payload: Buffer.from(payload),
      userId: meta.userId || null,
      username: meta.username || null,
      timestamp: new Date()
    };

    nextSeq.set(roomId, seq + 1);

    if (persistent) {
      await UpdateLog.create(entry);
    } else {
      if (!memory.has(roomId)) memory.set(roomId, []);
      memory.get(roomId).push(entry);
    }
    return entry;
  } catch (err) {
    console.warn('[replay] append failed:', err.message);
    return null;
  }
}

/**
 * The whole history for a room, oldest first. This ordering is the contract the
 * replay slider depends on — index N on the slider is entry N here.
 */
export async function getLogs(roomId) {
  try {
    if (!roomId) return [];
    if (persistent) {
      return await UpdateLog.find({ roomId }).sort({ seq: 1 }).lean();
    }
    return (memory.get(roomId) || []).slice();
  } catch (err) {
    console.warn('[replay] read failed:', err.message);
    return [];
  }
}

export async function countLogs(roomId) {
  try {
    if (!roomId) return 0;
    if (persistent) return await UpdateLog.countDocuments({ roomId });
    return (memory.get(roomId) || []).length;
  } catch (err) {
    console.warn('[replay] count failed:', err.message);
    return 0;
  }
}

/** True once the room has stopped recording new history. */
export async function isCapped(roomId) {
  return (await countLogs(roomId)) >= MAX_LOGS_PER_ROOM;
}

/** Wipe a room's history (used when a room's log is re-seeded from a snapshot). */
export async function clearLogs(roomId) {
  try {
    if (persistent) await UpdateLog.deleteMany({ roomId });
    memory.delete(roomId);
    nextSeq.delete(roomId);
  } catch (err) {
    console.warn('[replay] clear failed:', err.message);
  }
}
