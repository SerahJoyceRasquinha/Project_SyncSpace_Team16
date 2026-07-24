import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer } from 'react-konva';
import ShapeNode from '../canvas/ShapeNode.jsx';
import ConnectorNode from '../canvas/ConnectorNode.jsx';
import { ShapeErrorBoundary } from './ErrorBoundary.jsx';
import { normalizeShapes } from '../canvas/normalize.js';
import { shapesArray, readShape } from '../canvas/shapeDoc.js';
import { isConnector } from '../canvas/shapes.jsx';
import { connectorRoute, displayPoints } from '../canvas/connectors.js';
import { ReplayCache, frameBounds } from '../canvas/replay.js';

/**
 * REPLAY — the last item on the Axlero plan (Week 4).
 *
 * The idea in one sentence: the live document is not rewound, a SECOND one is
 * built. We take the room's update log, create an empty Y.Doc, and apply the
 * first N updates into it. Because a Yjs update is a self-contained, causally
 * ordered delta, applying a PREFIX of the log reconstructs exactly the document
 * as it stood after update N — not an approximation of it.
 *
 * Two consequences worth stating out loud in a review:
 *
 *  1. Replay is READ-ONLY BY CONSTRUCTION, not by being careful. The scrub doc
 *     is a local object that no socket writes to and that never emits, so there
 *     is no code path by which scrubbing could touch the live board. Nothing
 *     had to be locked or guarded to make that true.
 *
 *  2. It reuses the SAME renderer. normalizeShapes -> ShapeNode / ConnectorNode
 *     is the pipeline the live canvas uses, so history is drawn by the code
 *     under test rather than by a second implementation that could drift. A
 *     connector still re-routes against the shapes as they were at that moment,
 *     because routing is derived at render time from whatever doc it is handed.
 *
 * The one piece of real engineering here is the cache. Rebuilding from update 0
 * on every slider tick is O(N) per frame and makes playback stutter on a long
 * session. Yjs updates only move forward, so scrubbing FORWARD applies just the
 * delta; only scrubbing BACKWARD has to start over. That makes playback O(1)
 * amortised per frame, which is the direction that actually needs to be smooth.
 */

const SPEEDS = [0.5, 1, 2, 4];

const stamp = (ms) => {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch {
    return '';
  }
};

export default function ReplaySlider({ workspaceId, fetchLogs, onClose }) {
  const [entries, setEntries] = useState([]);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // index = how many updates have been applied. 0 = the empty board.
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ width: 800, height: 520 });

  const stageBoxRef = useRef(null);

  // The parent rebuilds its `replay` object every render, so fetchLogs has a
  // new identity each time. Pinning it in a ref keeps the load effect below a
  // genuine mount-only effect — depending on the prop directly would re-fetch
  // on every parent render and spin forever. The component is mounted fresh
  // each time replay is opened, so "once on mount" is exactly the right scope.
  const fetchLogsRef = useRef(fetchLogs);
  fetchLogsRef.current = fetchLogs;

  // ---- the scrub document ---------------------------------------------
  // All reconstruction lives in canvas/replay.js so it can be proven headlessly;
  // this component only decides WHICH frame to show and draws it.
  const cacheRef = useRef(null);
  const lastGoodRef = useRef({ shapes: [], code: '' });

  // ---- load the log ----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchLogsRef.current()
      .then((res) => {
        if (cancelled) return;
        if (!res?.ok) {
          setError(res?.message || 'Could not load the session history.');
          setEntries([]);
        } else {
          const list = Array.isArray(res.entries) ? res.entries : [];
          setEntries(list);
          setCapped(Boolean(res.capped));
          setIndex(list.length); // open on "now", then scrub back
          cacheRef.current = new ReplayCache(list);
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the session history.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- size the stage to its container ---------------------------------
  useEffect(() => {
    const el = stageBoxRef.current;
    if (!el) return;
    const measure = () =>
      setSize({
        width: Math.max(320, el.clientWidth),
        height: Math.max(240, el.clientHeight)
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // ---- playback --------------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    if (index >= entries.length) { setPlaying(false); return; }
    const id = setTimeout(() => setIndex((i) => Math.min(entries.length, i + 1)), 140 / speed);
    return () => clearTimeout(id);
  }, [playing, index, entries.length, speed]);

  // ---- the frame at the current index ----------------------------------
  const frame = useMemo(() => {
    if (!entries.length) return { shapes: [], code: '' };
    try {
      const doc = cacheRef.current ? cacheRef.current.at(index) : null;
      if (!doc) return lastGoodRef.current;
      const shapes = normalizeShapes(shapesArray(doc).toArray().map(readShape));
      shapes.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      const next = { shapes, code: doc.getText('monaco').toString() };
      lastGoodRef.current = next;
      return next;
    } catch (err) {
      // Same contract as the live canvas: reading the document must never be
      // able to kill the component. Hold the last frame that did read cleanly.
      console.error('[SyncSpace] replay: could not read the reconstructed doc:', err);
      return lastGoodRef.current;
    }
  }, [entries, index]);

  const shapesById = useMemo(() => {
    const m = new Map();
    for (const s of frame.shapes) m.set(s.id, s);
    return m;
  }, [frame.shapes]);

  /** Identical fallback logic to Canvas.routeOf, minus the live drag overrides. */
  const routeOf = useCallback(
    (conn) => {
      try {
        const route = connectorRoute(conn, shapesById);
        if (Array.isArray(route) && route.length >= 2 &&
            route.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) {
          return route;
        }
      } catch (err) {
        console.error('[SyncSpace] replay: connector routing failed for', conn.id, err);
      }
      return [
        { x: conn.start?.x || 0, y: conn.start?.y || 0 },
        { x: conn.end?.x || 0, y: conn.end?.y || 0 }
      ];
    },
    [shapesById]
  );

  const current = index > 0 ? entries[index - 1] : null;

  const fitToContent = useCallback(() => {
    const b = frameBounds(frame.shapes);
    if (!b || b.width <= 0 || b.height <= 0) {
      setView({ scale: 1, x: 0, y: 0 });
      return;
    }
    const pad = 40;
    const scale = Math.min(
      3,
      Math.max(0.1, Math.min(
        (size.width - pad * 2) / b.width,
        (size.height - pad * 2) / b.height
      ))
    );
    setView({
      scale,
      x: (size.width - b.width * scale) / 2 - b.minX * scale,
      y: (size.height - b.height * scale) / 2 - b.minY * scale
    });
  }, [frame.shapes, size.width, size.height]);

  const step = (delta) =>
    setIndex((i) => Math.max(0, Math.min(entries.length, i + delta)));

  // Esc closes, arrows step — a scrubber people can drive from the keyboard.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); step(1); }
      else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, entries.length]);

  return (
    <div className="replay-overlay" role="dialog" aria-label="Session replay">
      <div className="replay-window">
        <header className="replay-head">
          <div className="replay-title">
            <strong>Session replay</strong>
            <code className="ws-id">{workspaceId}</code>
            {capped && (
              <span className="replay-chip warn" title="Recording stopped at the history limit">
                history full
              </span>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">&#10005;</button>
        </header>

        {loading ? (
          <div className="replay-empty">
            <div className="spinner" />
            <p className="empty">Loading session history…</p>
          </div>
        ) : error ? (
          <div className="replay-empty">
            <div className="alert error">{error}</div>
          </div>
        ) : entries.length === 0 ? (
          <div className="replay-empty">
            <p className="empty">
              Nothing has been recorded in this workspace yet. Draw something on the
              board or type in the editor, then open replay again.
            </p>
          </div>
        ) : (
          <>
            <div className="replay-body">
              <div className="replay-stage" ref={stageBoxRef}>
                <Stage
                  width={size.width}
                  height={size.height}
                  scaleX={view.scale}
                  scaleY={view.scale}
                  x={view.x}
                  y={view.y}
                  listening={false}
                  className="stage"
                >
                  <Layer listening={false}>
                    {frame.shapes.map((s) => {
                      if (isConnector(s.type)) {
                        return (
                          <ShapeErrorBoundary key={s.id} shapeId={s.id} shapeType={s.type} resetKey={s}>
                            <ConnectorNode conn={s} pts={displayPoints(s, routeOf(s))} />
                          </ShapeErrorBoundary>
                        );
                      }
                      return (
                        <ShapeErrorBoundary key={s.id} shapeId={s.id} shapeType={s.type} resetKey={s}>
                          <ShapeNode shape={s} draggable={false} />
                        </ShapeErrorBoundary>
                      );
                    })}
                  </Layer>
                </Stage>

                <div className="replay-zoom">
                  <button className="zoom-btn" title="Zoom out"
                    onClick={() => setView((v) => ({ ...v, scale: Math.max(0.1, v.scale / 1.25) }))}>−</button>
                  <button className="zoom-label" title="Reset view"
                    onClick={() => setView({ scale: 1, x: 0, y: 0 })}>
                    {Math.round(view.scale * 100)}%
                  </button>
                  <button className="zoom-btn" title="Zoom in"
                    onClick={() => setView((v) => ({ ...v, scale: Math.min(3, v.scale * 1.25) }))}>+</button>
                  <button className="zoom-btn wide" title="Fit the board into view"
                    onClick={fitToContent}>Fit</button>
                </div>
              </div>

              <aside className="replay-side">
                <h3>Code at this point</h3>
                <pre className="replay-code">{frame.code || '(the editor was empty)'}</pre>
              </aside>
            </div>

            <footer className="replay-controls">
              <button className="replay-btn" onClick={() => { setPlaying(false); setIndex(0); }}
                title="Jump to the beginning">⏮</button>
              <button className="replay-btn" onClick={() => { setPlaying(false); step(-1); }}
                title="Step back (←)">◀</button>
              <button className="replay-btn primary" onClick={() => setPlaying((p) => !p)}
                title="Play / pause (Space)">{playing ? '❚❚' : '▶'}</button>
              <button className="replay-btn" onClick={() => { setPlaying(false); step(1); }}
                title="Step forward (→)">▶|</button>
              <button className="replay-btn" onClick={() => { setPlaying(false); setIndex(entries.length); }}
                title="Jump to the latest state">⏭</button>

              <input
                className="replay-range"
                type="range"
                min={0}
                max={entries.length}
                value={index}
                onChange={(e) => { setPlaying(false); setIndex(Number(e.target.value)); }}
                aria-label="Scrub through session history"
              />

              <span className="replay-count">{index} / {entries.length}</span>

              <select className="replay-speed" value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))} title="Playback speed">
                {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
            </footer>

            <div className="replay-meta">
              {index === 0
                ? 'The board as it was before the first recorded change.'
                : (
                  <>
                    update <strong>#{current?.seq ?? index - 1}</strong>
                    {current?.username ? <> by <strong>{current.username}</strong></> : null}
                    {current?.timestamp ? <> at {stamp(current.timestamp)}</> : null}
                    {' · '}{frame.shapes.length} object{frame.shapes.length === 1 ? '' : 's'} on the board
                  </>
                )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
