# SyncSpace — Session Replay (Blueprint 8.4 + Part 13)

The last outstanding item on the Axlero week plan. Weeks 1–4 were already
shipping; the four rows still marked **NOT STARTED** were not four features but
one feature in dependency order:

| Week | Row | Now |
|---|---|---|
| 3 | `updatelogs` collection (Blueprint 8.4) | `backend/models/UpdateLog.js` |
| 4 | Log every update to `updatelogs` | `backend/services/socketService.js` |
| 4 | Socket events `get-replay-logs` / `replay-logs` | `backend/services/socketService.js` |
| 4 | REPLAY: scrub backward through history | `frontend/src/components/ReplaySlider.jsx` |

Like every milestone before it, this is **additive**: no change to the sync
protocol, no change to the shape schema, no change to the renderer. Replay reads
the same bytes the relay was already moving and draws them with the same
components the live canvas already uses.

---

## The one idea everything follows from

**A Yjs update is a self-contained, causally ordered delta.** So if you keep every
update in order, applying the first *N* of them to an empty document reconstructs
exactly the document that existed after update *N* — not an approximation, not a
re-simulation, the actual state.

That single property is why replay needs no diffing engine, no snapshot ladder,
and no inverse operations. The whole reconstruction is four lines:

```js
const doc = new Y.Doc();
for (let i = 0; i < n; i++) Y.applyUpdate(doc, entries[i].payload, 'replay');
```

Everything below is plumbing around that.

---

## 1 · Why `updatelogs` has to exist separately from `docstates`

The project already persists to Mongo, so a fair question in review is why 8.3
was not enough.

- **`docstates` (8.3)** answers *"what does the board look like now?"* One row per
  room, overwritten every two seconds. **It is a photograph.**
- **`updatelogs` (8.4)** answers *"how did it get here?"* One row per update,
  appended and never modified. **It is the film reel.**

You cannot scrub a photograph. Replay needs the reel.

```js
// backend/models/UpdateLog.js
{ roomId, seq, payload: Buffer, userId, username, timestamp }
```

Two deliberate choices:

**`payload` is the raw binary update, not a decoded description of it.** These are
the exact bytes that were relayed to the other collaborators. Storing the opaque
update rather than a human-readable summary is what keeps replay honest — there
is no interpretation layer that could drift from the real one.

**`seq` exists even though there is a `timestamp`.** Two updates can land inside
the same millisecond, and Mongo makes no promise about returning documents in
insertion order without an explicit sort key. `seq` is the replay slider's x-axis;
the timestamp is only ever shown to a human.

---

## 2 · Recording: after the relay, never before

```js
socket.on('sync-update', async (update) => {
  const bytes = new Uint8Array(update);
  const room = await getRoom(workspaceId);
  Y.applyUpdate(room.doc, bytes, socket.id);
  socket.to(rt.roomOf(workspaceId)).emit('sync-update', bytes);  // relay FIRST

  logs.appendUpdate(workspaceId, bytes, { userId, username });   // then record
});
```

The ordering is the design. Collaborators must never wait on a database write to
see each other's edits, and `appendUpdate()` swallows its own errors, so a broken
or slow log can degrade replay but **cannot stall or break live collaboration.**
Logging is a bonus feature and it fails like one.

`test-replay.mjs` asserts this directly: *"live collaboration still works with
logging enabled."*

---

## 3 · Replay works without MongoDB — on purpose

Local MongoDB 8.x will not install on this project's Windows 10 development
machine. If replay only worked against a live database it could not be
demonstrated at all.

So `updateLogService.js` follows the **exact same dual-mode contract as
`workspaceStore.js`**: identical calls, Mongo or memory, chosen by one flag at
boot.

```js
setLogPersistence(connected);   // server.js — the same flag the other stores use
```

The whole feature — socket events, slider, reconstruction, tests — is demoable
today with no database, and a single `.env` line promotes it to durable history
on Atlas with no code change.

---

## 4 · The cap trims the tail, never the head

This is the most interesting constraint in the feature, and the one worth
volunteering in a viva.

Yjs updates form a causal chain: an update that edits a shape refers to the
update that created it. Therefore:

- A **prefix** of the log (0…k) is always a complete, internally consistent
  document. That is exactly what the slider scrubs through.
- A **suffix** is not. Drop the early updates and the later ones reference items
  Yjs has never seen, so it parks them as pending and the board renders blank.

**A ring buffer would be the one wrong data structure here.** When a room hits
`MAX_LOGS_PER_ROOM` we stop recording and set a `capped` flag, which the UI shows
honestly as a *"history full"* chip — rather than silently corrupting the history
we already have.

---

## 5 · Replay inherits the access boundary for free

The `get-replay-logs` handler is registered **inside the member branch** of the
connection handler — after the point where a lobby socket has already returned.

```js
if (kind === 'lobby') { ...; return; }   // ← nothing below is ever registered
// ...
socket.on('get-replay-logs', ...)         // members only, structurally
```

So someone sitting in the waiting room cannot read the history any more than they
can read the document, and this required no new check. The workspace is read from
`socket.data` — set at handshake from the **signed token** — never from the
request, so the event cannot be used to read another workspace's past either.

Both are tested: *"a waiting user CANNOT read the session history"* and
*"workspace B history does NOT contain workspace A content."*

---

## 6 · Seeding from a snapshot, so history never lies

A room can legitimately have a `docstates` snapshot but an empty log — the board
was drawn before this feature existed. Replaying it would start from a blank
canvas and then jump, which would be a **false claim about its history**.

So when a non-empty document is restored into a room with no log, the restored
state is recorded as `seq 0`. Replay then honestly begins at *"everything that
existed when recording started."* An empty `Y.Doc` encodes to exactly 2 bytes, so
this seeds nothing for a genuinely fresh room.

---

## 7 · The slider: read-only by construction

`ReplaySlider.jsx` does **not** rewind the live document. It builds a second one.

That matters more than it sounds. The scrub document is a local object that no
socket writes to and that never emits, so **there is no code path by which
scrubbing could touch the live board.** Nothing had to be locked, frozen or
guarded to make that true — it is a property of the structure, not of care taken.

It also reuses the **same renderer**:

```
normalizeShapes → ShapeNode / ConnectorNode
```

History is therefore drawn by the code under test rather than by a second
implementation that could drift. A connector still re-routes against the shapes
as they were at that moment, because routing is derived at render time from
whatever document it is handed.

The panel shows the whiteboard *and* the code editor at that point in history,
because both live in the same document — replaying one replays the other.

**This is also why stickers and uploaded images needed no work.** Replay applies
opaque Yjs updates and never inspects the shape schema, and it draws through the
same `normalizeShapes → ShapeNode` path the live board uses — which already
routes `type: 'image'` to `ImageNode`. A shape type added tomorrow replays for
free on the same terms. Two checks in `frontend/test-replay.mjs` pin that down so
it stays true.

### The forward-only cache

The one piece of real engineering. Rebuilding from update 0 on every slider tick
is O(N) per frame and makes playback of a long session stutter.

Updates only move forward, so:

- scrubbing **forward** applies just the delta → O(1) amortised per frame
- scrubbing **backward** discards and starts over → pays the rebuild once

Playback, the case that has to be smooth, is the fast one.

This is also the one thing that could silently corrupt replay, so it is proven
rather than asserted: `frontend/test-replay.mjs` walks forward, backward, and in
random jumps, checking at **every index** that the cached document is identical
to a from-scratch rebuild.

### Why the reconstruction lives in `canvas/replay.js`

Same discipline as `connectors.js` and `brushes.js`: the part that can actually
be *wrong* imports nothing but Yjs, so it is provable headlessly. The React
component only decides which frame to show and draws it.

---

## 8 · Tests

**`backend/test-replay.mjs` — 20 checks, the wire.** Run with the server up:

```bash
cd backend && npm run test:replay
```

Every update logged · both the `replay-logs` event *and* the ack callback answer ·
ordering, timestamps and attribution · full replay reproduces the live document
exactly · a prefix is a true intermediate state · the editor replays too ·
workspace isolation both ways · a lobby socket is refused · live sync unaffected ·
a late joiner's edits are logged.

**`frontend/test-replay.mjs` — 30 checks, the maths.** No server needed:

```bash
cd frontend && npm run test:replay
```

Full and partial reconstruction · a prefix shows a shape at its position *before*
a later move, and an object that was *later deleted* · the cache invariant
forward, backward and random · index clamping · `toBytes` across all four wire
formats socket.io delivers · a malformed entry is skipped instead of killing the
replay · a corrupt payload never throws · empty logs · `frameBounds` ·
**stickers and uploaded images replay with their `src` intact.**

### Suite totals

| Suite | Checks |
|---|---|
| `backend/test-workspace.mjs` | 15 |
| `backend/test-execute.mjs` | 16 |
| `backend/test-replay.mjs` | **20 (new)** |
| `frontend/test-shapes.mjs` | 11 |
| `frontend/test-connectors.mjs` | 28 |
| `frontend/test-brushes.mjs` | 29 |
| `frontend/test-replay.mjs` | **30 (new)** |
| `frontend/test-rendering.mjs` | 124 |
| **Total** | **273** |

All green, plus a clean Vite production build.

> `backend/test-sync.mjs` is a Milestone-0 leftover that connects with **no token**
> and emits `join-room`. The Week-4 auth turnstile correctly refuses it. It is
> superseded by `test-workspace.mjs` and is not counted above.

---

## Demo script (60 seconds)

1. Open a workspace in two tabs as two different users.
2. Draw a few shapes, connect two of them with an arrow, type in the code pane.
3. Hit **Replay** in the top bar.
4. Drag the slider to **0** — blank board. Press **play**.
5. Watch the board rebuild itself, shape by shape, with each update attributed to
   whoever made it, while the code pane fills in alongside.
6. Point at the other tab: **it never moved.** Replay is a second document.

---

## One pre-existing fix that had to happen first

`src/canvas/shapes.jsx` declared **`isImageType` twice** (once beside the other
type predicates, once further down with a doc comment). That is a hard error, not
a warning: esbuild refuses it, so `npm run build` and three of the five frontend
suites — `test-connectors`, `test-brushes`, `test-rendering` — all failed before
any of this work started.

The duplicate was removed and the explanatory comment kept on the surviving
declaration, which now sits with `isTextType` / `isDraggableLine` / `isConnector`.
Nothing else about the sticker or image feature was touched. With that one line
gone the pre-existing baseline is green again (223 checks), which is what made it
possible to prove the replay work broke nothing.

---

## Known limits, stated honestly

- **History is capped per room** (`MAX_LOGS_PER_ROOM`). Past the ceiling, recording
  stops and the UI says so. Trimming the head instead would corrupt replay, per §4.
- **`seq` is process-local.** One server process owns a room's `Y.Doc` (the existing
  `rooms` map already assumes this), so the counter is consistent with the rest of
  the design. Horizontal scaling would need the counter moved into Mongo — the same
  refactor the authoritative doc would need, and for the same reason.
- **Replay is snapshot-in-time.** It fetches the log once when opened; edits made
  while the panel is open are not streamed into it. Re-open to refresh. This is
  deliberate — a scrubber whose timeline grows under your cursor is worse UX than
  one that holds still.
