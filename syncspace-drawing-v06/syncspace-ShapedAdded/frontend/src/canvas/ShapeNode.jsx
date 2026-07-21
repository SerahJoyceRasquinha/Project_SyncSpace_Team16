import { forwardRef, memo } from 'react';
import { Line, Rect, Circle, Ellipse, Star, Path, Text } from 'react-konva';
import { shapePoints, heartPath, cloudPath } from './shapes.jsx';
import { brushDef, dashArray, renderPoints, calligraphyRibbon } from './brushes.js';

/**
 * Render a freehand stroke according to its `brush`. Every branch is a single
 * Konva node so selection/drag/transform still operate on one target. Perf
 * flags (perfectDrawEnabled / shadowForStrokeEnabled off) keep hundreds of
 * strokes cheap to redraw.
 */
function renderStroke(shape, common) {
  const brush = shape.brush || 'pen';
  const def = brushDef(brush);
  const color = shape.stroke || shape.color || '#111827';
  const width = shape.strokeWidth || 3;
  const opacity = shape.opacity ?? def.opacity ?? 1;
  const pts = shape.points || [];
  const perf = { perfectDrawEnabled: false, shadowForStrokeEnabled: false, listening: common.listening !== false };

  // Calligraphy is a filled variable-width ribbon, not a constant-width line.
  // A degenerate (single-point) stroke falls through to the round-cap Line
  // below so it still shows a dot and keeps the normal drag convention.
  if (brush === 'calligraphy' && pts.length >= 4) {
    const ribbon = calligraphyRibbon(renderPoints(pts, { smoothing: true }), width, shape.nibAngle ?? 45, !!shape.pressure);
    if (ribbon) {
      return (
        <Line {...common} {...perf} points={ribbon} closed fill={color}
          stroke={color} strokeWidth={1} lineJoin="round" opacity={opacity} />
      );
    }
  }

  const dash = dashArray(brush, width);
  return (
    <Line
      {...common}
      {...perf}
      points={renderPoints(pts, { smoothing: shape.smoothing !== false && brush !== 'highlighter' })}
      stroke={color}
      strokeWidth={width}
      tension={brush === 'highlighter' || brush === 'dotted' || brush === 'dashed' ? 0 : def.tension}
      lineCap={def.cap}
      lineJoin="round"
      opacity={opacity}
      dash={dash || undefined}
      globalCompositeOperation={def.comp === 'multiply' ? 'multiply' : undefined}
      hitStrokeWidth={Math.max(12, width)}
    />
  );
}

/**
 * One component renders EVERY shape type. Konva already provides Rect/Circle/etc,
 * so we map the record's `type` to the right primitive and feed it the common
 * transform fields (x, y, rotation, scaleX/Y, opacity). Selection, dragging and
 * the Transformer all operate on whichever node this returns — no per-shape
 * special-casing anywhere else in the app.
 *
 * The ref is forwarded so Canvas can attach the Konva Transformer to the node.
 */
const ShapeNode = forwardRef(function ShapeNode(
  { shape, draggable, onSelect, onDragStart, onDragMove, onDragEnd, onTransformEnd, onDblClick },
  ref
) {
  const {
    type, x, y, rotation, scaleX, scaleY, opacity,
    fill, stroke, strokeWidth, dash, width, height
  } = shape;

  // Props shared by every node.
  const common = {
    ref,
    id: shape.id,
    x, y,
    rotation: rotation || 0,
    scaleX: scaleX || 1,
    scaleY: scaleY || 1,
    opacity: opacity ?? 1,
    draggable,
    onMouseDown: onSelect,
    onTap: onSelect,
    onDragStart,
    onDragMove,
    onDragEnd,
    onTransformEnd,
    onDblClick,
    onDblTap: onDblClick,
    dash: dash || undefined
  };

  const stroked = { stroke, strokeWidth };
  const filled = { fill };
  const w = width || 0;
  const h = height || 0;

  switch (type) {
    // ---- freehand (Milestone 0 legacy + new pen strokes) --------------
    // Legacy strokes (no `brush`) fall through as a plain 'pen' — unchanged look.
    case 'path':
      return renderStroke(shape, common);

    // ---- rectangles ---------------------------------------------------
    case 'rect':
      return <Rect {...common} width={w} height={h} {...filled} {...stroked} />;
    case 'roundRect':
      return <Rect {...common} width={w} height={h} cornerRadius={Math.min(w, h) * 0.2} {...filled} {...stroked} />;

    // ---- ellipse family ----------------------------------------------
    // Circle / Ellipse / Star are drawn around their CENTRE in Konva, so their
    // node is positioned at the shape's centre: (x + w/2, y + h/2). node.x()
    // therefore returns the CENTRE, and both the drag and transform handlers in
    // Canvas convert back to the stored top-left with `- w/2`. They rotate in
    // place with no offset. See isCentered() in Canvas — that ONE predicate is
    // the whole special case; every coordinate handler branches on it.
    //
    // (The previous bug: onDragEnd wrote the centre into the top-left field
    // without converting, so each drag shifted the shape by half its size.)
    case 'circle': {
      const r = Math.min(w, h) / 2;
      return (
        <Circle
          {...common}
          x={x + w / 2}
          y={y + h / 2}
          radius={r}
          {...filled}
          {...stroked}
        />
      );
    }
    case 'ellipse':
      return (
        <Ellipse
          {...common}
          x={x + w / 2}
          y={y + h / 2}
          radiusX={w / 2}
          radiusY={h / 2}
          {...filled}
          {...stroked}
        />
      );

    case 'star':
      return (
        <Star
          {...common}
          x={x + w / 2}
          y={y + h / 2}
          numPoints={5}
          innerRadius={Math.min(w, h) / 4}
          outerRadius={Math.min(w, h) / 2}
          {...filled}
          {...stroked}
        />
      );

    // ---- smooth paths -------------------------------------------------
    case 'heart':
      return <Path {...common} data={heartPath(w, h)} {...filled} {...stroked} />;
    case 'cloud':
      return <Path {...common} data={cloudPath(w, h)} {...filled} {...stroked} />;

    // ---- lines --------------------------------------------------------
    case 'line':
      return (
        <Line
          {...common}
          points={shape.points || [0, 0, w, h]}
          stroke={stroke}
          strokeWidth={strokeWidth}
          lineCap="round"
          hitStrokeWidth={Math.max(12, strokeWidth)}
        />
      );

    // ---- text ---------------------------------------------------------
    case 'text':
      return (
        <Text
          {...common}
          text={shape.text || ''}
          fontSize={shape.fontSize || 20}
          fontFamily={shape.fontFamily || 'Inter'}
          fontStyle={
            `${shape.fontWeight === 'bold' ? 'bold ' : ''}${shape.italic ? 'italic' : ''}`.trim() || 'normal'
          }
          textDecoration={shape.underline ? 'underline' : ''}
          align={shape.align || 'left'}
          lineHeight={shape.lineHeight || 1.2}
          fill={shape.fill}
          width={shape.width || undefined}
        />
      );

    // ---- everything else is a closed polygon outline ------------------
    default:
      return (
        <Line
          {...common}
          points={shapePoints(type, w, h)}
          closed
          {...filled}
          {...stroked}
        />
      );
  }
});

/**
 * A stroke/shape only needs to re-render when its own record or its draggable
 * flag changes. During a pen draw or eraser drag the existing shapes' records
 * keep their identity (no Yjs snapshot fires), so hundreds of nodes are skipped
 * every frame and only the live preview layer repaints. The handler props are
 * intentionally excluded from the comparison: they close over stable refs
 * (ydoc, the shape id) and any state that would change a handler's behaviour
 * (tool, panning, lock) also flips `draggable`, which IS compared.
 */
export default memo(ShapeNode, (prev, next) =>
  prev.shape === next.shape && prev.draggable === next.draggable
);

/**
 * Non-interactive rendering of a stroke record, used for the local pen preview,
 * remote collaborators' in-progress strokes, and the live erase split preview —
 * so every one of those looks pixel-identical to the committed stroke because
 * they all go through the exact same brush code.
 */
export function PreviewStroke({ shape }) {
  return renderStroke(shape, { listening: false });
}
