import { memo } from 'react';
import { isFillable, isTextType, isConnector, isImageType, HEAD_OPTIONS, ROUTING_OPTIONS } from '../canvas/shapes.jsx';
import { BRUSHES } from '../canvas/brushes.js';

const FONTS = ['Inter', 'Arial', 'Calibri', 'Verdana', 'Roboto', 'Times New Roman', 'Courier New', 'Georgia', 'Trebuchet MS'];
const FILLS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#111827', '#ffffff', 'transparent'];
const BORDERS = [
  { label: 'Solid', value: 'solid' },
  { label: 'Dashed', value: 'dashed' },
  { label: 'Dotted', value: 'dotted' },
  { label: 'None', value: 'none' }
];

const FILL_TYPES = ['solid', 'linear', 'radial'];

const dashToStyle = (dash) => {
  if (dash === null || dash === undefined) return 'solid';
  if (Array.isArray(dash) && dash[0] === 2) return 'dotted';
  if (Array.isArray(dash)) return 'dashed';
  return 'solid';
};
const styleToDash = (style) => {
  if (style === 'dashed') return [8, 6];
  if (style === 'dotted') return [2, 6];
  return null;
};

/**
 * Contextual property panel. Its visibility and contents are entirely driven by
 * the `selection` array the Canvas passes in (the single source of truth), so it
 * is a pure function of the current selection with no internal show/hide logic:
 *
 *   • 0 selected  → nothing renders (the panel is simply absent).
 *   • 1 selected  → the full per-type panel for that object.
 *   • 2+ selected → a reduced panel exposing only the properties COMMON to every
 *                   selected object (edits fan out to all of them via patch()).
 *
 * Wrapped in React.memo: during a drag/resize/rotate the Canvas re-renders many
 * times, but the selection records come from the COMMITTED shape list (stable
 * references mid-gesture) and every callback is memoised upstream, so the panel
 * itself does not re-render on those frames.
 */
function PropertyPanel({ selection = [], patch, onDelete, onDuplicate, onReorder }) {
  if (!selection.length) return null;
  if (selection.length === 1) {
    return (
      <SingleProperties
        selected={selection[0]}
        patch={patch}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onReorder={onReorder}
      />
    );
  }
  return (
    <MultiProperties
      selection={selection}
      patch={patch}
      onDelete={onDelete}
      onDuplicate={onDuplicate}
      onReorder={onReorder}
    />
  );
}

export default memo(PropertyPanel);

/**
 * Contextual property panel for a SINGLE selected object. Fill/stroke/opacity/
 * border for shapes; a full formatting strip for text. Every control calls
 * patch(), which writes straight to Yjs, so a colour change is live for everyone
 * the instant it happens.
 */
function SingleProperties({ selected, patch, onDelete, onDuplicate, onReorder }) {
  if (!selected) return null;
  const s = selected;
  const isText = isTextType(s.type);
  const isConn = isConnector(s.type);
  // ROOT-CAUSE FIX: `isImage` was referenced further down (the Stroke
  // section) but never declared, so rendering this panel for ANY non-text
  // shape threw `ReferenceError: isImage is not defined` during React's
  // render phase and unmounted the whole app.
  const isImage = isImageType(s.type);
  const isStroke = s.type === 'path';
  const canFill = !isConn && !isImage && (isFillable(s.type) || isText);

  return (
    <div className="prop-panel">
      <div className="prop-head">
        <span>{isText ? 'Text' : isConn ? 'Connector' : isImage ? 'Image' : isStroke ? 'Stroke' : s.type}</span>
        <button className="prop-del" onClick={onDelete} title="Delete">Delete</button>
      </div>

      {isStroke && (
        <>
          <label className="prop-label">Brush</label>
          <select className="prop-select" value={s.brush || 'pen'}
            onChange={(e) => patch({ brush: e.target.value })}>
            {BRUSHES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </>
      )}

      {isConn && (
        <>
          <label className="prop-label">Routing</label>
          <select className="prop-select" value={s.routing || 'straight'}
            onChange={(e) => patch({ routing: e.target.value })}>
            {ROUTING_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>

          <div className="prop-row">
            <div className="prop-col">
              <label className="prop-label">Start head</label>
              <select className="prop-select" value={s.startHead || 'none'}
                onChange={(e) => patch({ startHead: e.target.value })}>
                {HEAD_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </div>
            <div className="prop-col">
              <label className="prop-label">End head</label>
              <select className="prop-select" value={s.endHead || 'filled'}
                onChange={(e) => patch({ endHead: e.target.value })}>
                {HEAD_OPTIONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </div>
          </div>

          {s.routing === 'curved' && (
            <>
              <label className="prop-label">Curvature</label>
              <input type="range" min="0.1" max="1" step="0.05"
                value={s.curvature ?? 0.5}
                onChange={(e) => patch({ curvature: Number(e.target.value) })} />
            </>
          )}
          {s.routing === 'elbow' && (
            <>
              <label className="prop-label">Corner radius</label>
              <input type="range" min="0" max="24"
                value={s.cornerRadius ?? 8}
                onChange={(e) => patch({ cornerRadius: Number(e.target.value) })} />
            </>
          )}

          <div className="prop-btn-row">
            <button className="fmt" title="Remove all bend points"
              onClick={() => patch({ waypoints: [] })}>Straighten</button>
            <button className="fmt" title="Swap direction (and arrowheads)"
              onClick={() => patch({
                start: s.end, end: s.start,
                waypoints: (() => {
                  const flat = s.waypoints || [];
                  const out = [];
                  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
                  return out;
                })()
              })}>Reverse</button>
          </div>
        </>
      )}

      {isText && (
        <>
          <label className="prop-label">Font</label>
          <select
            className="prop-select"
            value={s.fontFamily || 'Inter'}
            onChange={(e) => patch({ fontFamily: e.target.value })}
          >
            {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>

          <div className="prop-row">
            <div className="prop-col">
              <label className="prop-label">Size</label>
              <input
                type="number" min="8" max="200"
                className="prop-input"
                value={s.fontSize || 20}
                onChange={(e) => patch({ fontSize: Number(e.target.value) })}
              />
            </div>
            <div className="prop-col">
              <label className="prop-label">Line height</label>
              <input
                type="number" min="0.8" max="3" step="0.1"
                className="prop-input"
                value={s.lineHeight || 1.2}
                onChange={(e) => patch({ lineHeight: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="prop-btn-row">
            <button className={'fmt' + (s.fontWeight === 'bold' ? ' on' : '')}
              onClick={() => patch({ fontWeight: s.fontWeight === 'bold' ? 'normal' : 'bold' })}
              style={{ fontWeight: 700 }}>B</button>
            <button className={'fmt' + (s.italic ? ' on' : '')}
              onClick={() => patch({ italic: !s.italic })}
              style={{ fontStyle: 'italic' }}>I</button>
            <button className={'fmt' + (s.underline ? ' on' : '')}
              onClick={() => patch({ underline: !s.underline })}
              style={{ textDecoration: 'underline' }}>U</button>
            {['left', 'center', 'right'].map((a) => (
              <button key={a} className={'fmt' + (s.align === a ? ' on' : '')}
                onClick={() => patch({ align: a })}>{a[0].toUpperCase()}</button>
            ))}
          </div>
        </>
      )}

      {canFill && (
        <>
          <label className="prop-label">{isText ? 'Text colour' : 'Fill'}</label>
          <div className="swatch-row">
            {FILLS.map((c) => (
              <button
                key={c}
                className={'mini-swatch' + (s.fill === c ? ' active' : '') + (c === 'transparent' ? ' none' : '')}
                style={c === 'transparent' ? {} : { background: c }}
                onClick={() => { patch({ fillType: 'solid', fill: c }); }}
                title={c}
              />
            ))}
            <input type="color" className="color-pick"
              value={s.fill && s.fill.startsWith('#') ? s.fill : '#6366f1'}
              onChange={(e) => { patch({ fillType: 'solid', fill: e.target.value }); }} />
          </div>

          {/* ---- Gradient fill controls ---- */}
          {!isText && !isStroke && (
            <>
              <label className="prop-label">Fill type</label>
              <div className="prop-btn-row">
                {FILL_TYPES.map((ft) => (
                  <button key={ft}
                    className={'fmt' + ((s.fillType || 'solid') === ft ? ' on' : '')}
                    onClick={() => {
                      if (ft === 'solid') {
                        patch({ fillType: 'solid', fillGradientStart: undefined, fillGradientEnd: undefined, fillGradientAngle: undefined });
                      } else {
                        patch({ fillType: ft, fillGradientStart: s.fillGradientStart || s.fill || '#6366f1', fillGradientEnd: s.fillGradientEnd || '#a5b4fc', fillGradientAngle: s.fillGradientAngle || 0 });
                      }
                    }}>
                    {ft === 'linear' ? 'Linear' : ft === 'radial' ? 'Radial' : 'Solid'}
                  </button>
                ))}
              </div>

              {(s.fillType === 'linear' || s.fillType === 'radial') && (
                <>
                  <div className="prop-row">
                    <div className="prop-col">
                      <label className="prop-label">From</label>
                      <input type="color" className="prop-color"
                        value={s.fillGradientStart?.startsWith('#') ? s.fillGradientStart : '#6366f1'}
                        onChange={(e) => patch({ fillGradientStart: e.target.value })} />
                    </div>
                    <div className="prop-col">
                      <label className="prop-label">To</label>
                      <input type="color" className="prop-color"
                        value={s.fillGradientEnd?.startsWith('#') ? s.fillGradientEnd : '#a5b4fc'}
                        onChange={(e) => patch({ fillGradientEnd: e.target.value })} />
                    </div>
                  </div>

                  {s.fillType === 'linear' && (
                    <>
                      <label className="prop-label">Angle</label>
                      <input type="range" min="0" max="360"
                        value={s.fillGradientAngle ?? 0}
                        onChange={(e) => patch({ fillGradientAngle: Number(e.target.value) })} />
                    </>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}

      {!isText && s.type !== 'image' && !isConn && (
        <>
          <label className="prop-label">Stroke</label>
          <div className="swatch-row">
            {FILLS.filter((c) => c !== 'transparent').map((c) => (
              <button key={c}
                className={'mini-swatch' + (s.stroke === c ? ' active' : '')}
                style={{ background: c }}
                onClick={() => patch({ stroke: c })} />
            ))}
            <input type="color" className="color-pick"
              value={s.stroke && s.stroke.startsWith('#') ? s.stroke : '#111827'}
              onChange={(e) => patch({ stroke: e.target.value })} />
          </div>

          <div className="prop-row">
            <div className="prop-col">
              <label className="prop-label">Stroke width</label>
              <input type="range" min="0" max="20"
                value={s.strokeWidth ?? 2}
                onChange={(e) => patch({ strokeWidth: Number(e.target.value) })} />
            </div>
          </div>

          <label className="prop-label">Border</label>
          <select className="prop-select" value={dashToStyle(s.dash)}
            onChange={(e) => {
              const style = e.target.value;
              patch(style === 'none'
                ? { strokeWidth: 0 }
                : { dash: styleToDash(style), strokeWidth: s.strokeWidth || 2 });
            }}>
            {BORDERS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </>
      )}

      {/* ---- Corner radius (for rect / roundRect / image) ---- */}
      {!isConn && !isStroke && !isText && (
        <div className="prop-row">
          <div className="prop-col">
            <label className="prop-label">Corner radius</label>
            <input type="range" min="0" max="50"
              value={s.cornerRadius ?? 0}
              onChange={(e) => patch({ cornerRadius: Number(e.target.value) })} />
          </div>
        </div>
      )}

      {/* ---- Drop shadow controls ---- */}
      {!isConn && (
        <div className="prop-row">
          <div className="prop-col">
            <label className="prop-label">Drop shadow</label>
            <div className="prop-btn-row">
              <button className={'fmt' + (s.shadowEnabled ? ' on' : '')}
                onClick={() => patch({
                  shadowEnabled: !s.shadowEnabled,
                  ...(!s.shadowEnabled ? {
                    shadowColor: s.shadowColor || '#000000',
                    shadowBlur: s.shadowBlur || 10,
                    shadowOffsetX: s.shadowOffsetX || 4,
                    shadowOffsetY: s.shadowOffsetY || 4,
                    shadowOpacity: s.shadowOpacity || 0.3
                  } : {})
                })}>
                {s.shadowEnabled ? '✓ On' : 'Off'}
              </button>
            </div>
            {s.shadowEnabled && (
              <>
                <div className="prop-row">
                  <div className="prop-col">
                    <label className="prop-label">Color</label>
                    <input type="color" className="prop-color"
                      value={s.shadowColor || '#000000'}
                      onChange={(e) => patch({ shadowColor: e.target.value })} />
                  </div>
                  <div className="prop-col">
                    <label className="prop-label">Blur</label>
                    <input type="range" min="0" max="40"
                      value={s.shadowBlur ?? 10}
                      onChange={(e) => patch({ shadowBlur: Number(e.target.value) })} />
                  </div>
                </div>
                <div className="prop-row">
                  <div className="prop-col">
                    <label className="prop-label">Offset X</label>
                    <input type="range" min="-20" max="20"
                      value={s.shadowOffsetX ?? 4}
                      onChange={(e) => patch({ shadowOffsetX: Number(e.target.value) })} />
                  </div>
                  <div className="prop-col">
                    <label className="prop-label">Offset Y</label>
                    <input type="range" min="-20" max="20"
                      value={s.shadowOffsetY ?? 4}
                      onChange={(e) => patch({ shadowOffsetY: Number(e.target.value) })} />
                  </div>
                </div>
                <label className="prop-label">Opacity</label>
                <input type="range" min="0" max="1" step="0.05"
                  value={s.shadowOpacity ?? 0.3}
                  onChange={(e) => patch({ shadowOpacity: Number(e.target.value) })} />
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- Blur filter ---- */}
      {!isConn && (
        <div className="prop-row">
          <div className="prop-col">
            <label className="prop-label">Blur</label>
            <input type="range" min="0" max="20"
              value={s.blurRadius ?? 0}
              onChange={(e) => patch({ blurRadius: Number(e.target.value) })} />
          </div>
        </div>
      )}

      <label className="prop-label">Opacity</label>
      <input type="range" min="0.1" max="1" step="0.05"
        value={s.opacity ?? 1}
        onChange={(e) => patch({ opacity: Number(e.target.value) })} />

      {!isConn && (
        <>
          <label className="prop-label">Rotation</label>
          <input type="range" min="0" max="360"
            value={Math.round(s.rotation || 0)}
            onChange={(e) => patch({ rotation: Number(e.target.value) })} />
        </>
      )}

      <label className="prop-label">Arrange</label>
      <div className="prop-btn-row">
        <button className="fmt" title="Bring forward" onClick={() => onReorder?.('forward')}>▲</button>
        <button className="fmt" title="Send backward" onClick={() => onReorder?.('backward')}>▼</button>
        <button className="fmt" title="Duplicate (Ctrl+D)" onClick={onDuplicate}>⧉</button>
        <button className={'fmt' + (s.locked ? ' on' : '')}
          title={s.locked ? 'Unlock' : 'Lock (prevents moving/selecting)'}
          onClick={() => patch({ locked: !s.locked })}>
          {s.locked ? '🔒' : '🔓'}
        </button>
      </div>

      <div className="prop-meta">created by {s.creator || 'anon'}</div>
    </div>
  );
}

// A "mixed" sentinel: when the selected objects disagree on a value, we show the
// swatch/slider as un-highlighted rather than lying about a single shared value.
const MIXED = Symbol('mixed');
/** The shared value of `field` across every shape, or MIXED if they differ. */
function shared(list, field, fallback) {
  let seen = false;
  let val;
  for (const s of list) {
    const v = s[field] ?? fallback;
    if (!seen) { val = v; seen = true; }
    else if (v !== val) return MIXED;
  }
  return val;
}

/**
 * Contextual property panel for a MULTI-selection. It deliberately exposes ONLY
 * the properties that make sense for every selected object at once, so an edit
 * can be applied uniformly — patch() fans out to the whole selection (Canvas
 * routes it through updateMany). Which sections appear is decided by what the
 * selection has in common:
 *   • Fill    — only if every object is fillable (no connectors / images).
 *   • Stroke  — only if every object has a stroke (no text / images / connectors).
 *   • Opacity — always (every object type has it).
 *   • Arrange — reorder / duplicate / delete / lock, applied to all.
 * A value that differs across the selection shows as "Mixed" and is left
 * un-highlighted until the user picks one, which then unifies it.
 */
function MultiProperties({ selection, patch, onDelete, onDuplicate, onReorder }) {
  const canFillAll = selection.every(
    (s) => !isConnector(s.type) && !isImageType(s.type) &&
           (isFillable(s.type) || isTextType(s.type))
  );
  const canStrokeAll = selection.every(
    (s) => !isTextType(s.type) && !isImageType(s.type) && !isConnector(s.type)
  );
  const anyConn = selection.some((s) => isConnector(s.type));

  const fillVal = shared(selection, 'fill');
  const strokeVal = shared(selection, 'stroke');
  const strokeWidthVal = shared(selection, 'strokeWidth', 2);
  const opacityVal = shared(selection, 'opacity', 1);
  const allLocked = selection.every((s) => s.locked);

  return (
    <div className="prop-panel">
      <div className="prop-head">
        <span>{selection.length} selected</span>
        <button className="prop-del" onClick={onDelete} title="Delete all">Delete</button>
      </div>

      <div className="prop-meta multi-hint">
        Editing {selection.length} objects — changes apply to all.
      </div>

      {canFillAll && (
        <>
          <label className="prop-label">Fill</label>
          <div className="swatch-row">
            {FILLS.map((c) => (
              <button
                key={c}
                className={'mini-swatch' + (fillVal === c ? ' active' : '') + (c === 'transparent' ? ' none' : '')}
                style={c === 'transparent' ? {} : { background: c }}
                onClick={() => patch({ fillType: 'solid', fill: c })}
                title={c}
              />
            ))}
            <input type="color" className="color-pick"
              value={typeof fillVal === 'string' && fillVal.startsWith('#') ? fillVal : '#6366f1'}
              onChange={(e) => patch({ fillType: 'solid', fill: e.target.value })} />
          </div>
        </>
      )}

      {canStrokeAll && (
        <>
          <label className="prop-label">Stroke</label>
          <div className="swatch-row">
            {FILLS.filter((c) => c !== 'transparent').map((c) => (
              <button key={c}
                className={'mini-swatch' + (strokeVal === c ? ' active' : '')}
                style={{ background: c }}
                onClick={() => patch({ stroke: c })} />
            ))}
            <input type="color" className="color-pick"
              value={typeof strokeVal === 'string' && strokeVal.startsWith('#') ? strokeVal : '#111827'}
              onChange={(e) => patch({ stroke: e.target.value })} />
          </div>

          <label className="prop-label">Stroke width</label>
          <input type="range" min="0" max="20"
            value={strokeWidthVal === MIXED ? 2 : strokeWidthVal}
            onChange={(e) => patch({ strokeWidth: Number(e.target.value) })} />

          <label className="prop-label">Border</label>
          <select className="prop-select" value="mixed"
            onChange={(e) => {
              const style = e.target.value;
              if (style === 'mixed') return;
              patch(style === 'none'
                ? { strokeWidth: 0 }
                : { dash: styleToDash(style), strokeWidth: strokeWidthVal === MIXED ? 2 : (strokeWidthVal || 2) });
            }}>
            <option value="mixed" disabled hidden>Choose…</option>
            {BORDERS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </>
      )}

      <label className="prop-label">Opacity</label>
      <input type="range" min="0.1" max="1" step="0.05"
        value={opacityVal === MIXED ? 1 : opacityVal}
        onChange={(e) => patch({ opacity: Number(e.target.value) })} />

      <label className="prop-label">Arrange</label>
      <div className="prop-btn-row">
        {!anyConn && (
          <>
            <button className="fmt" title="Bring forward" onClick={() => onReorder?.('forward')}>▲</button>
            <button className="fmt" title="Send backward" onClick={() => onReorder?.('backward')}>▼</button>
          </>
        )}
        <button className="fmt" title="Duplicate (Ctrl+D)" onClick={onDuplicate}>⧉</button>
        <button className={'fmt' + (allLocked ? ' on' : '')}
          title={allLocked ? 'Unlock all' : 'Lock all'}
          onClick={() => patch({ locked: !allLocked })}>
          {allLocked ? '🔒' : '🔓'}
        </button>
      </div>
    </div>
  );
}
