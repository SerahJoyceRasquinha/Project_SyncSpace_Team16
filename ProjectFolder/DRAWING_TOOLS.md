# SyncSpace — Pen / Brush, Eraser & Undo overhaul

A full drawing-tool upgrade that rides the **existing** Yjs + Socket.io pipeline
with **zero changes to the sync protocol**. Everything a user draws or erases is
still one flat record in the same `ydoc.getArray('shapes')` array every other
object already lived in, so it inherits selection, deletion, undo/redo, property
edits, locking, layer order, duplication, persistence and real-time sync for
free — the same code paths, not a parallel system.

---

## The one idea everything follows from

A freehand stroke is an ordinary `type: 'path'` record. It now carries a few
extra fields so the *same* record can render as any brush:

```js
{ type:'path', brush, points:[x0,y0,x1,y1,...],
  stroke, strokeWidth, opacity, dash?, smoothing?, pressure?, nibAngle? }
```

Because it is a normal shape record, none of the four features below needed a
new sync channel, a new store, or a new undo system.

---

## 1 · Pen / Brush

A floating **Brush panel** appears whenever the Pen (or Eraser) tool is active,
anchored top-left of the canvas so it never fights the right-hand property panel.

- **7 brush styles**: Pen, Pencil, Marker, **Highlighter** (semi-transparent,
  rendered with a `multiply` blend so overlaps darken like real ink),
  **Calligraphy** (a variable-width nib ribbon — see below), Dashed, Dotted.
- **Colour**: a 15-swatch palette + native colour picker + a **Recent colours**
  strip (last 8, persisted).
- **Thickness** 1–60 px, **Opacity** 5–100 %, both live.
- **Smoothing** (Chaikin corner-cutting over an RDP-simplified path → no jagged
  lines) and **Pressure** (speed-based width, best on Calligraphy) toggles.
- **Live preview**: a sample squiggle drawn with the current settings.
- Settings are **persisted to `localStorage`** and stay active until changed —
  they do *not* reset when you re-pick the tool. Each stroke copies them **once,
  at creation**, so tweaking the panel never alters strokes already on the board.

**Calligraphy** (`brushes.js → calligraphyRibbon`) is a filled polygon, not a
constant-width line: the visible thickness at each point is the projection of a
flat nib (held at `nibAngle`) onto the stroke's normal, so travel perpendicular
to the nib swells and travel parallel tapers — the classic copperplate look.

**Performance while drawing**: the in-progress stroke lives in local state and is
broadcast over **awareness** (so peers watch it draw live); it is written to the
ydoc **once on pointer-up**. That replaces the old "push every sampled point into
the shared array" loop — which re-snapshotted every shape on every mouse-move —
so a whole stroke is one undo step and one network commit. `ShapeNode` is now
`React.memo`-wrapped, so during a draw or erase the hundreds of *existing* nodes
are skipped and only the live preview repaints.

---

## 2 · Eraser (true partial erase)

A real eraser, not an object-deleter. Drag across a stroke and only the part you
touch is rubbed out; the rest of the line survives as independent stroke(s).

- **Adjustable size**, a **circular preview** that follows the cursor, and the
  ring is broadcast so collaborators see where you're erasing.
- The eraser stamp is **sampled along each drag segment** (`markErased`) so a
  fast flick leaves no gaps, with a bounding-box broad-phase so far-away strokes
  are skipped — erasing stays cheap with thousands on canvas.
- **Preview is local**; the structural change commits atomically on release
  (`shapeDoc.js → applyErase`): in **one transaction** the original stroke is
  deleted and one fresh `path` is pushed per surviving run (`surviveRuns`),
  inheriting every visual property. That single transaction is why:
  - the whole erase is **one undo step** (undo restores the original stroke
    intact; redo re-splits it),
  - collaborators receive **one atomic update** — no half-erased state can be
    observed and nothing can interleave to corrupt the split,
  - a stroke erased through the middle becomes two strokes; a fully erased
    stroke simply disappears.

Shapes, text and connectors are intentionally left untouched by the eraser
(select + Delete for those), which the panel says out loud.

> **Design note.** True vector partial-erase was achieved *without* redesigning
> the freehand representation: a stroke was already a point list, so "erase" =
> "split the point list and re-emit the surviving runs as ordinary strokes."
> Committing on release (rather than streaming every intermediate split) is the
> deliberate choice that guarantees one-step undo and a corruption-proof,
> single-message sync.

---

## 3 · Undo / Redo

Already powered by `Y.UndoManager` on the shapes array — this work makes sure it
covers the new operations and stays correct in collaboration:

- **Ctrl+Z** undo · **Ctrl+Shift+Z** and **Ctrl+Y** redo · visible toolbar
  buttons (enabled/disabled from the live stacks).
- Because every action — pen strokes, **partial erasing**, shapes, connectors,
  arrows, text, moves, resize, rotation, colour/thickness/brush changes,
  deletions, layer ordering — is a tracked transaction on the one shapes array,
  all of them undo/redo in chronological order with no per-feature code.
- **Collaborative isolation**: the manager tracks only local (`origin: null`)
  transactions. Remote collaborators' edits arrive as `origin: 'remote'` and are
  never reverted by your undo. The high-frequency mid-drag writes use the
  `'live'` origin and are likewise ignored, so a drag is still one step.
- Memory: strokes are RDP-simplified on commit, so the stored point lists (and
  therefore the history) stay compact over long sessions.

---

## 4 · Real-time sync (unchanged protocol)

Every collaborator immediately sees new strokes, brush colour/thickness/type,
transparency, live drawing, the moving eraser ring, partial-erase results and
undo/redo — all through the existing relay, because they're all ordinary shape
records or awareness fields.

---

## Testing

| Suite | Proves | Result |
|---|---|---|
| `frontend/test-brushes.mjs` (new) | brush dash scaling, RDP simplify, Chaikin, calligraphy nib swell, eraser hit-marking & stroke splitting (middle→2 runs, end→1, whole→0, distant→none); over Yjs: partial erase splits & syncs to a 2nd client, is **one** undo step, fragments inherit style, undo restores the exact original, redo re-splits, **local undo never reverts a remote collaborator's stroke**, full erase deletes then undo restores | **29/29** |
| `frontend/test-shapes.mjs` (existing) | shape CRDT regressions | **11/11** |
| `frontend/test-connectors.mjs` (existing) | connector geometry & sync regressions | **28/28** |
| `vite build` | the whole app compiles clean | ✓ |

```bash
cd frontend
node test-shapes.mjs && node test-brushes.mjs && node test-connectors.mjs
npm run build
```

## Files touched

- **new** `frontend/src/canvas/brushes.js` — brush registry + all pure geometry
  (smoothing, simplify, calligraphy ribbon, eraser hit-test & split).
- **new** `frontend/src/components/BrushPanel.jsx` — the floating panel.
- **new** `frontend/test-brushes.mjs` — the suite above.
- `frontend/src/canvas/shapeDoc.js` — `commitStroke`, `applyErase` (atomic
  partial-erase). Existing functions unchanged.
- `frontend/src/canvas/ShapeNode.jsx` — brush-aware stroke rendering, perf
  flags, `React.memo`, exported `PreviewStroke`.
- `frontend/src/components/Canvas.jsx` — pen draft + eraser integration, panel
  wiring, persisted settings, `E` shortcut, live previews.
- `frontend/src/components/Toolbar.jsx` — Eraser tool button.
- `frontend/src/components/PropertyPanel.jsx` — brush selector for a selected
  stroke.
- `frontend/src/assets/index.css` — Brush panel styling.
