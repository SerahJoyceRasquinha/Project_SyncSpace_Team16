# SyncSpace — Milestone 1 (secure workspaces)

Real-time collaborative whiteboard + code editor, now behind a proper workspace
access system: administrators, hashed secret codes, a waiting room, and a policy
the admin can flip at any time.

**Everything from Milestone 0 still works exactly as before** — Yjs CRDT sync, the
Konva whiteboard, the Monaco editor, awareness cursors, MongoDB snapshots. The
collaboration core was extended, not rewritten.

---

## What changed

The app no longer drops you into a room. It opens on **Create Workspace / Join Workspace**.

**Create** → you become the administrator. You set a workspace name, a secret code
(bcrypt-hashed), your username, and an access policy. You are taken straight in.

**Join** → workspace ID + secret code + username. What happens next depends on the
policy the admin chose:

| Policy | Behaviour |
|---|---|
| **Permission based** | Correct code is *not* enough. You land in a waiting room. The admin sees your request live and clicks Approve or Reject. |
| **Join using password** | Correct code, straight in. No waiting, no approval. |

The admin can switch policy at any moment from inside the workspace. Existing
collaborators stay connected; only *future* joiners follow the new rule.

---

## The security boundary (the part that actually matters)

Hiding the UI is not security. The real gate is the socket handshake.

Every socket carries a signed token, and `io.use()` decides what kind it is:

- **Access token** → the socket joins `ws:<id>`, gets `sync-update` and `awareness-update` handlers. It can collaborate.
- **Lobby ticket** → the socket joins `lobby:<id>:<requestId>` and **no sync handlers are registered for it at all**. A user in the waiting room cannot read the document, cannot see cursors, cannot discover who else is in the room, and cannot write — not because the UI hides it, but because the server never wired those events up for that socket.

When the admin approves, the server **pushes an access token down the waiting
socket**. No polling, no refresh.

Admin authority is read from `socket.data`, which was set at handshake time from a
*signed* token — never from the event payload. A member who forges `admin:approve`
gets an error, not an approval. There is a test for exactly this.

---

## Run it

```bash
npm install --prefix backend
npm install --prefix frontend
npm install          # root, for `npm run dev`

npm run dev
```

Open <http://localhost:5173>.

`backend/.env`:

```env
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
JWT_SECRET=change-me-to-a-long-random-string
MONGO_URI=            # blank = memory-only. Works fine, forgets on restart.
```

**MongoDB is still optional.** With `MONGO_URI` blank, workspaces live in memory —
every feature below works, they just reset when you restart the server. Point it at
an Atlas cluster and the exact same code persists workspaces, members, requests and
CRDT snapshots. No code changes.

---

## Demo script (three browser windows)

1. **Window 1** → Create Workspace → name it, code `secret123`, username `Serah`, policy **Permission based**. Note the ID (e.g. `WS-7K2M9Q`). Draw something.
2. **Window 2 (incognito)** → Join → paste the ID, code `secret123`, username `Thanushree`.
   → She lands in the **waiting room**. She sees nothing of the board.
3. **Window 1** → the Admin badge is pulsing. Open it → her request is there with a timestamp.
   → Click **Approve**. Window 2 moves into the workspace *by itself*.
4. **Window 1** → Admin panel → switch policy to **Join using password**.
5. **Window 3** → Join with the same code → straight in, no waiting.
6. **Window 1** → Admin panel → **Remove** someone. Their session dies instantly.

Prove it headlessly:

```bash
cd backend
node test-workspace.mjs   # 15 assertions incl. the security boundaries
node test-sync.mjs        # Milestone 0 CRDT convergence, still passing
```

---

## Files

**New backend**

```
models/Workspace.js               workspace, members, pendingRequests
services/workspaceStore.js        repository — MongoDB OR in-memory, same API
services/workspaceService.js      ALL business rules, one implementation
services/realtime.js              io hub: toWorkspace / toAdmin / toLobby
controllers/workspaceController.js
routes/workspaceRoutes.js
middleware/authMiddleware.js      requireMember, requireAdmin
utils/token.js                    access tokens vs lobby tickets
utils/ids.js                      WS-7K2M9Q generator
utils/validate.js                 sanitise, validate, rate-limit
test-workspace.mjs
```

**Changed backend** — `services/socketService.js` (handshake auth + lobby + admin
channel; the Yjs relay itself is byte-for-byte the original), `server.js`, `.env`.

**New frontend** — `pages/Landing.jsx`, `pages/CreateWorkspace.jsx`,
`pages/JoinWorkspace.jsx`, `pages/WaitingRoom.jsx`, `components/AdminPanel.jsx`,
`components/Toast.jsx`, `hooks/useToasts.js`, `utils/api.js`, `utils/session.js`.

**Changed frontend** — `pages/Workspace.jsx` (admin panel + guarded entry),
`hooks/useCollaboration.js` (token auth + management channel; sync core unchanged),
`utils/socket.js`, `App.jsx`, `assets/index.css`.

**Removed** — `pages/Dashboard.jsx`. Its only job was "type a room ID to enter",
which is exactly the insecure behaviour this milestone replaces. Its function now
lives in `Landing` + `JoinWorkspace`.

**Untouched** — `components/Canvas.jsx`, `components/Editor.jsx`, `monaco-setup.js`,
`models/DocState.js`, `config/db.js`.

---

## REST API

| Method | Route | Who |
|---|---|---|
| POST | `/api/workspaces` | anyone |
| GET | `/api/workspaces/:id` | anyone (name + status only) |
| POST | `/api/workspaces/:id/join` | anyone |
| GET | `/api/workspaces/:id/me` | member |
| GET | `/api/workspaces/:id/requests` | admin |
| POST | `/api/workspaces/:id/requests/:reqId/approve` | admin |
| POST | `/api/workspaces/:id/requests/:reqId/reject` | admin |
| PATCH | `/api/workspaces/:id/policy` | admin |
| DELETE | `/api/workspaces/:id/members/:userId` | admin |
| POST | `/api/workspaces/:id/close` | admin |

## Socket events

**Client → server:** `sync-update`, `awareness-update`, `admin:approve`,
`admin:reject`, `admin:set-policy`, `admin:remove-user`, `admin:pending`

**Server → client:** `sync-update`, `awareness-update`, `room-info`,
`join:waiting`, `join:requested`, `join:approved`, `join:rejected`, `join:pending`,
`join:resolved`, `workspace:updated`, `workspace:policy-changed`,
`workspace:removed`, `workspace:closed`

---

## Edge cases handled

- **User refreshes the waiting page** → the ticket is in `sessionStorage`; on reconnect the server replays the current status (still waiting / already approved / rejected).
- **Admin was offline when the request arrived** → requests are durable; the admin receives `join:pending` on connect.
- **Admin changes policy while people are waiting** → they stay in the lobby and can still be approved by hand. Only *new* joiners follow the new rule.
- **Username taken while someone waited** → approval fails with a clear message rather than creating a duplicate.
- **Removed user** → membership is re-checked on *every* socket connect, so their token is dead immediately. No revocation list needed.
- **Two users, same username** → refused within a workspace, allowed across different workspaces.
- **Brute-forcing the secret code** → 10 attempts per IP per workspace per minute.
- **Workspace-ID probing** → "no such workspace" and "wrong code" return the *same* message, so the endpoint is not an ID oracle.
- **Server restart** → with Mongo, everything survives. Without it, workspaces reset (and the server says so at boot).

## Still to do (Week 4 of the Axlero plan)

`updatelogs` collection + the Replay slider. The auth and access-control half of
Week 4 is now done.