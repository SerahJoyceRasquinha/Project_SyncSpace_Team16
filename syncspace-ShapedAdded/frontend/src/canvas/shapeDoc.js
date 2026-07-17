import * as Y from 'yjs';
import { COMMON_DEFAULTS } from './shapes.jsx';

/**
 * Every mutation of the shared document goes through here. Keeping the write path
 * in one file is what makes concurrent edits safe to reason about and keeps the
 * Canvas component from growing a hundred ad-hoc ydoc.transact() calls.
 *
 * A shape is a Y.Map so that per-property edits (one user recolours while another
 * moves the same shape) merge at the FIELD level instead of clobbering the whole
 * object. That is the CRDT behaviour the brief asks us to prove.
 */

export const shapesArray = (ydoc) => ydoc.getArray('shapes');

let counter = 0;
export function makeId(ydoc) {
  counter += 1;
  return `${ydoc.clientID}-${Date.now()}-${counter}`;
}

/** Turn a plain object into a Y.Map, converting a `points` array into a Y.Array. */
function toYMap(obj) {
  const map = new Y.Map();
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'points' && Array.isArray(v)) {
      const arr = new Y.Array();
      arr.push(v);
      map.set(k, arr);
    } else {
      map.set(k, v);
    }
  }
  return map;
}

/** Read a Y.Map shape into a plain JS object the renderer can use. */
export function readShape(map) {
  const out = {};
  map.forEach((v, k) => {
    out[k] = v instanceof Y.Array ? v.toArray() : v;
  });
  return out;
}

/**
 * Add a new shape. `props` supplies type + geometry; the common schema fills the
 * rest. Returns the id so the caller can immediately select it.
 */
export function addShape(ydoc, user, props) {
  const id = makeId(ydoc);
  const now = Date.now();
  const arr = shapesArray(ydoc);
  const zIndex = arr.length;
  const record = {
    id,
    creator: user?.name || 'anon',
    createdAt: now,
    updatedAt: now,
    ...COMMON_DEFAULTS(),
    zIndex,
    ...props
  };
  ydoc.transact(() => {
    arr.push([toYMap(record)]);
  });
  return id;
}

function findMap(ydoc, id) {
  const arr = shapesArray(ydoc);
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    if (m.get('id') === id) return m;
  }
  return null;
}

/** Patch fields on one shape. Only the changed fields are written. */
export function updateShape(ydoc, id, patch) {
  const map = findMap(ydoc, id);
  if (!map) return;
  ydoc.transact(() => {
    for (const [k, v] of Object.entries(patch)) map.set(k, v);
    map.set('updatedAt', Date.now());
  });
}

/** Patch the same fields on many shapes (e.g. recolour a multi-selection). */
export function updateMany(ydoc, ids, patch) {
  ydoc.transact(() => {
    const arr = shapesArray(ydoc);
    for (let i = 0; i < arr.length; i++) {
      const m = arr.get(i);
      if (ids.includes(m.get('id'))) {
        for (const [k, v] of Object.entries(patch)) m.set(k, v);
        m.set('updatedAt', Date.now());
      }
    }
  });
}

/**
 * Same as updateShape, but the transaction carries the 'live' origin, which the
 * Canvas UndoManager does NOT track. Used for the high-frequency writes while a
 * drag is in flight, so remote users follow in real time but a whole drag still
 * undoes as ONE step (the final commit goes through updateShape).
 */
export const LIVE_ORIGIN = 'live';
export function updateShapeLive(ydoc, id, patch) {
  const map = findMap(ydoc, id);
  if (!map) return;
  ydoc.transact(() => {
    for (const [k, v] of Object.entries(patch)) map.set(k, v);
  }, LIVE_ORIGIN);
}

/**
 * Duplicate a set of shape records (used by copy/paste and Ctrl+D).
 * Connectors whose endpoints attach to shapes INSIDE the copied set are re-wired
 * to the new copies; attachments to shapes outside the set become free endpoints
 * at their last resolved position, so a pasted arrow never grabs the original.
 */
export function duplicateShapes(ydoc, user, records, offset = 24) {
  const idMap = new Map();
  const now = Date.now();
  const arr = shapesArray(ydoc);
  let z = 0;
  for (let i = 0; i < arr.length; i++) z = Math.max(z, arr.get(i).get('zIndex') || 0);

  const remapEnd = (end) => {
    if (!end) return end;
    const moved = { ...end, x: (end.x || 0) + offset, y: (end.y || 0) + offset };
    if (end.shapeId && idMap.has(end.shapeId)) {
      return { ...moved, shapeId: idMap.get(end.shapeId) };
    }
    const { shapeId: _drop, anchor: _drop2, ...free } = moved;
    return free;
  };

  const newIds = [];
  ydoc.transact(() => {
    // pass 1: ids for everything, so connectors can remap in pass 2
    for (const r of records) idMap.set(r.id, makeId(ydoc));

    for (const r of records) {
      const copy = { ...r, id: idMap.get(r.id), createdAt: now, updatedAt: now };
      copy.creator = user?.name || copy.creator || 'anon';
      copy.zIndex = ++z;
      if (copy.type === 'connector') {
        copy.start = remapEnd(copy.start);
        copy.end = remapEnd(copy.end);
        copy.waypoints = (copy.waypoints || []).map((n) => n + offset);
      } else {
        copy.x = (copy.x || 0) + offset;
        copy.y = (copy.y || 0) + offset;
      }
      arr.push([toYMap(copy)]);
      newIds.push(copy.id);
    }
  });
  return newIds;
}

/** Swap zIndex with the nearest neighbour above / below. */
export function reorderShape(ydoc, id, direction) {
  const arr = shapesArray(ydoc);
  const all = [];
  for (let i = 0; i < arr.length; i++) {
    all.push({ map: arr.get(i), z: arr.get(i).get('zIndex') || 0 });
  }
  all.sort((a, b) => a.z - b.z);
  const idx = all.findIndex((e) => e.map.get('id') === id);
  if (idx < 0) return;
  const swapWith = direction === 'forward' ? idx + 1 : idx - 1;
  if (swapWith < 0 || swapWith >= all.length) return;
  ydoc.transact(() => {
    const a = all[idx];
    const b = all[swapWith];
    // guarantee distinct values even if several shapes share a zIndex
    const za = b.z === a.z ? b.z + (direction === 'forward' ? 1 : -1) : b.z;
    a.map.set('zIndex', za);
    b.map.set('zIndex', a.z);
  });
}

export function removeShapes(ydoc, ids) {
  const arr = shapesArray(ydoc);
  ydoc.transact(() => {
    // delete from the end so indices stay valid as we splice
    for (let i = arr.length - 1; i >= 0; i--) {
      if (ids.includes(arr.get(i).get('id'))) arr.delete(i, 1);
    }
  });
}

export function clearAll(ydoc) {
  const arr = shapesArray(ydoc);
  ydoc.transact(() => arr.delete(0, arr.length));
}

/** Bring to front = highest zIndex. Used on selection so a shape is reachable. */
export function bringToFront(ydoc, id) {
  const arr = shapesArray(ydoc);
  let max = 0;
  for (let i = 0; i < arr.length; i++) max = Math.max(max, arr.get(i).get('zIndex') || 0);
  updateShape(ydoc, id, { zIndex: max + 1 });
}
