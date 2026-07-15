import { forwardRef } from 'react';
import { Line, Rect, Circle, Ellipse, Star, Path, Text } from 'react-konva';
import { shapePoints, heartPath, cloudPath } from './shapes.jsx';

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
  { shape, draggable, onSelect, onDragStart, onDragEnd, onTransformEnd, onDblClick },
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
    case 'path':
      return (
        <Line
          {...common}
          points={shape.points}
          stroke={shape.stroke || shape.color}
          strokeWidth={shape.strokeWidth || 3}
          tension={0.4}
          lineCap="round"
          lineJoin="round"
        />
      );

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

export default ShapeNode;
