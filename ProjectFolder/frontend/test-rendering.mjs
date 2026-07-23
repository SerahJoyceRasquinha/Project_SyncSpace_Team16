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
const { COMMON_DEFAULTS, shapePoints } = await import('./src/canvas/shapes.jsx');

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
for (const type of ALL_TYPES) {
  const r = mountAndSurvive(
    React.createElement(PropertyPanel, {
      selected: makeShape(type),
      patch: () => {}, onDelete: () => {}, onDuplicate: () => {}, onReorder: () => {}
    })
  );
  check(
    `selecting a "${type}" keeps the UI mounted`,
    r.survived
  );
}
{
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(React.createElement(PropertyPanel, { selected: null, patch: () => {} })); });
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
