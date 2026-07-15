# SyncSpace — Milestone 2.1 (drawing fixes)

Three targeted fixes on top of the Milestone 2 drawing system. No architecture
changes; every existing tool, the workspace/auth system, and CRDT sync are intact.
Frontend builds clean; 11 shape assertions + 15 workspace assertions pass.

## Issue 1 — Text tool no longer reverts to Select

**Root cause:** `startTextEditor()` ended with `setTool('select')`. Selecting Text
then clicking opened the editor *and* flipped the toolbar back to Select in the
same handler — it was a deliberate line, not an event side-effect.

**Fix + redesign (Canvas.jsx):**
- The Text tool now begins a **click-drag** on mousedown that defines a text
  region (a `kind: 'text'` drag), and opens the editor on mouseup *inside* that
  region. The tool stays `text` throughout, so you can place several boxes in a
  row. It only returns to Select after a box is actually committed.
- The editor is a real `<textarea>` sized to the region: it **wraps** at the
  region width and **grows downward** as content overflows (`scrollHeight`).
- Enter inserts a newline (multiline); Ctrl/Cmd+Enter or Escape or click-outside
  commits. Empty text is dropped/deleted. Double-click re-edits with formatting
  preserved. `onMouseDown` on the textarea is stopped so editing never starts a
  canvas drag. The Konva `Text` node already wraps at `width`, so saved text
  reflows when the box is resized.

## Issue 2 — Circle / Star jump on placement and drag

**Root cause:** circle/ellipse/star position their Konva node at the **centre**
(`x + w/2, y + h/2`), so `node.x()` returns the centre — but the app stores `x` as
the **top-left**. `onDragEnd` wrote the centre straight into the top-left field,
and the next render added `w/2` again, so **every drag shifted the shape by half
its size**. Rect/diamond/triangle were fine because their node x equals their
record x.

**Fix (ShapeNode.jsx, shapes.jsx, Canvas.jsx):** one shared predicate,
`isCentered(type)`. Wherever a position is read back off a centred node
(`onDragEnd`, `onTransformEnd`), subtract half-size to recover the stored
top-left. Centred shapes still rotate in place (Konva draws them around their own
centre, no offset needed). Verified with a headless create→drag→re-render test:
circle now moves by the exact drag delta, identical to rectangle.

## Issue 3 — Connector Arrow tool removed completely

Removed from: the toolbar button, the keyboard shortcut (`a`), `SHAPE_GROUPS`
(Flowchart "Connector" and the two Lines arrow variants), `isDraggableLine`, the
`shapeIcon` arrow case, the `ShapeNode` arrow render case, the unused `Arrow`
import from react-konva, and every `arrowVariant` reference in the creation code.
`grep -rn "arrow"` over `components/` and `canvas/` returns nothing. Build has no
unused-import or undefined-symbol warnings.

## Verify

```bash
npm install --prefix backend && npm install --prefix frontend && npm install
npm run dev

cd frontend && node test-shapes.mjs      # 11/11
cd backend  && node test-workspace.mjs   # 15/15
```

Manual: Text tool → drag a box → type a paragraph → watch it wrap and the box grow
→ Ctrl+Enter. Draw a circle and a star → drag them → they stay under the cursor and
don't jump. The Shapes menu and toolbar no longer show any arrow.
