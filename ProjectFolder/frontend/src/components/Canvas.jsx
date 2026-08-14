import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Stage, Layer, Line, Circle, Text, Rect, Transformer, Group } from 'react-konva';
import * as Y from 'yjs';
import Toolbar from './Toolbar.jsx';
import PropertyPanel from './PropertyPanel.jsx';
import BrushPanel from './BrushPanel.jsx';
import ShapeNode, { PreviewStroke } from '../canvas/ShapeNode.jsx';
import ConnectorNode from '../canvas/ConnectorNode.jsx';
import { ShapeErrorBoundary } from './ErrorBoundary.jsx';
import { normalizeShapes } from '../canvas/normalize.js';
import {
  shapesArray, readShape, addShape, updateShape, updateShapeLive, updateMany,
  removeShapes, clearAll, duplicateShapes, reorderShape,
  commitStroke, applyErase, alignShapesHorizontally, alignShapesVertically,
  distributeShapesHorizontally, distributeShapesVertically
} from '../canvas/shapeDoc.js';
import {
  isDraggableLine, isTextType, isCentered, isConnector, CONNECTOR_DEFAULTS
} from '../canvas/shapes.jsx';
import {
  DEFAULT_PEN_SETTINGS, DEFAULT_ERASER_SETTINGS,
  markErasedSweep, resample, surviveRuns, pointsBounds, simplify
} from '../canvas/brushes.js';
import {
  connectorRoute, displayPoints, findSnapTarget, anchorPoints, insertWaypoint
} from '../canvas/connectors.js';

// --- persisted pen / eraser preferences (per browser) --------------------
const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch { return fallback; }
};
const saveJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
};

const MIN_SIZE = 4;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const LIVE_COMMIT_MS = 45; // throttle for mid-drag sync so peers follow live

/**
 * The collaborative whiteboard.
 *
 * State model (unchanged storage location — still ydoc.getArray('shapes')):
 *   - Freehand strokes from Milestone 0 are read as-is and rendered as 'path'.
 *   - New objects are flat records with a `type`, all in the SAME array.
 *   - Connectors are just another record type. Their endpoints may reference
 *     other shapes by id; positions are DERIVED at render time, so moving a
 *     shape automatically redraws every connector attached to it — locally,
 *     remotely, with zero extra messages.
 *
 * Live sync: yshapes.observeDeep() re-snapshots on ANY change, local or remote,
 * so every client re-renders from one source of truth. Selection and remote
 * cursors travel through awareness, exactly as before.
 *
 * The viewport (zoom + pan) is LOCAL state — every collaborator keeps their own
 * camera. All document coordinates are world coordinates; the stage transform is
 * purely presentational, which is why every pointer read below goes through
 * worldPointer() (stage.getRelativePointerPosition()).
 */
export default function Canvas({ ydoc, awareness }) {
  const [shapes, setShapes] = useState([]);
  const [cursors, setCursors] = useState([]);
  const [remoteSelections, setRemoteSelections] = useState([]);
  const [tool, setTool] = useState('select');
  const [pendingShape, setPendingShape] = useState(null); // { type } chosen from Shapes menu
  const [connPreset, setConnPreset] = useState(null);     // preset for the connector tool
  const [selectedIds, setSelectedIds] = useState([]);
  // Whether the active freehand tool (pen/eraser) has already begun a stroke
  // since it was last (re)selected. This is the ONLY extra bit of UI state the
  // panel system needs: the brush/eraser panel is shown iff a freehand tool is
  // active AND drawing has not yet started, so the moment the user puts pen to
  // canvas the panel gets out of the way and only comes back when the tool is
  // explicitly (re)selected. It is a LOCAL interface flag — never synced.
  const [drawingStarted, setDrawingStarted] = useState(false);
  const [preview, setPreview] = useState(null); // live drag-to-create ghost
  const [editingText, setEditingText] = useState(null); // { id?, x, y, value, ... }
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 }); // local camera
  const [spaceDown, setSpaceDown] = useState(false);
  const [snapHint, setSnapHint] = useState(null); // { shapeId, anchor, x, y } while wiring
  const [livePos, setLivePos] = useState(() => new Map()); // id -> {x,y} mid-drag
  const [connOverride, setConnOverride] = useState(null); // { id, patch } mid handle-drag
  // A transient message shown over the stage (bad upload, file too large...).
  // Canvas has no access to the app-level toast hook, and the code that needed
  // one previously just called an undefined `toast()` and threw.
  const [notice, setNotice] = useState(null); // { kind: 'error'|'info', text }

  // ---- pen / eraser state (persisted preferences, live previews) --------
  const [penSettings, setPenSettings] = useState(() => loadJSON('ss.pen', DEFAULT_PEN_SETTINGS));
  const [eraserSettings, setEraserSettings] = useState(() => loadJSON('ss.eraser', DEFAULT_ERASER_SETTINGS));
  const [recentColors, setRecentColors] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ss.recent') || '[]'); } catch { return []; }
  });
  const [draft, setDraft] = useState(null);        // local in-progress stroke (shape-like)
  const [remoteDrafts, setRemoteDrafts] = useState([]); // peers' in-progress strokes
  const [remoteErasers, setRemoteErasers] = useState([]); // peers' eraser rings
  const [eraseMask, setEraseMask] = useState(null); // Map<id, Set<idx>> live erase preview
  const [eraserPos, setEraserPos] = useState(null); // {x,y} world for the cursor ring

  const draftRef = useRef(null);   // { points:[x,y,...], tpl:{...brush fields} }
  const eraseRef = useRef(null);   // { mask:Map, last:{x,y} }
  const lastDraftCast = useRef(0); // throttle awareness draft broadcast

  const updatePen = useCallback((patch) =>
    setPenSettings((p) => { const n = { ...p, ...patch }; saveJSON('ss.pen', n); return n; }), []);
  const updateEraser = useCallback((patch) =>
    setEraserSettings((e) => { const n = { ...e, ...patch }; saveJSON('ss.eraser', n); return n; }), []);
  const pushRecentColor = useCallback((c) =>
    setRecentColors((r) => { const n = [c, ...r.filter((x) => x !== c)].slice(0, 8); saveJSON('ss.recent', n); return n; }), []);

  const yshapes = useMemo(() => shapesArray(ydoc), [ydoc]);
  const stageRef = useRef(null);
  const trRef = useRef(null);
  const containerRef = useRef(null);
  const nodeRefs = useRef(new Map());
  const drawing = useRef(null); // in-progress freehand Y.Array or drag origin
  const clipboard = useRef([]); // internal copy/paste buffer (plain records)
  const lastLiveCommit = useRef(0);

  const me = awareness.getLocalState()?.user || { name: 'anon', color: '#6366f1' };

  // ---- Undo manager: scoped to the shapes array, local-origin only ------
  // (trackedOrigins defaults to {null}: the throttled 'live' mid-drag writes are
  // NOT tracked, so a whole drag still undoes as one step — see updateShapeLive)
  const undoMgr = useMemo(
    () => new Y.UndoManager(yshapes, { captureTimeout: 400 }),
    [yshapes]
  );
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    const refresh = () =>
      setUndoState({
        canUndo: undoMgr.undoStack.length > 0,
        canRedo: undoMgr.redoStack.length > 0
      });
    undoMgr.on('stack-item-added', refresh);
    undoMgr.on('stack-item-popped', refresh);
    return () => undoMgr.destroy();
  }, [undoMgr]);

  // ---- responsive stage sizing -----------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.max(320, width), height: Math.max(300, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- snapshot shapes from Yjs (local + remote) -----------------------
  useEffect(() => {
    const snapshot = () => {
      // normalizeShapes() is the single gate between the shared document and
      // the renderer: it fills defaults, coerces every geometry field to a
      // finite number, repairs legacy freehand records and de-duplicates ids,
      // so a malformed or partially-initialised record can never reach Konva.
      let list;
      try {
        list = normalizeShapes(yshapes.toArray().map(readShape));
      } catch (err) {
        // Reading the doc must never be able to kill the component. Keep the
        // last good snapshot rather than tearing the board down.
        console.error('[SyncSpace] failed to read shapes from the document:', err);
        return;
      }
      list.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      setShapes(list);
    };
    snapshot();
    yshapes.observeDeep(snapshot);
    return () => yshapes.unobserveDeep(snapshot);
  }, [yshapes]);

  // ---- awareness: cursors + remote selections --------------------------
  useEffect(() => {
    const onChange = () => {
      const cs = [];
      const sel = [];
      const drafts = [];
      const erasers = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return;
        if (state.cursor && state.user) cs.push({ clientId, ...state.cursor, ...state.user });
        if (state.selection?.length && state.user) {
          sel.push({ clientId, ids: state.selection, ...state.user });
        }
        if (state.draft?.points?.length && state.user) drafts.push({ clientId, ...state.draft });
        if (state.eraser && state.user) erasers.push({ clientId, ...state.eraser, ...state.user });
      });
      setCursors(cs);
      setRemoteSelections(sel);
      setRemoteDrafts(drafts);
      setRemoteErasers(erasers);
    };
    awareness.on('change', onChange);
    onChange();
    return () => awareness.off('change', onChange);
  }, [awareness, ydoc]);

  // ---- derived: live shape positions & connector routes ------------------
  // While a shape is being dragged we render it (and everything wired to it)
  // from livePos, so connectors follow the cursor frame-by-frame instead of
  // jumping on drag-end. Everyone else follows via the throttled live commits.
  const liveShapes = useMemo(() => {
    if (!livePos.size) return shapes;
    return shapes.map((s) => {
      const p = livePos.get(s.id);
      return p ? { ...s, ...p } : s;
    });
  }, [shapes, livePos]);

  const shapesById = useMemo(() => {
    const m = new Map();
    for (const s of liveShapes) m.set(s.id, s);
    return m;
  }, [liveShapes]);

  /** A connector record with any in-flight handle edits applied. */
  const connWithOverride = useCallback(
    (s) => (connOverride && connOverride.id === s.id ? { ...s, ...connOverride.patch } : s),
    [connOverride]
  );

  const routeOf = useCallback(
    (conn) => {
      const c = connWithOverride(conn);
      try {
        const route = connectorRoute(c, shapesById);
        // a route needs at least two finite points to be drawable
        if (Array.isArray(route) && route.length >= 2 &&
            route.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) {
          return { conn: c, route };
        }
      } catch (err) {
        console.error('[SyncSpace] connector routing failed for', c.id, err);
      }
      // Fall back to the endpoints' own cached coordinates so a connector
      // whose target shape just vanished still draws instead of throwing.
      return {
        conn: c,
        route: [
          { x: c.start?.x || 0, y: c.start?.y || 0 },
          { x: c.end?.x || 0, y: c.end?.y || 0 }
        ]
      };
    },
    [connWithOverride, shapesById]
  );

  // ---- keep the Transformer attached to the current selection ----------
  // Connectors are excluded: they have their own endpoint/bend handles, and a
  // bounding-box transform makes no sense for a routed line.
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const nodes = selectedIds
      .filter((id) => {
        const s = shapes.find((x) => x.id === id);
        return s && !isConnector(s.type) && !s.locked;
      })
      .map((id) => nodeRefs.current.get(id))
      // a ref can outlive its node for one commit (shape deleted remotely mid-
      // selection); binding a detached node makes Konva throw on the next draw
      .filter((n) => n && typeof n.getLayer === 'function' && n.getLayer());
    try {
      tr.nodes(nodes);
      tr.getLayer()?.batchDraw();
    } catch (err) {
      console.error('[SyncSpace] could not attach the transformer:', err);
      tr.nodes([]);
    }
  }, [selectedIds, shapes]);

  // publish my selection so peers can see it
  useEffect(() => {
    awareness.setLocalStateField('selection', selectedIds);
  }, [selectedIds, awareness]);

  // drop the eraser ring the moment the tool changes away from the eraser
  useEffect(() => {
    if (tool !== 'eraser') setEraserPos(null);
  }, [tool]);

  // auto-dismiss the transient notice
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- keep the selection referentially honest --------------------------
  // The selection is the single source of truth the property panel reads from,
  // so it must never point at a shape that has left the document. A shape can
  // vanish from under the selection for many reasons that are NOT a local
  // delete: a collaborator deletes it, the eraser consumes a selected stroke,
  // an undo/redo pops it, or a replay rebuilds the board. In every one of those
  // cases this prunes the stale id, which makes the panel disappear on the same
  // commit — no extra click, no panel left belonging to a gone object. Returning
  // the SAME array when nothing changed keeps this from causing a re-render loop.
  useEffect(() => {
    setSelectedIds((cur) => {
      if (!cur.length) return cur;
      const live = new Set(shapes.map((s) => s.id));
      const next = cur.filter((id) => live.has(id));
      return next.length === cur.length ? cur : next;
    });
  }, [shapes]);

  // A stable id -> record map over the COMMITTED shapes (distinct from the
  // live-position `shapesById` used for connector routing): the property panel
  // reads from this so a shape's transient drag position never churns the
  // panel's props (livePos changes would otherwise re-render it every mouse-move
  // mid-drag). Committed values are exactly what the panel should show anyway.
  const committedById = useMemo(() => {
    const m = new Map();
    for (const s of shapes) m.set(s.id, s);
    return m;
  }, [shapes]);

  // The resolved selection: exactly the currently-selected records that still
  // exist. Everything panel-related derives from this one array.
  const selectedShapes = useMemo(
    () => selectedIds.map((id) => committedById.get(id)).filter(Boolean),
    [selectedIds, committedById]
  );
  const selectedShape = selectedShapes.length === 1 ? selectedShapes[0] : null;

  // ---------------------------------------------------------------- helpers
  /**
   * Pointer position in WORLD coordinates (accounts for zoom + pan).
   * Konva's getRelativePointerPosition() returns null whenever the stage has
   * no recorded pointer (pointer left the window, a synthetic/keyboard-driven
   * event, a touch that already ended). Reading `.x` off that null was a real
   * crash path — most easily hit by dragging a shape off the canvas edge,
   * which fires mouseleave -> onStageMouseUp. Every caller now handles null.
   */
  const worldPointer = () => {
    const stage = stageRef.current;
    if (!stage) return null;
    const p = stage.getRelativePointerPosition();
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  };

  const patchSelected = useCallback((patch) => {
    if (selectedIds.length === 1) updateShape(ydoc, selectedIds[0], patch);
    else if (selectedIds.length > 1) updateMany(ydoc, selectedIds, patch);
  }, [selectedIds, ydoc]);

  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    removeShapes(ydoc, selectedIds);
    setSelectedIds([]);
  }, [selectedIds, ydoc]);

  const copySelected = useCallback(() => {
    const records = shapes.filter((s) => selectedIds.includes(s.id));
    if (records.length) clipboard.current = JSON.parse(JSON.stringify(records));
  }, [shapes, selectedIds]);

  const pasteClipboard = useCallback(() => {
    if (!clipboard.current.length) return;
    const ids = duplicateShapes(ydoc, me, clipboard.current);
    setSelectedIds(ids);
    setTool('select');
  }, [ydoc, me]);

  const duplicateSelected = useCallback(() => {
    const records = shapes.filter((s) => selectedIds.includes(s.id));
    if (!records.length) return;
    const ids = duplicateShapes(ydoc, me, JSON.parse(JSON.stringify(records)));
    setSelectedIds(ids);
  }, [shapes, selectedIds, ydoc, me]);

  // ---- one place that changes the active tool ---------------------------
  // Panel visibility is entirely state-driven off `tool` + `selectedIds` +
  // `drawingStarted`, so every tool switch funnels through here to keep those
  // invariants true, rather than each call site poking state ad hoc:
  //   • re-arm the freehand panel (drawingStarted -> false) so re-picking Pen
  //     or Eraser always brings its panel back,
  //   • clear the selection whenever we leave Select, so a shape's property
  //     panel and a tool's own panel can never be open at the same time (there
  //     is always exactly one contextual panel).
  // Switching TO Select intentionally keeps the current selection so the user
  // can go straight to editing what they just made (or pressed V to grab).
  const selectTool = useCallback((t) => {
    setPendingShape(null);
    setConnPreset(null);
    setDrawingStarted(false);
    if (t !== 'select') setSelectedIds([]);
    setTool(t);
  }, []);

  /** Arm one of the drag-to-create shape tools (rect/circle/star/… from menu). */
  const beginShapeTool = useCallback((shape) => {
    setSelectedIds([]);
    setDrawingStarted(false);
    setConnPreset(null);
    setPendingShape(shape);
    setTool('shape');
  }, []);

  const startConnectorTool = useCallback((preset) => {
    setSelectedIds([]);
    setDrawingStarted(false);
    setConnPreset(preset || {});
    setPendingShape(null);
    setTool('connector');
  }, []);

  /** Build the endpoint record for a snap result (or a free point). */
  const endpointFor = (snap, point) =>
    snap
      ? { shapeId: snap.shapeId, anchor: snap.anchor, x: snap.x, y: snap.y }
      : { x: point.x, y: point.y };

  // ---------------------------------------------------------------- image / sticker
  /**
   * Place a bitmap on the canvas at its NATURAL aspect ratio, scaled to fit a
   * sensible default box. It used to hardcode 160x120, so every upload was
   * squashed or stretched the moment it landed and the user had to fix it by
   * hand — a portrait photo arrived as a letterbox.
   */
  const placeImage = useCallback((src, extra = {}) => {
    const MAX = 320; // longest edge of a freshly placed image, in world units
    const finish = (natW, natH) => {
      const w = natW > 0 ? natW : MAX;
      const h = natH > 0 ? natH : MAX;
      const scale = Math.min(1, MAX / Math.max(w, h));
      const width = Math.max(MIN_SIZE, Math.round(w * scale));
      const height = Math.max(MIN_SIZE, Math.round(h * scale));
      // centre it in the current viewport
      const cx = (-view.x / view.scale) + (size.width / view.scale) / 2 - width / 2;
      const cy = (-view.y / view.scale) + (size.height / view.scale) / 2 - height / 2;
      const id = addShape(ydoc, me, {
        type: 'image',
        src,
        x: cx, y: cy,
        width, height,
        stroke: 'transparent',
        strokeWidth: 0,
        ...extra
      });
      setSelectedIds([id]);
      setTool('select');
    };

    // Measure first. An SVG with no intrinsic size reports 0, which `finish`
    // falls back on rather than dividing by it.
    const probe = new window.Image();
    probe.onload = () => finish(probe.naturalWidth, probe.naturalHeight);
    probe.onerror = () => finish(0, 0);
    probe.src = src;
  }, [ydoc, me, view, size]);

  /** Upload an image file, convert to base64, and place it on the canvas. */
  const handleImageUpload = useCallback((file) => {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) {
      setNotice({ kind: 'error', text: 'That file is not an image.' });
      return;
    }
    const reader = new FileReader();
    reader.onerror = () =>
      setNotice({ kind: 'error', text: 'That image could not be read.' });
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      // Max 5 MB for shared images so the Yjs doc doesn't bloat
      if (typeof dataUrl !== 'string' || dataUrl.length > 5 * 1024 * 1024) {
        // `toast` was never defined in this scope, so this branch threw a
        // ReferenceError instead of telling the user anything.
        setNotice({ kind: 'error', text: 'That image is too large — 5 MB is the limit.' });
        return;
      }
      placeImage(dataUrl);
    };
    reader.readAsDataURL(file);
  }, [placeImage]);

  /** Place a sticker (SVG data URL) on the canvas. */
  const handleSticker = useCallback((sticker) => {
    if (!sticker?.svg) return;
    placeImage(sticker.svg, { name: sticker.name });
  }, [placeImage]);

  // ---------------------------------------------------------------- pen / eraser
  /** Turn the persisted pen settings into a stroke-record template. */
  const strokeTemplate = useCallback(() => ({
    type: 'path',
    brush: penSettings.brush,
    stroke: penSettings.color,
    strokeWidth: penSettings.size,
    opacity: penSettings.opacity,
    smoothing: penSettings.smoothing,
    pressure: penSettings.pressure,
    nibAngle: penSettings.nibAngle
  }), [penSettings]);

  /** Precomputed bounds of every freehand stroke, for eraser broad-phase skip. */
  const pathBounds = useMemo(() => {
    const m = new Map();
    for (const s of shapes) {
      if (s.type === 'path' && s.points?.length) m.set(s.id, pointsBounds(s.points));
    }
    return m;
  }, [shapes]);

  /**
   * Erase everything the eraser sweeps between `from` and `to`.
   *
   * Three things make this feel continuous rather than granular:
   *
   *  1. Each stroke is DENSIFIED once per session (resample ~2px) before it is
   *     touched. Erasing removes whole vertices, so on an RDP-simplified stroke
   *     the smallest removable piece could be tens of pixels — that granularity
   *     was the "particles disappearing" effect.
   *  2. The eraser is tested as a swept CAPSULE over the whole drag segment
   *     instead of stamping circles at sampled intervals. It is exact (no gaps
   *     on a fast flick) and costs one test per vertex regardless of speed.
   *  3. The surviving runs are computed HERE and cached on the session, so the
   *     render pass just draws them instead of re-splitting every stroke on
   *     every frame.
   *
   * The document is NOT written here — this is a local preview; the split is
   * committed atomically on pointer-up (see commitErase).
   */
  const eraseAlong = useCallback((from, to) => {
    const sess = eraseRef.current;
    if (!sess) return;
    const r = eraserSettings.size;
    const padMinX = Math.min(from.x, to.x) - r, padMaxX = Math.max(from.x, to.x) + r;
    const padMinY = Math.min(from.y, to.y) - r, padMaxY = Math.max(from.y, to.y) + r;
    let changed = false;

    for (const s of shapes) {
      if (s.type !== 'path' || s.locked || !s.points?.length) continue;
      // Broad phase against the COMMITTED bounds: a far-away stroke is never
      // densified at all, which is what keeps this cheap with thousands on canvas.
      const b = pathBounds.get(s.id);
      if (b && (b.maxX < padMinX || b.minX > padMaxX || b.maxY < padMinY || b.minY > padMaxY)) continue;

      let dense = sess.dense.get(s.id);
      if (!dense) {
        // Finer than the eraser, but never so fine that a long stroke explodes
        // into hundreds of thousands of points.
        const spacing = Math.max(1, Math.min(2.5, r / 6));
        dense = resample(s.points, spacing);
        sess.dense.set(s.id, dense);
      }

      let set = sess.mask.get(s.id);
      const before = set ? set.size : 0;
      if (!set) { set = new Set(); sess.mask.set(s.id, set); }
      markErasedSweep(dense, from.x, from.y, to.x, to.y, r, set);
      if (set.size > before) {
        sess.runs.set(s.id, surviveRuns(dense, set));
        changed = true;
      }
    }
    // A fresh Map identity is what tells React to repaint the preview; the runs
    // inside are already computed, so the render pass itself stays cheap.
    if (changed) setEraseMask(new Map(sess.runs));
  }, [eraserSettings, shapes, pathBounds]);

  /** Commit the whole eraser drag as one undo step (delete originals, add runs). */
  const commitErase = useCallback(() => {
    const sess = eraseRef.current;
    eraseRef.current = null;
    setEraseMask(null);
    awareness.setLocalStateField('eraser', null);
    if (!sess || !sess.runs.size) return;
    const edits = [];
    for (const [id, runs] of sess.runs) {
      if (!shapes.some((x) => x.id === id)) continue;
      // Re-simplify each surviving fragment before it is stored. The runs come
      // from the densified copy, so committing them raw would persist (and
      // sync, and hold in undo history) an order of magnitude more points than
      // the stroke had before it was erased.
      edits.push({ id, runs: runs.map((run) => (run.length >= 6 ? simplify(run, 0.5) : run)) });
    }
    if (edits.length) applyErase(ydoc, me, edits);
  }, [shapes, ydoc, me, awareness]);

  /** Finish the local pen stroke: simplify + persist once, clear the preview. */
  const commitDraft = useCallback(() => {
    const d = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    awareness.setLocalStateField('draft', null);
    if (!d || d.points.length < 2) return;
    // a single click leaves a dot; a real stroke gets lightly simplified so the
    // stored record is compact (cheaper sync + redraw) without changing its look
    const pts = d.points.length >= 6 ? simplify(d.points, 0.5) : d.points;
    commitStroke(ydoc, me, { ...d.tpl, points: pts });
  }, [ydoc, me, awareness]);

  // ---------------------------------------------------------------- mouse
  const onStageMouseDown = (e) => {
    const stage = e.target.getStage();
    const clickedEmpty = e.target === stage;
    const pos = worldPointer();
    if (!pos) return;

    // panning (space held, or middle mouse) takes priority over every tool
    if (spaceDown || e.evt.button === 1) return;

    // SELECT tool: click empty space clears selection
    if (tool === 'select' && !pendingShape) {
      if (clickedEmpty) setSelectedIds([]);
      return;
    }

    // CONNECTOR tool: click (optionally on a shape) starts wiring
    if (tool === 'connector') {
      const snap = findSnapTarget(pos, liveShapes);
      drawing.current = {
        kind: 'connector',
        start: endpointFor(snap, pos),
        startPoint: snap ? { x: snap.x, y: snap.y } : { ...pos }
      };
      setSnapHint(snap);
      setPreview({
        kind: 'connector',
        pts: [drawing.current.startPoint, drawing.current.startPoint],
        preset: connPreset || {}
      });
      return;
    }

    // TEXT tool: click-drag to define a text region (like Figma/Miro).
    // We only begin a drag here; the editor opens on mouse-up so the user can
    // size the box first. The tool stays 'text' throughout — it does NOT revert
    // to Select (that revert was the original "text tool is broken" bug).
    if (tool === 'text') {
      drawing.current = { kind: 'text', x0: pos.x, y0: pos.y };
      setPreview({ type: 'rect', x: pos.x, y: pos.y, width: 0, height: 0 });
      return;
    }

    // PEN tool: begin a freehand stroke. The in-progress stroke lives in local
    // state and is broadcast over awareness so peers watch it draw live; it is
    // written to the ydoc ONCE on pointer-up (commitDraft). That keeps a whole
    // stroke as a single undo step and avoids re-snapshotting every shape on
    // every sampled point — the key to staying smooth with thousands on-canvas.
    if (tool === 'pen') {
      draftRef.current = { points: [pos.x, pos.y], tpl: strokeTemplate() };
      setDraft({ ...draftRef.current.tpl, points: [pos.x, pos.y] });
      drawing.current = { kind: 'pen' };
      // pen is now on the canvas: retire the brush panel so it never floats
      // over the stroke. It returns only when Pen is explicitly re-selected.
      if (!drawingStarted) setDrawingStarted(true);
      return;
    }

    // ERASER tool: begin a partial-erase drag (preview only until pointer-up).
    if (tool === 'eraser') {
      // mask = erased vertex indices, dense = densified copy of each touched
      // stroke, runs = the surviving fragments (computed once, drawn many times)
      eraseRef.current = { mask: new Map(), dense: new Map(), runs: new Map(), last: { ...pos } };
      drawing.current = { kind: 'erase' };
      setEraserPos(pos);
      awareness.setLocalStateField('eraser', { x: pos.x, y: pos.y, size: eraserSettings.size });
      eraseAlong(pos, pos);
      // erasing has begun: retire the eraser panel until Eraser is re-selected.
      if (!drawingStarted) setDrawingStarted(true);
      return;
    }

    // SHAPE / RECT / LINE: begin drag-to-create
    const type = tool === 'rect' ? 'rect'
      : tool === 'line' ? 'line'
      : pendingShape?.type;
    if (!type) return;

    drawing.current = { kind: 'shape', type, x0: pos.x, y0: pos.y };
    setPreview({ type, x: pos.x, y: pos.y, width: 0, height: 0 });
  };

  const onStageMouseMove = () => {
    const pos = worldPointer();
    if (!pos) return;
    awareness.setLocalStateField('cursor', { x: pos.x, y: pos.y });

    if (tool === 'eraser') setEraserPos(pos);

    const d = drawing.current;

    // idle connector tool: light up anchors under the cursor before the click
    if (!d && tool === 'connector') {
      setSnapHint(findSnapTarget(pos, liveShapes));
      return;
    }
    if (!d) return;

    if (d.kind === 'pen') {
      const dr = draftRef.current;
      dr.points.push(pos.x, pos.y);
      setDraft({ ...dr.tpl, points: dr.points.slice() });
      const now = performance.now();
      if (now - lastDraftCast.current > 55) {
        lastDraftCast.current = now;
        awareness.setLocalStateField('draft', { ...dr.tpl, points: dr.points.slice() });
      }
      return;
    }

    if (d.kind === 'erase') {
      const sess = eraseRef.current;
      eraseAlong(sess.last, pos);
      sess.last = { ...pos };
      awareness.setLocalStateField('eraser', { x: pos.x, y: pos.y, size: eraserSettings.size });
      return;
    }

    if (d.kind === 'connector') {
      const snap = findSnapTarget(pos, liveShapes, d.start.shapeId ? [d.start.shapeId] : []);
      setSnapHint(snap);
      setPreview({
        kind: 'connector',
        pts: [d.startPoint, snap ? { x: snap.x, y: snap.y } : pos],
        preset: connPreset || {}
      });
      return;
    }

    if (d.kind === 'text') {
      const x = Math.min(d.x0, pos.x);
      const y = Math.min(d.y0, pos.y);
      setPreview({ type: 'rect', x, y,
        width: Math.abs(pos.x - d.x0), height: Math.abs(pos.y - d.y0) });
      return;
    }

    if (d.kind === 'shape') {
      if (isDraggableLine(d.type)) {
        setPreview({ type: d.type, x: d.x0, y: d.y0,
          points: [0, 0, pos.x - d.x0, pos.y - d.y0], isLine: true });
      } else {
        const x = Math.min(d.x0, pos.x);
        const y = Math.min(d.y0, pos.y);
        const width = Math.abs(pos.x - d.x0);
        const height = Math.abs(pos.y - d.y0);
        setPreview({ type: d.type, x, y, width, height });
      }
    }
  };

  const onStageMouseUp = () => {
    const d = drawing.current;
    drawing.current = null;
    if (!d) return;

    if (d.kind === 'pen') { commitDraft(); return; }
    if (d.kind === 'erase') { commitErase(); return; }

    // Everything below needs a pointer position. If the pointer is already
    // gone (mouseleave, cancelled touch) abandon the in-progress creation
    // cleanly rather than committing a shape at a bogus coordinate.
    if (!worldPointer()) {
      setPreview(null);
      setSnapHint(null);
      return;
    }

    // CONNECTOR: commit if it actually goes somewhere (length or attachment)
    if (d.kind === 'connector') {
      const pos = worldPointer();
      const snap = findSnapTarget(pos, liveShapes, d.start.shapeId ? [d.start.shapeId] : []);
      const end = endpointFor(snap, pos);
      const endPoint = snap ? { x: snap.x, y: snap.y } : pos;
      const len = Math.hypot(endPoint.x - d.startPoint.x, endPoint.y - d.startPoint.y);
      setPreview(null);
      setSnapHint(null);
      if (len < MIN_SIZE * 2 && !(d.start.shapeId && end.shapeId)) return;

      const created = addShape(ydoc, me, {
        type: 'connector',
        ...CONNECTOR_DEFAULTS(),
        ...(connPreset || {}),
        start: d.start,
        end,
        x: 0, y: 0 // connectors position themselves from their endpoints
      });
      setTool('select');
      setConnPreset(null);
      if (created) setSelectedIds([created]);
      return;
    }

    // TEXT: the drag defined a region. Open the editor inside it and KEEP the
    // text tool active — creation happens on commit, not here.
    if (d.kind === 'text') {
      const pos = worldPointer();
      const x = Math.min(d.x0, pos.x);
      const y = Math.min(d.y0, pos.y);
      // a bare click (no real drag) still works: fall back to a default width
      const width = Math.max(Math.abs(pos.x - d.x0), 160);
      const height = Math.max(Math.abs(pos.y - d.y0), 40);
      setPreview(null);
      startTextEditor({ x, y, width, height });
      return;
    }

    if (d.kind === 'shape') {
      const pos = worldPointer();
      let created = null;

      if (isDraggableLine(d.type)) {
        const dx = pos.x - d.x0;
        const dy = pos.y - d.y0;
        if (Math.abs(dx) < MIN_SIZE && Math.abs(dy) < MIN_SIZE) { setPreview(null); return; }
        created = addShape(ydoc, me, {
          type: d.type,
          x: d.x0, y: d.y0,
          points: [0, 0, dx, dy],
          stroke: me.color || '#111827',
          strokeWidth: 3,
          fill: 'transparent'
        });
      } else {
        const x = Math.min(d.x0, pos.x);
        const y = Math.min(d.y0, pos.y);
        let width = Math.abs(pos.x - d.x0);
        let height = Math.abs(pos.y - d.y0);
        // a click (no drag) drops a sensible default-sized shape
        if (width < MIN_SIZE && height < MIN_SIZE) { width = 120; height = 90; }
        if (d.type === 'circle') { height = width = Math.max(width, height); }
        created = addShape(ydoc, me, {
          type: d.type,
          x, y, width, height,
          fill: '#6366f1',
          stroke: '#111827',
          strokeWidth: 2
        });
      }

      setPreview(null);
      setPendingShape(null);
      setTool('select');
      if (created) setSelectedIds([created]);
    }
  };

  // ---------------------------------------------------------------- zoom & pan
  const onWheel = (e) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!pointer) return;
    const old = view.scale;
    const factor = e.evt.deltaY > 0 ? 1 / 1.08 : 1.08;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, old * factor));
    if (scale === old) return;
    const world = { x: (pointer.x - view.x) / old, y: (pointer.y - view.y) / old };
    setView({ scale, x: pointer.x - world.x * scale, y: pointer.y - world.y * scale });
  };

  const zoomTo = (scale) => {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const cx = size.width / 2;
    const cy = size.height / 2;
    const world = { x: (cx - view.x) / view.scale, y: (cy - view.y) / view.scale };
    setView({ scale: s, x: cx - world.x * s, y: cy - world.y * s });
  };

  const panning = spaceDown;

  // ---------------------------------------------------------------- select
  const onSelectShape = (e, id) => {
    if (tool !== 'select' || panning) return;
    e.cancelBubble = true;
    // Locked shapes stay selectable — otherwise they could never be unlocked —
    // but they are excluded from dragging (draggable={!locked}) and from the
    // Transformer below, so selection is the ONLY thing a lock still allows.
    const additive = e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey;
    setSelectedIds((cur) =>
      additive
        ? cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
        : [id]
    );
    // NOTE: selecting deliberately does NOT bring the shape to the front.
    // It used to, which quietly destroyed any layer order the user had set up:
    // press "Send backward", click the shape again to keep working on it, and
    // it jumped straight back to the top — making the Arrange buttons look
    // broken when they had worked perfectly. Z-order is now only ever changed
    // by the explicit Arrange controls (reorderShape), which are undoable.
  };

  // ---------------------------------------------------------------- drag
  // Circle/ellipse/star position their Konva node at the CENTRE, so node.x()
  // returns the centre. Everywhere else stores (x, y) as the TOP-LEFT. This ONE
  // predicate is the entire special case: whenever we read a position back off
  // such a node, subtract half-size to get the stored top-left.
  const nodeTopLeft = (node, shape) => {
    let x = node.x();
    let y = node.y();
    if (isCentered(shape.type)) {
      x -= (shape.width || 0) / 2;
      y -= (shape.height || 0) / 2;
    }
    return { x, y };
  };

  // While a drag is in flight: render locally from livePos (keeps connectors
  // glued to the shape) and push throttled 'live' commits so peers follow too.
  const onDragMove = (e, shape) => {
    const p = nodeTopLeft(e.target, shape);
    setLivePos((m) => {
      const next = new Map(m);
      next.set(shape.id, p);
      return next;
    });
    const now = performance.now();
    if (now - lastLiveCommit.current > LIVE_COMMIT_MS) {
      lastLiveCommit.current = now;
      updateShapeLive(ydoc, shape.id, p);
    }
  };

  const onDragEnd = (e, shape) => {
    const p = nodeTopLeft(e.target, shape);
    updateShape(ydoc, shape.id, p);
    setLivePos((m) => {
      if (!m.has(shape.id)) return m;
      const next = new Map(m);
      next.delete(shape.id);
      return next;
    });
  };

  // ---------------------------------------------------------------- transform
  const onTransformEnd = (e, shape) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const patch = { rotation: node.rotation() };

    // For box shapes, bake the scale back into width/height so stroke width and
    // corner radius stay crisp instead of stretching. Lines/text keep their scale.
    if (shape.width != null && !isDraggableLine(shape.type) && !isTextType(shape.type)) {
      patch.width = Math.max(MIN_SIZE, (shape.width || 0) * scaleX);
      patch.height = Math.max(MIN_SIZE, (shape.height || 0) * scaleY);
      node.scaleX(1);
      node.scaleY(1);
      // node.x() is the CENTRE for these; convert to the stored top-left using
      // the NEW size so the box stays put as it resizes.
      if (isCentered(shape.type)) {
        patch.x = node.x() - patch.width / 2;
        patch.y = node.y() - patch.height / 2;
      } else {
        patch.x = node.x();
        patch.y = node.y();
      }
    } else {
      patch.x = node.x();
      patch.y = node.y();
      patch.scaleX = scaleX;
      patch.scaleY = scaleY;
    }
    updateShape(ydoc, shape.id, patch);
  };

  // ---------------------------------------------------------------- connectors
  /** Double-click a connector body: insert a bend point right there. */
  const onConnectorDblClick = (conn) => {
    const pos = worldPointer();
    if (!pos) return;
    const { conn: c, route } = routeOf(conn);
    updateShape(ydoc, conn.id, { waypoints: insertWaypoint(c, route, pos) });
    setSelectedIds([conn.id]);
  };

  /** Endpoint handle drag: live rewire with snapping + highlight. */
  const onEndpointDrag = (conn, which, node, commit) => {
    const pos = { x: node.x(), y: node.y() };
    const snap = findSnapTarget(pos, liveShapes);
    if (snap) node.position({ x: snap.x, y: snap.y });
    setSnapHint(snap);
    const endpoint = endpointFor(snap, pos);
    if (commit) {
      updateShape(ydoc, conn.id, { [which]: endpoint });
      setConnOverride(null);
      setSnapHint(null);
    } else {
      setConnOverride({ id: conn.id, patch: { [which]: endpoint } });
    }
  };

  /** Waypoint handle drag (index into the flat waypoints array / 2). */
  const onWaypointDrag = (conn, idx, node, commit) => {
    const base = connWithOverride(conn);
    const flat = [...(base.waypoints || [])];
    flat[idx * 2] = node.x();
    flat[idx * 2 + 1] = node.y();
    if (commit) {
      updateShape(ydoc, conn.id, { waypoints: flat });
      setConnOverride(null);
    } else {
      setConnOverride({ id: conn.id, patch: { waypoints: flat } });
    }
  };

  const deleteWaypoint = (conn, idx) => {
    const flat = [...(conn.waypoints || [])];
    flat.splice(idx * 2, 2);
    updateShape(ydoc, conn.id, { waypoints: flat });
  };

  /** Midpoint "+" handle: dragging it births a new bend point in place. */
  const midDragRef = useRef(null); // { connId, at } while a midpoint drag is live
  const onMidpointDrag = (conn, segIdx, node, phase) => {
    const committed = conn.waypoints || [];
    if (phase === 'start' || !midDragRef.current || midDragRef.current.connId !== conn.id) {
      // first touch: insert the new waypoint at this segment, remember its index
      const at = Math.min(segIdx, committed.length / 2);
      const flat = [...committed];
      flat.splice(at * 2, 0, node.x(), node.y());
      midDragRef.current = { connId: conn.id, at };
      setConnOverride({ id: conn.id, patch: { waypoints: flat } });
      return;
    }
    const { at } = midDragRef.current;
    const base = connWithOverride(conn);
    const flat = [...(base.waypoints || [])];
    flat[at * 2] = node.x();
    flat[at * 2 + 1] = node.y();
    if (phase === 'end') {
      midDragRef.current = null;
      updateShape(ydoc, conn.id, { waypoints: flat });
      setConnOverride(null);
    } else {
      setConnOverride({ id: conn.id, patch: { waypoints: flat } });
    }
  };

  // ---------------------------------------------------------------- text
  // Two entry points, one editor:
  //   - new text  -> startTextEditor({ x, y, width, height }) from a region drag
  //   - re-edit   -> startTextEditor({ existing })            from a double-click
  // The editor is a real <textarea> laid over the canvas: it wraps at the region
  // width and grows downward as content overflows (handled in the overlay's
  // onChange via scrollHeight). The active tool is left untouched, so the Text
  // tool stays selected for placing several boxes in a row.
  const startTextEditor = ({ x, y, width, height, existing = null }) => {
    setSelectedIds(existing ? [existing.id] : []);
    setEditingText({
      id: existing?.id || null,
      x: existing?.x ?? x,
      y: existing?.y ?? y,
      width: existing?.width || width || 160,
      height: existing?.height || height || 40,
      value: existing?.text || '',
      fontSize: existing?.fontSize || 20,
      fontFamily: existing?.fontFamily || 'Inter',
      fill: existing?.fill || '#111827',
      fontWeight: existing?.fontWeight || 'normal',
      italic: existing?.italic || false,
      underline: existing?.underline || false,
      align: existing?.align || 'left',
      lineHeight: existing?.lineHeight || 1.2
    });
  };

  const commitText = () => {
    const t = editingText;
    setEditingText(null);
    if (!t) return;
    const value = t.value.trim();

    if (t.id) {
      // editing an existing object: empty content deletes it
      if (!value) { removeShapes(ydoc, [t.id]); setSelectedIds([]); }
      else updateShape(ydoc, t.id, { text: t.value, width: t.width, height: t.height });
      return;
    }

    // brand-new: only persist non-empty text (empty region is silently dropped)
    if (value) {
      const id = addShape(ydoc, me, {
        type: 'text',
        x: t.x, y: t.y,
        width: t.width,
        height: t.height,
        text: t.value,
        fontSize: t.fontSize,
        fontFamily: t.fontFamily,
        fill: t.fill,
        fontWeight: t.fontWeight,
        italic: t.italic,
        underline: t.underline,
        align: t.align,
        lineHeight: t.lineHeight,
        stroke: 'transparent',
        strokeWidth: 0
      });
      setSelectedIds([id]);
      setTool('select'); // after finishing a NEW box, hand control back to Select
    }
  };

  const onShapeDblClick = (shape) => {
    if (isTextType(shape.type)) startTextEditor({ existing: shape });
  };

  // ---------------------------------------------------------------- export
  const exportPNG = () => {
    setSelectedIds([]); // hide the transformer & handles first
    setTimeout(() => {
      if (!stageRef.current) return; // unmounted before the timer fired
      const uri = stageRef.current.toDataURL({ pixelRatio: 2 });
      const a = document.createElement('a');
      a.href = uri;
      a.download = 'syncspace-board.png';
      a.click();
    }, 60);
  };

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (editingText) return; // typing in the overlay
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) {
        e.preventDefault();
        deleteSelected();
      } else if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoMgr.undo();
      } else if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        undoMgr.redo();
      } else if (ctrl && e.key.toLowerCase() === 'c') {
        if (selectedIds.length) { e.preventDefault(); copySelected(); }
      } else if (ctrl && e.key.toLowerCase() === 'v') {
        if (clipboard.current.length) { e.preventDefault(); pasteClipboard(); }
      } else if (ctrl && e.key.toLowerCase() === 'd') {
        if (selectedIds.length) { e.preventDefault(); duplicateSelected(); }
      } else if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedIds(shapes.filter((s) => !s.locked).map((s) => s.id));
      } else if (e.key === 'Escape') {
        drawing.current = null;
        draftRef.current = null;
        eraseRef.current = null;
        setPreview(null);
        setSnapHint(null);
        setDraft(null);
        setEraseMask(null);
        setEraserPos(null);
        awareness.setLocalStateField('draft', null);
        awareness.setLocalStateField('eraser', null);
        setSelectedIds([]); setDrawingStarted(false);
        setPendingShape(null); setConnPreset(null); setTool('select');
      } else if (!ctrl) {
        const map = { v: 'select', p: 'pen', e: 'eraser', r: 'rect', t: 'text', l: 'line' };
        const k = e.key.toLowerCase();
        if (map[k]) selectTool(map[k]);
        else if (k === 'c') startConnectorTool({ routing: 'elbow' });
        else if (k === 'a') startConnectorTool({});
      }
    };
    const onKeyUp = (e) => {
      if (e.key === ' ') setSpaceDown(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [selectedIds, editingText, deleteSelected, undoMgr, shapes,
      copySelected, pasteClipboard, duplicateSelected, startConnectorTool, selectTool]);

  const cursorStyle =
    panning ? 'grab'
    : tool === 'select' ? 'default'
    : tool === 'text' ? 'text'
    : tool === 'eraser' ? 'none'
    : 'crosshair';

  const handleScale = 1 / view.scale; // keep handles a constant on-screen size

  const selectedConnector =
    selectedShape && isConnector(selectedShape.type) ? selectedShape : null;

  // ---- single source of truth for which panel is on screen --------------
  // Exactly one contextual panel can ever be eligible at a time, derived purely
  // from the tool + selection + drawing state (no imperative show/hide):
  //   • a freehand tool owns the panel area → show the Brush/Eraser panel,
  //     unless a stroke is already underway (then nothing floats over it);
  //   • otherwise the selection owns it → show the Property panel for whatever
  //     is selected (one shape, or the common props of many).
  // Because selecting a freehand tool clears the selection, and the property
  // panel is suppressed whenever a freehand tool is active, the two can never
  // be open together.
  const isFreehandTool = tool === 'pen' || tool === 'eraser';
  const showBrushPanel = isFreehandTool && !drawingStarted;
  const propertySelection = isFreehandTool ? [] : selectedShapes;

  // Stable so the memoized PropertyPanel isn't re-rendered every frame during a
  // drag. Reorder applies to each selected shape (front/back of the whole set).
  const reorderSelection = useCallback((dir) => {
    for (const s of selectedShapes) reorderShape(ydoc, s.id, dir);
  }, [selectedShapes, ydoc]);

  // Alignment and distribution callbacks
  const alignHorizontally = useCallback((type) => {
    alignShapesHorizontally(ydoc, selectedIds, type);
  }, [ydoc, selectedIds]);

  const alignVertically = useCallback((type) => {
    alignShapesVertically(ydoc, selectedIds, type);
  }, [ydoc, selectedIds]);

  const distributeHorizontally = useCallback(() => {
    distributeShapesHorizontally(ydoc, selectedIds);
  }, [ydoc, selectedIds]);

  const distributeVertically = useCallback(() => {
    distributeShapesVertically(ydoc, selectedIds);
  }, [ydoc, selectedIds]);

  return (
    <div className="pane whiteboard-pane">
      <div className="pane-header column">
        <Toolbar
          tool={
            pendingShape ? 'shape'
              // The toolbar has two buttons for the one connector tool. Tell it
              // which variant is armed, otherwise Arrow could never highlight.
              : tool === 'connector'
                ? (connPreset?.routing === 'elbow' ? 'connector' : 'arrow')
                : tool
          }
          setTool={selectTool}
          onShape={(s) => {
            if (s.type === 'connector') startConnectorTool(s.preset || {});
            else beginShapeTool(s);
          }}
          onConnector={startConnectorTool}
          onImage={handleImageUpload}
          onSticker={handleSticker}
          onUndo={() => undoMgr.undo()}
          onRedo={() => undoMgr.redo()}
          canUndo={undoState.canUndo}
          canRedo={undoState.canRedo}
          onDelete={deleteSelected}
          hasSelection={selectedIds.length > 0}
        />
      </div>

      <div className="canvas-body">
        <div className="stage-container" ref={containerRef} style={{ cursor: cursorStyle }}>
          <Stage
            ref={stageRef}
            width={size.width}
            height={size.height}
            scaleX={view.scale}
            scaleY={view.scale}
            x={view.x}
            y={view.y}
            draggable={panning}
            onDragMove={(e) => {
              // keep the controlled x/y props in lock-step with the live pan,
              // otherwise any mid-drag re-render (a remote cursor moving, a
              // shape syncing) would snap the camera back to its old position
              if (e.target === stageRef.current) {
                setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
              }
            }}
            onDragEnd={(e) => {
              if (e.target === stageRef.current) {
                setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
              }
            }}
            onWheel={onWheel}
            onMouseDown={onStageMouseDown}
            onMouseMove={onStageMouseMove}
            onMouseUp={onStageMouseUp}
            onMouseLeave={(e) => { onStageMouseUp(e); setEraserPos(null); }}
            className="stage"
          >
            <Layer>
              {liveShapes.map((s) => {
                // live erase preview: a masked stroke renders as its surviving
                // runs so the user watches it break apart before releasing
                if (eraseMask && s.type === 'path' && eraseMask.has(s.id)) {
                  const runs = eraseMask.get(s.id) || [];
                  return (
                    <Group key={s.id} listening={false}>
                      {runs.map((r, i) => (
                        <PreviewStroke key={i} shape={{ ...s, points: r }} />
                      ))}
                    </Group>
                  );
                }
                // Every object is rendered inside its own boundary: if any
                // single record cannot draw, IT is skipped and the stage,
                // toolbar and every other shape keep rendering normally.
                if (isConnector(s.type)) {
                  const { conn, route } = routeOf(s);
                  return (
                    <ShapeErrorBoundary key={s.id} shapeId={s.id} shapeType={s.type} resetKey={s}>
                      <ConnectorNode
                        conn={conn}
                        pts={displayPoints(conn, route)}
                        ref={(node) => {
                          if (node) nodeRefs.current.set(s.id, node);
                          else nodeRefs.current.delete(s.id);
                        }}
                        onSelect={(e) => onSelectShape(e, s.id)}
                        onDblClick={() => onConnectorDblClick(s)}
                      />
                    </ShapeErrorBoundary>
                  );
                }
                return (
                  <ShapeErrorBoundary key={s.id} shapeId={s.id} shapeType={s.type} resetKey={s}>
                    <ShapeNode
                      shape={s}
                      ref={(node) => {
                        if (node) nodeRefs.current.set(s.id, node);
                        else nodeRefs.current.delete(s.id);
                      }}
                      draggable={tool === 'select' && !s.locked && !panning}
                      onSelect={(e) => onSelectShape(e, s.id)}
                      onDragMove={(e) => onDragMove(e, s)}
                      onDragEnd={(e) => onDragEnd(e, s)}
                      onTransformEnd={(e) => onTransformEnd(e, s)}
                      onDblClick={() => onShapeDblClick(s)}
                    />
                  </ShapeErrorBoundary>
                );
              })}

              {/* live drag-to-create preview */}
              {preview && <PreviewGhost preview={preview} />}

              {/* in-progress pen strokes: local + remote collaborators */}
              {draft && <PreviewStroke shape={draft} />}
              {remoteDrafts.map((d) => (
                <PreviewStroke key={`rd-${d.clientId}`} shape={{ type: 'path', ...d }} />
              ))}

              {/* eraser rings — the cursor for the local user, presence for peers */}
              {tool === 'eraser' && eraserPos && (
                <Circle x={eraserPos.x} y={eraserPos.y} radius={eraserSettings.size}
                  stroke="#ef4444" strokeWidth={1.5 * handleScale}
                  dash={[4 * handleScale, 4 * handleScale]}
                  fill="rgba(239,68,68,0.06)" listening={false} />
              )}
              {remoteErasers.map((r) => (
                <Circle key={`re-${r.clientId}`} x={r.x} y={r.y} radius={r.size || 20}
                  stroke={r.color || '#ef4444'} strokeWidth={1.2 * handleScale}
                  dash={[4 * handleScale, 4 * handleScale]} listening={false} />
              ))}

              {/* editable handles for the selected connector */}
              {selectedConnector && !selectedConnector.locked && (
                <ConnectorHandles
                  conn={connWithOverride(selectedConnector)}
                  route={routeOf(selectedConnector).route}
                  scale={handleScale}
                  onEndpointDrag={(which, node, commit) =>
                    onEndpointDrag(selectedConnector, which, node, commit)}
                  onWaypointDrag={(idx, node, commit) =>
                    onWaypointDrag(selectedConnector, idx, node, commit)}
                  onWaypointDelete={(idx) => deleteWaypoint(selectedConnector, idx)}
                  onMidpointDrag={(segIdx, node, phase) =>
                    onMidpointDrag(selectedConnector, segIdx, node, phase)}
                />
              )}

              {/* snap feedback while wiring a connector */}
              {snapHint && (
                <SnapIndicator
                  snap={snapHint}
                  shape={shapesById.get(snapHint.shapeId)}
                  scale={handleScale}
                />
              )}

              {/* remote selection boxes (awareness) */}
              {remoteSelections.map((sel) =>
                sel.ids.map((id) => {
                  // custom-drawn connectors have no Konva self-rect, so their
                  // box comes from the route geometry instead of getClientRect
                  const s = shapesById.get(id);
                  let box;
                  if (s && isConnector(s.type)) {
                    const { conn: c, route } = routeOf(s);
                    const pts = displayPoints(c, route);
                    const xs = pts.map((p) => p.x);
                    const ys = pts.map((p) => p.y);
                    box = {
                      x: Math.min(...xs) - 4, y: Math.min(...ys) - 4,
                      width: Math.max(...xs) - Math.min(...xs) + 8,
                      height: Math.max(...ys) - Math.min(...ys) + 8
                    };
                  } else {
                    const node = nodeRefs.current.get(id);
                    if (!node) return null;
                    box = node.getClientRect({ relativeTo: stageRef.current });
                  }
                  return (
                    <Group key={`${sel.clientId}-${id}`} listening={false}>
                      <Rect x={box.x} y={box.y} width={box.width} height={box.height}
                        stroke={sel.color} strokeWidth={1.5 * handleScale} dash={[4, 4]} />
                      <Text x={box.x} y={box.y - 16 * handleScale} text={sel.name}
                        fontSize={11 * handleScale} fill={sel.color} />
                    </Group>
                  );
                })
              )}

              <Transformer
                ref={trRef}
                rotateEnabled
                keepRatio={false}
                boundBoxFunc={(oldBox, newBox) =>
                  newBox.width < MIN_SIZE || newBox.height < MIN_SIZE ? oldBox : newBox
                }
              />

              {/* local cursors of peers */}
              {cursors.map((c) => (
                <Circle key={c.clientId} x={c.x} y={c.y} radius={4 * handleScale}
                  fill={c.color} listening={false} />
              ))}
              {cursors.map((c) => (
                <Text key={`${c.clientId}-l`} x={c.x + 8 * handleScale} y={c.y - 6 * handleScale}
                  text={c.name} fontSize={11 * handleScale} fill={c.color} listening={false} />
              ))}
            </Layer>
          </Stage>

          {notice && (
            <div className={'canvas-notice ' + notice.kind} role="status">
              {notice.text}
              <button className="canvas-notice-x" onClick={() => setNotice(null)}
                title="Dismiss">×</button>
            </div>
          )}

          <BrushPanel
            visible={showBrushPanel}
            tool={tool}
            pen={penSettings}
            setPen={updatePen}
            eraser={eraserSettings}
            setEraser={updateEraser}
            recentColors={recentColors}
            onColor={pushRecentColor}
          />

          {/* text edit overlay (HTML, positioned over the click point).
              Document coords are world coords; the overlay lives in screen
              space, so it is placed through the same camera transform. */}
          {editingText && (
            <textarea
              className="text-overlay"
              autoFocus
              style={{
                left: view.x + editingText.x * view.scale,
                top: view.y + editingText.y * view.scale,
                width: editingText.width * view.scale,
                height: editingText.height * view.scale,
                fontSize: editingText.fontSize * view.scale,
                fontFamily: editingText.fontFamily,
                fontWeight: editingText.fontWeight,
                fontStyle: editingText.italic ? 'italic' : 'normal',
                textDecoration: editingText.underline ? 'underline' : 'none',
                textAlign: editingText.align,
                lineHeight: editingText.lineHeight,
                color: editingText.fill
              }}
              value={editingText.value}
              onChange={(e) => {
                // grow the region downward when the content outgrows it, so long
                // text stays visible while editing (Issue 1: vertical auto-expand)
                const el = e.target;
                el.style.height = 'auto';
                const grownScreen = Math.max(editingText.height * view.scale, el.scrollHeight);
                setEditingText({ ...editingText, value: e.target.value,
                  height: grownScreen / view.scale });
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onBlur={commitText}
              onKeyDown={(e) => {
                // Enter adds a newline (multiline). Ctrl/Cmd+Enter or Escape finish.
                if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitText(); }
                if (e.key === 'Escape') { e.preventDefault(); commitText(); }
              }}
            />
          )}
        </div>

        <PropertyPanel
          selection={propertySelection}
          patch={patchSelected}
          onDelete={deleteSelected}
          onDuplicate={duplicateSelected}
          onReorder={reorderSelection}
          onAlignHorizontally={alignHorizontally}
          onAlignVertically={alignVertically}
          onDistributeHorizontally={distributeHorizontally}
          onDistributeVertically={distributeVertically}
        />
      </div>

      <div className="canvas-footer">
        <span className="hint-inline">
          {tool === 'select' ? 'Click to select · drag to move · space+drag to pan · scroll to zoom'
            : tool === 'pen' ? 'Draw freehand · pick a brush, colour and size on the left'
            : tool === 'eraser' ? 'Drag across a stroke to rub out part of it · adjust size on the left'
            : tool === 'text' ? 'Click to place text'
            : tool === 'connector' ? 'Drag between shapes to connect · double-click a connector to add a bend'
            : 'Drag on the canvas to create'}
        </span>
        <div className="zoom-controls">
          <button className="zoom-btn" onClick={() => zoomTo(view.scale / 1.25)} title="Zoom out">−</button>
          <button className="zoom-label" onClick={() => setView({ scale: 1, x: 0, y: 0 })}
            title="Reset view">{Math.round(view.scale * 100)}%</button>
          <button className="zoom-btn" onClick={() => zoomTo(view.scale * 1.25)} title="Zoom in">+</button>
        </div>
        <button className="btn-clear" onClick={exportPNG} title="Download the board as an image">
          Export PNG
        </button>
        <button className="btn-clear" onClick={() => { clearAll(ydoc); setSelectedIds([]); }}>
          Clear all
        </button>
      </div>
    </div>
  );
}

/** The translucent shape shown while dragging to create. */
function PreviewGhost({ preview }) {
  const common = { opacity: 0.5, listening: false };
  if (preview.kind === 'connector') {
    const [a, b] = preview.pts;
    return (
      <Group listening={false}>
        <Line points={[a.x, a.y, b.x, b.y]} stroke="#6366f1" strokeWidth={2}
          dash={[6, 4]} {...common} />
        <Circle x={a.x} y={a.y} radius={3.5} fill="#6366f1" {...common} />
        <Circle x={b.x} y={b.y} radius={3.5} fill="#6366f1" {...common} />
      </Group>
    );
  }
  if (preview.isLine) {
    return <Line x={preview.x} y={preview.y} points={preview.points}
      stroke="#6366f1" strokeWidth={3} dash={[6, 4]} {...common} />;
  }
  return (
    <Rect x={preview.x} y={preview.y}
      width={preview.width} height={preview.height}
      stroke="#6366f1" strokeWidth={1.5} dash={[6, 4]} fill="rgba(99,102,241,0.08)" {...common} />
  );
}

/**
 * Anchor dots + snap ring shown while an endpoint hovers near a shape.
 * The green ring marks the exact point the endpoint will attach to.
 */
function SnapIndicator({ snap, shape, scale }) {
  return (
    <Group listening={false}>
      {shape && anchorPoints(shape).map((a) => (
        <Circle key={a.id} x={a.x} y={a.y} radius={4 * scale}
          fill="#ffffff" stroke="#10b981" strokeWidth={1.5 * scale} />
      ))}
      <Circle x={snap.x} y={snap.y} radius={7 * scale}
        stroke="#10b981" strokeWidth={2 * scale} />
    </Group>
  );
}

/**
 * The edit chrome of a selected connector:
 *   - round handles on both endpoints (drag to re-wire, snaps to shapes)
 *   - square handles on every bend point (drag to move, double-click to delete)
 *   - faint "+" dots on segment midpoints (drag one to grow a new bend)
 */
function ConnectorHandles({
  conn, route, scale,
  onEndpointDrag, onWaypointDrag, onWaypointDelete, onMidpointDrag
}) {
  // While a midpoint is being dragged we FREEZE its rendered position (captured
  // at drag start) so React never re-positions the node Konva is dragging, and
  // hide it — the freshly-born waypoint square underneath is the live feedback.
  const [midDrag, setMidDrag] = useState(null); // { seg, x, y }

  const start = route[0];
  const end = route[route.length - 1];
  const waypoints = [];
  const flat = conn.waypoints || [];
  for (let i = 0; i + 1 < flat.length; i += 2) waypoints.push({ x: flat[i], y: flat[i + 1] });

  const mids = [];
  for (let i = 0; i < route.length - 1; i++) {
    mids.push({
      seg: i,
      x: (route[i].x + route[i + 1].x) / 2,
      y: (route[i].y + route[i + 1].y) / 2
    });
  }

  const endpointHandle = (which, p) => (
    <Circle
      key={which}
      x={p.x} y={p.y}
      radius={6 * scale}
      fill="#ffffff"
      stroke="#6366f1"
      strokeWidth={2 * scale}
      draggable
      onMouseDown={(e) => { e.cancelBubble = true; }}
      onDragMove={(e) => onEndpointDrag(which, e.target, false)}
      onDragEnd={(e) => onEndpointDrag(which, e.target, true)}
    />
  );

  return (
    <Group>
      {mids.map((m) => {
        const dragging = midDrag && midDrag.seg === m.seg;
        return (
          <Circle
            key={`mid-${m.seg}`}
            x={dragging ? midDrag.x : m.x}
            y={dragging ? midDrag.y : m.y}
            radius={4.5 * scale}
            visible={!midDrag || dragging}
            opacity={dragging ? 0 : 1}
            fill="rgba(99,102,241,0.35)"
            stroke="#6366f1"
            strokeWidth={1 * scale}
            draggable
            onMouseDown={(e) => { e.cancelBubble = true; }}
            onDragStart={(e) => {
              setMidDrag({ seg: m.seg, x: m.x, y: m.y });
              onMidpointDrag(m.seg, e.target, 'start');
            }}
            onDragMove={(e) => onMidpointDrag(m.seg, e.target, 'move')}
            onDragEnd={(e) => {
              onMidpointDrag(m.seg, e.target, 'end');
              setMidDrag(null);
              e.target.position({ x: m.x, y: m.y }); // hand position back to React
            }}
          />
        );
      })}
      {waypoints.map((w, i) => (
        <Rect
          key={`wp-${i}`}
          x={w.x - 5 * scale} y={w.y - 5 * scale}
          width={10 * scale} height={10 * scale}
          fill="#ffffff"
          stroke="#6366f1"
          strokeWidth={2 * scale}
          draggable
          onMouseDown={(e) => { e.cancelBubble = true; }}
          onDragMove={(e) => onWaypointDrag(i, {
            x: () => e.target.x() + 5 * scale,
            y: () => e.target.y() + 5 * scale
          }, false)}
          onDragEnd={(e) => onWaypointDrag(i, {
            x: () => e.target.x() + 5 * scale,
            y: () => e.target.y() + 5 * scale
          }, true)}
          onDblClick={(e) => { e.cancelBubble = true; onWaypointDelete(i); }}
          onDblTap={(e) => { e.cancelBubble = true; onWaypointDelete(i); }}
        />
      ))}
      {endpointHandle('start', start)}
      {endpointHandle('end', end)}
    </Group>
  );
}
