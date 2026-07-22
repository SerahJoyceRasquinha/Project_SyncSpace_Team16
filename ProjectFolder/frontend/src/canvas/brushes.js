/**
 * The brush + eraser engine for the Pen tool.
 *
 * DESIGN: a freehand stroke is still an ordinary `type: 'path'` record in the
 * SAME ydoc.getArray('shapes') as every other object — it just carries a few
 * extra fields so it can render as any of several brush styles:
 *
 *   { type: 'path', brush, points:[x0,y0,x1,y1,...], stroke, strokeWidth,
 *     opacity, dash, nibAngle?, ... }
 *
 * Because it is a normal shape record, it gets selection, deletion, undo/redo,
 * property edits, locking, layer order, duplication, persistence and real-time
 * sync for free — the exact code paths every other shape uses. Nothing here
 * touches the sync protocol.
 *
 * Everything in this file is pure geometry / pure data, so it is unit-testable
 * headlessly (see test-brushes.mjs) without a browser or Konva.
 */

// ---------------------------------------------------------------- registry
export const BRUSHES = [
  { id: 'pen',         label: 'Pen',         width: 4,  opacity: 1,    dash: null,   comp: 'source-over', cap: 'round', tension: 0.4 },
  { id: 'pencil',      label: 'Pencil',      width: 2,  opacity: 0.75, dash: null,   comp: 'source-over', cap: 'round', tension: 0.2 },
  { id: 'marker',      label: 'Marker',      width: 12, opacity: 0.92, dash: null,   comp: 'source-over', cap: 'round', tension: 0.35 },
  { id: 'highlighter', label: 'Highlighter', width: 18, opacity: 0.35, dash: null,   comp: 'multiply',    cap: 'butt',  tension: 0 },
  { id: 'calligraphy', label: 'Calligraphy', width: 14, opacity: 1,    dash: null,   comp: 'source-over', cap: 'round', tension: 0 },
  { id: 'dashed',      label: 'Dashed',      width: 4,  opacity: 1,    dash: 'dash', comp: 'source-over', cap: 'butt',  tension: 0.3 },
  { id: 'dotted',      label: 'Dotted',      width: 4,  opacity: 1,    dash: 'dot',  comp: 'source-over', cap: 'round', tension: 0.3 }
];

export const BRUSH_BY_ID = Object.fromEntries(BRUSHES.map((b) => [b.id, b]));

export function brushDef(id) {
  return BRUSH_BY_ID[id] || BRUSH_BY_ID.pen;
}

/** A palette that reads well on the white canvas. */
export const PEN_PALETTE = [
  '#111827', '#374151', '#6b7280', '#ef4444', '#f59e0b', '#eab308',
  '#22c55e', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
  '#ec4899', '#f43f5e', '#ffffff'
];

/** The first-run defaults for the Pen tool. Persisted per browser thereafter. */
export const DEFAULT_PEN_SETTINGS = {
  brush: 'pen',
  color: '#111827',
  size: 4,
  opacity: 1,
  smoothing: true,
  pressure: false,
  nibAngle: 45
};

export const DEFAULT_ERASER_SETTINGS = { size: 24 };

/**
 * Turn a brush's dash keyword into a concrete Konva dash array, scaled to the
 * stroke width so dashes/dots stay proportional at any thickness.
 */
export function dashArray(brush, width) {
  const w = Math.max(1, width);
  if (brush === 'dashed') return [w * 2.2, w * 1.8];
  if (brush === 'dotted') return [0.01, w * 2]; // round cap + ~0 dash = dots
  return null;
}

// ---------------------------------------------------------------- smoothing
/**
 * Chaikin corner-cutting: one pass roughly doubles the point count while
 * rounding every corner, so a shaky mouse path renders as a smooth curve.
 * Endpoints are preserved. Runs in O(n).
 */
export function chaikin(flat, iterations = 1) {
  let pts = flat;
  for (let it = 0; it < iterations; it++) {
    if (pts.length <= 4) break;
    const out = [pts[0], pts[1]];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i], y0 = pts[i + 1];
      const x1 = pts[i + 2], y1 = pts[i + 3];
      out.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25);
      out.push(x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75);
    }
    out.push(pts[pts.length - 2], pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/**
 * Ramer–Douglas–Peucker simplification. Drops points that lie within `epsilon`
 * of the line they sit on, so a densely-sampled mouse path is stored compactly
 * (smaller records, cheaper sync, faster redraw) without visibly changing shape.
 */
export function simplify(flat, epsilon = 0.6) {
  const n = flat.length / 2;
  if (n < 3) return flat.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const px = (i) => flat[i * 2];
  const py = (i) => flat[i * 2 + 1];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    const ax = px(a), ay = py(a), bx = px(b), by = py(b);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const t = ((px(i) - ax) * dx + (py(i) - ay) * dy) / len2;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = (px(i) - cx) ** 2 + (py(i) - cy) ** 2;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon * epsilon && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(px(i), py(i));
  return out;
}

/** Rendering-time point prep: simplify a touch, then round corners if asked. */
export function renderPoints(flat, { smoothing } = {}) {
  if (!flat || flat.length < 4) return flat || [];
  return smoothing ? chaikin(simplify(flat, 0.4), 1) : flat;
}

// ---------------------------------------------------------------- calligraphy
/**
 * Build a filled ribbon polygon for a broad-nib calligraphy stroke. The nib is
 * a flat edge held at `nibAngle`; the visible thickness at each point is the
 * projection of that edge onto the stroke's normal, so travel perpendicular to
 * the nib is thick and travel parallel to it tapers thin — the classic
 * copperplate swell. With `pressure`, fast travel (points spaced further apart)
 * also thins the line, simulating a lighter, quicker hand.
 *
 * Returns a flat, CLOSED point array to render as one filled Konva Line.
 */
export function calligraphyRibbon(flat, width, nibAngle = 45, pressure = false) {
  const n = flat.length / 2;
  if (n < 2) return null;
  const maxHalf = Math.max(1, width) / 2;
  const minRatio = 0.18;
  const nib = (nibAngle * Math.PI) / 180;
  const nx = Math.cos(nib), ny = Math.sin(nib);

  const P = (i) => [flat[i * 2], flat[i * 2 + 1]];
  const left = [];
  const right = [];

  // spacing stats for the (optional) speed→width mapping
  let avg = 0;
  if (pressure) {
    let tot = 0;
    for (let i = 1; i < n; i++) {
      const [x0, y0] = P(i - 1), [x1, y1] = P(i);
      tot += Math.hypot(x1 - x0, y1 - y0);
    }
    avg = tot / Math.max(1, n - 1);
  }

  for (let i = 0; i < n; i++) {
    const [x, y] = P(i);
    // travel direction from neighbours
    const [ax, ay] = P(Math.max(0, i - 1));
    const [bx, by] = P(Math.min(n - 1, i + 1));
    let tx = bx - ax, ty = by - ay;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    // thickness = how perpendicular travel is to the nib edge
    let ratio = Math.abs(tx * ny - ty * nx); // |cross(travel, nibDir)|
    ratio = minRatio + (1 - minRatio) * ratio;
    let half = maxHalf * ratio;
    if (pressure && avg > 0) {
      const speed = tl / avg; // >1 = faster than average
      half *= Math.max(0.45, Math.min(1.3, 1.15 - 0.35 * (speed - 1)));
    }
    // offset along the stroke normal
    const ox = -ty * half, oy = tx * half;
    left.push(x + ox, y + oy);
    right.push(x - ox, y - oy);
  }
  // left edge forward, right edge backward -> closed ribbon
  const poly = left.slice();
  for (let i = n - 1; i >= 0; i--) poly.push(right[i * 2], right[i * 2 + 1]);
  return poly;
}

// ---------------------------------------------------------------- eraser
/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
export function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** Cheap axis-aligned bounds of a flat point array (for skip tests). */
export function pointsBounds(flat) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i], y = flat[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Mark which vertices of a stroke fall under an eraser stamp (a circle of
 * `radius` centred at ex,ey). A vertex is erased if it is inside the circle OR
 * either segment touching it passes through the circle — so a fast eraser
 * crossing a long straight run still bites cleanly. Accumulates into `into`.
 */
export function markErased(flat, ex, ey, radius, into) {
  const r2 = radius * radius;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const x = flat[i * 2], y = flat[i * 2 + 1];
    if ((x - ex) ** 2 + (y - ey) ** 2 <= r2) { into.add(i); continue; }
    if (i + 1 < n) {
      const x1 = flat[(i + 1) * 2], y1 = flat[(i + 1) * 2 + 1];
      if (segDist2(ex, ey, x, y, x1, y1) <= r2) { into.add(i); into.add(i + 1); }
    }
  }
  return into;
}

/**
 * Given a stroke's points and the set of erased vertex indices, return the
 * SURVIVING runs — each a contiguous flat point array of length >= 2 points.
 * The gap left by the eraser becomes a clean break, so one stroke split down
 * the middle yields two independent strokes and the rest is preserved.
 */
export function surviveRuns(flat, erased) {
  const n = flat.length / 2;
  const runs = [];
  let cur = [];
  for (let i = 0; i < n; i++) {
    if (erased.has(i)) {
      if (cur.length >= 4) runs.push(cur);
      cur = [];
    } else {
      cur.push(flat[i * 2], flat[i * 2 + 1]);
    }
  }
  if (cur.length >= 4) runs.push(cur);
  return runs;
}
