/**
 * The shape registry.
 *
 * DESIGN: every drawable object — freehand path, rectangle, star, text —
 * is one flat record in the SAME Yjs array the original project already used
 * (ydoc.getArray('shapes')). A `type` field says which kind it is. This is the
 * "generic shape abstraction" the brief asks for: one create pipeline, one render
 * switch, one selection system, instead of a parallel implementation per shape.
 *
 * Backwards compatibility: the Milestone-0 freehand shape stored { id, color,
 * points }. Canvas still reads those (see normalizeLegacy) and now also writes a
 * `type: 'path'` so new and old records live side by side.
 */

// ---- the common schema every object carries -----------------------------
export const COMMON_DEFAULTS = () => ({
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  fill: '#6366f1',
  stroke: '#111827',
  strokeWidth: 2,
  opacity: 1,
  dash: null, // null=solid, [8,6]=dashed, [2,6]=dotted
  locked: false,
  zIndex: 0
});

// A shape is "hollow-by-default" (outline only) unless listed here.
const FILLABLE = new Set([
  'rect', 'roundRect', 'diamond', 'parallelogram', 'trapezoid',
  'circle', 'ellipse', 'triangle', 'pentagon', 'hexagon', 'star',
  'heart', 'cross', 'speechBubble', 'cloud'
]);

export function isFillable(type) {
  return FILLABLE.has(type);
}

export function isTextType(type) {
  return type === 'text';
}

export function isDraggableLine(type) {
  return type === 'line';
}

export function isConnector(type) {
  return type === 'connector';
}

/**
 * Every connector starts from these. Presets from the Shapes menu / toolbar
 * override individual fields — one type, one render path, many looks.
 */
export const CONNECTOR_DEFAULTS = () => ({
  routing: 'straight',      // 'straight' | 'elbow' | 'curved'
  curvature: 0.5,
  cornerRadius: 8,
  startHead: 'none',
  endHead: 'filled',
  waypoints: [],
  stroke: '#111827',
  strokeWidth: 2,
  fill: 'transparent',
  dash: null
});

export const HEAD_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'filled', label: 'Filled arrow' },
  { value: 'hollow', label: 'Hollow arrow' },
  { value: 'open', label: 'Open arrow' },
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' }
];

export const ROUTING_OPTIONS = [
  { value: 'straight', label: 'Straight' },
  { value: 'elbow', label: 'Elbow (zig-zag)' },
  { value: 'curved', label: 'Curved' }
];

/**
 * Circle/ellipse/star are the shapes Konva draws around their CENTRE. Their node
 * is positioned at (x + w/2, y + h/2), so node.x() reports the centre and any
 * position read-back must subtract half-size to recover the stored top-left.
 * This single predicate is the whole special case for those shapes.
 */
export function isCentered(type) {
  return type === 'circle' || type === 'ellipse' || type === 'star';
}

/**
 * Regular-polygon point generator (used by triangle/pentagon/hexagon and the
 * Konva star). Returns points in a 0..1 box so the same maths drives any size.
 */
function polygon(sides, rotationDeg = -90) {
  const pts = [];
  const rot = (rotationDeg * Math.PI) / 180;
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    pts.push({ x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) });
  }
  return pts;
}

/**
 * Given a shape's width & height, return the Konva <Line> points (a flat number
 * array) that draw it. Everything that is a closed outline routes through here,
 * so adding a shape is: add a case, done. No new component, no new sync path.
 */
export function shapePoints(type, w, h) {
  const P = (norm) => norm.flatMap((p) => [p.x * w, p.y * h]);
  switch (type) {
    case 'diamond':
      return P([{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }]);
    case 'parallelogram':
      return P([{ x: 0.25, y: 0 }, { x: 1, y: 0 }, { x: 0.75, y: 1 }, { x: 0, y: 1 }]);
    case 'trapezoid':
      return P([{ x: 0.2, y: 0 }, { x: 0.8, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    case 'triangle':
      return P([{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    case 'pentagon':
      return P(polygon(5));
    case 'hexagon':
      return P(polygon(6));
    case 'cross':
      return P([
        { x: 0.35, y: 0 }, { x: 0.65, y: 0 }, { x: 0.65, y: 0.35 },
        { x: 1, y: 0.35 }, { x: 1, y: 0.65 }, { x: 0.65, y: 0.65 },
        { x: 0.65, y: 1 }, { x: 0.35, y: 1 }, { x: 0.35, y: 0.65 },
        { x: 0, y: 0.65 }, { x: 0, y: 0.35 }, { x: 0.35, y: 0.35 }
      ]);
    case 'speechBubble':
      return P([
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.7 }, { x: 0.35, y: 0.7 },
        { x: 0.2, y: 1 }, { x: 0.2, y: 0.7 }, { x: 0, y: 0.7 }
      ]);
    default:
      return P([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  }
}

/** Heart is smooth, so it gets its own bezier path (Konva <Path>). */
export function heartPath(w, h) {
  const x = (n) => n * w;
  const y = (n) => n * h;
  return [
    `M ${x(0.5)} ${y(0.3)}`,
    `C ${x(0.5)} ${y(0.1)} ${x(0.1)} ${y(0.05)} ${x(0.1)} ${y(0.35)}`,
    `C ${x(0.1)} ${y(0.6)} ${x(0.35)} ${y(0.75)} ${x(0.5)} ${y(0.95)}`,
    `C ${x(0.65)} ${y(0.75)} ${x(0.9)} ${y(0.6)} ${x(0.9)} ${y(0.35)}`,
    `C ${x(0.9)} ${y(0.05)} ${x(0.5)} ${y(0.1)} ${x(0.5)} ${y(0.3)}`,
    'Z'
  ].join(' ');
}

/** Cloud, also smooth. */
export function cloudPath(w, h) {
  const x = (n) => n * w;
  const y = (n) => n * h;
  return [
    `M ${x(0.25)} ${y(0.8)}`,
    `a ${x(0.15)} ${y(0.15)} 0 0 1 ${x(0.02)} ${y(-0.55)}`,
    `a ${x(0.2)} ${y(0.2)} 0 0 1 ${x(0.4)} ${y(-0.05)}`,
    `a ${x(0.15)} ${y(0.15)} 0 0 1 ${x(0.08)} ${y(0.6)}`,
    'Z'
  ].join(' ');
}

// ---- what the toolbar shows ---------------------------------------------
export const SHAPE_GROUPS = [
  {
    label: 'Flowchart',
    shapes: [
      { type: 'rect', name: 'Process' },
      { type: 'roundRect', name: 'Start / End' },
      { type: 'diamond', name: 'Decision' },
      { type: 'parallelogram', name: 'Input / Output' }
    ]
  },
  {
    label: 'Geometric',
    shapes: [
      { type: 'circle', name: 'Circle' },
      { type: 'ellipse', name: 'Ellipse' },
      { type: 'triangle', name: 'Triangle' },
      { type: 'pentagon', name: 'Pentagon' },
      { type: 'hexagon', name: 'Hexagon' },
      { type: 'star', name: 'Star' },
      { type: 'heart', name: 'Heart' }
    ]
  },
  {
    label: 'Extra',
    shapes: [
      { type: 'trapezoid', name: 'Trapezoid' },
      { type: 'cross', name: 'Cross' },
      { type: 'speechBubble', name: 'Speech' },
      { type: 'cloud', name: 'Cloud' }
    ]
  },
  {
    label: 'Lines',
    shapes: [
      { type: 'line', name: 'Line' }
    ]
  },
  {
    label: 'Connectors & Arrows',
    shapes: [
      { type: 'connector', name: 'Connector', preset: { endHead: 'none' } },
      { type: 'connector', name: 'Elbow', preset: { routing: 'elbow' } },
      { type: 'connector', name: 'Curved', preset: { routing: 'curved' } },
      { type: 'connector', name: 'Arrow', preset: {} },
      { type: 'connector', name: 'Double Arrow', preset: { startHead: 'filled' } },
      { type: 'connector', name: 'Dashed Arrow', preset: { dash: [8, 6] } },
      { type: 'connector', name: 'Dotted Arrow', preset: { dash: [2, 6] } },
      { type: 'connector', name: 'Thick Arrow', preset: { strokeWidth: 5 } },
      { type: 'connector', name: 'Thin Arrow', preset: { strokeWidth: 1 } },
      { type: 'connector', name: 'Hollow Head', preset: { endHead: 'hollow' } },
      { type: 'connector', name: 'Open Arrow', preset: { endHead: 'open' } },
      { type: 'connector', name: 'Block Arrow', preset: { endHead: 'block' } }
    ]
  }
];

/** Small inline SVG preview for each toolbar button. */
export function shapeIcon(type, name) {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 };
  if (type === 'connector') {
    const head = <polygon points="17,4 12.6,5.2 15.8,8.4" fill="currentColor" />;
    switch (name) {
      case 'Connector': return <path d="M3 16 L17 4" {...s} />;
      case 'Elbow': return <path d="M3 16 H10 V4 H17" {...s} />;
      case 'Curved': return <><path d="M3 16 C 9 16 11 4 17 4" {...s} />{head}</>;
      case 'Double Arrow': return (
        <>
          <line x1="5" y1="14.5" x2="15" y2="5.5" {...s} />
          {head}
          <polygon points="3,16 7.4,14.8 4.2,11.6" fill="currentColor" />
        </>
      );
      case 'Dashed Arrow': return <><line x1="3" y1="16" x2="15" y2="5.5" {...s} strokeDasharray="4 2.5" />{head}</>;
      case 'Dotted Arrow': return <><line x1="3" y1="16" x2="15" y2="5.5" {...s} strokeDasharray="1.5 3" />{head}</>;
      case 'Thick Arrow': return <><line x1="3" y1="16" x2="14.5" y2="6" stroke="currentColor" strokeWidth="3.2" fill="none" />{head}</>;
      case 'Thin Arrow': return <><line x1="3" y1="16" x2="15" y2="5.5" stroke="currentColor" strokeWidth="0.9" fill="none" />{head}</>;
      case 'Hollow Head': return (
        <>
          <line x1="3" y1="16" x2="13.5" y2="6.8" {...s} />
          <polygon points="17,4 12.6,5.2 15.8,8.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </>
      );
      case 'Open Arrow': return (
        <>
          <line x1="3" y1="16" x2="17" y2="4" {...s} />
          <path d="M12.6 4.4 L17 4 L16.6 8.4" {...s} strokeWidth="1.4" />
        </>
      );
      case 'Block Arrow': return (
        <>
          <line x1="3" y1="16" x2="13" y2="7.2" {...s} />
          <rect x="12.4" y="3.4" width="4.4" height="4.4" fill="currentColor" transform="rotate(-41 14.6 5.6)" />
        </>
      );
      default: return <><line x1="3" y1="16" x2="15" y2="5.5" {...s} />{head}</>;
    }
  }
  switch (type) {
    case 'rect': return <rect x="3" y="5" width="14" height="10" {...s} />;
    case 'roundRect': return <rect x="3" y="5" width="14" height="10" rx="4" {...s} />;
    case 'diamond': return <polygon points="10,3 17,10 10,17 3,10" {...s} />;
    case 'parallelogram': return <polygon points="6,4 18,4 14,16 2,16" {...s} />;
    case 'trapezoid': return <polygon points="6,4 14,4 18,16 2,16" {...s} />;
    case 'circle': return <circle cx="10" cy="10" r="7" {...s} />;
    case 'ellipse': return <ellipse cx="10" cy="10" rx="8" ry="5" {...s} />;
    case 'triangle': return <polygon points="10,3 17,17 3,17" {...s} />;
    case 'pentagon': return <polygon points="10,2 18,8 15,17 5,17 2,8" {...s} />;
    case 'hexagon': return <polygon points="6,3 14,3 18,10 14,17 6,17 2,10" {...s} />;
    case 'star': return <polygon points="10,2 12,8 18,8 13,12 15,18 10,14 5,18 7,12 2,8 8,8" {...s} />;
    case 'heart': return <path d="M10 16 C2 10 4 4 10 7 C16 4 18 10 10 16 Z" {...s} />;
    case 'cross': return <polygon points="7,3 13,3 13,7 17,7 17,13 13,13 13,17 7,17 7,13 3,13 3,7 7,7" {...s} />;
    case 'speechBubble': return <path d="M3 4 H17 V13 H8 L5 17 V13 H3 Z" {...s} />;
    case 'cloud': return <path d="M6 15 A4 4 0 0 1 7 8 A5 5 0 0 1 15 8 A4 4 0 0 1 15 15 Z" {...s} />;
    case 'line': return <line x1="3" y1="16" x2="17" y2="4" {...s} />;
    default: return <rect x="3" y="5" width="14" height="10" {...s} />;
  }
}
