import { shapePoints } from './shapes.jsx';

/**
 * The connector geometry engine.
 *
 * A connector is a flat record in the SAME shapes array as everything else:
 *
 *   {
 *     type: 'connector',
 *     start: { x, y, shapeId?, anchor? },   // anchor: 'n'|'e'|'s'|'w'|'auto'
 *     end:   { x, y, shapeId?, anchor? },
 *     waypoints: [x1, y1, x2, y2, ...],     // user-inserted bend points
 *     routing: 'straight' | 'elbow' | 'curved',
 *     curvature: 0..1,                      // spline tension for curved mode
 *     cornerRadius: px,                     // rounded elbows
 *     startHead / endHead: 'none'|'filled'|'hollow'|'open'|'block'|'bar',
 *     stroke, strokeWidth, dash, opacity, locked, zIndex
 *   }
 *
 * DESIGN PRINCIPLE: endpoints attached to a shape store the shapeId + anchor,
 * and their live position is DERIVED at render time from wherever that shape is
 * right now. Nothing ever "reconnects" because nothing ever disconnects — move
 * shape A and every connector touching it recomputes on the next render, for
 * every client, with zero extra network traffic. The cached x/y on an endpoint
 * is only the fallback used if the shape is later deleted.
 */

export const ANCHOR_IDS = ['n', 'e', 's', 'w'];
export const SNAP_RADIUS = 14;      // px (world units) to snap onto an anchor dot
export const BODY_SNAP_PAD = 8;     // hovering this close to a shape body = attach

// ---------------------------------------------------------------- geometry

const deg2rad = (d) => (d * Math.PI) / 180;

export function rotateAround(px, py, cx, cy, deg) {
  if (!deg) return { x: px, y: py };
  const a = deg2rad(deg);
  const dx = px - cx;
  const dy = py - cy;
  return {
    x: cx + dx * Math.cos(a) - dy * Math.sin(a),
    y: cy + dx * Math.sin(a) + dy * Math.cos(a)
  };
}

/**
 * Konva rotates centred shapes (circle/ellipse/star) around their centre and
 * everything else around its top-left. This mirrors ShapeNode exactly so the
 * outline we intersect against is the outline the user actually sees.
 */
function rotationOrigin(shape) {
  const w = shape.width || 0;
  const h = shape.height || 0;
  if (shape.type === 'circle' || shape.type === 'ellipse' || shape.type === 'star') {
    return { x: shape.x + w / 2, y: shape.y + h / 2 };
  }
  return { x: shape.x, y: shape.y };
}

/** Sample the visible outline of a shape as a world-space polygon. */
export function shapeOutline(shape) {
  const w = Math.max(shape.width || 0, 1);
  const h = Math.max(shape.height || 0, 1);
  const sx = shape.scaleX || 1;
  const sy = shape.scaleY || 1;
  const origin = rotationOrigin(shape);
  const place = (lx, ly) =>
    rotateAround(shape.x + lx * sx, shape.y + ly * sy, origin.x, origin.y, shape.rotation || 0);

  let local = [];
  switch (shape.type) {
    case 'circle': {
      const r = Math.min(w, h) / 2;
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        local.push({ x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) });
      }
      break;
    }
    case 'ellipse': {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        local.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) });
      }
      break;
    }
    case 'star': {
      const outer = Math.min(w, h) / 2;
      const inner = outer / 2;
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        local.push({ x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) });
      }
      break;
    }
    case 'text':
    case 'path':
    case 'line':
    case 'image':
    case 'heart':
    case 'cloud':
    case 'rect':
    case 'roundRect': {
      local = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
      break;
    }
    default: {
      // every polygon type routes through the shared shapePoints() generator
      const flat = shapePoints(shape.type, w, h);
      for (let i = 0; i < flat.length; i += 2) local.push({ x: flat[i], y: flat[i + 1] });
      if (local.length < 3) {
        local = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
      }
    }
  }
  return local.map((p) => place(p.x, p.y));
}

export function shapeCenter(shape) {
  const w = (shape.width || 0) * (shape.scaleX || 1);
  const h = (shape.height || 0) * (shape.scaleY || 1);
  const origin = rotationOrigin(shape);
  return rotateAround(shape.x + w / 2, shape.y + h / 2, origin.x, origin.y, shape.rotation || 0);
}

/** The four named anchor dots (edge midpoints of the rotated bounding box). */
export function anchorPoint(shape, anchor) {
  const w = (shape.width || 0) * (shape.scaleX || 1);
  const h = (shape.height || 0) * (shape.scaleY || 1);
  const origin = rotationOrigin(shape);
  const locals = {
    n: { x: shape.x + w / 2, y: shape.y },
    s: { x: shape.x + w / 2, y: shape.y + h },
    w: { x: shape.x, y: shape.y + h / 2 },
    e: { x: shape.x + w, y: shape.y + h / 2 }
  };
  const p = locals[anchor] || locals.e;
  return rotateAround(p.x, p.y, origin.x, origin.y, shape.rotation || 0);
}

export function anchorPoints(shape) {
  return ANCHOR_IDS.map((id) => ({ id, ...anchorPoint(shape, id) }));
}

// segment intersection helper
function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y), t };
}

/**
 * Smart attachment: the point where the segment centre->towards leaves the
 * shape's REAL outline (circle edge, diamond edge, triangle edge — not the
 * bounding box). This is what makes 'auto' anchors slide around the perimeter
 * as the other end moves.
 */
export function edgePoint(shape, towards) {
  const c = shapeCenter(shape);
  const poly = shapeOutline(shape);
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const hit = segIntersect(c, towards, poly[i], poly[(i + 1) % poly.length]);
    if (hit && (!best || hit.t > best.t)) best = hit; // furthest from centre
  }
  return best ? { x: best.x, y: best.y } : c;
}

// ---------------------------------------------------------------- endpoints

/**
 * Resolve one endpoint of a connector to live world coordinates.
 * `other` is the neighbouring point on the route (used by 'auto' anchors).
 */
export function resolveEndpoint(end, shapesById, other) {
  if (!end) return { x: 0, y: 0 };
  const shape = end.shapeId ? shapesById.get(end.shapeId) : null;
  if (!shape) return { x: end.x || 0, y: end.y || 0 }; // detached or shape deleted
  if (end.anchor && end.anchor !== 'auto') return anchorPoint(shape, end.anchor);
  return edgePoint(shape, other || shapeCenter(shape));
}

/**
 * Full route of a connector: [start, ...waypoints, end], with 'auto' anchors
 * aimed at their nearest neighbour on the route so the attachment point tracks
 * whatever the connector is actually doing.
 */
export function connectorRoute(conn, shapesById) {
  const way = [];
  const flat = conn.waypoints || [];
  for (let i = 0; i + 1 < flat.length; i += 2) way.push({ x: flat[i], y: flat[i + 1] });

  const startShape = conn.start?.shapeId ? shapesById.get(conn.start.shapeId) : null;
  const endShape = conn.end?.shapeId ? shapesById.get(conn.end.shapeId) : null;

  // aim targets for auto anchors: first/last waypoint, else the other endpoint
  const aimForStart =
    way[0] ||
    (endShape ? shapeCenter(endShape) : { x: conn.end?.x || 0, y: conn.end?.y || 0 });
  const aimForEnd =
    way[way.length - 1] ||
    (startShape ? shapeCenter(startShape) : { x: conn.start?.x || 0, y: conn.start?.y || 0 });

  const start = resolveEndpoint(conn.start, shapesById, aimForStart);
  const end = resolveEndpoint(conn.end, shapesById, aimForEnd);
  return [start, ...way, end];
}

// ------------------------------------------------------------------ routing

/**
 * Turn the logical route into the polyline that is actually drawn.
 * 'elbow' inserts axis-aligned segments between consecutive points, giving the
 * classic H-V-H flowchart look; every user waypoint stays a draggable corner.
 */
export function displayPoints(conn, route) {
  if (conn.routing !== 'elbow') return route;
  const out = [route[0]];
  for (let i = 1; i < route.length; i++) {
    const p = out[out.length - 1];
    const q = route[i];
    if (Math.abs(p.x - q.x) > 0.5 && Math.abs(p.y - q.y) > 0.5) {
      // alternate horizontal-first / vertical-first so chains of waypoints
      // produce the H-V-H-V-H pattern instead of a staircase of same-direction Ls
      const horizontalFirst = i % 2 === 1;
      out.push(horizontalFirst ? { x: q.x, y: p.y } : { x: p.x, y: q.y });
    }
    out.push(q);
  }
  return out;
}

/** Catmull-Rom -> cubic Bezier segments for smooth curved connectors. */
export function catmullRomBeziers(pts, tension = 0.5) {
  if (pts.length < 3) return [];
  const t = Math.max(0.05, Math.min(1, tension));
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    segs.push({
      c1: { x: p1.x + ((p2.x - p0.x) / 6) * t * 2, y: p1.y + ((p2.y - p0.y) / 6) * t * 2 },
      c2: { x: p2.x - ((p3.x - p1.x) / 6) * t * 2, y: p2.y - ((p3.y - p1.y) / 6) * t * 2 },
      to: p2
    });
  }
  return segs;
}

/** Direction (radians) the line arrives at its first / last point. */
export function terminalAngles(conn, pts) {
  const first = pts[0];
  const last = pts[pts.length - 1];
  let inward = pts[1] || last;
  let outward = pts[pts.length - 2] || first;
  if (conn.routing === 'curved' && pts.length > 2) {
    const segs = catmullRomBeziers(pts, conn.curvature ?? 0.5);
    if (segs.length) {
      inward = segs[0].c1;
      outward = segs[segs.length - 1].c2;
    }
  }
  return {
    start: Math.atan2(first.y - inward.y, first.x - inward.x),
    end: Math.atan2(last.y - outward.y, last.x - outward.x)
  };
}

// ----------------------------------------------------------------- snapping

/** Squared distance helper. */
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * What should a connector endpoint attach to at this pointer position?
 * Returns { shapeId, anchor, x, y } (anchor may be 'auto' for a body hover)
 * or null for empty canvas. Skips connectors themselves and any excluded ids.
 */
export function findSnapTarget(point, shapes, excludeIds = []) {
  let best = null;
  for (const s of shapes) {
    if (s.type === 'connector' || s.type === 'path' || s.type === 'image') continue;
    if (excludeIds.includes(s.id)) continue;

    // 1. exact anchor dots win
    for (const a of anchorPoints(s)) {
      const dist2 = d2(a, point);
      if (dist2 <= SNAP_RADIUS ** 2 && (!best || dist2 < best.dist2)) {
        best = { shapeId: s.id, anchor: a.id, x: a.x, y: a.y, dist2 };
      }
    }
    if (best && best.dist2 <= 25) continue; // dead-on an anchor, done with this shape

    // 2. hovering the body = smart 'auto' edge attachment
    const w = (s.width || 0) * (s.scaleX || 1);
    const h = (s.height || 0) * (s.scaleY || 1);
    const c = shapeCenter(s);
    const half = { x: w / 2 + BODY_SNAP_PAD, y: h / 2 + BODY_SNAP_PAD };
    const local = rotateAround(point.x, point.y, c.x, c.y, -(s.rotation || 0));
    if (Math.abs(local.x - c.x) <= half.x && Math.abs(local.y - c.y) <= half.y) {
      const edge = edgePoint(s, point);
      const dist2 = d2(edge, point) + 1; // anchors beat body hits at equal distance
      if (!best || dist2 < best.dist2) {
        best = { shapeId: s.id, anchor: 'auto', x: edge.x, y: edge.y, dist2 };
      }
    }
  }
  if (!best) return null;
  const { dist2: _drop, ...target } = best;
  return target;
}

/** Index of the display segment nearest to a point (for inserting bends). */
export function nearestSegment(pts, point) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len2 = d2(a, b) || 1;
    let t = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / len2;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    const dist = d2(proj, point);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Insert a bend point into the flat waypoints array so it lands on the segment
 * the user actually clicked. Waypoint k sits between route points k and k+1,
 * so a click on route segment i inserts at waypoint index i.
 */
export function insertWaypoint(conn, route, point) {
  const seg = nearestSegment(route, point);
  const flat = [...(conn.waypoints || [])];
  const idx = Math.min(seg, flat.length / 2);
  flat.splice(idx * 2, 0, point.x, point.y);
  return flat;
}
