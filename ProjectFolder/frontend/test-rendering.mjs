/**
 * Regression suite for the "drawing a shape makes the whole UI disappear" bug.
 *
 *   node --experimental-loader=./test-support/loader.mjs test-rendering.mjs
 *
 * WHAT THIS PROTECTS
 * ------------------
 * The original defect was a single undeclared identifier (`isImage`) in
 * PropertyPanel. It threw a ReferenceError during React's RENDER phase, and
 * because the app used createRoot() with no error boundary anywhere, React
 * responded by unmounting the entire tree — toolbar, stage and all. The page
 * never "crashed"; it just went blank until a manual refresh.
 *
 * Group 1 reproduces that exact mechanism against a real DOM: it mounts the
 * component and asserts the container is still populated afterwards. If anyone
 * ever reintroduces a render-phase throw on any shape type, this fails loudly
 * instead of shipping.
 *
 * Groups 2-6 cover the pipeline the shapes travel through: the render switch,
 * the malformed-data gate, error containment, connector routing and geometry.
 */
import { JSDOM } from 'jsdom';

// ---- DOM must exist before react-dom/client is imported ------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so assignment fails.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Image = dom.window.Image;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react-dom/test-utils');

const PropertyPanel = (await import('./src/components/PropertyPanel.jsx')).default;
const ShapeNodeMod = await import('./src/canvas/ShapeNode.jsx');
const ShapeNode = ShapeNodeMod.default;
const ConnectorNode = (await import('./src/canvas/ConnectorNode.jsx')).default;
const { ShapeErrorBoundary } = await import('./src/components/ErrorBoundary.jsx');
const { normalizeShape, normalizeShapes, cleanPoints } = await import('./src/canvas/normalize.js');
const { connectorRoute, displayPoints } = await import('./src/canvas/connectors.js');
const { COMMON_DEFAULTS, shapePoints, rotateAboutCentre, normalizeAngle, shapeLocalCentre, supportsCornerRadius } = await import('./src/canvas/shapes.jsx');

// ---- tiny harness, same style as the project's other test-*.mjs ----------
let pass = 0, fail = 0;
const check = (name, ok) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
};
const group = (title) => console.log('\n' + title + '\n' + '-'.repeat(title.length));

// Silence expected boundary logging so the output stays readable.
const realError = console.error;
const quiet = (fn) => { console.error = () => {}; try { return fn(); } finally { console.error = realError; } };

/** Mount `el` into a fresh container and report whether the UI survived. */
function mountAndSurvive(el) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let threw = null;
  quiet(() => {
    try {
      act(() => { root.render(el); });
    } catch (err) {
      threw = err;
    }
  });
  // The signature of the original bug: React tears the tree down, leaving the
  // container empty, WITHOUT the exception necessarily reaching us here.
  const populated = host.innerHTML.length > 0;
  quiet(() => { try { act(() => root.unmount()); } catch { /* ignore */ } });
  host.remove();
  return { survived: !threw && populated, threw, populated };
}

// Every drawable object the whiteboard can produce.
const ALL_TYPES = [
  'line', 'path', 'rect', 'roundRect', 'circle', 'ellipse', 'diamond',
  'parallelogram', 'trapezoid', 'triangle', 'pentagon', 'hexagon', 'star',
  'heart', 'cross', 'speechBubble', 'cloud', 'connector', 'text', 'image'
];

const makeShape = (type, extra = {}) => normalizeShape({
  id: `t-${type}`,
  type,
  creator: 'tester',
  ...COMMON_DEFAULTS(),
  width: 120,
  height: 90,
  points: [0, 0, 40, 40, 80, 10],
  text: 'hello',
  src: '',
  start: { x: 0, y: 0 },
  end: { x: 100, y: 60 },
  waypoints: [],
  ...extra
});

// =========================================================================
group('1. PropertyPanel mounts for every shape type (the original crash)');
// =========================================================================
// The panel takes a SELECTION ARRAY, not a single `selected` record. These
// tests used to pass the long-removed `selected` prop, so the panel fell back
// to its `selection = []` default, rendered null, and all 20 reported a failure
// that had nothing to do with the product. They now drive the real API.
for (const type of ALL_TYPES) {
  const r = mountAndSurvive(
    React.createElement(PropertyPanel, {
      selection: [makeShape(type)],
      patch: () => {}, onDelete: () => {}, onDuplicate: () => {}, onReorder: () => {}
    })
  );
  check(
    `selecting a "${type}" keeps the UI mounted`,
    r.survived
  );
}
// A multi-selection renders a different component (MultiProperties) and so
// needs its own render-phase cover; mixing types is the case most likely to
// hit a branch that assumes a field exists.
for (const [label, types] of [
  ['two rects', ['rect', 'rect']],
  ['mixed shape + text', ['rect', 'text']],
  ['mixed shape + connector', ['rect', 'connector']],
  ['mixed shape + image', ['rect', 'image']],
  ['one of every type', ALL_TYPES]
]) {
  const r = mountAndSurvive(
    React.createElement(PropertyPanel, {
      selection: types.map((t, i) => makeShape(t, { id: `multi-${t}-${i}` })),
      patch: () => {}, onDelete: () => {}, onDuplicate: () => {}, onReorder: () => {}
    })
  );
  check(`multi-select of ${label} keeps the UI mounted`, r.survived);
}
{
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(React.createElement(PropertyPanel, { selection: [], patch: () => {} })); });
  check('no selection renders nothing (and does not throw)', host.innerHTML === '');
  act(() => root.unmount());
  host.remove();
}

// =========================================================================
group('2. ShapeNode renders every shape type');
// =========================================================================
for (const type of ALL_TYPES.filter((t) => t !== 'connector')) {
  const r = mountAndSurvive(
    React.createElement(ShapeNode, { shape: makeShape(type), draggable: true })
  );
  check(`ShapeNode renders "${type}"`, !r.threw);
}
// effects that previously had no coverage at all
for (const [label, extra] of [
  ['drop shadow', { shadowEnabled: true }],
  ['blur filter', { blurRadius: 8 }],
  ['linear gradient', { fillType: 'linear' }],
  ['radial gradient', { fillType: 'radial' }],
  ['dashed border', { dash: [8, 6] }],
  ['rounded corners', { cornerRadius: 12 }],
  ['rotated + scaled', { rotation: 37, scaleX: 1.4, scaleY: 0.6 }]
]) {
  const r = mountAndSurvive(
    React.createElement(ShapeNode, { shape: makeShape('rect', extra), draggable: true })
  );
  check(`ShapeNode renders a rect with ${label}`, !r.threw);
}
for (const brush of ['pen', 'pencil', 'marker', 'highlighter', 'calligraphy', 'dashed', 'dotted']) {
  const r = mountAndSurvive(
    React.createElement(ShapeNode, {
      shape: makeShape('path', { brush, points: [0, 0, 10, 12, 25, 5, 40, 30, 60, 12] }),
      draggable: true
    })
  );
  check(`ShapeNode renders the "${brush}" brush`, !r.threw);
}

// =========================================================================
group('2b. Fill resolution — gradients must actually win over the solid fill');
// =========================================================================
// The regression this pins: every case in the render switch used to spread
// `{ fill: shape.fill }` AFTER the gradient props. Konva's fill priority
// defaults to 'color', so the solid colour won and Linear/Radial were dead
// controls — the panel highlighted the button and the canvas never changed.
// "Renders without throwing" (group 2) could never catch that; this can.
{
  const { fillProps, shadowProps } = ShapeNodeMod;

  const solid = fillProps(makeShape('rect', { fill: '#ff0000', fillType: 'solid' }));
  check('solid fill keeps the colour and colour priority',
    solid.fill === '#ff0000' && solid.fillPriority === 'color');
  check('solid fill carries no leftover gradient stops',
    solid.fillLinearGradientColorStops === undefined &&
    solid.fillRadialGradientColorStops === undefined);

  const lin = fillProps(makeShape('rect', {
    fill: '#ff0000', fillType: 'linear',
    fillGradientStart: '#111111', fillGradientEnd: '#222222'
  }));
  check('linear gradient clears the solid fill', lin.fill === undefined);
  check('linear gradient sets linear priority', lin.fillPriority === 'linear-gradient');
  check('linear gradient carries both stops',
    Array.isArray(lin.fillLinearGradientColorStops) &&
    lin.fillLinearGradientColorStops[1] === '#111111' &&
    lin.fillLinearGradientColorStops[3] === '#222222');

  const rad = fillProps(makeShape('rect', {
    fillType: 'radial', fillGradientStart: '#111111', fillGradientEnd: '#222222'
  }));
  check('radial gradient clears the solid fill and sets radial priority',
    rad.fill === undefined && rad.fillPriority === 'radial-gradient');
  check('radial gradient has a non-zero end radius',
    rad.fillRadialGradientEndRadius > 0);

  // A half-configured gradient must fall back to the solid fill rather than
  // rendering an invisible shape. Built raw on purpose: normalizeShape()
  // back-fills missing stops with defaults, so a normalised record can never
  // reach fillProps() in this state — but a legacy or hand-edited one can.
  const halfDone = fillProps({
    type: 'rect', width: 100, height: 100,
    fill: '#00ff00', fillType: 'linear', fillGradientStart: '', fillGradientEnd: ''
  });
  check('a gradient missing its stops falls back to the solid fill',
    halfDone.fill === '#00ff00' && halfDone.fillPriority === 'color');

  // A zero-sized record (mid-drag) must not produce a degenerate gradient.
  const zeroSized = fillProps({
    type: 'rect', width: 0, height: 0, fill: '#00ff00',
    fillType: 'linear', fillGradientStart: '#000', fillGradientEnd: '#fff'
  });
  check('a zero-sized shape falls back to the solid fill',
    zeroSized.fill === '#00ff00' && zeroSized.fillPriority === 'color');

  // Circle/Ellipse/Star are drawn around their CENTRE, so a gradient built with
  // top-left maths (the old behaviour) landed half a shape off.
  const rectLin = fillProps(makeShape('rect', {
    width: 100, height: 100, fillType: 'linear',
    fillGradientStart: '#000', fillGradientEnd: '#fff', fillGradientAngle: 0
  }));
  const circLin = fillProps(makeShape('circle', {
    width: 100, height: 100, fillType: 'linear',
    fillGradientStart: '#000', fillGradientEnd: '#fff', fillGradientAngle: 0
  }));
  const mid = (p) => (p.fillLinearGradientStartPoint.x + p.fillLinearGradientEndPoint.x) / 2;
  check('a top-left shape centres its gradient at w/2', Math.abs(mid(rectLin) - 50) < 0.001);
  check('a centred shape centres its gradient at 0 (not w/2)', Math.abs(mid(circLin)) < 0.001);

  const radCirc = fillProps(makeShape('circle', {
    width: 80, height: 80, fillType: 'radial',
    fillGradientStart: '#000', fillGradientEnd: '#fff'
  }));
  check('a centred shape anchors its radial gradient at its own origin',
    Math.abs(radCirc.fillRadialGradientStartPoint.x) < 0.001 &&
    Math.abs(radCirc.fillRadialGradientStartPoint.y) < 0.001);

  // Turning the shadow off has to actively remove it, not just stop adding it.
  const shadowOn = shadowProps(makeShape('rect', { shadowEnabled: true, shadowBlur: 12 }), '#fff');
  const shadowOff = shadowProps(makeShape('rect', { shadowEnabled: false }), '#fff');
  check('shadow on sets an enabled shadow', shadowOn.shadowEnabled === true && shadowOn.shadowBlur === 12);
  check('shadow off actively disables it', shadowOff.shadowEnabled === false && shadowOff.shadowBlur === 0);
  const hollowShadow = shadowProps(makeShape('rect', { shadowEnabled: true }), 'transparent');
  check('a hollow shape casts its shadow from the stroke',
    hollowShadow.shadowForStrokeEnabled === true);
}

// =========================================================================
group('2c. Rotation pivots about the centre, like the Transformer does');
// =========================================================================
// Konva rotates a node about its ORIGIN, which for most shapes is the top-left
// corner. Writing `rotation` alone therefore swung a shape away across the
// canvas, while the Transformer's rotate handle pivoted about the centre — the
// same property behaving two different ways depending on which control you used.
{
  const centreOf = (s) => {
    const c = shapeLocalCentre(s);
    const a = ((s.rotation || 0) * Math.PI) / 180;
    return {
      x: (s.x || 0) + c.x * Math.cos(a) - c.y * Math.sin(a),
      y: (s.y || 0) + c.x * Math.sin(a) + c.y * Math.cos(a)
    };
  };
  const holdsCentre = (s, deg) => {
    const before = centreOf(s);
    const after = centreOf({ ...s, ...rotateAboutCentre(s, deg) });
    return Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9;
  };

  const rect = makeShape('rect', { x: 100, y: 50, width: 120, height: 80, rotation: 0 });
  check('rotating a rect keeps its centre pinned', holdsCentre(rect, 90));
  check('rotating a rect by an odd angle keeps its centre pinned', holdsCentre(rect, 37));
  check('rotating a rect BACK to 0 restores the original position', (() => {
    const spun = { ...rect, ...rotateAboutCentre(rect, 137) };
    const back = { ...spun, ...rotateAboutCentre(spun, 0) };
    return Math.abs(back.x - rect.x) < 1e-9 && Math.abs(back.y - rect.y) < 1e-9;
  })());

  const circle = makeShape('circle', { x: 10, y: 20, width: 60, height: 60 });
  const cPatch = rotateAboutCentre(circle, 45);
  check('a centred shape needs no position compensation',
    cPatch.x === undefined && cPatch.y === undefined && cPatch.rotation === 45);

  const stroke = makeShape('path', { x: 0, y: 0, points: [10, 10, 90, 10, 90, 70] });
  check('rotating a freehand stroke pivots about its own points, not the world origin',
    holdsCentre(stroke, 90));

  check('rotateAboutCentre ignores a non-finite angle',
    Object.keys(rotateAboutCentre(rect, NaN)).length === 0);

  // The slider is 0..360, but a Transformer drag can leave rotation negative or
  // past 360, which the slider then displayed as a clamped lie.
  check('normalizeAngle folds a negative angle into range', normalizeAngle(-90) === 270);
  check('normalizeAngle folds an over-turn into range', normalizeAngle(450) === 90);
  check('normalizeAngle passes an in-range angle through', normalizeAngle(37) === 37);
  check('normalizeAngle survives junk', normalizeAngle(undefined) === 0);

  // Corner radius is only honoured by Rect; offering it elsewhere was a control
  // that changed the record and nothing else.
  check('corner radius is offered for rectangles',
    supportsCornerRadius('rect') && supportsCornerRadius('roundRect'));
  check('corner radius is not offered where Konva ignores it',
    !supportsCornerRadius('circle') && !supportsCornerRadius('star') &&
    !supportsCornerRadius('triangle') && !supportsCornerRadius('path'));
}

// =========================================================================
group('3. Malformed records are repaired before they reach the renderer');
// =========================================================================
{
  const junk = normalizeShape({ id: 'j1', type: 'rect', x: NaN, y: 'abc', width: -50, height: Infinity, opacity: 99, rotation: null, scaleX: 0 });
  check('NaN x becomes a finite number', Number.isFinite(junk.x));
  check('non-numeric y becomes a finite number', Number.isFinite(junk.y));
  check('negative width is clamped to >= 0', junk.width >= 0);
  check('Infinite height becomes finite', Number.isFinite(junk.height));
  check('out-of-range opacity is clamped to <= 1', junk.opacity <= 1);
  check('null rotation becomes 0', junk.rotation === 0);
  check('zero scaleX is corrected to 1 (0 collapses the node)', junk.scaleX === 1);

  check('odd-length points array is made even', cleanPoints([1, 2, 3]).length % 2 === 0);
  check('NaN coordinates are dropped in pairs', cleanPoints([0, 0, NaN, 5, 10, 10]).every(Number.isFinite));
  check('non-array points becomes []', cleanPoints('nope').length === 0);

  const conn = normalizeShape({ id: 'c1', type: 'connector', start: null, end: undefined, waypoints: 'bad' });
  check('null connector start becomes a valid point', Number.isFinite(conn.start.x) && Number.isFinite(conn.start.y));
  check('undefined connector end becomes a valid point', Number.isFinite(conn.end.x) && Number.isFinite(conn.end.y));
  check('invalid waypoints become []', Array.isArray(conn.waypoints) && conn.waypoints.length === 0);

  const txt = normalizeShape({ id: 't1', type: 'text', text: 42, fontSize: -3, lineHeight: 'x' });
  check('non-string text is coerced to a string', typeof txt.text === 'string');
  check('invalid fontSize becomes usable', txt.fontSize > 0);
  check('invalid lineHeight becomes usable', Number.isFinite(txt.lineHeight) && txt.lineHeight > 0);

  const legacy = normalizeShape({ id: 'L', color: '#ff0000', points: [0, 0, 5, 5] });
  check('legacy freehand record gains type "path"', legacy.type === 'path');
  check('legacy `color` is carried into `stroke`', legacy.stroke === '#ff0000');

  const noId = normalizeShape({ type: 'rect' }, 7);
  check('a record with no id still gets a usable key', typeof noId.id === 'string' && noId.id.length > 0);

  const dupes = normalizeShapes([{ id: 'same', type: 'rect' }, { id: 'same', type: 'circle' }]);
  check('duplicate ids are de-duplicated (React key safety)', dupes[0].id !== dupes[1].id);

  check('normalizeShapes(null) returns []', normalizeShapes(null).length === 0);
  check('normalizeShapes tolerates null entries', normalizeShapes([null, undefined]).length === 2);
}

// =========================================================================
group('4. A failing shape is contained, not fatal');
// =========================================================================
{
  const Boom = () => { throw new Error('deliberate render failure'); };
  const r = mountAndSurvive(
    React.createElement('div', null,
      React.createElement('span', { id: 'before' }, 'toolbar'),
      React.createElement(ShapeErrorBoundary, { shapeId: 'bad', shapeType: 'rect', resetKey: 1 },
        React.createElement(Boom)),
      React.createElement('span', { id: 'after' }, 'canvas')
    )
  );
  check('a throwing shape does not blank its siblings', r.survived);

  // and the same failure WITHOUT a boundary is what used to kill the app
  const bare = mountAndSurvive(React.createElement('div', null, React.createElement(Boom)));
  check('control: the same throw with no boundary does blank the tree', !bare.survived);
}

// =========================================================================
group('5. Connector routing survives hostile input');
// =========================================================================
{
  const byId = new Map();
  byId.set('r1', makeShape('rect', { id: 'r1', x: 0, y: 0, width: 100, height: 60 }));

  const cases = [
    ['both endpoints free', { start: { x: 0, y: 0 }, end: { x: 50, y: 50 } }],
    ['attached to a live shape', { start: { shapeId: 'r1', anchor: 'e' }, end: { x: 300, y: 200 } }],
    ['attached to a DELETED shape', { start: { shapeId: 'gone', anchor: 'n' }, end: { x: 300, y: 200 } }],
    ['auto anchor on both ends', { start: { shapeId: 'r1', anchor: 'auto' }, end: { shapeId: 'r1', anchor: 'auto' } }],
    ['identical endpoints (zero length)', { start: { x: 10, y: 10 }, end: { x: 10, y: 10 } }],
    ['with waypoints', { start: { x: 0, y: 0 }, end: { x: 200, y: 200 }, waypoints: [50, 10, 120, 180] }]
  ];
  for (const routing of ['straight', 'elbow', 'curved']) {
    for (const [label, extra] of cases) {
      let ok = true;
      try {
        const conn = makeShape('connector', { routing, ...extra });
        const route = connectorRoute(conn, byId);
        const pts = displayPoints(conn, route);
        ok = Array.isArray(pts) && pts.length >= 2 &&
             pts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
        if (ok) {
          const r = mountAndSurvive(React.createElement(ConnectorNode, { conn, pts }));
          ok = !r.threw;
        }
      } catch { ok = false; }
      check(`${routing.padEnd(8)} connector, ${label}`, ok);
    }
  }
  for (const head of ['none', 'filled', 'hollow', 'open', 'block', 'bar']) {
    const conn = makeShape('connector', { startHead: head, endHead: head });
    const pts = connectorRoute(conn, byId);
    const r = mountAndSurvive(React.createElement(ConnectorNode, { conn, pts }));
    check(`arrowhead "${head}" renders`, !r.threw);
  }
}

// =========================================================================
group('6. Polygon geometry is always finite');
// =========================================================================
for (const type of ALL_TYPES) {
  const pts = shapePoints(type, 120, 90);
  check(`shapePoints("${type}") is finite and even-length`,
    Array.isArray(pts) && pts.length >= 6 && pts.length % 2 === 0 && pts.every(Number.isFinite));
}
for (const [label, w, h] of [['zero size', 0, 0], ['negative size', -10, -10]]) {
  const pts = shapePoints('diamond', w, h);
  check(`shapePoints handles ${label}`, pts.every(Number.isFinite));
}

// =========================================================================
console.log('\n' + '='.repeat(60));
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
