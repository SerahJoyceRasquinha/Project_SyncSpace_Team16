/**
 * Headless proof of the connector system: the geometry engine (anchors, edge
 * intersection, routing, snapping) and the CRDT semantics (attachment survives
 * shape moves, duplication remaps endpoints, sync between two clients).
 *
 *   node test-connectors.mjs
 *
 * connectors.js imports the shape registry (a .jsx file), so this test bundles
 * the real source with esbuild first — it tests the ACTUAL shipped modules, not
 * a re-implementation.
 */
import { build } from 'esbuild';
import * as Y from 'yjs';
import { rmSync } from 'fs';
import path from 'path';

// the bundle lives INSIDE frontend/ so its `import 'yjs'` resolves to the same
// node_modules copy this test uses — instanceof checks must agree
const out = path.resolve('.test-connectors-bundle.mjs');
process.on('exit', () => rmSync(out, { force: true }));
await build({
  entryPoints: ['src/canvas/test-entry.js'],
  bundle: true,
  format: 'esm',
  outfile: out,
  jsx: 'automatic',
  external: ['yjs'],
  logLevel: 'silent',
  plugins: [{
    // the entry point exists only in memory: re-export everything under test
    name: 'virtual-entry',
    setup(b) {
      b.onResolve({ filter: /test-entry\.js$/ }, (a) => ({ path: a.path, namespace: 'v' }));
      b.onLoad({ filter: /.*/, namespace: 'v' }, () => ({
        contents: `
          export * from './connectors.js';
          export * from './shapeDoc.js';
        `,
        resolveDir: path.resolve('src/canvas'),
        loader: 'js'
      }));
    }
  }]
});
const M = await import(out);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

console.log('\nSyncSpace — connector geometry + CRDT\n');

// ---------------------------------------------------------------- geometry
const rect = { id: 'r1', type: 'rect', x: 100, y: 100, width: 200, height: 100 };
const circle = { id: 'c1', type: 'circle', x: 500, y: 100, width: 100, height: 100 };
const diamond = { id: 'd1', type: 'diamond', x: 300, y: 400, width: 120, height: 80 };

// 1. named anchors sit on the box edge midpoints
let a = M.anchorPoint(rect, 'e');
check('anchor e = right edge midpoint', near(a.x, 300) && near(a.y, 150), JSON.stringify(a));
a = M.anchorPoint(rect, 'n');
check('anchor n = top edge midpoint', near(a.x, 200) && near(a.y, 100));

// 2. edge intersection: a ray toward the right exits a RECT at its right edge
let p = M.edgePoint(rect, { x: 600, y: 150 });
check('rect edge point on right edge', near(p.x, 300) && near(p.y, 150), JSON.stringify(p));

// 3. ...but exits a CIRCLE at radius distance, not at the bounding box
p = M.edgePoint(circle, { x: 900, y: 150 });
check('circle edge point at radius (not bbox)', near(p.x, 600, 2) && near(p.y, 150, 2), JSON.stringify(p));
p = M.edgePoint(circle, { x: 550, y: -100 });
check('circle edge point tracks direction', p.y < 120 && near(Math.hypot(p.x - 550, p.y - 150), 50, 3));

// 4. diamond: the 45-degree edge, well inside the bounding-box corner
p = M.edgePoint(diamond, { x: 600, y: 300 }); // up-right diagonal
const inCorner = near(p.x, 420, 1) && near(p.y, 400, 1);
check('diamond edge point is on the slanted edge, not the bbox corner', !inCorner, JSON.stringify(p));

// 5. rotation: rotating a rect 90deg moves its 'e' anchor accordingly
const rot = { ...rect, rotation: 90 };
a = M.anchorPoint(rot, 'e');
check('rotated anchor follows the shape', !near(a.x, 300) || !near(a.y, 150), JSON.stringify(a));

// ---------------------------------------------------------------- routing
const byId = new Map([[rect.id, rect], [circle.id, circle]]);
const conn = {
  id: 'k1', type: 'connector', routing: 'straight',
  start: { shapeId: 'r1', anchor: 'auto', x: 0, y: 0 },
  end: { shapeId: 'c1', anchor: 'auto', x: 0, y: 0 },
  waypoints: []
};

// 6. both auto endpoints resolve onto their shapes' facing edges
let route = M.connectorRoute(conn, byId);
check('auto route: starts on rect right edge', near(route[0].x, 300, 2) && near(route[0].y, 138, 20), JSON.stringify(route[0]));
check('auto route: ends on circle left edge', near(route[1].x, 500, 3) && near(route[1].y, 150, 20), JSON.stringify(route[1]));

// 7. moving the attached shape moves the DERIVED route with zero writes
const moved = new Map(byId);
moved.set('c1', { ...circle, x: 800, y: 300 });
const route2 = M.connectorRoute(conn, moved);
check('derived endpoints follow the moved shape', route2[1].x > 700 && route2[1].y > 250, JSON.stringify(route2[1]));

// 8. deleted shape: endpoint falls back to its cached coordinates
const gone = new Map([[rect.id, rect]]);
const cached = { ...conn, end: { shapeId: 'c1', anchor: 'auto', x: 510, y: 160 } };
route = M.connectorRoute(cached, gone);
check('deleted shape -> cached fallback position', near(route[1].x, 510) && near(route[1].y, 160));

// 9. waypoints appear between the endpoints, in order
const bent = { ...conn, waypoints: [400, 50, 450, 250] };
route = M.connectorRoute(bent, byId);
check('waypoints inserted in route order', route.length === 4 && near(route[1].x, 400) && near(route[2].y, 250));

// 10. elbow display path is fully axis-aligned
const elbow = { ...bent, routing: 'elbow' };
const disp = M.displayPoints(elbow, M.connectorRoute(elbow, byId));
const axisAligned = disp.every((q, i) =>
  i === 0 || near(q.x, disp[i - 1].x, 0.6) || near(q.y, disp[i - 1].y, 0.6));
check('elbow display points are axis-aligned', axisAligned, JSON.stringify(disp));

// 11. straight routing leaves the route untouched
check('straight display == route', M.displayPoints(bent, route) === route);

// 12. curved: catmull-rom produces one bezier per segment
const segs = M.catmullRomBeziers(route, 0.5);
check('curved: bezier segment per span', segs.length === route.length - 1);

// ---------------------------------------------------------------- snapping
const shapes = [rect, circle, diamond];

// 13. near an anchor dot -> snaps to that exact named anchor
let snap = M.findSnapTarget({ x: 302, y: 148 }, shapes);
check('snap: anchor dot wins', snap && snap.shapeId === 'r1' && snap.anchor === 'e', JSON.stringify(snap));

// 14. over the body -> smart 'auto' edge attachment
snap = M.findSnapTarget({ x: 180, y: 130 }, shapes);
check('snap: body hover gives auto attachment', snap && snap.shapeId === 'r1' && snap.anchor === 'auto');

// 15. empty canvas -> no snap
check('snap: empty space is null', M.findSnapTarget({ x: 900, y: 900 }, shapes) === null);

// 16. excluded shape is not snapped to (endpoint cannot attach to its own shape)
snap = M.findSnapTarget({ x: 180, y: 130 }, shapes, ['r1']);
check('snap: excluded ids skipped', snap === null || snap.shapeId !== 'r1');

// 17. insertWaypoint lands the bend on the clicked segment
const flat = M.insertWaypoint(bent, M.connectorRoute(bent, byId), { x: 425, y: 150 });
check('insertWaypoint: added between existing bends',
  flat.length === 6 && flat[2] === 425 && flat[3] === 150, JSON.stringify(flat));

// ---------------------------------------------------------------- CRDT layer
const A = new Y.Doc();
const B = new Y.Doc();
A.on('update', (u) => Y.applyUpdate(B, u));
B.on('update', (u) => Y.applyUpdate(A, u));
const user = { name: 'tester', color: '#fff' };

// 18. a connector record syncs to the second client intact
const rectId = M.addShape(A, user, { type: 'rect', x: 0, y: 0, width: 50, height: 50 });
const connId = M.addShape(A, user, {
  type: 'connector', routing: 'elbow', startHead: 'none', endHead: 'filled',
  start: { shapeId: rectId, anchor: 'auto', x: 50, y: 25 },
  end: { x: 200, y: 25 }, waypoints: [], x: 0, y: 0
});
const onB = M.shapesArray(B).toArray().map((m) => M.readShape(m));
const connOnB = onB.find((s) => s.id === connId);
check('connector syncs across clients', !!connOnB && connOnB.start.shapeId === rectId
  && connOnB.routing === 'elbow', JSON.stringify(connOnB));

// 19. updateShapeLive is invisible to the undo manager; updateShape is not
const undo = new Y.UndoManager(M.shapesArray(A), { captureTimeout: 0 });
M.updateShapeLive(A, rectId, { x: 500 });
check('live drag writes are NOT undoable', undo.undoStack.length === 0);
M.updateShape(A, rectId, { x: 510 });
check('final commit IS undoable', undo.undoStack.length === 1);
undo.destroy();

// 20. duplicating {rect + connector} re-wires the copy to the copied rect
const records = M.shapesArray(A).toArray().map((m) => M.readShape(m));
const newIds = M.duplicateShapes(A, user, records);
const all = M.shapesArray(A).toArray().map((m) => M.readShape(m));
const copyConn = all.find((s) => s.type === 'connector' && newIds.includes(s.id));
const copyRect = all.find((s) => s.type === 'rect' && newIds.includes(s.id));
check('duplicate: connector re-wired to the copied shape',
  copyConn && copyRect && copyConn.start.shapeId === copyRect.id, JSON.stringify(copyConn?.start));

// 21. duplicating the connector ALONE detaches it (never grabs the original)
const alone = M.duplicateShapes(A, user, [copyConn]);
const lonely = M.shapesArray(A).toArray().map((m) => M.readShape(m))
  .find((s) => s.id === alone[0]);
check('duplicate alone: endpoint becomes free', lonely && !lonely.start.shapeId);

// 22. reorderShape swaps z with a neighbour, in both directions
const z0 = () => M.shapesArray(A).toArray().map((m) => M.readShape(m))
  .sort((x, y) => (x.zIndex || 0) - (y.zIndex || 0)).map((s) => s.id);
const before = z0();
M.reorderShape(A, before[0], 'forward');
const after = z0();
check('reorder: bring forward swaps neighbours', after[1] === before[0] && after[0] === before[1], after.join());
M.reorderShape(A, before[0], 'backward');
check('reorder: send backward restores order', z0()[0] === before[0]);

// 23. remove the rect: the synced connector still resolves via cached coords
M.removeShapes(A, [rectId]);
const survivors = M.shapesArray(B).toArray().map((m) => M.readShape(m));
const orphan = survivors.find((s) => s.id === connId);
const orphanRoute = M.connectorRoute(orphan, new Map(survivors.map((s) => [s.id, s])));
check('deleting an attached shape never breaks the connector',
  orphanRoute.length === 2 && near(orphanRoute[0].x, 50) && near(orphanRoute[0].y, 25),
  JSON.stringify(orphanRoute));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
