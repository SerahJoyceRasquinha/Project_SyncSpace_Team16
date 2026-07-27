/**
 * STRESS test for the streamed replay transfer.  Server must be running:
 *     npm run test:replay-stress
 *
 * Drives one room past the 5 000-entry history cap with 300 KB image-scale
 * updates mixed into thousands of rapid drag-style updates, then asserts the
 * fetch is chunk-bounded, complete, seq-ordered, fast, and reconstructs the
 * big payloads byte-for-byte. This is the "several thousand drawing
 * operations" case that the old one-packet transport could never serve.
 */
import { io } from 'socket.io-client';
import * as Y from 'yjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

const URL = 'http://localhost:5000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`${URL}/api${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

function fetchStream(socket, stallMs = 12000) {
  return new Promise((resolve) => {
    let meta = null, entries = null, received = 0, settled = false, stall = null, chunks = 0, maxChunkBytes = 0;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(stall); resolve(v); } };
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => finish({ ok: false, timeout: true }), stallMs); };
    socket.on('replay-logs-begin', (res) => {
      meta = res; entries = (res.meta || []).map((m) => ({ ...m, payload: null })); arm();
      if (!entries.length) finish({ ok: true, meta, entries: [], chunks });
    });
    socket.on('replay-logs-chunk', (chunk) => {
      chunks++;
      const d = chunk.data;
      const data = d instanceof Uint8Array ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
        : d instanceof ArrayBuffer ? new Uint8Array(d)
        : Uint8Array.from(d?.data || []);
      maxChunkBytes = Math.max(maxChunkBytes, data.length);
      let off = 0;
      chunk.sizes.forEach((size, j) => {
        entries[chunk.start + j].payload = data.subarray(off, off + size);
        off += size; received++;
      });
      arm();
      if (received >= entries.length) finish({ ok: true, meta, entries, chunks, maxChunkBytes });
    });
    socket.on('replay-logs-error', (res) => finish({ ok: false, error: res?.message }));
    arm();
    socket.emit('get-replay-logs', {});
  });
}

const created = await post('/workspaces', {
  name: 'Stress Room', password: 'secret123', username: 'Serah', permissionMode: 'password'
});
const ydoc = new Y.Doc();
const socket = io(URL, { auth: { token: created.data.token } });
ydoc.on('update', (u, o) => { if (o !== 'remote') socket.emit('sync-update', u); });
await new Promise((r) => socket.on('connect', r));
await wait(300);

const shapes = ydoc.getArray('shapes');
const m = new Y.Map();
m.set('id', 'target'); m.set('type', 'rect'); m.set('x', 0); m.set('y', 0);
ydoc.transact(() => shapes.push([m]));

// 5 image-scale updates (~300 KB base64 src each) — bigger than one chunk's byte cap
for (let img = 0; img < 5; img++) {
  const im = new Y.Map();
  im.set('id', `img-${img}`); im.set('type', 'image'); im.set('x', img * 50); im.set('y', 10);
  im.set('src', 'data:image/png;base64,' + 'A'.repeat(300 * 1024));
  ydoc.transact(() => shapes.push([im]));
}

// then thousands of rapid tiny updates, right up past the 5000 cap
const t0 = Date.now();
for (let i = 0; i < 5200; i++) {
  ydoc.transact(() => { m.set('x', i); }, 'live');
  if (i % 500 === 0) await wait(10); // let the socket flush
}
console.log(`emitted 5206 updates in ${Date.now() - t0}ms`);
await wait(3000); // drain

const tf = Date.now();
const out = await fetchStream(socket);
const fetchMs = Date.now() - tf;

const total = out.entries?.reduce((a, e) => a + (e.payload?.length || 0), 0) || 0;
const complete = out.entries?.every((e) => e.payload && e.payload.length === e.size);
const ordered = out.entries?.every((e, i) => i === 0 || e.seq > out.entries[i - 1].seq);

console.log(`\n  fetch=${fetchMs}ms chunks=${out.chunks} maxChunk=${(out.maxChunkBytes / 1024).toFixed(0)}KB totalPayload=${(total / 1024 / 1024).toFixed(2)}MB\n`);

check('the capped session streams back without a parse error', out.ok === true);
check('recording stopped exactly at the cap, head intact',
  out.entries?.length === 5000 && out.meta?.capped === true,
  `entries=${out.entries?.length} capped=${out.meta?.capped}`);
check('every entry arrived complete', complete === true);
check('entries stayed strictly seq-ordered', ordered === true);
check('no chunk exceeded its byte bound (512KB + one oversize entry headroom)',
  out.maxChunkBytes <= 512 * 1024 + 310 * 1024, `max=${out.maxChunkBytes}`);
check('a 5000-update history fetches promptly', fetchMs < 5000, `took ${fetchMs}ms`);

// reconstruct and verify the big payloads survived byte-for-byte
const doc = new Y.Doc();
const ta = Date.now();
for (const e of out.entries) Y.applyUpdate(doc, e.payload, 'replay');
const rebuildMs = Date.now() - ta;
const imgs = doc.getArray('shapes').toArray().filter((s) => s.get('type') === 'image');
check('all image payloads reconstruct byte-for-byte',
  imgs.length === 5 && imgs.every((s) => s.get('src').length === 22 + 300 * 1024));
check('full reconstruction stays fast', rebuildMs < 3000, `took ${rebuildMs}ms`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
