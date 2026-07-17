import { forwardRef } from 'react';
import { Shape } from 'react-konva';
import { catmullRomBeziers, terminalAngles } from './connectors.js';

/**
 * Renders one connector: line body (straight / rounded elbow / smooth curve)
 * plus its two arrowheads, all inside a single custom Konva Shape so hit
 * testing, dashing and opacity behave exactly like any other node.
 *
 * The RESOLVED display points are passed in from Canvas (which owns live shape
 * positions), so this component is pure drawing — it never touches the doc.
 */

const HEAD_KINDS = ['filled', 'hollow', 'open', 'block', 'bar'];

export function headLength(head, strokeWidth) {
  if (!head || head === 'none') return 0;
  const base = Math.max(9, (strokeWidth || 2) * 3.2);
  return head === 'block' ? base * 0.8 : head === 'bar' ? 0 : base;
}

/** Draw one arrowhead at (tip) pointing along angle. */
function drawHead(ctx, kind, tip, angle, strokeWidth, stroke) {
  if (!HEAD_KINDS.includes(kind)) return;
  const len = Math.max(9, (strokeWidth || 2) * 3.2);
  const wid = len * 0.62;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (dx, dy) => ({
    x: tip.x + dx * cos - dy * sin,
    y: tip.y + dx * sin + dy * cos
  });

  ctx.save();
  ctx.setLineDash([]); // heads are always solid even on dashed lines
  ctx.lineWidth = Math.max(1.2, strokeWidth || 2);
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  ctx.lineJoin = 'round';

  if (kind === 'filled' || kind === 'hollow') {
    const a = at(-len, wid / 2);
    const b = at(-len, -wid / 2);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.closePath();
    if (kind === 'hollow') {
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fill();
    }
  } else if (kind === 'open') {
    const a = at(-len, wid / 2);
    const b = at(-len, -wid / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  } else if (kind === 'block') {
    const s = len * 0.8;
    const p1 = at(0, s / 2);
    const p2 = at(-s, s / 2);
    const p3 = at(-s, -s / 2);
    const p4 = at(0, -s / 2);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'bar') {
    const a = at(0, wid * 0.75);
    const b = at(0, -wid * 0.75);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Pull a terminal point back so the line doesn't poke through its head. */
function shorten(p, angle, by) {
  if (!by) return p;
  return { x: p.x - Math.cos(angle) * by, y: p.y - Math.sin(angle) * by };
}

/** Trace the connector body onto a canvas path (shared by scene + hit). */
function traceBody(ctx, conn, pts, angles) {
  const startTrim = headLength(conn.startHead, conn.strokeWidth) * 0.75;
  const endTrim = headLength(conn.endHead, conn.strokeWidth) * 0.75;
  const body = pts.map((p) => ({ ...p }));
  body[0] = shorten(body[0], angles.start, startTrim);
  body[body.length - 1] = shorten(body[body.length - 1], angles.end, endTrim);

  ctx.beginPath();
  ctx.moveTo(body[0].x, body[0].y);

  if (conn.routing === 'curved' && body.length > 2) {
    for (const s of catmullRomBeziers(body, conn.curvature ?? 0.5)) {
      ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y);
    }
    return;
  }

  const r = conn.routing === 'elbow' ? conn.cornerRadius ?? 8 : conn.cornerRadius ?? 0;
  if (!r || body.length < 3) {
    for (let i = 1; i < body.length; i++) ctx.lineTo(body[i].x, body[i].y);
    return;
  }
  // rounded corners at every interior vertex
  for (let i = 1; i < body.length - 1; i++) {
    const p = body[i - 1];
    const v = body[i];
    const n = body[i + 1];
    const inLen = Math.hypot(v.x - p.x, v.y - p.y);
    const outLen = Math.hypot(n.x - v.x, n.y - v.y);
    const rad = Math.min(r, inLen / 2, outLen / 2);
    if (rad < 0.5 || !inLen || !outLen) {
      ctx.lineTo(v.x, v.y);
      continue;
    }
    const inPt = { x: v.x - ((v.x - p.x) / inLen) * rad, y: v.y - ((v.y - p.y) / inLen) * rad };
    const outPt = { x: v.x + ((n.x - v.x) / outLen) * rad, y: v.y + ((n.y - v.y) / outLen) * rad };
    ctx.lineTo(inPt.x, inPt.y);
    ctx.quadraticCurveTo(v.x, v.y, outPt.x, outPt.y);
  }
  ctx.lineTo(body[body.length - 1].x, body[body.length - 1].y);
}

const ConnectorNode = forwardRef(function ConnectorNode(
  { conn, pts, onSelect, onDblClick },
  ref
) {
  if (!pts || pts.length < 2) return null;
  const angles = terminalAngles(conn, pts);
  const stroke = conn.stroke || '#111827';
  const strokeWidth = conn.strokeWidth ?? 2;

  return (
    <Shape
      ref={ref}
      id={conn.id}
      opacity={conn.opacity ?? 1}
      // These attrs are what Konva's hit graph reads (hasHitStroke etc.).
      // The visible line is drawn manually in sceneFunc; the fat hitStrokeWidth
      // keeps a 1px connector easy to grab.
      stroke={stroke}
      strokeWidth={Math.max(0.5, strokeWidth)}
      hitStrokeWidth={Math.max(14, strokeWidth + 10)}
      onMouseDown={onSelect}
      onTap={onSelect}
      onDblClick={onDblClick}
      onDblTap={onDblClick}
      // custom drawing --------------------------------------------------
      sceneFunc={(context, shapeNode) => {
        const ctx = context._context;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.max(0.5, strokeWidth);
        if (conn.dash) ctx.setLineDash(conn.dash);
        traceBody(ctx, conn, pts, angles);
        ctx.stroke();
        ctx.setLineDash([]);
        drawHead(ctx, conn.startHead, pts[0], angles.start, strokeWidth, stroke);
        drawHead(ctx, conn.endHead, pts[pts.length - 1], angles.end, strokeWidth, stroke);
        ctx.restore();
      }}
      // hit region: the same path, stroked fat (never filled — filling an open
      // polyline would make the whole enclosed area clickable) ------------
      hitFunc={(context, shapeNode) => {
        traceBody(context._context, conn, pts, angles);
        context.strokeShape(shapeNode);
      }}
    />
  );
});

export default ConnectorNode;
