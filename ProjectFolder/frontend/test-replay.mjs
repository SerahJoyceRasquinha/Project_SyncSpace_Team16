/**
 * Headless proof of the replay reconstruction engine (src/canvas/replay.js).
 *
 *   node test-replay.mjs
 *
 * test-replay.mjs in backend/ proves the WIRE: that updates are logged and that
 * 'get-replay-logs' returns them safely. This file proves the MATHS: that a
 * prefix of that log rebuilds the exact document that existed at the time, and
 * that the forward-only cache the slider relies on is indistinguishable from
 * rebuilding from scratch. replay.js imports nothing but Yjs, so it runs here
 * directly with no bundler.
 */
import * as Y from 'yjs';
import { toBytes, rebuildTo, ReplayCache, frameBounds } from './src/canvas/replay.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + ' ' + detail); }
};

console.log('\nSyncSpace — replay reconstruction engine\n');

// ---- build a recorded session ----------------------------------------
// A doc that records its own updates, exactly as the server's log does.
const live = new Y.Doc();
const entries = [];
live.on('update', (u) => entries.push({ seq: entries.length, payload: u }));

const shapes = live.getArray('shapes');
const mkRect = (id, x) => {
  const m = new Y.Map();
  live.transact(() => {
    m.set('id', id);
    m.set('type', 'rect');
    m.set('x', x); m.set('y', 20);
    m.set('width', 60); m.set('height', 40);
    shapes.push([m]);
  });
  return m;
};

const r1 = mkRect('r1', 0);
mkRect('r2', 100);
mkRect('r3', 200);
live.transact(() => r1.set('x', 500));             // a move
live.getText('monaco').insert(0, 'hello world\n'); // an editor edit
live.transact(() => shapes.delete(1, 1));          // a delete

check('the session recorded some updates', entries.length >= 6, `got ${entries.length}`);

const idsOf = (doc) => doc.getArray('shapes').toArray().map((m) => m.get('id'));

// ---- 1. full reconstruction ------------------------------------------
const full = rebuildTo(entries, entries.length);
check('replaying the whole log reproduces the shapes exactly',
  JSON.stringify(idsOf(full)) === JSON.stringify(idsOf(live)),
  `${JSON.stringify(idsOf(full))} vs ${JSON.stringify(idsOf(live))}`);
check('replaying the whole log reproduces the editor text',
  full.getText('monaco').toString() === live.getText('monaco').toString());
check('replaying the whole log reproduces field-level edits',
  full.getArray('shapes').toArray().find((m) => m.get('id') === 'r1')?.get('x') === 500);

// ---- 2. prefixes are real intermediate states -------------------------
check('index 0 is the empty board', rebuildTo(entries, 0).getArray('shapes').length === 0);
check('index 1 shows exactly the first object', idsOf(rebuildTo(entries, 1)).length === 1);

// the delete is the LAST update, so the frame before it still has r2
const beforeDelete = rebuildTo(entries, entries.length - 1);
check('a prefix shows an object that was later deleted',
  idsOf(beforeDelete).includes('r2') && !idsOf(live).includes('r2'));

// the move happened after all three were created
const beforeMove = rebuildTo(entries, 3);
check('a prefix shows a shape at its ORIGINAL position (before the move)',
  beforeMove.getArray('shapes').toArray().find((m) => m.get('id') === 'r1')?.get('x') === 0);

// ---- 3. the cache invariant (the slider depends on this) --------------
// Scrubbing forward incrementally must equal rebuilding from scratch, at
// EVERY index. This is the one property that would silently corrupt replay.
const cache = new ReplayCache(entries);
let forwardOk = true;
for (let n = 0; n <= entries.length; n++) {
  const cached = cache.at(n);
  const fresh = rebuildTo(entries, n);
  if (JSON.stringify(idsOf(cached)) !== JSON.stringify(idsOf(fresh)) ||
      cached.getText('monaco').toString() !== fresh.getText('monaco').toString()) {
    forwardOk = false;
    break;
  }
}
check('scrubbing FORWARD matches a from-scratch rebuild at every index', forwardOk);

// ...and backwards, which forces the cache to discard and start over
const back = new ReplayCache(entries);
back.at(entries.length);
let backwardOk = true;
for (let n = entries.length; n >= 0; n--) {
  const cached = back.at(n);
  const fresh = rebuildTo(entries, n);
  if (JSON.stringify(idsOf(cached)) !== JSON.stringify(idsOf(fresh))) { backwardOk = false; break; }
}
check('scrubbing BACKWARD matches a from-scratch rebuild at every index', backwardOk);

// jumping around at random, which is what a dragged slider actually does
const jumpy = new ReplayCache(entries);
let jumpOk = true;
for (const n of [4, 1, 6, 0, 3, entries.length, 2, 5]) {
  const cached = jumpy.at(n);
  if (JSON.stringify(idsOf(cached)) !== JSON.stringify(idsOf(rebuildTo(entries, n)))) {
    jumpOk = false; break;
  }
}
check('random scrubbing matches a from-scratch rebuild', jumpOk);

check('asking for the same index twice is stable',
  JSON.stringify(idsOf(jumpy.at(3))) === JSON.stringify(idsOf(jumpy.at(3))));

// ---- 4. out-of-range indices are clamped, not crashes -----------------
check('an index past the end clamps to the final state',
  JSON.stringify(idsOf(rebuildTo(entries, 9999))) === JSON.stringify(idsOf(live)));
check('a negative index clamps to the empty board',
  rebuildTo(entries, -5).getArray('shapes').length === 0);

// ---- 5. toBytes handles every shape socket.io delivers ----------------
const sample = entries[0].payload;
check('toBytes passes a Uint8Array through', toBytes(sample) instanceof Uint8Array);
check('toBytes accepts a plain array',
  toBytes(Array.from(sample))?.length === sample.length);
check('toBytes accepts a serialised Node Buffer',
  toBytes({ type: 'Buffer', data: Array.from(sample) })?.length === sample.length);
check('toBytes accepts a raw ArrayBuffer',
  toBytes(sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength))
    ?.length === sample.length);
check('toBytes rejects junk without throwing',
  toBytes(null) === null && toBytes(42) === null && toBytes('nope') === null);

// ---- 6. one bad entry must not destroy the whole replay ---------------
const poisoned = entries.slice();
poisoned.splice(2, 0, { seq: -1, payload: null });
const survived = rebuildTo(poisoned, poisoned.length);
check('a malformed entry is skipped, the rest still replays',
  JSON.stringify(idsOf(survived)) === JSON.stringify(idsOf(live)));

const garbage = entries.slice();
garbage.splice(2, 0, { seq: -1, payload: Uint8Array.from([9, 9, 9, 9, 9]) });
let threw = false;
const quiet = console.warn;
console.warn = () => {}; // the skip-and-continue warning is the POINT here
try { rebuildTo(garbage, garbage.length); } catch { threw = true; }
console.warn = quiet;
check('a corrupt payload never throws out of rebuildTo', threw === false);

// ---- 7. an empty log is a valid, empty replay -------------------------
check('an empty log rebuilds an empty document',
  rebuildTo([], 0).getArray('shapes').length === 0);
check('a fresh cache over an empty log is safe',
  new ReplayCache([]).at(5).getArray('shapes').length === 0);

// ---- 7b. stickers / images replay like any other record ---------------
// Replay is type-agnostic by construction - it applies opaque Yjs updates and
// never inspects the shape schema - so a sticker or an uploaded image needs no
// special handling. Asserted explicitly so that stays true as shapes are added.
const withImage = new Y.Doc();
const imgEntries = [];
withImage.on('update', (u) => imgEntries.push({ seq: imgEntries.length, payload: u }));
const STICKER_SRC =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3C/svg%3E';
withImage.transact(() => {
  const m = new Y.Map();
  m.set('id', 'sticker-1');
  m.set('type', 'image');
  m.set('src', STICKER_SRC);
  m.set('x', 30); m.set('y', 30);
  m.set('width', 64); m.set('height', 64);
  withImage.getArray('shapes').push([m]);
});
withImage.transact(() =>
  withImage.getArray('shapes').get(0).set('x', 400)   // move the sticker
);

const imgReplay = rebuildTo(imgEntries, imgEntries.length);
const replayed = imgReplay.getArray('shapes').get(0);
check('a sticker / image record survives a full replay',
  replayed?.get('type') === 'image' && replayed?.get('src') === STICKER_SRC);
check('a sticker shows its ORIGINAL position at an earlier index',
  rebuildTo(imgEntries, 1).getArray('shapes').get(0)?.get('x') === 30 &&
  replayed?.get('x') === 400);
check('frameBounds measures an image by its box',
  (() => {
    const r = frameBounds([{ x: 30, y: 30, width: 64, height: 64 }]);
    return r.minX === 30 && r.width === 64;
  })());

// ---- 8. frameBounds ---------------------------------------------------
const b = frameBounds([{ x: 10, y: 20, width: 100, height: 50 }]);
check('frameBounds measures a plain box',
  b.minX === 10 && b.minY === 20 && b.width === 100 && b.height === 50);

const bp = frameBounds([{ x: 0, y: 0, points: [5, 5, 25, 45] }]);
check('frameBounds measures a stroke from its points',
  bp.minX === 5 && bp.minY === 5 && bp.maxX === 25 && bp.maxY === 45);

check('frameBounds returns null for nothing to frame', frameBounds([]) === null);
check('frameBounds ignores non-finite geometry without producing NaN', (() => {
  const r = frameBounds([{ x: NaN, y: undefined, width: 'x', height: null },
                         { x: 4, y: 4, width: 6, height: 6 }]);
  return r && Number.isFinite(r.minX) && Number.isFinite(r.width);
})());

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
