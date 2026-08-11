# SyncSpace — Milestone 3: Connectors & the Executable IDE

Two additions, both fully collaborative, both riding the existing Yjs + Socket.io
pipeline with **zero changes to the sync protocol**: a professional
connector/arrow system on the whiteboard, and a multi-language, executable IDE in
the code pane. (The old Milestone 2.1 "arrow" was a dumb line — it was removed
for a reason. This is the real thing.)

---

## Part 1 — The connector system

### The one idea everything else follows from

A connector is a flat record in the **same `shapes` array** as every rectangle
and star, but its endpoints may *reference other shapes*:

```js
{
  type: 'connector',
  start: { shapeId: 'abc', anchor: 'auto', x: 300, y: 150 },  // attached
  end:   { x: 620, y: 240 },                                   // free
  waypoints: [x1, y1, x2, y2, ...],   // user-inserted bend points
  routing: 'straight' | 'elbow' | 'curved',
  curvature, cornerRadius,
  startHead / endHead: 'none' | 'filled' | 'hollow' | 'open' | 'block' | 'bar',
  stroke, strokeWidth, dash, opacity, locked, zIndex
}
```

Attached endpoint positions are **derived at render time** from wherever the
referenced shape currently is (`connectors.js → connectorRoute()`). Nothing is
ever "re-attached" because nothing is ever detached: move a shape and every
connector touching it recomputes on the next frame — locally, remotely, with
**zero extra network traffic**. The cached `x/y` on an endpoint is only the
fallback used if the shape is later deleted, so deleting a box never breaks its
arrows.

Because a connector is an ordinary shape record in an ordinary `Y.Map`, it gets
selection, deletion, undo/redo, multi-select property edits, locking, layer
ordering, duplication, persistence and real-time sync **for free** — the same
code paths as every other shape, not a parallel system.

### Geometry (frontend/src/canvas/connectors.js)

- **Anchors**: N/E/S/W dots on every shape, rotation-aware (the rotation origin
  mirrors Konva exactly: centre for circle/ellipse/star, top-left otherwise).
- **Smart `auto` attachment**: the endpoint sits where the line from the shape's
  centre crosses its *real outline* — the sampled circle/ellipse perimeter, the
  actual diamond/triangle/star polygon via the shared `shapePoints()` generator —
  not the bounding box. As the far end moves, the attachment point slides around
  the perimeter, exactly like draw.io.
- **Routing**: `straight` polyline through waypoints; `elbow` inserts
  axis-aligned segments (alternating H-first/V-first so chains of bends form the
  classic zig-zag) with **rounded corners** via quadratic arcs; `curved` runs a
  Catmull-Rom → cubic-Bézier spline through the points, tension = the curvature
  slider.
- **Snapping** (`findSnapTarget`): anchor dots win inside 14 px; hovering a
  shape body inside an 8 px pad gives smart `auto` edge attachment; a green ring
  + anchor dots preview the exact attach point while wiring.

### Rendering (frontend/src/canvas/ConnectorNode.jsx)

One custom Konva `Shape`. The `sceneFunc` draws the body (with dash support and
rounded elbows), then the two heads — filled / hollow / open-V / block / bar —
always solid even on dashed lines, with the body trimmed back so it never pokes
through a hollow head. The `hitFunc` strokes the same path ≥ 14 px wide (never
filled: filling an open polyline would make the whole enclosed area clickable),
so a 1 px dotted connector is still easy to grab.

### Editing (Canvas.jsx)

Select a connector and it grows its own chrome instead of the Transformer:

- **round endpoint handles** — drag to re-wire, with live snap + highlight;
- **square waypoint handles** — drag to move, **double-click to delete**;
- **faint midpoint dots** — drag one and it *births a new bend point* in place
  (draw.io-style), also **double-click anywhere on the body** to insert a bend;
- Property panel: routing mode (convert straight ↔ elbow ↔ curved any time),
  both heads, curvature / corner radius, **Straighten** (clears bends),
  **Reverse** (flips direction, heads and all), plus the shared stroke, dash,
  width, opacity, lock, layer order and duplicate controls.

Toolbar: a **Connector** tool (`C`, elbow-routed) and an **Arrow** tool (`A`,
straight + filled head), and a **"Connectors & Arrows"** group in the Shapes
menu with 12 presets (double / dashed / dotted / thick / thin / hollow / open /
block / curved …). Every preset is just field values on the one connector type —
one render path, many looks.

### Live-follow drags (shapeDoc.js → `updateShapeLive`)

Dragging a shape now streams throttled (45 ms) position commits with a special
`'live'` transaction origin. The `UndoManager` tracks only origin-`null`
transactions, so **remote users watch the box glide in real time — with every
attached connector re-routing frame by frame — yet the whole drag undoes as one
step** (the final `dragEnd` commit is the only tracked write). Locally the
dragged shape renders from an ephemeral `livePos` map, so React and Konva never
fight over the node's position.

### The supporting operations connectors deserve

To make "connectors behave like every other object" true, the object system
itself grew the missing verbs, applied to *all* shapes:

- **Copy / paste / duplicate** (`Ctrl+C/V/D`) with connector re-wiring: copies
  attached to shapes *inside* the copied set re-attach to the new copies;
  attachments *outside* the set become free endpoints — a pasted arrow never
  grabs the original (`shapeDoc.js → duplicateShapes`, two-pass id remap).
- **Select all** (`Ctrl+A`), **lock/unlock** (locked = selectable but immovable,
  untransformable, un-draggable — selectable on purpose, otherwise you could
  never unlock), **bring forward / send backward** (zIndex neighbour swap).
- **Zoom & pan**: wheel zooms to the pointer (0.2×–4×), space+drag pans, footer
  has −/%/+ controls; the camera is *local* state per collaborator, all document
  coordinates stay world coordinates, and every pointer read goes through
  `stage.getRelativePointerPosition()`. Handles, cursors and selection chrome
  scale by 1/zoom so they stay a constant screen size.
- **Export PNG** from the footer.

Performance: routes are computed in `useMemo`-backed passes over a `Map` index
(`shapesById`), the elbow/curve tessellation is O(points), and nothing rewrites
connector records when shapes move — hundreds of shapes with live re-routing
stay cheap because *derivation replaces mutation*.

---

## Part 2 — The executable IDE

### Backend: `backend/services/execution/` (+ `routes/executeRoutes.js`)

A self-contained execution service — it imports **nothing** from the
collaboration server and exposes one function, `executeCode()`. The pipeline:

```
temp dir → write source → [compile] → run (stdin piped) → cleanup
```

- **`languages.js`** — the registry. JavaScript (Node), Python 3, Java, C, C++.
  Adding a language = adding one entry (filename, optional compile step, run
  command, toolchain binary). Java's public-class filename rule is handled by
  detecting the class name (`Greeter.java`, default `Main`).
- **`runner.js`** — the only place a process is ever spawned. Every run gets:
  a hard SIGKILL wall-clock timeout; stdout/stderr capped at 64 KB each (streams
  keep draining, storage stops — a print-flood cannot eat the server); a minimal
  environment (no inherited secrets); cwd pinned to a throwaway temp dir; and on
  POSIX, `ulimit` caps for CPU seconds, file size, process count (fork bombs)
  and — for native code — virtual memory. Managed runtimes are capped by their
  own flags instead (`--max-old-space-size=256`, `-Xmx256m`), because V8/JVM
  reserve gigabytes of virtual *address space* up front and an address-space
  ulimit kills them at startup. Found by the test suite, not by a user.
- **`index.js`** — orchestration: temp-dir lifecycle, compile-vs-run phases with
  structured results (`phase: 'compile' | 'run' | 'setup'`), a FIFO queue capping
  concurrent executions (default 2), size limits on code (256 KB) and stdin
  (64 KB), and **graceful toolchain detection**: a missing `javac` comes back as
  a human sentence, not a crash (the shell wrapper turns ENOENT into exit 127 +
  "not found", and both spellings are recognised).
- **Route**: `POST /api/workspaces/:workspaceId/execute` (+ `GET …/languages`),
  guarded by the *same* `requireMember` as every other route — only a live
  member with a valid access token can run code, a removed member's token dies
  instantly — plus a per-user rate limit (10 runs / 30 s). The JSON body limit
  rose to 1 MB so whole source files fit.

For a hardened multi-tenant deployment, wrap `runner.js` in a container; the
interface stays identical — which is exactly why spawning lives in one file.

### Frontend: the new `Editor.jsx`

All shared state lives in the **same ydoc** the canvas uses, so it syncs over
the existing relay and persists in the same snapshot:

| Shared thing              | Where                        | Effect |
|---------------------------|------------------------------|--------|
| the code buffer           | `Y.Text('monaco')` (y-monaco)| everyone types in one file, remote cursors included |
| the active language       | `Y.Map('editorMeta')`        | the dropdown + Monaco syntax mode switch for **everyone** |
| the console               | `Y.Array('runHistory')` (cap 20) | every run result — stdout, stderr, compile errors, exit code, time, *who ran it* — appears for all collaborators, live, and survives reloads |

The stdin box is deliberately local: each person experiments with their own
input; the results that come back are shared and attributed.

UI: language dropdown (populated from the server's actual catalog, static
fallback offline) · **Run** button with busy state (`Ctrl+Enter`) · collapsible
stdin panel · console with per-run status (finished / exit n / timed out /
compile error), duration, coloured stdout/stderr/compiler blocks, truncation
notice, and a shared **Clear** · drag-to-resize console divider · word-wrap,
light/dark theme and fullscreen toggles · Ln/Col cursor display · Monaco's
built-ins (find `Ctrl+F`, replace `Ctrl+H`, go-to-line `Ctrl+G`, folding,
bracket matching, auto-indent) are enabled and advertised in the footer.

---

## Testing (all headless, all green)

| Suite | What it proves | Result |
|---|---|---|
| `frontend/test-connectors.mjs` (new) | the **real shipped modules**, bundled with esbuild: anchors, rotated anchors, edge intersection on circles/diamonds (not bboxes), auto-routing, derived endpoints following moved shapes, cached fallback after deletion, waypoint order, axis-aligned elbows, spline segments, snapping priorities & exclusions, bend insertion, cross-client connector sync, live-origin writes invisible to undo, duplicate re-wiring & detachment, layer reordering | **28/28** |
| `backend/test-execute.mjs` (new) | real processes: stdout/stderr/exit codes/timing, stdin round-trips, compile errors as `compile` phase, C & C++ end-to-end, infinite loop killed at the 5 s wall, 100 MB print-flood truncated at 64 KB, unknown language & empty code as clean errors, missing `javac` failing gracefully, 6-way parallel burst through the queue | **16/16** |
| HTTP end-to-end (in the report above) | `/execute` behind real auth: token runs code, no token → 401, another workspace's token → 403, 120 KB source accepted | **6/6** |
| `frontend/test-shapes.mjs` (existing) | shape CRDT regressions | **11/11** |
| `backend/test-workspace.mjs` (existing) | the whole permission system over live sockets | **15/15** |
| `vite build` | the full app compiles clean | ✓ |

The execution suite caught two genuine sandbox bugs before any user could
(dash's `ulimit -u`, and `ulimit -v` OOM-killing V8/JVM at startup) — which is
the argument for testing the sandbox with real processes rather than mocks.

## Run it

```bash
npm install --prefix backend && npm install --prefix frontend && npm install
npm run dev
# tests
cd frontend && node test-shapes.mjs && node test-connectors.mjs
cd backend  && node test-execute.mjs && node test-workspace.mjs   # server for -workspace: npm run dev first
```

Manual tour: press `C`, drag from the rectangle to the circle — watch the green
snap ring; move the circle — the connector follows; double-click the line to add
a bend; switch it to Curved in the panel; open a second tab and drag a shape —
the other tab sees it glide, arrows re-routing live; then pick Python in the
editor, type a `print`, add stdin, hit Run — both tabs get the output.
