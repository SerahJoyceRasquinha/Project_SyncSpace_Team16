/**
 * Headless proof of the Pen/Brush + Eraser + Undo work. Like test-connectors,
 * this bundles the REAL shipped modules with esbuild (shapeDoc.js pulls in the
 * .jsx shape registry) so we test the actual code, not a re-implementation.
 *
 *   node test-brushes.mjs
 *
 * Two areas:
 *   1. pure geometry — brush dash, simplify, chaikin, calligraphy ribbon,
 *      eraser hit-marking and stroke splitting;
 *   2. CRDT semantics — a partial erase is one atomic transaction that splits a
 *      stroke, syncs to a second client, undoes/redoes as a SINGLE step, and a
 *      remote collaborator's edits are never reverted by the local user's undo.
 */
import { build } from 'esbuild';
import * as Y from 'yjs';
import { rmSync } from 'fs';
import path from 'path';

const out = path.resolve('.test-brushes-bundle.mjs');
process.on('exit', () => rmSync(out, { force: true }));
await build({
  entryPoints: ['src/canvas/test-brush-entry.js'],
  bundle: true,
  format: 'esm',
  outfile: out,
  jsx: 'automatic',
  external: ['yjs'],
  logLevel: 'silent',
  plugins: [{
    name: 'virtual-entry',
    setup(b) {
      b.onResolve({ filter: /test-brush-entry\.js$/ }, (a) => ({ path: a.path, namespace: 'v' }));
      b.onLoad({ filter: /.*/, namespace: 'v' }, () => ({
        contents: `
          export * from './brushes.js';
          export * from './shapeDoc.js';
        `,
        resolveDir: path.resolve('src/canvas'),
        loader: 'js'
      }));
    }
  }]
});

const M = await import(out);
const {
  dashArray, simplify, chaikin, calligraphyRibbon, segDist2, pointsBounds,
  markErased, surviveRuns,
  shapesArray, readShape, addShape, commitStroke, applyErase, removeShapes
} = M;

let pass = 0, fail = 0;
const check = (name, ok) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('\nSyncSpace — brushes, eraser & undo\n');

// ------------------------------------------------------------- 1. geometry
console.log('brush geometry');

check('dash: pen is solid (null)', dashArray('pen', 4) === null);
check('dash: dashed scales with width', (() => {
  const d = dashArray('dashed', 5); return Array.isArray(d) && approx(d[0], 11) && approx(d[1], 9);
})());
check('dash: dotted is ~zero dash + gap (round-cap dots)', (() => {
  const d = dashArray('dotted', 4); return d[0] < 0.1 && approx(d[1], 8);
})());

check('simplify: a straight run collapses to its endpoints', (() => {
  const line = [];
  for (let i = 0; i <= 10; i++) line.push(i * 10, 0);
  const s = simplify(line, 0.5);
  return s.length === 4 && s[0] === 0 && s[2] === 100;
})());
check('simplify: keeps a real corner', (() => {
  const s = simplify([0, 0, 50, 0, 50, 50], 0.5);
  return s.length === 6; // the corner point survives
})());

check('chaikin: rounds corners and preserves endpoints', (() => {
  const c = chaikin([0, 0, 10, 0, 10, 10], 1);
  return c.length > 6 && c[0] === 0 && c[1] === 0 &&
    c[c.length - 2] === 10 && c[c.length - 1] === 10;
})());

check('calligraphy: closed ribbon has 2 vertices per point', (() => {
  const pts = [0, 0, 10, 0, 20, 0];
  const ribbon = calligraphyRibbon(pts, 12, 45, false);
  return ribbon.length === (pts.length / 2) * 2 * 2;
})());
check('calligraphy: thickness swells perpendicular to the nib, thins parallel', (() => {
  // nib at 0deg (horizontal). A vertical stroke is perpendicular -> thick;
  // a horizontal stroke is parallel -> thin. Compare ribbon widths at the middle.
  const widthOf = (pts) => {
    const r = calligraphyRibbon(pts, 20, 0, false);
    const n = pts.length / 2;
    const mid = Math.floor(n / 2);
    // left[mid] vs right[mid] (right is stored reversed at the tail)
    const lx = r[mid * 2], ly = r[mid * 2 + 1];
    const rx = r[(2 * n - 1 - mid) * 2], ry = r[(2 * n - 1 - mid) * 2 + 1];
    return Math.hypot(lx - rx, ly - ry);
  };
  const vertical = [0, 0, 0, 10, 0, 20, 0, 30];
  const horizontal = [0, 0, 10, 0, 20, 0, 30, 0];
  return widthOf(vertical) > widthOf(horizontal) + 2;
})());

check('segDist2: point to segment distance is correct', () =>
  approx(segDist2(5, 5, 0, 0, 10, 0), 25) && approx(segDist2(5, 0, 0, 0, 10, 0), 0));

check('pointsBounds: axis-aligned extent', (() => {
  const b = pointsBounds([0, 0, 30, 10, -5, 40]);
  return b.minX === -5 && b.maxX === 30 && b.minY === 0 && b.maxY === 40;
})());

// ------------------------------------------------------------- eraser split
console.log('\neraser splitting');

// horizontal stroke, 11 points spaced 10 apart
const H = [];
for (let i = 0; i <= 10; i++) H.push(i * 10, 0);

check('erase middle -> two surviving runs', (() => {
  const set = new Set();
  markErased(H, 50, 0, 5, set);           // stamp on the centre vertex
  const runs = surviveRuns(H, set);
  return runs.length === 2 &&
    runs[0][0] === 0 &&                    // left run starts at the origin
    runs[1][runs[1].length - 2] === 100;   // right run ends at the far end
})());

check('erase near an end -> one run preserved', (() => {
  const set = new Set();
  markErased(H, 0, 0, 5, set);
  const runs = surviveRuns(H, set);
  return runs.length === 1 && runs[0][runs[0].length - 2] === 100;
})());

check('erase the whole stroke -> no runs', (() => {
  const set = new Set();
  for (let x = 0; x <= 100; x += 5) markErased(H, x, 0, 8, set);
  return surviveRuns(H, set).length === 0;
})());

check('a distant stamp erases nothing', (() => {
  const set = new Set();
  markErased(H, 50, 500, 5, set);
  return set.size === 0 && surviveRuns(H, set).length === 1;
})());

// ------------------------------------------------------------- 2. CRDT
console.log('\npartial erase over Yjs (two clients, undo/redo)');

// two "clients" kept in sync; A's writes reach B as 'remote' (and vice-versa)
const A = new Y.Doc();
const B = new Y.Doc();
A.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(B, u, 'remote'); });
B.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(A, u, 'remote'); });

const shapesA = shapesArray(A);
const shapesB = shapesArray(B);
const me = { name: 'tester', color: '#111827' };

// UndoManager exactly like Canvas: tracks local (origin null) writes only
const undo = new Y.UndoManager(shapesA, { captureTimeout: 0 });

// draw one long stroke
const strokeId = commitStroke(A, me, {
  brush: 'marker', stroke: '#3b82f6', strokeWidth: 12, opacity: 0.9, points: H.slice()
});
check('commitStroke: creates one path record, synced to B', () =>
  shapesA.length === 1 && shapesB.length === 1 &&
  readShape(shapesB.get(0)).type === 'path' &&
  readShape(shapesB.get(0)).brush === 'marker');

const undoDepthBefore = undo.undoStack.length;

// erase the middle -> should split into two strokes, atomically
const set = new Set();
markErased(H, 50, 0, 5, set);
applyErase(A, me, [{ id: strokeId, runs: surviveRuns(H, set) }]);

check('erase splits the stroke into two fragments', () => shapesA.length === 2);
check('the split is ONE undo step', () => undo.undoStack.length === undoDepthBefore + 1);
check('fragments inherit the brush + colour + opacity', () => {
  const f = readShape(shapesA.get(0));
  return f.brush === 'marker' && f.stroke === '#3b82f6' && approx(f.opacity, 0.9);
});
check('the erase synced to B (B also has two fragments)', () => shapesB.length === 2);
check('the original stroke id is gone', () =>
  ![0, 1].some((i) => readShape(shapesA.get(i)).id === strokeId));

// undo the erase -> the single original stroke comes back, everywhere
undo.undo();
check('undo restores the single original stroke', () => shapesA.length === 1);
check('undo restores the exact original points', () => {
  const p = readShape(shapesA.get(0)).points;
  return p.length === H.length && p[0] === 0 && p[p.length - 2] === 100;
});
check('undo synced to B (B back to one stroke)', () => shapesB.length === 1);

// redo -> the split returns
undo.redo();
check('redo re-applies the split (two strokes again)', () => shapesA.length === 2);
check('redo synced to B', () => shapesB.length === 2);

// ------------------------------------------------------------- collaboration isolation
console.log('\ncollaborative undo isolation');

// B (a different collaborator) draws a stroke; it reaches A as a remote update
const bStroke = commitStroke(B, { name: 'other' }, {
  brush: 'pen', stroke: '#ef4444', strokeWidth: 4, points: [200, 200, 260, 240]
});
const aCountWithRemote = shapesA.length;
check('remote collaborator stroke appears locally', () =>
  shapesA.length === aCountWithRemote && [...Array(shapesA.length).keys()]
    .some((i) => readShape(shapesA.get(i)).id === bStroke));

// A undoes: it must revert only A's own last action, never B's remote stroke
undo.undo();
check("local undo does NOT revert the remote collaborator's stroke", () =>
  [...Array(shapesA.length).keys()].some((i) => readShape(shapesA.get(i)).id === bStroke));

// ------------------------------------------------------------- full erase
console.log('\nfull erase');
const solo = commitStroke(A, me, { brush: 'pen', stroke: '#000', strokeWidth: 3, points: [0, 0, 5, 0, 10, 0] });
const beforeFull = shapesA.length;
const fset = new Set([0, 1, 2]);
applyErase(A, me, [{ id: solo, runs: surviveRuns([0, 0, 5, 0, 10, 0], fset) }]);
check('erasing every vertex deletes the stroke', () => shapesA.length === beforeFull - 1);
undo.undo();
check('undo brings the fully-erased stroke back', () => shapesA.length === beforeFull);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
