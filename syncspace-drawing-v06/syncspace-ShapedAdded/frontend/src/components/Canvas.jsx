import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Stage, Layer, Line, Circle, Text, Rect, Transformer, Group } from 'react-konva';
import * as Y from 'yjs';
import Toolbar from './Toolbar.jsx';
import PropertyPanel from './PropertyPanel.jsx';
import BrushPanel from './BrushPanel.jsx';
import ShapeNode, { PreviewStroke } from '../canvas/ShapeNode.jsx';
import ConnectorNode from '../canvas/ConnectorNode.jsx';
import {
  shapesArray, readShape, addShape, updateShape, updateShapeLive, updateMany,
  removeShapes, clearAll, bringToFront, duplicateShapes, reorderShape,
  commitStroke, applyErase
} from '../canvas/shapeDoc.js';
import {
  isDraggableLine, isTextType, isCentered, isConnector, CONNECTOR_DEFAULTS
} from '../canvas/shapes.jsx';
import {
  DEFAULT_PEN_SETTINGS, DEFAULT_ERASER_SETTINGS,
  markErased, surviveRuns, pointsBounds, simplify
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
  const [preview, setPreview] = useState(null); // live drag-to-create ghost
  const [editingText, setEditingText] = useState(null); // { id?, x, y, value, ... }
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 }); // local camera
  const [spaceDown, setSpaceDown] = useState(false);
  const [snapHint, setSnapHint] = useState(null); // { shapeId, anchor, x, y } while wiring
  const [livePos, setLivePos] = useState(() => new Map()); // id -> {x,y} mid-drag
  const [connOverride, setConnOverride] = useState(null); // { id, patch } mid handle-drag

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
      const list = yshapes.toArray().map((m) => {
        const s = readShape(m);
        // legacy freehand: had { id, color, points } and no type
        if (!s.type) {
          s.type = 'path';
          s.stroke = s.stroke || s.color || '#111827';
        }
        return s;
      });
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
      return { conn: c, route: connectorRoute(c, shapesById) };
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
      .filter(Boolean);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, shapes]);

  // publish my selection so peers can see it
  useEffect(() => {
    awareness.setLocalStateField('selection', selectedIds);
  }, [selectedIds, awareness]);

  // drop the eraser ring the moment the tool changes away from the eraser
  useEffect(() => {
    if (tool !== 'eraser') setEraserPos(null);
  }, [tool]);

  const selectedShape = selectedIds.length === 1
    ? shapes.find((s) => s.id === selectedIds[0])
    : null;

  // ---------------------------------------------------------------- helpers
  /** Pointer position in WORLD coordinates (accounts for zoom + pan). */
  const worldPointer = () => stageRef.current.getRelativePointerPosition();

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

  const startConnectorTool = useCallback((preset) => {
    setConnPreset(preset || {});
    setTool('connector');
    setPendingShape(null);
  }, []);

  /** Build the endpoint record for a snap result (or a free point). */
  const endpointFor = (snap, point) =>
    snap
      ? { shapeId: snap.shapeId, anchor: snap.anchor, x: snap.x, y: snap.y }
      : { x: point.x, y: point.y };

  // ---- image paste / drop ----------------------------------------------
  // Paste (Ctrl+V) an image from the clipboard, or drag-drop an image file
  // onto the canvas. The image is converted to a base64 data URL and stored
  // in the Yjs doc so it syncs to all collaborators.
  const addImageShape = useCallback((dataUrl, pos) => {
    const img = new window.Image();
    img.onload = () => {
      const w = Math.min(img.naturalWidth, 600);
      const h = Math.min(img.naturalHeight, 400);
      addShape(ydoc, me, {
        type: 'image',
        src: dataUrl,
        x: pos.x - w / 2,
        y: pos.y - h / 2,
        width: w,
        height: h,
        fill: 'transparent',
        stroke: 'transparent',
        strokeWidth: 0
      });
    };
    img.src = dataUrl;
  }, [ydoc, me]);

  useEffect(() => {
    const stage = stageRef.current?.getStage();
    if (!stage) return;

    // Paste from clipboard
    const onPaste = (e) => {
      if (editingText) return; // don't intercept when editing text
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = (ev) => {
            const pos = worldPointer();
            addImageShape(ev.target.result, pos);
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [editingText, addImageShape]);

  // Drag-drop images onto the stage container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onDragOver = (e) => {
      if (e.dataTransfer?.types?.includes('Files') ||
          e.dataTransfer?.types?.includes('text/html')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const onDrop = (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files?.length) {
        const file = files[0];
        if (file.type.startsWith('image/')) {
          const rect = container.getBoundingClientRect();
          const x = (e.clientX - rect.left - view.x) / view.scale;
          const y = (e.clientY - rect.top - view.y) / view.scale;
          const reader = new FileReader();
          reader.onload = (ev) => addImageShape(ev.target.result, { x, y });
          reader.readAsDataURL(file);
        }
        return;
      }
      // Handle pasted HTML (e.g., drag an image from a browser tab)
      const html = e.dataTransfer?.getData('text/html');
      if (html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const img = tmp.querySelector('img');
        if (img?.src) {
          const rect = container.getBoundingClientRect();
          const x = (e.clientX - rect.left - view.x) / view.scale;
          const y = (e.clientY - rect.top - view.y) / view.scale;
          addImageShape(img.src, { x, y });
        }
      }
    };

    container.addEventListener('dragover', onDragOver);
    container.addEventListener('drop', onDrop);
    return () => {
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('drop', onDrop);
    };
  }, [view, addImageShape]);

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
   * Stamp the eraser along the segment from -> to (sampled so a fast drag leaves
   * no gaps), marking erased vertices per stroke in the live session mask. The
   * document is NOT written here — this is a local preview; the split is
   * committed atomically on pointer-up (see commitErase).
   */
  const eraseAlong = useCallback((from, to) => {
    const sess = eraseRef.current;
    if (!sess) return;
    const r = eraserSettings.size;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.6)));
    const padMinX = Math.min(from.x, to.x) - r, padMaxX = Math.max(from.x, to.x) + r;
    const padMinY = Math.min(from.y, to.y) - r, padMaxY = Math.max(from.y, to.y) + r;
    let changed = false;
    for (const s of shapes) {
      if (s.type !== 'path' || s.locked || !s.points?.length) continue;
      const b = pathBounds.get(s.id);
      if (b && (b.maxX < padMinX || b.minX > padMaxX || b.maxY < padMinY || b.minY > padMaxY)) continue;
      let set = sess.mask.get(s.id);
      const before = set ? set.size : 0;
      if (!set) set = new Set();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        markErased(s.points, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, r, set);
      }
      if (set.size > before) { sess.mask.set(s.id, set); changed = true; }
    }
    if (changed) setEraseMask(new Map(sess.mask));
  }, [eraserSettings, shapes, pathBounds]);

  /** Commit the whole eraser drag as one undo step (delete originals, add runs). */
  const commitErase = useCallback(() => {
    const sess = eraseRef.current;
    eraseRef.current = null;
    setEraseMask(null);
    awareness.setLocalStateField('eraser', null);
    if (!sess || !sess.mask.size) return;
    const edits = [];
    for (const [id, set] of sess.mask) {
      const s = shapes.find((x) => x.id === id);
      if (!s?.points) continue;
      edits.push({ id, runs: surviveRuns(s.points, set) });
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
      return;
    }

    // ERASER tool: begin a partial-erase drag (preview only until pointer-up).
    if (tool === 'eraser') {
      eraseRef.current = { mask: new Map(), last: { ...pos } };
      drawing.current = { kind: 'erase' };
      setEraserPos(pos);
      awareness.setLocalStateField('eraser', { x: pos.x, y: pos.y, size: eraserSettings.size });
      eraseAlong(pos, pos);
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
    const pointer = stage.getPointerPosition();
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
    bringToFront(ydoc, id);
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
    const { conn: c, route } = routeOf(conn);
    const pos = worldPointer();
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
        setSelectedIds([]); setPendingShape(null); setConnPreset(null); setTool('select');
      } else if (!ctrl) {
        const map = { v: 'select', p: 'pen', e: 'eraser', r: 'rect', t: 'text', l: 'line' };
        const k = e.key.toLowerCase();
        if (map[k]) { setTool(map[k]); setPendingShape(null); setConnPreset(null); }
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
      copySelected, pasteClipboard, duplicateSelected, startConnectorTool]);

  const cursorStyle =
    panning ? 'grab'
    : tool === 'select' ? 'default'
    : tool === 'text' ? 'text'
    : tool === 'eraser' ? 'none'
    : 'crosshair';

  const handleScale = 1 / view.scale; // keep handles a constant on-screen size

  const selectedConnector =
    selectedShape && isConnector(selectedShape.type) ? selectedShape : null;

  return (
    <div className="pane whiteboard-pane">
      <div className="pane-header column">
        <Toolbar
          tool={pendingShape ? 'shape' : tool}
          setTool={(t) => { setTool(t); setPendingShape(null); setConnPreset(null); }}
          onShape={(s) => {
            if (s.type === 'connector') startConnectorTool(s.preset || {});
            else { setPendingShape(s); setTool('shape'); }
          }}
          onConnector={startConnectorTool}
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
                  const runs = surviveRuns(s.points, eraseMask.get(s.id));
                  return (
                    <Group key={s.id} listening={false}>
                      {runs.map((r, i) => (
                        <PreviewStroke key={i} shape={{ ...s, points: r }} />
                      ))}
                    </Group>
                  );
                }
                if (isConnector(s.type)) {
                  const { conn, route } = routeOf(s);
                  return (
                    <ConnectorNode
                      key={s.id}
                      conn={conn}
                      pts={displayPoints(conn, route)}
                      ref={(node) => {
                        if (node) nodeRefs.current.set(s.id, node);
                        else nodeRefs.current.delete(s.id);
                      }}
                      onSelect={(e) => onSelectShape(e, s.id)}
                      onDblClick={() => onConnectorDblClick(s)}
                    />
                  );
                }
                return (
                  <ShapeNode
                    key={s.id}
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

          <BrushPanel
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
          selected={selectedShape}
          patch={patchSelected}
          onDelete={deleteSelected}
          onDuplicate={duplicateSelected}
          onReorder={(dir) => selectedShape && reorderShape(ydoc, selectedShape.id, dir)}
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
