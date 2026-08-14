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

/**
 * Write one patch entry. `undefined` means "remove this field" — Yjs happily
 * STORES undefined as a value otherwise, leaving a dead key that later reads
 * back as a real (undefined) property and defeats every `?? default` in the
 * renderer. Deleting is what the caller actually meant.
 */
function applyField(map, k, v) {
  if (v === undefined) map.delete(k);
  else map.set(k, v);
}

/** Patch fields on one shape. Only the changed fields are written. */
export function updateShape(ydoc, id, patch) {
  const map = findMap(ydoc, id);
  if (!map) return;
  ydoc.transact(() => {
    for (const [k, v] of Object.entries(patch)) applyField(map, k, v);
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
        for (const [k, v] of Object.entries(patch)) applyField(m, k, v);
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

/**
 * Commit one finished freehand stroke as a `type: 'path'` record. Kept as a
 * thin wrapper over addShape so a stroke is an ordinary shape — same array,
 * same sync, same undo. Called once on pointer-up (the live drawing is a local
 * preview until then), which is why a whole stroke is a single undo step and
 * costs one network message instead of one per sampled point.
 */
export function commitStroke(ydoc, user, props) {
  return addShape(ydoc, user, { type: 'path', x: 0, y: 0, ...props });
}

/**
 * Apply a whole eraser drag to the document in ONE transaction.
 *
 * `edits` is [{ id, runs }], where `runs` are the surviving contiguous point
 * arrays for the stroke `id` (computed locally from the eraser path). For each
 * edited stroke we delete the original record and push one fresh `path` per
 * surviving run, inheriting every visual property. Doing it all in a single
 * (origin-null) transaction means:
 *   - the UndoManager records the entire erase as ONE step (undo restores the
 *     original stroke intact; redo re-splits it);
 *   - collaborators receive one atomic update — no half-erased intermediate
 *     state can be observed and nothing can interleave to corrupt the split;
 *   - a stroke erased through the middle survives as two strokes; a stroke
 *     fully erased simply disappears.
 * Returns the ids of the newly created fragment strokes.
 */
export function applyErase(ydoc, user, edits) {
  if (!edits.length) return [];
  const arr = shapesArray(ydoc);
  const newIds = [];
  ydoc.transact(() => {
    for (const { id, runs } of edits) {
      // locate + read the original before removing it
      let orig = null, origIndex = -1;
      for (let i = 0; i < arr.length; i++) {
        if (arr.get(i).get('id') === id) { orig = arr.get(i); origIndex = i; break; }
      }
      if (!orig) continue;
      const base = readShape(orig);
      arr.delete(origIndex, 1);

      for (const run of runs) {
        const frag = {
          ...base,
          id: makeId(ydoc),
          points: run,
          updatedAt: Date.now()
        };
        frag.creator = base.creator || user?.name || 'anon';
        arr.push([toYMap(frag)]);
        newIds.push(frag.id);
      }
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

/**
 * Bring to front = highest zIndex. Called on selection so a shape is reachable.
 *
 * TWO FIXES over the naive version:
 *  1. It is a NO-OP when the shape is already frontmost. Previously every single
 *     click rewrote zIndex and updatedAt, producing a document mutation (and a
 *     network broadcast) for an action that changed nothing.
 *  2. It writes with the untracked LIVE_ORIGIN, so merely CLICKING a shape no
 *     longer pushes an entry onto the UndoManager. Before this, Ctrl+Z after
 *     selecting something undid the invisible z-order bump instead of the user's
 *     last real edit, which made undo/redo feel broken.
 * Explicit reordering still goes through reorderShape() and remains undoable.
 */
export function bringToFront(ydoc, id) {
  const arr = shapesArray(ydoc);
  let max = 0;
  let target = null;
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    const z = m.get('zIndex') || 0;
    if (z > max) max = z;
    if (m.get('id') === id) target = m;
  }
  if (!target) return;
  if ((target.get('zIndex') || 0) >= max) return; // already on top: nothing to do
  ydoc.transact(() => { target.set('zIndex', max + 1); }, LIVE_ORIGIN);
}

/**
 * Get bounding box of a shape for alignment purposes.
 * Handles both regular shapes (with width/height) and freehand paths (with points).
 */
function getShapeBounds(shape) {
  const x = shape.x || 0;
  const y = shape.y || 0;
  const width = shape.width || 0;
  const height = shape.height || 0;
  const points = shape.points || [];

  // For freehand strokes, calculate bounds from points
  if (points.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      const px = points[i];
      const py = points[i + 1];
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  return { x, y, width, height };
}

/**
 * Align multiple shapes horizontally (left, center, right).
 * Aligns all shapes to the first selected shape's position.
 */
export function alignShapesHorizontally(ydoc, ids, type) {
  if (ids.length < 2) return;
  
  const arr = shapesArray(ydoc);
  const shapes = [];
  const shapeMap = new Map();
  
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    const id = m.get('id');
    if (ids.includes(id)) {
      const shape = readShape(m);
      shapes.push(shape);
      shapeMap.set(id, { map: m, shape });
    }
  }

  if (shapes.length < 2) return;

  const bounds = shapes.map(s => getShapeBounds(s));
  let targetX = bounds[0].x;

  if (type === 'center') {
    targetX = bounds[0].x + bounds[0].width / 2;
    ydoc.transact(() => {
      for (let i = 1; i < shapes.length; i++) {
        const b = bounds[i];
        const newX = targetX - b.width / 2;
        shapeMap.get(ids[i]).map.set('x', newX);
        shapeMap.get(ids[i]).map.set('updatedAt', Date.now());
      }
    });
  } else if (type === 'right') {
    targetX = bounds[0].x + bounds[0].width;
    ydoc.transact(() => {
      for (let i = 1; i < shapes.length; i++) {
        const b = bounds[i];
        const newX = targetX - b.width;
        shapeMap.get(ids[i]).map.set('x', newX);
        shapeMap.get(ids[i]).map.set('updatedAt', Date.now());
      }
    });
  } else {
    // 'left' - align to left edge
    ydoc.transact(() => {
      for (let i = 1; i < shapes.length; i++) {
        shapeMap.get(ids[i]).map.set('x', targetX);
        shapeMap.get(ids[i]).map.set('updatedAt', Date.now());
      }
    });
  }
}

/**
 * Align multiple shapes vertically (top, center, bottom).
 */
export function alignShapesVertically(ydoc, ids, type) {
  if (ids.length < 2) return;
  
  const arr = shapesArray(ydoc);
  const shapes = [];
  const shapeMap = new Map();
  
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    const id = m.get('id');
    if (ids.includes(id)) {
      const shape = readShape(m);
      shapes.push(shape);
      shapeMap.set(id, { map: m, shape });
    }
  }

  if (shapes.length < 2) return;

  const bounds = shapes.map(s => getShapeBounds(s));
  let targetY = bounds[0].y;

  if (type === 'center') {
    targetY = bounds[0].y + bounds[0].height / 2;
    ydoc.transact(() => {
      for (let i = 1; i < shapes.length; i++) {
        const b = bounds[i];
        const newY = targetY - b.height / 2;
        shapeMap.get(ids[i]).map.set('y', newY);
        shapeMap.get(ids[i]).map.set('updatedAt', Date.now());
      }
    });
  } else if (type === 'bottom') {
    targetY = bounds[0].y + bounds[0].height;
    ydoc.transact(() => {
      for (let i = 1; i < shapes.length; i++) {
        const b = bounds[i];
        const newY = targetY - b.height;
        shapeMap.get(ids[i]).map.set('y', newY);
        shapeMap.get(ids[i]).map.set('updatedAt', Date.now());
      }
    });
  } else {
    // 'top' - align to top edge
    ydoc.transact(() => {
      for (let i = 1; i < shapes.length; i++) {
        shapeMap.get(ids[i]).map.set('y', targetY);
        shapeMap.get(ids[i]).map.set('updatedAt', Date.now());
      }
    });
  }
}

/**
 * Distribute shapes horizontally with equal spacing.
 * Arranges shapes so gaps between them are equal.
 */
export function distributeShapesHorizontally(ydoc, ids) {
  if (ids.length < 3) return;
  
  const arr = shapesArray(ydoc);
  const shapes = [];
  const shapeMap = new Map();
  
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    const id = m.get('id');
    if (ids.includes(id)) {
      const shape = readShape(m);
      shapes.push(shape);
      shapeMap.set(id, { map: m, shape, idx: i });
    }
  }

  if (shapes.length < 3) return;

  const bounds = shapes.map(s => getShapeBounds(s));
  
  // Sort by x position
  const sorted = bounds.map((b, i) => ({ bound: b, id: ids[i], idx: i }))
    .sort((a, b) => a.bound.x - b.bound.x);

  // Calculate total space and gaps
  const firstX = sorted[0].bound.x + sorted[0].bound.width;
  const lastX = sorted[sorted.length - 1].bound.x;
  const totalSpace = lastX - firstX;
  const gap = totalSpace / (sorted.length - 1);

  ydoc.transact(() => {
    for (let i = 1; i < sorted.length - 1; i++) {
      const newX = firstX + (gap * i) - sorted[i].bound.width / 2;
      shapeMap.get(sorted[i].id).map.set('x', newX);
      shapeMap.get(sorted[i].id).map.set('updatedAt', Date.now());
    }
  });
}

/**
 * Distribute shapes vertically with equal spacing.
 */
export function distributeShapesVertically(ydoc, ids) {
  if (ids.length < 3) return;
  
  const arr = shapesArray(ydoc);
  const shapes = [];
  const shapeMap = new Map();
  
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    const id = m.get('id');
    if (ids.includes(id)) {
      const shape = readShape(m);
      shapes.push(shape);
      shapeMap.set(id, { map: m, shape, idx: i });
    }
  }

  if (shapes.length < 3) return;

  const bounds = shapes.map(s => getShapeBounds(s));
  
  // Sort by y position
  const sorted = bounds.map((b, i) => ({ bound: b, id: ids[i], idx: i }))
    .sort((a, b) => a.bound.y - b.bound.y);

  // Calculate total space and gaps
  const firstY = sorted[0].bound.y + sorted[0].bound.height;
  const lastY = sorted[sorted.length - 1].bound.y;
  const totalSpace = lastY - firstY;
  const gap = totalSpace / (sorted.length - 1);

  ydoc.transact(() => {
    for (let i = 1; i < sorted.length - 1; i++) {
      const newY = firstY + (gap * i) - sorted[i].bound.height / 2;
      shapeMap.get(sorted[i].id).map.set('y', newY);
      shapeMap.get(sorted[i].id).map.set('updatedAt', Date.now());
    }
  });
}
