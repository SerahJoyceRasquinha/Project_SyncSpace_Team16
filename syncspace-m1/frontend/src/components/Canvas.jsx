import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Line, Circle, Text } from 'react-konva';
import * as Y from 'yjs';

const COLORS = ['#111827', '#ef4444', '#3b82f6', '#10b981', '#f59e0b'];

/**
 * Whiteboard state lives in a Y.Array called "shapes".
 * Each shape is a Y.Map { id, color, points: Y.Array<number> }.
 *
 * Why a Y.Array of numbers for the points instead of a plain JS array?
 * Because two people drawing at once then produce APPENDS, which Yjs
 * merges cleanly - no last-write-wins overwrite. That's the CRDT payoff.
 */
export default function Canvas({ ydoc, awareness, width = 640, height = 520 }) {
  const [shapes, setShapes] = useState([]);
  const [cursors, setCursors] = useState([]);
  const [color, setColor] = useState(COLORS[0]);
  const drawingRef = useRef(null);
  const yshapes = ydoc.getArray('shapes');

  // Re-render whenever anything in the shapes tree changes (local OR remote).
  useEffect(() => {
    const snapshot = () => {
      setShapes(
        yshapes.toArray().map((m) => ({
          id: m.get('id'),
          color: m.get('color'),
          points: m.get('points').toArray()
        }))
      );
    };
    snapshot();
    yshapes.observeDeep(snapshot);
    return () => yshapes.unobserveDeep(snapshot);
  }, [ydoc]);

  // Other people's cursors come from awareness, not from the document.
  useEffect(() => {
    const onChange = () => {
      const list = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return;
        if (state.cursor && state.user) {
          list.push({ clientId, ...state.cursor, ...state.user });
        }
      });
      setCursors(list);
    };
    awareness.on('change', onChange);
    return () => awareness.off('change', onChange);
  }, [awareness, ydoc]);

  const handleDown = (e) => {
    const pos = e.target.getStage().getPointerPosition();
    const shape = new Y.Map();
    const points = new Y.Array();
    points.push([pos.x, pos.y]);
    ydoc.transact(() => {
      shape.set('id', `${ydoc.clientID}-${Date.now()}`);
      shape.set('color', color);
      shape.set('points', points);
      yshapes.push([shape]);
    });
    drawingRef.current = points;
  };

  const handleMove = (e) => {
    const pos = e.target.getStage().getPointerPosition();
    awareness.setLocalStateField('cursor', { x: pos.x, y: pos.y });
    if (!drawingRef.current) return;
    drawingRef.current.push([pos.x, pos.y]);
  };

  const handleUp = () => {
    drawingRef.current = null;
  };

  const clearAll = () => {
    ydoc.transact(() => yshapes.delete(0, yshapes.length));
  };

  return (
    <div className="pane">
      <div className="pane-header">
        <span>Whiteboard</span>
        <div className="tools">
          {COLORS.map((c) => (
            <button
              key={c}
              className={'swatch' + (c === color ? ' active' : '')}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
            />
          ))}
          <button className="btn-clear" onClick={clearAll}>Clear</button>
        </div>
      </div>

      <Stage
        width={width}
        height={height}
        onMouseDown={handleDown}
        onMouseMove={handleMove}
        onMouseUp={handleUp}
        onMouseLeave={handleUp}
        className="stage"
      >
        <Layer>
          {shapes.map((s) => (
            <Line
              key={s.id}
              points={s.points}
              stroke={s.color}
              strokeWidth={3}
              tension={0.4}
              lineCap="round"
              lineJoin="round"
            />
          ))}
          {cursors.map((c) => (
            <Circle key={c.clientId} x={c.x} y={c.y} radius={5} fill={c.color} />
          ))}
          {cursors.map((c) => (
            <Text
              key={`${c.clientId}-label`}
              x={c.x + 9}
              y={c.y - 6}
              text={c.name}
              fontSize={12}
              fill={c.color}
            />
          ))}
        </Layer>
      </Stage>
    </div>
  );
}
