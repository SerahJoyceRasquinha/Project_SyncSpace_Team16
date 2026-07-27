/**
 * End-to-end test of the REPLAY system (Blueprint 8.4 + Part 13).
 * Server must be running.   Usage:  node test-replay.mjs
 *
 * Proves, in order:
 *   1.  Every relayed update is appended to the room's log
 *   2.  'get-replay-logs' answers on the 'replay-logs' EVENT (blueprint wording)
 *   3.  ...and on the acknowledgement callback too
 *   4.  Entries come back in order, with seq / timestamp / author metadata
 *   5.  REPLAYING THE WHOLE LOG reconstructs the live document exactly
 *   6.  Replaying a PREFIX gives a true intermediate state (the slider's job)
 *   7.  Replay covers the code editor, not just the whiteboard
 *   8.  Attribution: an update is logged against the user who made it
 *   9.  ISOLATION: a second workspace has its own history, with no leakage
 *   10. A LOBBY socket cannot read history (no handler is registered for it)
 *   11. Live collaboration is unaffected by logging
 */
import { io } from 'socket.io-client';
import * as Y from 'yjs';

const URL = process.env.URL || 'http://localhost:5000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
};

async function post(path, body, token) {
  const res = await fetch(`${URL}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function connect(token) {
  const ydoc = new Y.Doc();
  const socket = io(URL, { auth: { token } });
  ydoc.on('update', (u, origin) => {
    if (origin !== 'remote') socket.emit('sync-update', u);
  });
  socket.on('sync-update', (u) => Y.applyUpdate(ydoc, new Uint8Array(u), 'remote'));
  return { socket, ydoc };
}

/**
 * Fetch the log over the STREAMED protocol (begin / chunk / end) and return
 * the same shape the old single-message response had, so every assertion
 * below keeps its meaning: { workspaceId, count, capped, entries }.
 * Resolves null on timeout — which is also how the lobby-refusal test reads.
 */
function getLogsViaEvent(socket, timeout = 5000) {
  return new Promise((resolve) => {
    let meta = null;
    let entries = null;
    let received = 0;

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('replay-logs-begin', onBegin);
      socket.off('replay-logs-chunk', onChunk);
      socket.off('replay-logs-end', onEnd);
      socket.off('replay-logs-error', onError);
    };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);

    const onBegin = (res) => {
      meta = res;
      entries = (res.meta || []).map((m) => ({ ...m, payload: null }));
      if (!entries.length) { cleanup(); resolve({ ...res, entries: [] }); }
    };
    const onChunk = (chunk) => {
      if (!entries) return;
      const data = toBytes(chunk.data) || new Uint8Array(0);
      let off = 0;
      chunk.sizes.forEach((size, j) => {
        entries[chunk.start + j].payload = data.subarray(off, off + size);
        off += size;
        received++;
      });
    };
    const onEnd = () => {
      cleanup();
      resolve(meta && received >= entries.length
        ? { workspaceId: meta.workspaceId, count: meta.count, capped: meta.capped, entries }
        : null);
    };
    const onError = (res) => { cleanup(); resolve({ ...res, failed: true, entries: [] }); };

    socket.on('replay-logs-begin', onBegin);
    socket.on('replay-logs-chunk', onChunk);
    socket.on('replay-logs-end', onEnd);
    socket.on('replay-logs-error', onError);
    socket.emit('get-replay-logs', {});
  });
}

const toBytes = (p) =>
  p instanceof Uint8Array ? p
    : p instanceof ArrayBuffer ? new Uint8Array(p)
    : Array.isArray(p) ? Uint8Array.from(p)
    : Array.isArray(p?.data) ? Uint8Array.from(p.data)
    : null;

/** Rebuild a document from the first `n` logged updates. */
function rebuild(entries, n) {
  const doc = new Y.Doc();
  for (let i = 0; i < n; i++) {
    const bytes = toBytes(entries[i].payload);
    if (bytes) Y.applyUpdate(doc, bytes, 'replay');
  }
  return doc;
}

const shapeCount = (doc) => doc.getArray('shapes').length;

console.log('\nSyncSpace — replay / updatelogs\n');

// ------------------------------------------------------------ workspace A
const created = await post('/workspaces', {
  name: 'Replay Demo Room',
  password: 'secret123',
  username: 'Serah',
  permissionMode: 'password'
});
if (created.status !== 201) {
  console.log('  FAIL  could not create workspace', JSON.stringify(created.data));
  process.exit(1);
}
const wsId = created.data.workspace.workspaceId;
const adminToken = created.data.token;
console.log(`        workspace = ${wsId}\n`);

const admin = connect(adminToken);
await wait(500);

// ---- make a history we can recognise later ---------------------------
// three shapes, added one at a time, plus some code
const shapes = admin.ydoc.getArray('shapes');

const addShape = (id, x) => {
  const m = new Y.Map();
  m.set('id', id);
  m.set('type', 'rect');
  m.set('x', x);
  m.set('y', 40);
  m.set('width', 80);
  m.set('height', 60);
  admin.ydoc.transact(() => shapes.push([m]));
};

addShape('r1', 10);
await wait(250);
addShape('r2', 120);
await wait(250);
addShape('r3', 230);
await wait(250);

admin.ydoc.getText('monaco').insert(0, 'print("replay")\n');
await wait(600);

// 1 / 2 -------------------------------------------------- fetch the log
const viaEvent = await getLogsViaEvent(admin.socket);
check('get-replay-logs answers over the replay-logs stream', viaEvent !== null && !viaEvent.failed);
check('every relayed update was logged',
  (viaEvent?.count || 0) >= 4, `got ${viaEvent?.count}`);

const entries = viaEvent?.entries || [];

// 3 ---------------------------------------------------- ack path as well
// The ack is a SUMMARY on purpose: payloads in an ack would be one packet
// with one attachment per entry, the exact shape the parser refuses.
const viaAck = await new Promise((resolve) =>
  admin.socket.emit('get-replay-logs', {}, resolve)
);
check('the acknowledgement callback answers a summary too',
  viaAck?.ok === true && viaAck.streamed === true && viaAck.count === viaEvent.count);

// 4 ------------------------------------------------------------ metadata
const ordered = entries.every((e, i) => i === 0 || e.seq > entries[i - 1].seq);
check('entries are ordered by seq, oldest first', ordered);
check('entries carry a timestamp and a payload',
  entries.every((e) => Number.isFinite(e.timestamp) && toBytes(e.payload)?.length > 0));
check('workspace id is echoed back', viaEvent.workspaceId === wsId);

// 5 ------------------------------------- full replay == the live document
const full = rebuild(entries, entries.length);
check('replaying the whole log reproduces the live shape count',
  shapeCount(full) === shapeCount(admin.ydoc),
  `replay=${shapeCount(full)} live=${shapeCount(admin.ydoc)}`);

const liveIds = admin.ydoc.getArray('shapes').toArray().map((m) => m.get('id')).sort();
const replayIds = full.getArray('shapes').toArray().map((m) => m.get('id')).sort();
check('replaying the whole log reproduces the exact shapes',
  JSON.stringify(liveIds) === JSON.stringify(replayIds),
  `replay=${JSON.stringify(replayIds)}`);

// 7 ------------------------------------------------ the editor replays too
check('replay includes the code editor text',
  full.getText('monaco').toString() === admin.ydoc.getText('monaco').toString());

// 6 --------------------------------- THE SLIDER: a prefix is a valid past
// Walk every prefix and confirm the shape count never decreases and ends at 3.
// This is precisely what scrubbing the slider does.
let monotonic = true;
let prev = 0;
const counts = [];
for (let n = 0; n <= entries.length; n++) {
  const c = shapeCount(rebuild(entries, n));
  counts.push(c);
  if (c < prev) monotonic = false;
  prev = c;
}
check('scrubbing forward never loses objects (every prefix is a valid past)',
  monotonic, `counts=${counts.join(',')}`);
check('index 0 is the empty board', counts[0] === 0);
check('the final index equals the live board', counts[counts.length - 1] === shapeCount(admin.ydoc));
check('an intermediate index shows FEWER objects than now',
  counts.some((c) => c > 0 && c < shapeCount(admin.ydoc)),
  `counts=${counts.join(',')}`);

// 8 --------------------------------------------------------- attribution
check('updates are attributed to the user who made them',
  entries.every((e) => e.username === 'Serah'),
  `saw ${[...new Set(entries.map((e) => e.username))].join(',')}`);

// 9 ------------------------------------------------------------ isolation
const second = await post('/workspaces', {
  name: 'Other Room',
  password: 'secret123',
  username: 'Vruttika',
  permissionMode: 'password'
});
const otherConn = connect(second.data.token);
await wait(500);
otherConn.ydoc.getText('monaco').insert(0, 'not yours\n');
await wait(500);

const otherLogs = await getLogsViaEvent(otherConn.socket);
check('a second workspace has its own, separate history',
  otherLogs?.workspaceId === second.data.workspace.workspaceId);

const otherDoc = rebuild(otherLogs.entries, otherLogs.entries.length);
check('workspace B history does NOT contain workspace A content',
  shapeCount(otherDoc) === 0 && otherDoc.getText('monaco').toString() === 'not yours\n');

const refetchA = await getLogsViaEvent(admin.socket);
check('workspace A history does NOT contain workspace B content',
  rebuild(refetchA.entries, refetchA.entries.length).getText('monaco').toString()
    === 'print("replay")\n');

// 10 ------------------------------------------------- THE ACCESS BOUNDARY
const permWs = await post('/workspaces', {
  name: 'Locked Room',
  password: 'secret123',
  username: 'Owner',
  permissionMode: 'permission'
});
const permId = permWs.data.workspace.workspaceId;
const ownerConn = connect(permWs.data.token);
await wait(400);
ownerConn.ydoc.getText('monaco').insert(0, 'secret plans\n');
await wait(400);

const waiting = await post(`/workspaces/${permId}/join`, {
  username: 'Stranger',
  password: 'secret123'
});
const lobby = connect(waiting.data.ticket);
await wait(500);
const lobbyLogs = await getLogsViaEvent(lobby.socket, 2500);
check('a waiting user CANNOT read the session history', lobbyLogs === null);

// 11 --------------------------------------- logging did not break sync
const member = await post(`/workspaces/${wsId}/join`, {
  username: 'Devika',
  password: 'secret123'
});
const memberConn = connect(member.data.token);
await wait(800);
check('live collaboration still works with logging enabled',
  memberConn.ydoc.getText('monaco').toString() === 'print("replay")\n' &&
  shapeCount(memberConn.ydoc) === 3,
  `text=${JSON.stringify(memberConn.ydoc.getText('monaco').toString())} shapes=${shapeCount(memberConn.ydoc)}`);

memberConn.ydoc.getText('monaco').insert(0, '# joined later\n');
await wait(700);
check("a late joiner's edits are logged too",
  (await getLogsViaEvent(admin.socket)).count > refetchA.count);

// 12 --------------------- LONG SESSIONS: the regression this fix exists for
// The old transport put one binary attachment per entry into a single packet;
// the parser refuses more than 10 attachments, so any session past ~10
// updates died with a "parse error" disconnect and the UI blamed a timeout.
// Prove a genuinely long, mixed-size history now round-trips completely,
// in order, and reconstructs the exact live document — fast.
const big = await post('/workspaces', {
  name: 'Marathon Room',
  password: 'secret123',
  username: 'Serah',
  permissionMode: 'password'
});
const bigConn = connect(big.data.token);
await wait(400);

const bigShapes = bigConn.ydoc.getArray('shapes');
const mainMap = new Y.Map();
mainMap.set('id', 'drag-target'); mainMap.set('type', 'rect');
mainMap.set('x', 0); mainMap.set('y', 0);
mainMap.set('width', 120); mainMap.set('height', 80);
bigConn.ydoc.transact(() => bigShapes.push([mainMap]));

// ~60 freehand strokes with real point arrays (mixed tools / rapid drawing)…
for (let s = 0; s < 60; s++) {
  const m = new Y.Map();
  m.set('id', `stroke-${s}`); m.set('type', 'path'); m.set('x', 0); m.set('y', 0);
  const pts = new Y.Array();
  const flat = [];
  for (let p = 0; p < 120; p++) flat.push(s * 3 + p, s * 2 + p);
  pts.push(flat);
  m.set('points', pts);
  bigConn.ydoc.transact(() => bigShapes.push([m]));
}
// …plus ~350 tiny live-drag patches, the way a real pointer emits them
for (let i = 0; i < 350; i++) {
  bigConn.ydoc.transact(() => { mainMap.set('x', i); mainMap.set('y', i % 97); }, 'live');
}
bigConn.ydoc.getText('monaco').insert(0, '# a long session\n');
await wait(1500); // let the relay drain and every update get logged

const t0 = Date.now();
const bigLogs = await getLogsViaEvent(bigConn.socket, 10000);
const fetchMs = Date.now() - t0;

check('a long session (400+ updates) streams back without a parse error',
  bigLogs !== null && !bigLogs.failed, `fetch=${fetchMs}ms`);
check('the long history arrives COMPLETE (no dropped entries)',
  (bigLogs?.entries || []).length === bigLogs?.count &&
  (bigLogs?.count || 0) >= 400 &&
  bigLogs.entries.every((e) => toBytes(e.payload)?.length === e.size),
  `count=${bigLogs?.count} entries=${bigLogs?.entries?.length}`);
check('long-session entries stay ordered by seq',
  (bigLogs?.entries || []).every((e, i) => i === 0 || e.seq > bigLogs.entries[i - 1].seq));
check('the long history fetch completes promptly (well under any timeout)',
  fetchMs < 5000, `took ${fetchMs}ms`);

const bigReplay = rebuild(bigLogs.entries, bigLogs.entries.length);
check('replaying the long log reproduces the live document exactly',
  shapeCount(bigReplay) === shapeCount(bigConn.ydoc) &&
  bigReplay.getText('monaco').toString() === bigConn.ydoc.getText('monaco').toString() &&
  bigReplay.getArray('shapes').toArray().find((m) => m.get('id') === 'drag-target')?.get('x') === 349,
  `replay=${shapeCount(bigReplay)} live=${shapeCount(bigConn.ydoc)}`);

// live sync must have survived serving that history
const bigPeer = await post(`/workspaces/${big.data.workspace.workspaceId}/join`, {
  username: 'Devika',
  password: 'secret123'
});
const bigPeerConn = connect(bigPeer.data.token);
await wait(1200);
check('live collaboration is unaffected by streaming a long history',
  shapeCount(bigPeerConn.ydoc) === shapeCount(bigConn.ydoc),
  `peer=${shapeCount(bigPeerConn.ydoc)} live=${shapeCount(bigConn.ydoc)}`);

console.log(`\n  ${passed} passed, ${failed} failed\n`);

admin.socket.disconnect();
otherConn.socket.disconnect();
ownerConn.socket.disconnect();
lobby.socket.disconnect();
memberConn.socket.disconnect();
bigConn.socket.disconnect();
bigPeerConn.socket.disconnect();
process.exit(failed ? 1 : 0);
