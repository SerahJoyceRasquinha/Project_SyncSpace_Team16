import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Stage, Layer, Line, Circle, Text, Rect, Transformer, Group } from 'react-konva';
import * as Y from 'yjs';
import Toolbar from './Toolbar.jsx';
import PropertyPanel from './PropertyPanel.jsx';
import ShapeNode from '../canvas/ShapeNode.jsx';
import {
  shapesArray, readShape, addShape, updateShape, updateMany,
  removeShapes, clearAll, bringToFront
} from '../canvas/shapeDoc.js';
import { isDraggableLine, isTextType, isCentered } from '../canvas/shapes.jsx';

const MIN_SIZE = 4;

/**
 * The collaborative whiteboard.
 *
 * State model (unchanged storage location — still ydoc.getArray('shapes')):
 *   - Freehand strokes from Milestone 0 are read as-is and rendered as 'path'.
 *   - New objects are flat records with a `type`, all in the SAME array.
 *
 * Live sync: yshapes.observeDeep() re-snapshots on ANY change, local or remote,
 * so every client re-renders from one source of truth. Selection and remote
 * cursors travel through awareness, exactly as before.
 */
export default function Canvas({ ydoc, awareness }) {
  const [shapes, setShapes] = useState([]);
  const [cursors, setCursors] = useState([]);
  const [remoteSelections, setRemoteSelections] = useState([]);
  const [tool, setTool] = useState('select');
  const [pendingShape, setPendingShape] = useState(null); // { type } chosen from Shapes menu
  const [selectedIds, setSelectedIds] = useState([]);
  const [preview, setPreview] = useState(null); // live drag-to-create ghost
  const [editingText, setEditingText] = useState(null); // { id?, x, y, value, ... }
  const [size, setSize] = useState({ width: 800, height: 600 });

  const yshapes = useMemo(() => shapesArray(ydoc), [ydoc]);
  const stageRef = useRef(null);
  const trRef = useRef(null);
  const containerRef = useRef(null);
  const nodeRefs = useRef(new Map());
  const drawing = useRef(null); // in-progress freehand Y.Array or drag origin

  const me = awareness.getLocalState()?.user || { name: 'anon', color: '#6366f1' };

  // ---- Undo manager: scoped to the shapes array, local-origin only ------
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
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return;
        if (state.cursor && state.user) cs.push({ clientId, ...state.cursor, ...state.user });
        if (state.selection?.length && state.user) {
          sel.push({ clientId, ids: state.selection, ...state.user });
        }
      });
      setCursors(cs);
      setRemoteSelections(sel);
    };
    awareness.on('change', onChange);
    onChange();
    return () => awareness.off('change', onChange);
  }, [awareness, ydoc]);

  // ---- keep the Transformer attached to the current selection ----------
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const nodes = selectedIds
      .map((id) => nodeRefs.current.get(id))
      .filter(Boolean);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, shapes]);

  // publish my selection so peers can see it
  useEffect(() => {
    awareness.setLocalStateField('selection', selectedIds);
  }, [selectedIds, awareness]);

  const selectedShape = selectedIds.length === 1
    ? shapes.find((s) => s.id === selectedIds[0])
    : null;

  // ---------------------------------------------------------------- helpers
  const stagePointer = () => stageRef.current.getPointerPosition();

  const patchSelected = useCallback((patch) => {
    if (selectedIds.length === 1) updateShape(ydoc, selectedIds[0], patch);
    else if (selectedIds.length > 1) updateMany(ydoc, selectedIds, patch);
  }, [selectedIds, ydoc]);

  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    removeShapes(ydoc, selectedIds);
    setSelectedIds([]);
  }, [selectedIds, ydoc]);

  // ---------------------------------------------------------------- mouse
  const onStageMouseDown = (e) => {
    const stage = e.target.getStage();
    const clickedEmpty = e.target === stage;
    const pos = stage.getPointerPosition();

    // SELECT tool: click empty space clears selection
    if (tool === 'select' && !pendingShape) {
      if (clickedEmpty) setSelectedIds([]);
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

    // PEN tool: begin a freehand stroke (Milestone 0 behaviour preserved)
    if (tool === 'pen') {
      const points = new Y.Array();
      points.push([pos.x, pos.y]);
      const map = new Y.Map();
      ydoc.transact(() => {
        map.set('id', `${ydoc.clientID}-${Date.now()}`);
        map.set('type', 'path');
        map.set('stroke', me.color || '#111827');
        map.set('strokeWidth', 3);
        map.set('points', points);
        map.set('creator', me.name);
        map.set('zIndex', yshapes.length);
        yshapes.push([map]);
      });
      drawing.current = { kind: 'pen', points };
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
    const pos = stagePointer();
    awareness.setLocalStateField('cursor', { x: pos.x, y: pos.y });

    const d = drawing.current;
    if (!d) return;

    if (d.kind === 'pen') {
      d.points.push([pos.x, pos.y]);
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

    if (d.kind === 'pen') return; // stroke already committed live

    // TEXT: the drag defined a region. Open the editor inside it and KEEP the
    // text tool active — creation happens on commit, not here.
    if (d.kind === 'text') {
      const pos = stagePointer();
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
      const pos = stagePointer();
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

  // ---------------------------------------------------------------- select
  const onSelectShape = (e, id) => {
    if (tool !== 'select') return;
    e.cancelBubble = true;
    const shape = shapes.find((s) => s.id === id);
    if (shape?.locked) return;
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
  const onDragEnd = (e, shape) => {
    const node = e.target;
    let x = node.x();
    let y = node.y();
    if (isCentered(shape.type)) {
      x -= (shape.width || 0) / 2;
      y -= (shape.height || 0) / 2;
    }
    updateShape(ydoc, shape.id, { x, y });
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

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (editingText) return; // typing in the overlay
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) {
        e.preventDefault();
        deleteSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoMgr.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        undoMgr.redo();
      } else if (e.key === 'Escape') {
        setSelectedIds([]); setPendingShape(null); setTool('select');
      } else if (!e.ctrlKey && !e.metaKey) {
        const map = { v: 'select', p: 'pen', r: 'rect', t: 'text', l: 'line' };
        if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, editingText, deleteSelected, undoMgr]);

  const cursorStyle =
    tool === 'select' ? 'default'
    : tool === 'text' ? 'text'
    : 'crosshair';

  const stageScale = { x: 1, y: 1 };

  return (
    <div className="pane whiteboard-pane">
      <div className="pane-header column">
        <Toolbar
          tool={pendingShape ? 'shape' : tool}
          setTool={(t) => { setTool(t); setPendingShape(null); }}
          onShape={(s) => { setPendingShape(s); setTool('shape'); }}
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
            scaleX={stageScale.x}
            scaleY={stageScale.y}
            onMouseDown={onStageMouseDown}
            onMouseMove={onStageMouseMove}
            onMouseUp={onStageMouseUp}
            onMouseLeave={onStageMouseUp}
            className="stage"
          >
            <Layer>
              {shapes.map((s) => (
                <ShapeNode
                  key={s.id}
                  shape={s}
                  ref={(node) => {
                    if (node) nodeRefs.current.set(s.id, node);
                    else nodeRefs.current.delete(s.id);
                  }}
                  draggable={tool === 'select' && !s.locked}
                  onSelect={(e) => onSelectShape(e, s.id)}
                  onDragEnd={(e) => onDragEnd(e, s)}
                  onTransformEnd={(e) => onTransformEnd(e, s)}
                  onDblClick={() => onShapeDblClick(s)}
                />
              ))}

              {/* live drag-to-create preview */}
              {preview && <PreviewGhost preview={preview} />}

              {/* remote selection boxes (awareness) */}
              {remoteSelections.map((sel) =>
                sel.ids.map((id) => {
                  const node = nodeRefs.current.get(id);
                  if (!node) return null;
                  const box = node.getClientRect();
                  return (
                    <Group key={`${sel.clientId}-${id}`} listening={false}>
                      <Rect x={box.x} y={box.y} width={box.width} height={box.height}
                        stroke={sel.color} strokeWidth={1.5} dash={[4, 4]} />
                      <Text x={box.x} y={box.y - 16} text={sel.name}
                        fontSize={11} fill={sel.color} />
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
                <Circle key={c.clientId} x={c.x} y={c.y} radius={4} fill={c.color} listening={false} />
              ))}
              {cursors.map((c) => (
                <Text key={`${c.clientId}-l`} x={c.x + 8} y={c.y - 6}
                  text={c.name} fontSize={11} fill={c.color} listening={false} />
              ))}
            </Layer>
          </Stage>

          {/* text edit overlay (HTML, positioned over the click point) */}
          {editingText && (
            <textarea
              className="text-overlay"
              autoFocus
              style={{
                left: editingText.x,
                top: editingText.y,
                width: editingText.width,
                height: editingText.height,
                fontSize: editingText.fontSize,
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
                const grown = Math.max(editingText.height, el.scrollHeight);
                setEditingText({ ...editingText, value: e.target.value, height: grown });
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

        <PropertyPanel selected={selectedShape} patch={patchSelected} onDelete={deleteSelected} />
      </div>

      <div className="canvas-footer">
        <span className="hint-inline">
          {tool === 'select' ? 'Click to select · drag to move · double-click text to edit'
            : tool === 'pen' ? 'Draw freehand'
            : tool === 'text' ? 'Click to place text'
            : 'Drag on the canvas to create'}
        </span>
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
