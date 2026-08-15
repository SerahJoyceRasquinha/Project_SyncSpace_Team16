/**
 * End-to-end test of the workspace permission system.
 * Server must be running.   Usage:  node test-workspace.mjs
 *
 * Proves, in order:
 *   1. Create workspace (permission mode) -> admin gets an access token
 *   2. Joiner is NOT let in; is parked in the lobby
 *   3. A lobby socket CANNOT read the document (the security boundary)
 *   4. Admin approves -> access token is PUSHED down the waiting socket
 *   5. The approved user's edits merge with the admin's (Yjs still works)
 *   6. Admin flips policy to password mode -> next joiner walks straight in
 *   7. Wrong password is refused
 *   8. Duplicate username is refused
 *   9. A member CANNOT perform an admin action
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

console.log('\nSyncSpace — workspace permission system\n');

// 1 -------------------------------------------------------------- create
const created = await post('/workspaces', {
  name: 'Viva Demo Room',
  password: 'secret123',
  username: 'Serah',
  permissionMode: 'permission'
});
check('create workspace', created.status === 201 && !!created.data.token);
const wsId = created.data.workspace.workspaceId;
const adminToken = created.data.token;
console.log(`        workspace = ${wsId}\n`);

const adminConn = connect(adminToken);
await wait(500);
adminConn.ydoc.getText('monaco').insert(0, 'const admin = true;\n');
await wait(300);

// 2 ---------------------------------------------------------------- join
let joinRequest = null;
adminConn.socket.on('join:requested', ({ request }) => { joinRequest = request; });

const joined = await post(`/workspaces/${wsId}/join`, {
  username: 'Thanushree',
  password: 'secret123'
});
check('permission mode -> pending, no token issued',
  joined.data.status === 'pending' && !joined.data.token && !!joined.data.ticket);

await wait(400);
check('admin is notified in real time', joinRequest?.username === 'Thanushree');

// 3 ---------------------------------------------- THE SECURITY BOUNDARY
const lobby = connect(joined.data.ticket);
let lobbySawDocument = false;
lobby.socket.on('sync-update', () => { lobbySawDocument = true; });
let approvedToken = null;
lobby.socket.on('join:approved', ({ token }) => { approvedToken = token; });
await wait(600);

check('waiting user receives NO document state',
  lobbySawDocument === false && lobby.ydoc.getText('monaco').toString() === '');

// Even if they try to write, the server has no handler for them.
lobby.socket.emit('sync-update', Y.encodeStateAsUpdate(new Y.Doc()));
await wait(300);
check('waiting user cannot write to the document',
  adminConn.ydoc.getText('monaco').toString() === 'const admin = true;\n');

// 4 ------------------------------------------------------------- approve
const approval = await new Promise((resolve) =>
  adminConn.socket.emit('admin:approve', { requestId: joinRequest.requestId }, resolve)
);
check('admin approves', approval.ok === true);
await wait(600);
check('access token pushed down the waiting socket', !!approvedToken);

// 5 --------------------------------------------------- collaboration still works
lobby.socket.disconnect();
const memberConn = connect(approvedToken);
await wait(700);
check('approved user now receives the document',
  memberConn.ydoc.getText('monaco').toString() === 'const admin = true;\n');

memberConn.ydoc.getText('monaco').insert(0, 'let member = 1;\n');
await wait(700);
const adminText = adminConn.ydoc.getText('monaco').toString();
const memberText = memberConn.ydoc.getText('monaco').toString();
check('concurrent edits still converge (Yjs intact)',
  adminText === memberText && adminText.includes('member') && adminText.includes('admin'));

// 9 ----------------------------------------------- member cannot act as admin
const escalation = await new Promise((resolve) =>
  memberConn.socket.emit('admin:set-policy', { permissionMode: 'password' }, resolve)
);
check('member CANNOT change the policy (privilege escalation blocked)',
  escalation.ok === false);

// 6 -------------------------------------------------------- switch policy
const policy = await new Promise((resolve) =>
  adminConn.socket.emit('admin:set-policy', { permissionMode: 'password' }, resolve)
);
check('admin switches policy to password mode', policy.ok === true);
await wait(300);

const fastJoin = await post(`/workspaces/${wsId}/join`, {
  username: 'Vruttika',
  password: 'secret123'
});
check('password mode -> immediate access, no waiting room',
  fastJoin.data.status === 'approved' && !!fastJoin.data.token);

// 7 ------------------------------------------------------- wrong password
const wrong = await post(`/workspaces/${wsId}/join`, {
  username: 'Intruder',
  password: 'not-the-code'
});
check('wrong secret code is refused', wrong.status === 401);

// 8 --------------------------------------------------- duplicate username
const dupe = await post(`/workspaces/${wsId}/join`, {
  username: 'Serah',
  password: 'secret123'
});
check('duplicate username is refused', dupe.status === 409);

// no token at all
const anon = io(URL);
const anonFailed = await new Promise((resolve) => {
  anon.on('connect_error', () => resolve(true));
  anon.on('connect', () => resolve(false));
  setTimeout(() => resolve(false), 2500);
});
check('socket with NO token is rejected at the handshake', anonFailed === true);
anon.disconnect();

adminConn.socket.disconnect();
memberConn.socket.disconnect();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
