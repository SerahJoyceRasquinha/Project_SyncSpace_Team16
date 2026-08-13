/**
 * Direct unit tests for the replay update log's capacity policy.
 *
 *   node test-updatelog.mjs
 *
 * No server, no database: the log service runs in its in-memory mode, so this
 * exercises the budget and the coalescing path deterministically instead of
 * trying to provoke them through a live socket session.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * The old ceiling was a flat 5 000 entries. Dragging a shape emits a throttled
 * position commit every 45 ms (~22/sec), so under four minutes of ordinary
 * dragging silently exhausted a room's whole replay history. Two changes fixed
 * that, and both need holding in place:
 *
 *   1. consecutive updates from one user inside COALESCE_WINDOW_MS merge into a
 *      single entry, so a drag costs a handful of slots instead of hundreds;
 *   2. the ceiling is count AND bytes, so neither a flood of tiny updates nor a
 *      few enormous ones can run away.
 *
 * The non-negotiable property throughout: merging must never change what the
 * log reconstructs. Every test below that compacts history also replays it.
 */
import * as Y from 'yjs';
import * as logs from './services/updateLogService.js';

let pass = 0, fail = 0;
const check = (name, ok, note = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (note ? '  ' + note : '')); }
};
const group = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rebuild a document from a room's whole log, the way the replay UI does. */
async function rebuild(roomId) {
  const doc = new Y.Doc();
  for (const e of await logs.getLogs(roomId)) {
    Y.applyUpdate(doc, new Uint8Array(e.payload));
  }
  return doc;
}

console.log('\nSyncSpace — replay log capacity\n');

// =========================================================================
group('1. Coalescing compacts a burst without losing any history');
// =========================================================================
{
  const room = 'coalesce-room';
  await logs.clearLogs(room);

  const src = new Y.Doc();
  const arr = src.getArray('shapes');
  // Subscribe BEFORE the first transaction: the creation update has to be in
  // the log too, or every later update references an item Yjs has never seen
  // and parks as pending.
  const emitted = [];
  src.on('update', (u) => emitted.push(u));

  const m = new Y.Map();
  src.transact(() => { m.set('id', 'drag-me'); m.set('x', 0); arr.push([m]); });

  // a drag: 300 tiny position commits in rapid succession, one user
  for (let i = 1; i <= 300; i++) src.transact(() => m.set('x', i));
  for (const u of emitted) await logs.appendUpdate(room, u, { userId: 'u1', username: 'Serah' });

  const stored = await logs.countLogs(room);
  check('a 300-update drag stores far fewer entries than updates',
    stored > 0 && stored < 300 / 4, `301 updates -> ${stored} entries`);

  // …and the compacted log still rebuilds the exact document
  const doc = await rebuild(room);
  const rebuilt = doc.getArray('shapes').get(0);
  check('the coalesced log reconstructs the final state exactly',
    rebuilt?.get('x') === 300, `x=${rebuilt?.get('x')}`);
  check('the coalesced log keeps the object identity',
    rebuilt?.get('id') === 'drag-me');

  // every PREFIX must still be a valid document — this is the property the
  // replay slider rests on, and the one merging could plausibly have broken
  const all = await logs.getLogs(room);
  let prefixesOk = true;
  for (let n = 1; n <= all.length; n++) {
    const d = new Y.Doc();
    try {
      for (let i = 0; i < n; i++) Y.applyUpdate(d, new Uint8Array(all[i].payload));
      if (d.getArray('shapes').length !== 1) prefixesOk = false;
    } catch { prefixesOk = false; }
  }
  check('every prefix of the coalesced log is a valid document', prefixesOk);
}

// =========================================================================
group('2. Separate actions stay separate replay steps');
// =========================================================================
{
  const room = 'window-room';
  await logs.clearLogs(room);
  const src = new Y.Doc();
  const arr = src.getArray('shapes');
  const emitted = [];
  src.on('update', (u) => emitted.push(u));

  src.transact(() => arr.push([new Y.Map()]));
  await logs.appendUpdate(room, emitted.pop(), { userId: 'u1' });
  // past the coalescing window: a deliberate second action
  await wait(logs.COALESCE_WINDOW_MS + 120);
  src.transact(() => arr.push([new Y.Map()]));
  await logs.appendUpdate(room, emitted.pop(), { userId: 'u1' });

  check('actions separated by a pause are NOT merged',
    (await logs.countLogs(room)) === 2, `entries=${await logs.countLogs(room)}`);
}
{
  const room = 'user-room';
  await logs.clearLogs(room);
  const src = new Y.Doc();
  const arr = src.getArray('shapes');
  const emitted = [];
  src.on('update', (u) => emitted.push(u));

  src.transact(() => arr.push([new Y.Map()]));
  await logs.appendUpdate(room, emitted.pop(), { userId: 'alice' });
  src.transact(() => arr.push([new Y.Map()]));
  await logs.appendUpdate(room, emitted.pop(), { userId: 'bob' });

  // attribution is shown in the scrubber, so merging across users would lie
  check('updates from DIFFERENT users are never merged together',
    (await logs.countLogs(room)) === 2, `entries=${await logs.countLogs(room)}`);
}

// =========================================================================
group('3. The budget still stops a runaway room');
// =========================================================================
{
  check('the entry ceiling was raised well past the old 5 000',
    logs.MAX_LOGS_PER_ROOM > 5000, `cap=${logs.MAX_LOGS_PER_ROOM}`);
  check('a byte ceiling exists alongside the entry ceiling',
    logs.MAX_LOG_BYTES_PER_ROOM > 0, `bytes=${logs.MAX_LOG_BYTES_PER_ROOM}`);

  const room = 'bytes-room';
  await logs.clearLogs(room);

  // Big payloads, spaced past the coalescing window so each takes its own slot.
  // ~1 MB each against a 32 MB budget: recording must stop, and stop cleanly.
  const big = Buffer.alloc(1024 * 1024, 7);
  let accepted = 0;
  for (let i = 0; i < 40; i++) {
    const r = await logs.appendUpdate(room, big, { userId: `u${i}` });
    if (r) accepted++;
  }
  check('the byte budget stops recording before memory runs away',
    accepted < 40, `accepted=${accepted}/40`);
  check('the room reports itself as capped once the budget is spent',
    (await logs.isCapped(room)) === true);
  check('the entries accepted before the cap are all still there',
    (await logs.countLogs(room)) === accepted);

  // The head is what replay needs; a ring buffer would have been the one wrong
  // structure here (a suffix references items Yjs never saw).
  const kept = await logs.getLogs(room);
  check('the log kept the HEAD of the session, in order',
    kept.every((e, i) => i === 0 || e.seq > kept[i - 1].seq) &&
    (kept[0]?.seq === 0));
}

// =========================================================================
group('4. Failure modes degrade rather than throw');
// =========================================================================
{
  const room = 'junk-room';
  await logs.clearLogs(room);
  check('an empty payload is skipped, not stored',
    (await logs.appendUpdate(room, Buffer.alloc(0), {})) === null);
  check('a missing room id is skipped', (await logs.appendUpdate(null, Buffer.from([1]), {})) === null);

  // An unmergeable buffer must cost the compaction, never the append.
  const src = new Y.Doc();
  const emitted = [];
  src.on('update', (u) => emitted.push(u));
  src.transact(() => src.getArray('shapes').push([new Y.Map()]));
  await logs.appendUpdate(room, emitted.pop(), { userId: 'u1' });
  const junk = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);
  let threw = false;
  try { await logs.appendUpdate(room, junk, { userId: 'u1' }); } catch { threw = true; }
  check('a malformed update never throws out of appendUpdate', threw === false);
  check('the good entry before it survived', (await logs.countLogs(room)) >= 1);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
