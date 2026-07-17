import { useState, useRef, useEffect } from 'react';
import { SHAPE_GROUPS, shapeIcon } from '../canvas/shapes.jsx';

/**
 * The top toolbar. Lives in the whiteboard pane header, alongside the existing
 * colour swatches — NOT a floating menu, NOT a sidebar, exactly as specified.
 * The Shapes button opens a grouped grid; everything else is a direct tool.
 */
export default function Toolbar({ tool, setTool, onShape, onConnector, onUndo, onRedo, canUndo, canRedo, onDelete, hasSelection }) {
  const [shapesOpen, setShapesOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!shapesOpen) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShapesOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [shapesOpen]);

  const ToolBtn = ({ id, label, children }) => (
    <button
      className={'tool-btn' + (tool === id ? ' active' : '')}
      onClick={() => setTool(id)}
      title={label}
    >
      {children}
    </button>
  );

  const svg = (child) => (
    <svg viewBox="0 0 20 20" width="18" height="18">{child}</svg>
  );

  return (
    <div className="toolbar">
      <ToolBtn id="select" label="Select (V)">
        {svg(<path d="M4 3 L4 15 L8 11 L11 17 L13 16 L10 10 L15 10 Z" fill="currentColor" />)}
      </ToolBtn>

      <ToolBtn id="pen" label="Pen — freehand (P)">
        {svg(<path d="M3 17 L5 12 L14 3 L17 6 L8 15 Z" fill="none" stroke="currentColor" strokeWidth="1.6" />)}
      </ToolBtn>

      <ToolBtn id="rect" label="Rectangle (R)">
        {svg(<rect x="3" y="5" width="14" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" />)}
      </ToolBtn>

      <ToolBtn id="text" label="Text (T)">
        {svg(<>
          <path d="M4 5 H16" stroke="currentColor" strokeWidth="1.8" />
          <path d="M10 5 V16" stroke="currentColor" strokeWidth="1.8" />
        </>)}
      </ToolBtn>

      <ToolBtn id="line" label="Line (L)">
        {svg(<line x1="3" y1="16" x2="17" y2="4" stroke="currentColor" strokeWidth="1.8" />)}
      </ToolBtn>

      {/* Connector: elbow-routed smart connector; Arrow: straight with a head.
          Both create the SAME 'connector' record — they only differ in preset. */}
      <button
        className={'tool-btn' + (tool === 'connector' ? ' active' : '')}
        onClick={() => onConnector({ routing: 'elbow' })}
        title="Connector — drag between shapes (C)"
      >
        {svg(<>
          <path d="M4 15 H10 V5 H14" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <rect x="2" y="13" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <polygon points="17.5,5 13.6,3.6 13.6,6.4" fill="currentColor" />
        </>)}
      </button>
      <button
        className="tool-btn"
        onClick={() => onConnector({})}
        title="Arrow (A)"
      >
        {svg(<>
          <line x1="3" y1="16" x2="14" y2="5.5" stroke="currentColor" strokeWidth="1.8" />
          <polygon points="17,4 12.4,5 15.8,8.6" fill="currentColor" />
        </>)}
      </button>

      {/* -------- Shapes dropdown -------- */}
      <div className="shapes-wrap" ref={menuRef}>
        <button
          className={'tool-btn wide' + (shapesOpen ? ' active' : '')}
          onClick={() => setShapesOpen((o) => !o)}
          title="Shapes"
        >
          {svg(<>
            <rect x="2" y="3" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="13.5" cy="6.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <polygon points="10,18 6,11 14,11" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </>)}
          <span className="caret">▾</span>
        </button>

        {shapesOpen && (
          <div className="shapes-menu">
            {SHAPE_GROUPS.map((group) => (
              <div key={group.label} className="shapes-group">
                <div className="shapes-group-label">{group.label}</div>
                <div className="shapes-grid">
                  {group.shapes.map((s) => (
                    <button
                      key={s.name}
                      className="shape-cell"
                      title={s.name}
                      onClick={() => {
                        onShape(s);
                        setShapesOpen(false);
                      }}
                    >
                      <svg viewBox="0 0 20 20" width="22" height="22">{shapeIcon(s.type, s.name)}</svg>
                      <span>{s.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="toolbar-sep" />

      <button className="tool-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        {svg(<path d="M7 6 L3 10 L7 14 M3 10 H12 A4 4 0 0 1 12 18 H9" fill="none" stroke="currentColor" strokeWidth="1.6" />)}
      </button>
      <button className="tool-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
        {svg(<path d="M13 6 L17 10 L13 14 M17 10 H8 A4 4 0 0 0 8 18 H11" fill="none" stroke="currentColor" strokeWidth="1.6" />)}
      </button>
      <button className="tool-btn danger" onClick={onDelete} disabled={!hasSelection} title="Delete (Del)">
        {svg(<path d="M5 6 H15 M8 6 V4 H12 V6 M6 6 L7 17 H13 L14 6" fill="none" stroke="currentColor" strokeWidth="1.5" />)}
      </button>
    </div>
  );
}
