import { forwardRef, memo, useEffect, useRef, useState } from 'react';
import { Line, Rect, Circle, Ellipse, Star, Path, Text, Image } from 'react-konva';
import Konva from 'konva';
import { shapePoints, heartPath, cloudPath } from './shapes.jsx';
import { brushDef, dashArray, renderPoints, calligraphyRibbon } from './brushes.js';

/**
 * Apply effects (gradient fill, drop shadow, blur filter) to a Konva node config.
 * Every shape node gets these applied via spread into its props.
 */
function withEffects(shape, baseProps) {
  const props = { ...baseProps };
  const s = shape;

  // ---- blur filter (Konva Blur filter) --------------------------------
  if (s.blurRadius && s.blurRadius > 0) {
    props.filters = [...(props.filters || []), Konva.Filters.Blur];
    props.blurRadius = s.blurRadius;
  }

  // ---- drop shadow (Konva shadow properties) --------------------------
  if (s.shadowEnabled) {
    props.shadowColor = s.shadowColor || '#000000';
    props.shadowBlur = s.shadowBlur ?? 10;
    props.shadowOffsetX = s.shadowOffsetX ?? 4;
    props.shadowOffsetY = s.shadowOffsetY ?? 4;
    props.shadowOpacity = s.shadowOpacity ?? 0.3;
    // If shadow is enabled but no fill is set, give a minimal fill so the
    // shadow has something to cast on
    if (!props.fill || props.fill === 'transparent') {
      props.shadowForStrokeEnabled = true;
    }
  }

  // ---- gradient fill (linear or radial) --------------------------------
  // We use Konva's fillLinearGradientStartPoint / fillLinearGradientEndPoint
  // and similar props for radial. These must be set on shapes that support
  // fillGradient (Rect, Circle, Ellipse, etc. — anything with a fill).
  if (s.fillType === 'linear' && s.fillGradientStart && s.fillGradientEnd) {
    const w = s.width || 200;
    const h = s.height || 200;
    const angleRad = ((s.fillGradientAngle || 0) * Math.PI) / 180;
    const cx = w / 2;
    const cy = h / 2;
    const len = Math.sqrt(w * w + h * h) / 2;
    const dx = Math.cos(angleRad) * len;
    const dy = Math.sin(angleRad) * len;
    props.fillLinearGradientStartPoint = { x: cx - dx, y: cy - dy };
    props.fillLinearGradientEndPoint = { x: cx + dx, y: cy + dy };
    props.fillLinearGradientColorStops = [0, s.fillGradientStart, 1, s.fillGradientEnd];
    // Remove the solid fill so gradient takes over
    delete props.fill;
  } else if (s.fillType === 'radial' && s.fillGradientStart && s.fillGradientEnd) {
    const w = s.width || 200;
    const h = s.height || 200;
    props.fillRadialGradientStartPoint = { x: w / 2, y: h / 2 };
    props.fillRadialGradientEndPoint = { x: w / 2, y: h / 2 };
    props.fillRadialGradientStartRadius = 0;
    props.fillRadialGradientEndRadius = Math.max(w, h) / 2;
    props.fillRadialGradientColorStops = [0, s.fillGradientStart, 1, s.fillGradientEnd];
    delete props.fill;
  }

  return props;
}

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
  const eff = withEffects(shape, {});

  // Calligraphy is a filled variable-width ribbon, not a constant-width line.
  // A degenerate (single-point) stroke falls through to the round-cap Line
  // below so it still shows a dot and keeps the normal drag convention.
  if (brush === 'calligraphy' && pts.length >= 4) {
    const ribbon = calligraphyRibbon(renderPoints(pts, { smoothing: true }), width, shape.nibAngle ?? 45, !!shape.pressure);
    if (ribbon) {
      return (
        <Line {...common} {...perf} {...eff} points={ribbon} closed fill={color}
          stroke={color} strokeWidth={1} lineJoin="round" opacity={opacity} />
      );
    }
  }

  const dash = dashArray(brush, width);
  return (
    <Line
      {...common}
      {...perf}
      {...eff}
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
 *
 * NEW FEATURES:
 *  - Gradient fills (linear / radial) via fillType, fillGradientStart, fillGradientEnd
 *  - Drop shadows via shadowEnabled + shadow* props
 *  - Blur filter via blurRadius
 *  - Custom cornerRadius slider for rect shapes
 *  - Image crop via crop prop on ImageNode
 */
const ShapeNode = forwardRef(function ShapeNode(
  { shape, draggable, onSelect, onDragStart, onDragMove, onDragEnd, onTransformEnd, onDblClick },
  ref
) {
  const {
    type, x, y, rotation, scaleX, scaleY, opacity,
    fill, stroke, strokeWidth, dash, width, height,
    cornerRadius: cr
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
    case 'rect': {
      // Apply cornerRadius if set (> 0) — new feature: rounded corners slider
      const effectiveCR = (cr && cr > 0) ? cr : undefined;
      return <Rect {...withEffects(shape, common)} width={w} height={h}
        cornerRadius={effectiveCR} {...filled} {...stroked} />;
    }
    case 'roundRect': {
      // Use custom cornerRadius if set, otherwise fall back to the old 20% formula
      const effectiveCR = (cr && cr > 0) ? cr : Math.min(w, h) * 0.2;
      return <Rect {...withEffects(shape, common)} width={w} height={h}
        cornerRadius={effectiveCR} {...filled} {...stroked} />;
    }

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
          {...withEffects(shape, common)}
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
          {...withEffects(shape, common)}
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
          {...withEffects(shape, common)}
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
      return <Path {...withEffects(shape, common)} data={heartPath(w, h)} {...filled} {...stroked} />;
    case 'cloud':
      return <Path {...withEffects(shape, common)} data={cloudPath(w, h)} {...filled} {...stroked} />;

    // ---- lines --------------------------------------------------------
    case 'line':
      return (
        <Line
          {...withEffects(shape, common)}
          points={shape.points || [0, 0, w, h]}
          stroke={stroke}
          strokeWidth={strokeWidth}
          lineCap="round"
          hitStrokeWidth={Math.max(12, strokeWidth)}
        />
      );

    // ---- images -------------------------------------------------------
    // ImageNode was previously defined but never referenced, so an image
    // record fell through to `default:` and rendered as a bare rectangle.
    case 'image':
      return <ImageNode shape={shape} common={common} />;

    // ---- text ---------------------------------------------------------
    case 'text':
      return (
        <Text
          {...withEffects(shape, common)}
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

    // ---- images (user-uploaded or stickers) ---------------------------
    case 'image':
      return <ImageNode shape={shape} common={common} />;

    // ---- everything else is a closed polygon outline ------------------
    default:
      return (
        <Line
          {...withEffects(shape, common)}
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
 * A Konva Image node that loads its source from `shape.src` (a data URL or blob URL).
 * The image is stored as a base64 data URL in the Yjs doc so it syncs to all peers.
 * Falls back to a placeholder rectangle while loading or on error.
 *
 * NEW: Supports image cropping via `shape.crop` = { x, y, width, height }.
 * The crop rect is in source-image pixel coordinates.
 */
function ImageNode({ shape, common }) {
  const imageRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!shape.src) { setError(true); return; }
    setLoaded(false);
    setError(false);
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (imageRef.current !== img) return;
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      setLoaded(true);
    };
    img.onerror = () => {
      if (imageRef.current !== img) return;
      setError(true);
    };
    imageRef.current = img;   // set BEFORE .src so onload never sees a stale ref
    img.src = shape.src;
    return () => {
      if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      imageRef.current = null;
    };
  }, [shape.src]);

  // Apply effects (shadow, blur) to the image too
  const effCommon = withEffects(shape, common);

  // Compute image rendering props with optional crop
  const imgProps = {
    ...effCommon,
    image: imageRef.current,
    width: shape.width || naturalSize.w || 160,
    height: shape.height || naturalSize.h || 120
  };

  // If crop is set, apply it. crop = { x, y, width, height } in source pixels.
  if (shape.crop && loaded && naturalSize.w > 0 && naturalSize.h > 0) {
    imgProps.crop = {
      x: shape.crop.x || 0,
      y: shape.crop.y || 0,
      width: shape.crop.width || naturalSize.w,
      height: shape.crop.height || naturalSize.h
    };
  }

  // While loading or on error, fall back to a placeholder
  if (!loaded || error) {
    return (
      <Rect
        {...common}
        width={shape.width || 160}
        height={shape.height || 120}
        fill={error ? '#2a2a3a' : '#1a1a2a'}
        stroke={error ? '#ef4444' : '#6366f1'}
        strokeWidth={error ? 1.5 : 1}
        strokeScaleEnabled={false}
        dash={error ? [4, 4] : undefined}
        cornerRadius={4}
      />
    );
  }

  return <Image {...imgProps} />;
}

/**
 * Non-interactive rendering of a stroke record, used for the local pen preview,
 * remote collaborators' in-progress strokes, and the live erase split preview —
 * so every one of those looks pixel-identical to the committed stroke because
 * they all go through the exact same brush code.
 */
export function PreviewStroke({ shape }) {
  return renderStroke(shape, { listening: false });
}

