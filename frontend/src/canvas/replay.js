import * as Y from 'yjs';

/**
 * The reconstruction engine behind the replay slider.
 *
 * Kept deliberately free of React and Konva — it imports nothing but Yjs — so
 * the part of replay that can actually be WRONG is provable headlessly, the
 * same discipline connectors.js and brushes.js follow. The component that uses
 * this file only draws; every claim about history correctness is tested here.
 */

/**
 * socket.io hands binary back in one of several shapes depending on transport
 * and platform: a real Uint8Array, a raw ArrayBuffer, a plain number array, or
 * a serialised Node Buffer ({ type:'Buffer', data:[...] }). Normalising here
 * means the rest of replay only ever sees Uint8Array.
 */
export function toBytes(payload) {
  if (!payload) return null;
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (Array.isArray(payload)) return Uint8Array.from(payload);
  if (typeof payload === 'object' && Array.isArray(payload.data)) {
    return Uint8Array.from(payload.data);
  }
  return null;
}

/**
 * Split one streamed history chunk back into per-entry byte arrays.
 *
 * The server ships the log as replay-logs-chunk messages, each carrying ONE
 * packed buffer plus the per-entry sizes — never one buffer per entry. That
 * shape is not an optimisation, it is the fix for a hard failure: socket.io
 * turns every nested Buffer into a separate binary attachment, and the
 * parser on both ends refuses packets with more than 10 attachments, so the
 * old one-buffer-per-entry response was rejected outright (a "parse error"
 * disconnect) for any session past ~10 updates.
 *
 * Slices are zero-copy subarray views into the chunk buffer. Returns null if
 * the chunk is internally inconsistent (sizes disagree with the data length),
 * so the caller can report "corrupted replay data" rather than render a lie.
 */
export function unpackChunk(chunk) {
  if (!chunk || !Array.isArray(chunk.sizes)) return null;
  const data = toBytes(chunk.data) || new Uint8Array(0);
  const out = [];
  let off = 0;
  for (const s of chunk.sizes) {
    const size = Number(s);
    if (!Number.isInteger(size) || size < 0 || off + size > data.length) return null;
    out.push(data.subarray(off, off + size));
    off += size;
  }
  if (off !== data.length) return null;
  return out;
}

/**
 * Build a fresh document from the first `n` entries of a log.
 *
 * This is the whole idea of replay in four lines: a Yjs update is a
 * self-contained, causally ordered delta, so applying a PREFIX of the log
 * yields exactly the document as it stood after update n — not a guess at it.
 *
 * A single unreadable entry is skipped rather than allowed to abort the run:
 * losing one frame of history is a far better failure than showing the user a
 * blank replay because one buffer arrived malformed.
 */
export function rebuildTo(entries, n) {
  const doc = new Y.Doc();
  const upto = Math.max(0, Math.min(n, entries.length));
  for (let i = 0; i < upto; i++) {
    const bytes = toBytes(entries[i]?.payload);
    if (!bytes) continue;
    try {
      Y.applyUpdate(doc, bytes, 'replay');
    } catch (err) {
      console.warn('[SyncSpace] replay: skipped a malformed update at', i, err);
    }
  }
  return doc;
}

/**
 * A forward-only cache over rebuildTo().
 *
 * Rebuilding from update 0 on every slider tick is O(N) per frame, which makes
 * playback of a long session stutter. Updates only ever move forward, so
 * scrubbing FORWARD applies just the delta and scrubbing BACKWARD starts over.
 * Playback — the case that has to be smooth — becomes O(1) amortised per frame,
 * while a backward jump pays the rebuild once.
 *
 * Correctness rests on Yjs applying updates in order being equivalent to
 * applying them all at once, which is exactly the property test-replay.mjs
 * asserts: incremental and from-scratch reconstruction must agree at every n.
 */
export class ReplayCache {
  constructor(entries = []) {
    this.reset(entries);
  }

  /**
   * The document as it stood after `n` updates. n = 0 is the empty board.
   *
   * Backward moves no longer always restart from zero: while building
   * forward the cache snapshots the encoded document every `checkpointEvery`
   * updates (at most ~20 snapshots per session, so memory stays bounded),
   * and a backward jump restores from the nearest checkpoint at or below the
   * target. On a session thousands of updates long that turns "drag the
   * slider left" from a full O(N) rebuild into a short delta.
   */
  at(n) {
    const target = Math.max(0, Math.min(n, this.entries.length));

    if (target < this.builtTo) {
      let base = 0;
      let snap = null;
      for (const [k, v] of this.checkpoints) {
        if (k <= target && k > base) { base = k; snap = v; }
      }
      this.doc = new Y.Doc();
      this.builtTo = 0;
      if (snap) {
        try {
          Y.applyUpdate(this.doc, snap, 'replay');
          this.builtTo = base;
        } catch (err) {
          console.warn('[SyncSpace] replay: checkpoint restore failed, rebuilding from 0', err);
          this.doc = new Y.Doc();
          this.builtTo = 0;
        }
      }
    }

    for (let i = this.builtTo; i < target; i++) {
      const bytes = toBytes(this.entries[i]?.payload);
      if (bytes) {
        try {
          Y.applyUpdate(this.doc, bytes, 'replay');
        } catch (err) {
          console.warn('[SyncSpace] replay: skipped a malformed update at', i, err);
        }
      }
      const applied = i + 1;
      if (applied % this.checkpointEvery === 0 && !this.checkpoints.has(applied)) {
        try {
          this.checkpoints.set(applied, Y.encodeStateAsUpdate(this.doc));
        } catch { /* a missing checkpoint only costs speed, never correctness */ }
      }
    }

    this.builtTo = target;
    return this.doc;
  }

  /** Drop the cached document (used when a new log is loaded). */
  reset(entries) {
    if (entries) this.entries = entries;
    this.doc = new Y.Doc();
    this.builtTo = 0;
    this.checkpoints = new Map(); // appliedCount -> encoded state
    // ~20 checkpoints max regardless of session length, floor of 250 so tiny
    // sessions (which rebuild instantly anyway) carry none of the overhead.
    this.checkpointEvery = Math.max(250, Math.ceil((this.entries?.length || 0) / 20));
  }
}

/**
 * Rough world-space bounds of a set of normalised shapes, used by the replay
 * viewer's "Fit" button. Returns null when there is nothing to frame, so the
 * caller can fall back to a 1:1 view rather than dividing by zero.
 */
export function frameBounds(shapes = []) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const s of shapes) {
    if (!s || typeof s !== 'object') continue;
    const ox = Number.isFinite(s.x) ? s.x : 0;
    const oy = Number.isFinite(s.y) ? s.y : 0;

    const pts = Array.isArray(s.points) && s.points.length >= 2 ? s.points : null;
    if (pts) {
      for (let i = 0; i + 1 < pts.length; i += 2) {
        add(ox + Number(pts[i]), oy + Number(pts[i + 1]));
      }
    }
    if (s.start) add(Number(s.start.x), Number(s.start.y));
    if (s.end) add(Number(s.end.x), Number(s.end.y));

    // A stroke stores absolute points against x=y=0, so folding in its origin
    // corner would stretch the bounds all the way back to (0,0) and make Fit
    // zoom out to nothing. Only shapes that actually have extent contribute a
    // corner box; point-based records are measured by their points alone.
    const w = Number(s.width) || 0;
    const h = Number(s.height) || 0;
    if (!pts || w > 0 || h > 0) {
      add(ox, oy);
      add(ox + w, oy + h);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
