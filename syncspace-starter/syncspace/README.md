# SyncSpace — Milestone 0 (working demo)

A real, working slice of the SyncSpace blueprint: two people join the same room and see
each other's whiteboard strokes, code edits, and cursors in real time — merged with Yjs
CRDTs, relayed over Socket.io.

**In scope for this milestone:** shared Konva whiteboard, shared Monaco editor,
live presence + cursors, optional MongoDB snapshot persistence.
**Not yet:** JWT auth, room permissions, session replay. (Milestones 1–3.)

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js (LTS) | 18 or 20+ | `node -v` |
| npm | 9+ | `npm -v` |
| Git | any | `git --version` |
| MongoDB Community | 6+ | **optional** for this milestone |

MongoDB is optional: leave `MONGO_URI` empty in `backend/.env` and the server runs
fully in memory. Everything still syncs; it just forgets a room when you restart it.

---

## 2. Install

```bash
cd syncspace

npm install --prefix backend
npm install --prefix frontend

# optional: root runner that starts both at once
npm install
```

---

## 3. Configure

`backend/.env`:

```
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
MONGO_URI=mongodb://127.0.0.1:27017/syncspace   # or leave blank for memory-only
```

---

## 4. Run

Two terminals:

```bash
# Terminal 1
cd backend && npm run dev      # http://localhost:5000

# Terminal 2
cd frontend && npm run dev     # http://localhost:5173
```

Or one:

```bash
npm run dev                    # from the project root
```

---

## 5. Test it

1. Open <http://localhost:5173>, enter name `Serah`, room `demo`, join.
2. Open a **second window** (or an incognito window), name `Thanushree`, room `demo`.
3. Draw on the left canvas → it appears in the other window instantly.
4. Type in the right editor → same.
5. Watch the other person's coloured cursor move across the canvas and the editor.
6. Reload one window — state is restored from the server's Y.Doc.

Headless proof that concurrent edits **merge instead of overwrite**:

```bash
cd backend
node test-sync.mjs     # server must be running
# -> PASS - both clients converged (no lost keystrokes)
```

---

## 6. File map

```
backend/
  server.js                 Express + Socket.io entry point
  config/db.js              Mongo connection (degrades to memory-only)
  models/DocState.js        Binary Yjs snapshot per room  (blueprint 8.3)
  services/socketService.js Room hub: join-room / sync-update / awareness-update
  test-sync.mjs             Two-client convergence test
frontend/
  src/monaco-setup.js       Forces ONE Monaco instance + Vite workers
  src/utils/socket.js       Socket.io client
  src/hooks/useCollaboration.js   Yjs <-> Socket.io provider (the core)
  src/components/Canvas.jsx Konva whiteboard bound to a Y.Array
  src/components/Editor.jsx Monaco bound to a Y.Text via y-monaco
  src/pages/Dashboard.jsx   Name + room entry
  src/pages/Workspace.jsx   Split-pane workspace
```

---

## 7. Gotchas already handled

- **No `React.StrictMode`.** It double-mounts effects in dev, which would open two
  sockets per client and make the logs lie to you.
- **One Monaco instance.** `@monaco-editor/react` loads Monaco from a CDN by default,
  but `y-monaco` imports the local npm package. `loader.config({ monaco })` in
  `monaco-setup.js` forces them to agree, otherwise remote cursors break.
- **React 18 pinned.** `react-konva@18` does not work with React 19.
- **Echo loop.** Remote updates are applied with the origin tag `'remote'`, and the
  `ydoc.on('update')` handler ignores that origin — otherwise A→B→A→B forever.

## 8. Next milestones

1. JWT auth (`authController`, `authMiddleware`) + socket handshake token check.
2. Room ownership & `allowedUsers` (blueprint 8.2, Part 12).
3. `updatelogs` collection + `get-replay-logs` / `replay-logs` → `ReplaySlider.jsx`.
