/**
 * Quick sanity test: two headless clients join the same room,
 * each types into the shared Y.Text, and both must converge.
 * Run:  node test-sync.mjs   (with the server already running)
 */
import { io } from 'socket.io-client';
import * as Y from 'yjs';

const URL = process.env.URL || 'http://localhost:5000';
const ROOM = 'test-room-' + Date.now();

function makeClient(label) {
  const ydoc = new Y.Doc();
  const socket = io(URL);
  ydoc.on('update', (u, origin) => {
    if (origin !== 'remote') socket.emit('sync-update', u);
  });
  socket.on('sync-update', (u) => Y.applyUpdate(ydoc, new Uint8Array(u), 'remote'));
  socket.on('connect', () => socket.emit('join-room', { roomId: ROOM, user: label }));
  return { ydoc, socket, label };
}

const a = makeClient('A');
const b = makeClient('B');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(800);
a.ydoc.getText('monaco').insert(0, 'hello ');
b.ydoc.getText('monaco').insert(0, 'world ');
await wait(1200);

const textA = a.ydoc.getText('monaco').toString();
const textB = b.ydoc.getText('monaco').toString();

console.log('A sees:', JSON.stringify(textA));
console.log('B sees:', JSON.stringify(textB));
console.log(textA === textB && textA.length === 12
  ? 'PASS - both clients converged (no lost keystrokes)'
  : 'FAIL - divergence');

a.socket.disconnect();
b.socket.disconnect();
process.exit(0);
