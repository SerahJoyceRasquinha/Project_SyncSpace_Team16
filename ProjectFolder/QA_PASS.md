# SyncSpace — quality pass: shapes, properties panel, eraser, replay capacity

Scope of this pass: a code-level audit of the whiteboard stack, with fixes for
every defect found, held in place by the headless suites. Focus areas were the
shapes/properties panel, the eraser's feel, image handling and replay capacity.

**Read the honesty section at the bottom before treating this as a sign-off.**

---

## Verification

| Suite | Before | After |
|---|---|---|
| `frontend/test-rendering.mjs` | 104 pass / **20 fail** | **156 / 0** |
| `frontend/test-brushes.mjs` | 29 / 0 | **43 / 0** |
| `frontend/test-shapes.mjs` | 11 / 0 | 11 / 0 |
| `frontend/test-connectors.mjs` | 28 / 0 | 28 / 0 |
| `frontend/test-replay.mjs` | 38 / 0 | 38 / 0 |
| `backend/test-replay.mjs` | 26 / 0 | **27 / 0** |
| `backend/test-updatelog.mjs` | — | **16 / 0** (new) |
| `backend/stress-replay.mjs` | 8 / 0 | 8 / 0 |
| `backend/test-workspace.mjs` | 15 / 0 | 15 / 0 |
| `vite build` | clean | clean |

```bash
cd frontend && npm i
node test-shapes.mjs && node test-brushes.mjs && node test-connectors.mjs \
  && node test-replay.mjs && npm run test:render && npm run build

cd ../backend && npm i
node test-updatelog.mjs                 # no server needed
npm run dev                             # then, in another shell:
node test-replay.mjs && node stress-replay.mjs && node test-workspace.mjs
```

---

## 1 · Gradient fills never rendered (the headline defect)

`ShapeNode.withEffects()` built the gradient props and then did `delete
props.fill`, expecting the gradient to take over. But **every case in the render
switch re-spread `{...filled}` — i.e. `fill: shape.fill` — after it**, and
Konva's `fillPriority` defaults to `'color'`. The solid colour won every single
time.

The consequence: **Linear and Radial were dead controls on every shape.** The
button highlighted, the record updated, the document synced, and the canvas
never changed. This is the exact "the button reflects the value but nothing
happens" symptom the brief describes, and no existing test could catch it —
`test-rendering` group 2 only asserted "renders without throwing", which a
gradient that silently loses to a solid fill does perfectly.

Two further bugs sat behind it, invisible until the first was fixed:

- **Gradient origin was wrong for centred shapes.** The geometry was computed
  from a top-left origin for every type, but Circle / Ellipse / Star are drawn
  around their *centre*, so their gradients landed half a shape down and right.
- **Switching back to Solid never cleared the stops**, so Konva kept painting
  the old gradient.

`withEffects` is now split into `fillProps` / `shadowProps`, owns the entire
paint, is spread **last**, and sets `fillPriority` explicitly rather than
relying on Konva's fallback ordering. Pinned by the new group **2b** (14 tests).

### A regression this refactor introduced, and how it was caught

Konva's `Image` paints a solid rect whenever it has a fill. Routing images
through the unified paint would have covered every uploaded photo and sticker
with flat indigo (`#6366f1`, the schema default). `ImageNode` now takes shadow
only. Worth flagging because it is the kind of change that looks obviously
correct and is not.

## 2 · The Blur slider was also a dead control

`filters: [Konva.Filters.Blur]` does nothing until `node.cache()` is called — a
filter is a pixel operation over a bitmap that does not otherwise exist. No
pixel ever changed at any blur value. Added `useBlurFilter`, a hook with a
merged ref (the Canvas needs the ref for the Transformer, the filter needs it to
cache) that caches with padding so the blur is not clipped by its own bounding
box, and clears the cache at 0 so an un-blurred shape goes back to rendering
live instead of staying a frozen bitmap.

## 3 · Properties panel

- **`.fmt` was `width: 28px` for every button**, including the ones with words
  on them — "Solid", "Linear", "Radial", "Straighten", "Reverse", "On"/"Off"
  were all crammed into a 28px square and clipped. Now content-sized, with two
  explicit variants (`.fmt.icon` square glyph, `.fmt.grow` shares the row) so
  the intent is visible at the call site. The panel's content box is ~184px, so
  nothing may assume more — the old B/I/U + L/C/R row needed 188px and wrapped
  with a single orphan button.
- **Border select showed a stale value.** "None" writes `strokeWidth: 0`, but
  the style was derived from `dash` alone, so a border-less shape reported
  "Solid" and re-picking "None" looked like a dead click. Now derived from both
  fields.
- **Multi-select Border was hardcoded `value="mixed"`** and could never reflect
  the selection even when every object agreed. Now shows the real shared value,
  with a proper `Mixed` tag when they differ (the docs claimed this existed; it
  did not).
- **Corner radius was offered on circles, stars and every polygon**, where only
  Konva's `Rect` honours it — a slider that changed the record and nothing else.
  Gated behind `supportsCornerRadius()`.
- **Rotation pivoted about the wrong point.** Konva rotates about the node
  origin (top-left for most shapes), so the slider swung a shape away across the
  canvas while the Transformer's rotate handle pivoted about the centre: one
  property, two behaviours. `rotateAboutCentre()` compensates x/y so both agree.
  Negative / >360 angles from a Transformer drag are now folded into range
  instead of being displayed as a clamped lie.
- **Border is no longer offered for freehand strokes**, where the dash pattern
  comes from the brush and a written `dash` was never read.
- Range inputs were inheriting the global `input { padding: 10px 12px; border }`
  rule, wrapping every slider in a tall bordered box.
- Added live numeric readouts on every slider, `:focus-visible` rings (there was
  no keyboard focus indicator anywhere in the app), and a **Reset appearance**
  action.

## 4 · Eraser: why it felt like particles

Erasing removes whole vertices, so **the vertex spacing IS the erase
granularity** — and strokes are RDP-simplified on commit, which is precisely the
operation that deletes redundant vertices. A long drag could commit as two
points tens of pixels apart. Rubbing over it removed the whole span at once, so
the erased edge never tracked the cursor; it snapped between whatever vertices
happened to survive simplification.

Three changes:

1. **Densify before erasing.** Each stroke is resampled to ~2px once per erase
   session, so the erasable unit is far smaller than the eraser and the hole
   follows the ring's real outline.
2. **Swept capsule instead of stamped circles.** The old code stamped the
   circle at intervals along the drag, which was approximate (too few samples
   left scalloped gaps) and cost `O(samples × vertices)` per frame, with the
   sample count growing with pointer speed. The capsule is the exact swept
   region at one distance test per vertex, so a fast flick and a slow careful
   rub give identical results and frame cost stops depending on speed.
3. **Cache the surviving runs** on the session so the render pass draws them
   instead of re-splitting every stroke every frame.

Fragments are re-simplified before commit, so the densified points do not leak
into the document, the network or the undo history. Atomic single-transaction
commit, one-step undo and collaborator sync are all unchanged. 14 new tests,
including "a fast flick erases exactly what a slow drag does".

## 5 · Layer order was destroyed by selecting

`bringToFront()` ran on **every** selection click. Send a shape backward, click
it again to keep working on it, and it jumped straight back to the top — making
the Arrange buttons look broken when they had worked perfectly. Removed;
z-order now only ever changes through the explicit Arrange controls, which are
undoable.

## 6 · Replay capacity

The cap was a flat 5 000 entries. What actually fills it: dragging a shape emits
a throttled position commit every 45 ms — about **22 updates a second**. Under
four minutes of ordinary dragging exhausted a room's entire replay history, on
exactly the long collaborative sessions replay exists for.

Raising the number alone would trade one failure for another, so the pressure is
attacked from both ends:

1. **Coalescing.** Consecutive updates from the same user inside a 400 ms window
   merge into one entry via `Y.mergeUpdates`. A 60-frame drag becomes a handful
   of entries. Different users are never merged (attribution is shown in the
   scrubber), and a deliberate pause keeps actions as separate replay steps.
2. **A two-sided budget** — 50 000 entries *and* 32 MB, whichever lands first —
   so neither a flood of tiny updates nor a few enormous ones runs away.

Merging is safe because `mergeUpdates(a, b)` is equivalent to applying `a` then
`b`, so a **prefix** of the merged log is still exactly the document as it stood
— the one property the whole replay design rests on. `test-updatelog.mjs`
asserts that every prefix of a coalesced log is a valid document, and
`stress-replay` now shows a 5 206-update session recording in full instead of
capping. The cap still engages when genuinely reached, and still trims the tail
rather than the head (a ring buffer remains the one wrong structure here).

## 7 · Smaller defects fixed

| Defect | Effect |
|---|---|
| `toast?.(...)` in `handleImageUpload` referenced an undeclared identifier | `ReferenceError` on any upload over 5 MB, instead of a message |
| Image uploads hardcoded 160×120 | Every image squashed or stretched on arrival; a portrait photo landed as a letterbox. Now sized from natural dimensions |
| `<input type="file">` nested inside `<button>` | Invalid HTML; `input.click()` dispatched a click that bubbled back into the button's own handler |
| `updateShape` wrote `undefined` into Yjs | Yjs stores it as a real value, leaving a dead key that defeats every `?? default`. Now deletes the field |
| Duplicate `case 'image'` in the render switch | Unreachable dead code |
| Arrow toolbar button had no active state | Never highlighted, whichever tool was armed |
| Dead `pendingSticker` state | Unused |

## 8 · Two test-suite corrections

Both were tests encoding stale assumptions, not product bugs — worth calling out
so the numbers are not mistaken for something they are not:

- **The 20 pre-existing `test-rendering` failures were a stale test.** It passed
  the long-removed `selected` prop instead of `selection`, so the panel fell
  back to its empty default and rendered nothing. Updated to the real API, plus
  new multi-select render coverage.
- **Two backend assertions counted log *entries*** — exactly what coalescing
  reduces by design. Rewritten to assert reconstruction fidelity, which is the
  property that actually matters. `stress-replay`'s cap assertion was rewritten
  to match the new policy, and the cap itself is now proved directly in
  `test-updatelog.mjs` rather than by trying to provoke it through a live socket
  session.

---

## What this pass does NOT cover

No browser was available in this environment. Everything above is code-level
analysis plus the headless suites and a real `vite build`. The following parts
of the brief were **not** performed and should not be considered signed off:

- Live interaction testing — clicking through every control, first-click
  responsiveness, hover/active/disabled states in a real browser.
- Visual QA at multiple window widths, zoom levels, small/large screens and
  high-DPI displays. **The CSS changes in particular are reasoned but visually
  unconfirmed** and want one pass of human eyes at a couple of widths.
- Multi-collaborator session testing with real concurrent users.
- Stress testing with hundreds of objects, long sessions or continuous
  pan/zoom in a live browser.
- Monaco editor feature-by-feature verification. It was read through and no
  clear defect was found, but it was not exercised.
- Image behaviour at extreme zoom. Enlarging a bitmap past its natural
  resolution will still pixelate — that is inherent, not a bug, and would need a
  higher-resolution source or a vector asset to avoid.
