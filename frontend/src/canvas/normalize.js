import { COMMON_DEFAULTS } from './shapes.jsx';

/**
 * The gate between the shared document and the renderer.
 *
 * Yjs guarantees that everyone converges on the SAME document — it does not
 * guarantee that the document is well-formed. A record can legitimately arrive
 * here half-built: an older client version, an interrupted transaction, a
 * hand-edited persisted snapshot, a field an undo rolled back to `undefined`,
 * or simply a shape whose creation raced with a peer's delete.
 *
 * Konva reacts badly to NaN/Infinity/null geometry (a single NaN in a points
 * array silently poisons an entire canvas path), so every record is coerced to
 * something drawable HERE, once, before it can reach a Konva node.
 *
 * Everything in this file is pure — no React, no Konva, no document access —
 * so it is testable headlessly.
 */

/** Finite number or fallback. Rejects NaN, Infinity, null, '', objects. */
const num = (v, fallback = 0) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Finite, non-negative number (sizes, widths, radii). */
const size = (v, fallback = 0) => Math.max(0, num(v, fallback));

/** A colour-ish string, or the fallback. */
const color = (v, fallback) =>
  typeof v === 'string' && v.trim() ? v : fallback;

/** Clamp into [lo, hi]. */
const clamp = (v, lo, hi, fallback) => {
  const n = num(v, fallback);
  return Math.min(hi, Math.max(lo, n));
};

/**
 * A flat [x0,y0,x1,y1,...] array with every entry finite and an even length.
 * Non-finite entries are dropped in PAIRS so x/y never desynchronise — a
 * half-dropped coordinate would shear the whole stroke.
 */
export function cleanPoints(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (let i = 0; i + 1 < v.length; i += 2) {
    const x = Number(v[i]);
    const y = Number(v[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push(x, y);
  }
  return out;
}

/** A connector endpoint: always an object with finite x/y. */
function cleanEndpoint(e) {
  if (!e || typeof e !== 'object') return { x: 0, y: 0 };
  const out = { x: num(e.x, 0), y: num(e.y, 0) };
  if (typeof e.shapeId === 'string' && e.shapeId) out.shapeId = e.shapeId;
  if (typeof e.anchor === 'string' && e.anchor) out.anchor = e.anchor;
  return out;
}

const DASH_OK = (d) =>
  Array.isArray(d) && d.length > 0 && d.every((n) => Number.isFinite(Number(n)) && Number(n) >= 0);

/**
 * Normalise ONE record read out of the Yjs document into something that is
 * always safe to hand to Konva.
 *
 * `index` is only used to synthesise a stable key if a record somehow has no
 * id — React needs a key and a duplicate/undefined key is its own class of
 * rendering bug.
 */
export function normalizeShape(raw, index = 0) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const d = COMMON_DEFAULTS();

  // ---- identity & metadata -------------------------------------------
  const id = typeof s.id === 'string' && s.id ? s.id : `__orphan-${index}`;

  // Legacy Milestone-0 freehand had { id, color, points } and no `type`.
  let type = typeof s.type === 'string' && s.type ? s.type : null;
  if (!type) type = Array.isArray(s.points) || s.points ? 'path' : 'rect';

  const out = {
    ...s,
    id,
    type,
    creator: typeof s.creator === 'string' ? s.creator : 'anon',
    createdAt: num(s.createdAt, 0),
    updatedAt: num(s.updatedAt, 0),
    zIndex: num(s.zIndex, 0),
    locked: s.locked === true,

    // ---- transform ---------------------------------------------------
    x: num(s.x, 0),
    y: num(s.y, 0),
    rotation: num(s.rotation, 0),
    // a zero scale collapses a node and makes the Transformer produce NaN
    scaleX: num(s.scaleX, 1) || 1,
    scaleY: num(s.scaleY, 1) || 1,
    opacity: clamp(s.opacity, 0, 1, 1),

    // ---- paint -------------------------------------------------------
    fill: color(s.fill, d.fill),
    stroke: color(s.stroke, s.color /* legacy field */ || d.stroke),
    strokeWidth: size(s.strokeWidth, d.strokeWidth),
    dash: DASH_OK(s.dash) ? s.dash.map(Number) : null,
    cornerRadius: size(s.cornerRadius, 0),

    // ---- effects -----------------------------------------------------
    fillType: ['solid', 'linear', 'radial'].includes(s.fillType) ? s.fillType : 'solid',
    fillGradientStart: color(s.fillGradientStart, d.fillGradientStart),
    fillGradientEnd: color(s.fillGradientEnd, d.fillGradientEnd),
    fillGradientAngle: num(s.fillGradientAngle, 0),
    shadowEnabled: s.shadowEnabled === true,
    shadowColor: color(s.shadowColor, d.shadowColor),
    shadowBlur: size(s.shadowBlur, d.shadowBlur),
    shadowOffsetX: num(s.shadowOffsetX, d.shadowOffsetX),
    shadowOffsetY: num(s.shadowOffsetY, d.shadowOffsetY),
    shadowOpacity: clamp(s.shadowOpacity, 0, 1, d.shadowOpacity),
    blurRadius: size(s.blurRadius, 0)
  };

  // ---- dimensions ------------------------------------------------------
  // Lines and freehand paths carry their geometry in `points`; everything else
  // needs a real box. A 0x0 box is legal (mid-drag) but NaN never is.
  if (s.width != null || s.height != null) {
    out.width = size(s.width, 0);
    out.height = size(s.height, 0);
  }

  // ---- per-type geometry ----------------------------------------------
  if (type === 'path' || type === 'line') {
    out.points = cleanPoints(s.points);
  } else if (Array.isArray(s.points)) {
    out.points = cleanPoints(s.points);
  }

  if (type === 'connector') {
    out.start = cleanEndpoint(s.start);
    out.end = cleanEndpoint(s.end);
    out.waypoints = cleanPoints(s.waypoints);
    out.routing = ['straight', 'elbow', 'curved'].includes(s.routing) ? s.routing : 'straight';
    out.curvature = clamp(s.curvature, 0.05, 1, 0.5);
    out.startHead = typeof s.startHead === 'string' ? s.startHead : 'none';
    out.endHead = typeof s.endHead === 'string' ? s.endHead : 'filled';
    // a connector's own x/y are meaningless; its geometry is its endpoints
    out.x = 0;
    out.y = 0;
  }

  if (type === 'text') {
    out.text = typeof s.text === 'string' ? s.text : String(s.text ?? '');
    out.fontSize = Math.max(1, size(s.fontSize, 20)) || 20;
    out.fontFamily = color(s.fontFamily, 'Inter');
    out.lineHeight = clamp(s.lineHeight, 0.5, 5, 1.2);
    out.align = ['left', 'center', 'right'].includes(s.align) ? s.align : 'left';
    out.italic = s.italic === true;
    out.underline = s.underline === true;
    out.fontWeight = s.fontWeight === 'bold' ? 'bold' : 'normal';
  }

  if (type === 'path') {
    out.brush = typeof s.brush === 'string' ? s.brush : 'pen';
    out.smoothing = s.smoothing !== false;
    out.pressure = s.pressure === true;
    out.nibAngle = num(s.nibAngle, 45);
  }

  if (type === 'image') {
    out.src = typeof s.src === 'string' ? s.src : '';
    out.crop =
      s.crop && typeof s.crop === 'object'
        ? {
            x: num(s.crop.x, 0),
            y: num(s.crop.y, 0),
            width: size(s.crop.width, 0),
            height: size(s.crop.height, 0)
          }
        : null;
  }

  return out;
}

/**
 * Normalise a whole snapshot. Also de-duplicates ids: two records sharing an id
 * would give React duplicate keys, which makes it reuse/destroy the wrong Konva
 * node and produces "shapes that won't select" or vanish on re-render.
 */
export function normalizeShapes(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = normalizeShape(list[i], i);
    if (seen.has(s.id)) s.id = `${s.id}__dup${i}`;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}
