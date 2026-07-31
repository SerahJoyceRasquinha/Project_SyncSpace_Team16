import * as Y from 'yjs';
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

/*
 * ---------------------------------------------------------------------------
 * CAPACITY: WHY A COUNT ALONE WAS THE WRONG BUDGET
 *
 * The old ceiling was 5 000 entries. That sounds generous until you notice what
 * actually fills it: dragging a shape emits a throttled 'live' position commit
 * every 45 ms, so ~22 updates a second. Four minutes of ordinary dragging
 * exhausted the whole history, and the room stopped recording — on exactly the
 * long collaborative sessions replay exists for.
 *
 * Raising the number alone would trade one failure for another (memory). So the
 * budget is now TWO-SIDED and the pressure is attacked from both ends:
 *
 *   1. COALESCING (below) collapses the drag storm at the source. Consecutive
 *      updates from the same user inside a short window are merged into ONE
 *      entry with Y.mergeUpdates. A 60-frame drag becomes a handful of entries
 *      instead of sixty, so the count buys far more real session.
 *
 *   2. The ceiling is a byte budget AS WELL AS a count. Whichever is reached
 *      first stops recording, so a room full of tiny updates gets its much
 *      higher entry count, while a room full of pasted images is stopped by
 *      size before it can eat the process.
 *
 * Merging is safe for replay because Y.mergeUpdates(a, b) produces an update
 * equivalent to applying a then b. A PREFIX of the merged log is therefore
 * still exactly the document as it stood at that point — which is the one
 * property the whole replay design rests on.
 * ---------------------------------------------------------------------------
 */

/** Ceiling per room, in entries. */
export const MAX_LOGS_PER_ROOM = 50000;

/** Ceiling per room, in bytes of stored payload. Whichever limit lands first wins. */
export const MAX_LOG_BYTES_PER_ROOM = 32 * 1024 * 1024;

/**
 * Two updates from the SAME user landing within this window are merged into one
 * entry. Long enough to swallow a drag (which emits every 45 ms), short enough
 * that separate deliberate actions stay separate steps on the slider.
 */
export const COALESCE_WINDOW_MS = 400;

/**
 * A merged entry is never allowed to grow past this. Without it, one long
 * continuous drag would coalesce into a single ever-growing blob that has to be
 * rewritten on every frame — quadratic work, and a replay step so coarse the
 * slider would jump across the whole gesture.
 */
export const MAX_COALESCED_BYTES = 16 * 1024;

// roomId -> [{ seq, payload, userId, username, timestamp }]
const memory = new Map();

// roomId -> next seq. Authoritative in memory mode; a lazily-seeded cache in
// Mongo mode. One server process owns a room's Y.Doc (see socketService's
// `rooms` map), so a process-local counter is consistent with the rest of the
// design — the same assumption the authoritative doc already makes.
const nextSeq = new Map();

// roomId -> in-flight seeding promise, so concurrent first appends share ONE
// seed instead of racing each other.
const seeding = new Map();

// roomId -> total stored payload bytes, for the size half of the budget.
const bytesUsed = new Map();

// roomId -> { seq, payload, userId, atMs } for the most recent entry, so a
// coalescing append never has to read the store back.
const lastEntry = new Map();

/**
 * Make sure nextSeq has an entry for the room. Runs the (possibly async) seed
 * at most once per room; every concurrent caller awaits the same promise.
 *
 * Seeding and ALLOCATION are deliberately separated: the old code awaited the
 * seed and then incremented, which left an `await` between "read the counter"
 * and "advance the counter". Two updates landing back-to-back (a drag emits
 * ~60 a second) could both resume from that await with the same value and be
 * logged under DUPLICATE seq numbers — silently corrupting the replay
 * timeline's x-axis on exactly the long sessions replay exists for. The
 * caller now allocates with a synchronous read+increment after awaiting this,
 * so no interleaving is possible.
 */
async function ensureSeeded(roomId) {
  if (nextSeq.has(roomId)) return;
  if (!seeding.has(roomId)) {
    seeding.set(roomId, (async () => {
      let start = 0;
      if (persistent) {
        try {
          const last = await UpdateLog.findOne({ roomId }).sort({ seq: -1 }).lean();
          if (last) start = last.seq + 1;
        } catch (err) {
          console.warn('[replay] could not read last seq:', err.message);
        }
      }
      if (!nextSeq.has(roomId)) nextSeq.set(roomId, start);
    })().finally(() => seeding.delete(roomId)));
  }
  await seeding.get(roomId);
}

/**
 * Append one update to the room's history, merging it into the previous entry
 * when the two belong to the same burst (see COALESCE_WINDOW_MS).
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

    await ensureSeeded(roomId);
    const buf = Buffer.from(payload);
    const now = Date.now();

    // ---- coalesce into the previous entry when it is part of the same burst
    const prev = lastEntry.get(roomId);
    const sameBurst =
      prev &&
      (prev.userId || null) === (meta.userId || null) &&
      now - prev.atMs <= COALESCE_WINDOW_MS &&
      prev.payload.length + buf.length <= MAX_COALESCED_BYTES;

    if (sameBurst) {
      const merged = mergeSafely(prev.payload, buf);
      // If merging fails or does not actually pay for itself, fall through and
      // append normally — correctness first, compaction second.
      if (merged && merged.length <= MAX_COALESCED_BYTES) {
        const delta = merged.length - prev.payload.length;
        if (persistent) {
          await UpdateLog.updateOne(
            { roomId, seq: prev.seq },
            { $set: { payload: merged, timestamp: new Date(now) } }
          );
        } else {
          const list = memory.get(roomId);
          const row = list && list[list.length - 1];
          if (row && row.seq === prev.seq) {
            row.payload = merged;
            row.timestamp = new Date(now);
          }
        }
        bytesUsed.set(roomId, (bytesUsed.get(roomId) || 0) + delta);
        // The burst's start time is kept, not refreshed, so a continuous drag
        // cannot coalesce forever into one entry.
        lastEntry.set(roomId, { ...prev, payload: merged });
        return { roomId, seq: prev.seq, payload: merged, coalesced: true };
      }
    }

    // ---- otherwise append a new entry, if there is budget for it ----------
    const seq = nextSeq.get(roomId);
    const used = bytesUsed.get(roomId) || 0;
    // capped: keep the head, drop the tail (see the note at the top of the file)
    if (seq >= MAX_LOGS_PER_ROOM) return null;
    if (used + buf.length > MAX_LOG_BYTES_PER_ROOM) return null;
    nextSeq.set(roomId, seq + 1);

    const entry = {
      roomId,
      seq,
      payload: buf,
      userId: meta.userId || null,
      username: meta.username || null,
      timestamp: new Date(now)
    };

    if (persistent) {
      await UpdateLog.create(entry);
    } else {
      if (!memory.has(roomId)) memory.set(roomId, []);
      memory.get(roomId).push(entry);
    }
    bytesUsed.set(roomId, used + buf.length);
    lastEntry.set(roomId, {
      seq, payload: buf, userId: meta.userId || null, atMs: now
    });
    return entry;
  } catch (err) {
    console.warn('[replay] append failed:', err.message);
    return null;
  }
}

/**
 * Merge two Yjs updates into one equivalent update, or null if they cannot be
 * merged. Never throws: a malformed buffer must cost us the compaction, not the
 * append — the caller falls back to storing the update on its own.
 */
function mergeSafely(a, b) {
  try {
    return Buffer.from(Y.mergeUpdates([new Uint8Array(a), new Uint8Array(b)]));
  } catch (err) {
    console.warn('[replay] could not merge updates, storing separately:', err.message);
    return null;
  }
}

/**
 * The whole history for a room, oldest first. This ordering is the contract the
 * replay slider depends on — index N on the slider is entry N here. Memory mode
 * sorts by seq too rather than trusting push order, so the read side upholds
 * the contract by itself in both modes.
 */
export async function getLogs(roomId) {
  try {
    if (!roomId) return [];
    if (persistent) {
      return await UpdateLog.find({ roomId }).sort({ seq: 1 }).lean();
    }
    return (memory.get(roomId) || []).slice().sort((a, b) => a.seq - b.seq);
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

/** True once the room has stopped recording new history (either limit hit). */
export async function isCapped(roomId) {
  if ((bytesUsed.get(roomId) || 0) >= MAX_LOG_BYTES_PER_ROOM) return true;
  return (await countLogs(roomId)) >= MAX_LOGS_PER_ROOM;
}

/** Wipe a room's history (used when a room's log is re-seeded from a snapshot). */
export async function clearLogs(roomId) {
  try {
    if (persistent) await UpdateLog.deleteMany({ roomId });
    memory.delete(roomId);
    nextSeq.delete(roomId);
    bytesUsed.delete(roomId);
    lastEntry.delete(roomId);
  } catch (err) {
    console.warn('[replay] clear failed:', err.message);
  }
}
