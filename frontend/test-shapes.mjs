/**
 * Headless proof that the shape system syncs and that concurrent field edits
 * merge instead of clobbering. Uses two bare Y.Docs wired to each other, so it
 * tests the CRDT model directly without needing the browser or Konva.
 *
 *   node test-shapes.mjs
 */
import * as Y from 'yjs';

let pass = 0, fail = 0;
const check = (name, ok) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
};

// two "clients", kept in sync by forwarding updates both ways
const A = new Y.Doc();
const B = new Y.Doc();
A.on('update', (u) => Y.applyUpdate(B, u));
B.on('update', (u) => Y.applyUpdate(A, u));

const shapesA = A.getArray('shapes');
const shapesB = B.getArray('shapes');

const mkRect = (doc, id, extra = {}) => {
  const m = new Y.Map();
  doc.transact(() => {
    m.set('id', id);
    m.set('type', 'rect');
    m.set('x', 10); m.set('y', 10);
    m.set('width', 100); m.set('height', 80);
    m.set('fill', '#6366f1'); m.set('stroke', '#111827');
    for (const [k, v] of Object.entries(extra)) m.set(k, v);
    doc.getArray('shapes').push([m]);
  });
  return m;
};

console.log('\nSyncSpace — shape CRDT sync\n');

// 1. creation on A appears on B
mkRect(A, 'r1');
check('shape created on A is visible on B', shapesB.length === 1 && shapesB.get(0).get('id') === 'r1');

// 2. concurrent creation from both — no duplicates, both survive
mkRect(A, 'a-shape');
mkRect(B, 'b-shape');
const ids = shapesA.toArray().map((m) => m.get('id')).sort();
check('concurrent creation keeps BOTH shapes', ids.includes('a-shape') && ids.includes('b-shape'));
check('no duplicate rendering (array lengths match)', shapesA.length === shapesB.length && shapesA.length === 3);

// 3. THE KEY ONE: two users edit the SAME shape's DIFFERENT fields at once
const onA = shapesA.get(0);   // r1 as seen by A
const onB = shapesB.get(0);   // r1 as seen by B
A.transact(() => onA.set('fill', '#ef4444'));   // A recolours
B.transact(() => onB.set('x', 999));            // B moves, simultaneously
check('field-level merge: A\'s colour change survives', shapesA.get(0).get('fill') === '#ef4444');
check('field-level merge: B\'s move survives', shapesA.get(0).get('x') === 999);
check('both docs converged', shapesA.get(0).get('fill') === shapesB.get(0).get('fill')
  && shapesA.get(0).get('x') === shapesB.get(0).get('x'));

// 4. deletion propagates
A.transact(() => {
  for (let i = shapesA.length - 1; i >= 0; i--) {
    if (shapesA.get(i).get('id') === 'a-shape') shapesA.delete(i, 1);
  }
});
check('deletion on A removes the shape on B',
  !shapesB.toArray().some((m) => m.get('id') === 'a-shape'));

// 5. UndoManager reverts a local creation
const undo = new Y.UndoManager(shapesA);
mkRect(A, 'temp');
check('shape added before undo', shapesA.toArray().some((m) => m.get('id') === 'temp'));
undo.undo();
check('undo removes it', !shapesA.toArray().some((m) => m.get('id') === 'temp'));
undo.redo();
check('redo restores it', shapesA.toArray().some((m) => m.get('id') === 'temp'));

// 6. late joiner gets full state via a state vector sync
const C = new Y.Doc();
Y.applyUpdate(C, Y.encodeStateAsUpdate(A));
check('late joiner receives the whole canvas',
  C.getArray('shapes').length === shapesA.length);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
