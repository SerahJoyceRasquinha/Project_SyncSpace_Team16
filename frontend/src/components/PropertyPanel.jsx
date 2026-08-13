import { memo } from 'react';
import {
  isFillable, isTextType, isConnector, isImageType, supportsCornerRadius,
  rotateAboutCentre, normalizeAngle, HEAD_OPTIONS, ROUTING_OPTIONS
} from '../canvas/shapes.jsx';
import { BRUSHES } from '../canvas/brushes.js';

const FONTS = ['Inter', 'Arial', 'Calibri', 'Verdana', 'Roboto', 'Times New Roman', 'Courier New', 'Georgia', 'Trebuchet MS'];
const FILLS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#111827', '#ffffff', 'transparent'];
const BORDERS = [
  { label: 'Solid', value: 'solid' },
  { label: 'Dashed', value: 'dashed' },
  { label: 'Dotted', value: 'dotted' },
  { label: 'None', value: 'none' }
];

const FILL_TYPES = [
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' }
];

/**
 * Border style is derived from TWO fields, not one. `strokeWidth: 0` is what
 * "None" actually writes, so reading only `dash` reported "Solid" for a shape
 * with no border at all — the select showed a value the shape did not have, and
 * re-picking "None" then looked like a dead click because nothing changed.
 */
const borderStyleOf = (s) => {
  if (!s.strokeWidth) return 'none';
  const dash = s.dash;
  if (Array.isArray(dash) && dash.length) return dash[0] === 2 ? 'dotted' : 'dashed';
  return 'solid';
};
const styleToDash = (style) => {
  if (style === 'dashed') return [8, 6];
  if (style === 'dotted') return [2, 6];
  return null;
};
/** The patch a border-style choice implies. Shared by single and multi select. */
const borderPatch = (style, currentWidth) =>
  style === 'none'
    ? { strokeWidth: 0 }
    : { dash: styleToDash(style), strokeWidth: currentWidth || 2 };

/** Slider + live numeric readout. Every range control in the panel uses this. */
function Slider({ label, value, onChange, min, max, step = 1, format }) {
  const shown = format ? format(value) : value;
  return (
    <>
      <label className="prop-label between">
        <span>{label}</span>
        <span className="prop-num">{shown}</span>
      </label>
      <input
        type="range" className="prop-range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </>
  );
}

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
 *
 * A control is only rendered when the selected object can actually honour it —
 * a slider that writes a field nothing reads is worse than a missing one,
 * because it looks like the app ignored the user.
 */
function SingleProperties({ selected, patch, onDelete, onDuplicate, onReorder }) {
  if (!selected) return null;
  const s = selected;
  const isText = isTextType(s.type);
  const isConn = isConnector(s.type);
  const isImage = isImageType(s.type);
  const isStroke = s.type === 'path';
  const canFill = !isConn && !isImage && (isFillable(s.type) || isText);
  // Freehand strokes take their dash pattern from the BRUSH, so a border-style
  // select here would write a `dash` the renderer never reads.
  const canBorder = !isText && !isImage && !isConn && !isStroke;
  const canGradient = canFill && !isText && !isStroke;

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
            <Slider label="Curvature" min="0.1" max="1" step="0.05"
              value={s.curvature ?? 0.5}
              format={(v) => Number(v).toFixed(2)}
              onChange={(v) => patch({ curvature: v })} />
          )}
          {s.routing === 'elbow' && (
            <Slider label="Corner radius" min="0" max="24"
              value={s.cornerRadius ?? 8}
              format={(v) => `${v}px`}
              onChange={(v) => patch({ cornerRadius: v })} />
          )}

          <label className="prop-label">Actions</label>
          <div className="prop-btn-row">
            <button className="fmt grow" title="Remove all bend points"
              onClick={() => patch({ waypoints: [] })}>Straighten</button>
            <button className="fmt grow" title="Swap direction (and arrowheads)"
              onClick={() => patch({
                start: s.end, end: s.start,
                startHead: s.endHead ?? 'filled',
                endHead: s.startHead ?? 'none',
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

          {/* Two rows, not one: six 28px buttons plus gaps overflow the panel's
              content width and used to wrap with a single orphan on line two. */}
          <label className="prop-label">Style</label>
          <div className="prop-btn-row">
            <button className={'fmt icon' + (s.fontWeight === 'bold' ? ' on' : '')}
              title="Bold"
              onClick={() => patch({ fontWeight: s.fontWeight === 'bold' ? 'normal' : 'bold' })}
              style={{ fontWeight: 700 }}>B</button>
            <button className={'fmt icon' + (s.italic ? ' on' : '')}
              title="Italic"
              onClick={() => patch({ italic: !s.italic })}
              style={{ fontStyle: 'italic' }}>I</button>
            <button className={'fmt icon' + (s.underline ? ' on' : '')}
              title="Underline"
              onClick={() => patch({ underline: !s.underline })}
              style={{ textDecoration: 'underline' }}>U</button>
          </div>
          <label className="prop-label">Align</label>
          <div className="prop-btn-row">
            {[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']].map(([a, title]) => (
              <button key={a} className={'fmt grow' + (s.align === a ? ' on' : '')}
                title={title}
                onClick={() => patch({ align: a })}>{title}</button>
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
                className={'mini-swatch' + (s.fill === c && s.fillType !== 'linear' && s.fillType !== 'radial' ? ' active' : '') + (c === 'transparent' ? ' none' : '')}
                style={c === 'transparent' ? {} : { background: c }}
                onClick={() => { patch({ fillType: 'solid', fill: c }); }}
                title={c === 'transparent' ? 'Transparent' : c}
              />
            ))}
            <input type="color" className="color-pick" title="Custom fill colour"
              value={s.fill && s.fill.startsWith('#') ? s.fill : '#6366f1'}
              onChange={(e) => { patch({ fillType: 'solid', fill: e.target.value }); }} />
          </div>

          {/* ---- Gradient fill controls ---- */}
          {canGradient && (
            <>
              <label className="prop-label">Fill type</label>
              <div className="prop-btn-row">
                {FILL_TYPES.map((ft) => (
                  <button key={ft.value}
                    className={'fmt grow' + ((s.fillType || 'solid') === ft.value ? ' on' : '')}
                    title={`${ft.label} fill`}
                    onClick={() => {
                      if (ft.value === 'solid') {
                        // `null`, not `undefined`: undefined is written into the
                        // document as a real value, leaving a dead key behind.
                        patch({ fillType: 'solid' });
                      } else {
                        patch({
                          fillType: ft.value,
                          fillGradientStart: s.fillGradientStart || s.fill || '#6366f1',
                          fillGradientEnd: s.fillGradientEnd || '#a5b4fc',
                          fillGradientAngle: s.fillGradientAngle || 0
                        });
                      }
                    }}>
                    {ft.label}
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
                    <Slider label="Angle" min="0" max="360"
                      value={s.fillGradientAngle ?? 0}
                      format={(v) => `${v}°`}
                      onChange={(v) => patch({ fillGradientAngle: v })} />
                  )}
                </>
              )}
            </>
          )}
        </>
      )}

      {canBorder && (
        <>
          <label className="prop-label">Stroke</label>
          <div className="swatch-row">
            {FILLS.filter((c) => c !== 'transparent').map((c) => (
              <button key={c} title={c}
                className={'mini-swatch' + (s.stroke === c ? ' active' : '')}
                style={{ background: c }}
                onClick={() => patch({ stroke: c })} />
            ))}
            <input type="color" className="color-pick" title="Custom stroke colour"
              value={s.stroke && s.stroke.startsWith('#') ? s.stroke : '#111827'}
              onChange={(e) => patch({ stroke: e.target.value })} />
          </div>

          <Slider label="Stroke width" min="0" max="20"
            value={s.strokeWidth ?? 2}
            format={(v) => `${v}px`}
            onChange={(v) => patch({ strokeWidth: v })} />

          <label className="prop-label">Border</label>
          <select className="prop-select" value={borderStyleOf(s)}
            onChange={(e) => patch(borderPatch(e.target.value, s.strokeWidth))}>
            {BORDERS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </>
      )}

      {/* ---- Corner radius: only Rect actually honours it ---- */}
      {supportsCornerRadius(s.type) && (
        <Slider label="Corner radius" min="0" max="50"
          value={s.cornerRadius ?? 0}
          format={(v) => `${v}px`}
          onChange={(v) => patch({ cornerRadius: v })} />
      )}

      {/* ---- Drop shadow ---- */}
      {!isConn && (
        <>
          <label className="prop-label">Drop shadow</label>
          <div className="prop-btn-row">
            <button className={'fmt grow' + (s.shadowEnabled ? ' on' : '')}
              title={s.shadowEnabled ? 'Turn the drop shadow off' : 'Turn the drop shadow on'}
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
              {s.shadowEnabled ? 'On' : 'Off'}
            </button>
          </div>
          {s.shadowEnabled && (
            <div className="prop-sub">
              <div className="prop-row">
                <div className="prop-col">
                  <label className="prop-label">Colour</label>
                  <input type="color" className="prop-color"
                    value={s.shadowColor || '#000000'}
                    onChange={(e) => patch({ shadowColor: e.target.value })} />
                </div>
              </div>
              <Slider label="Shadow blur" min="0" max="40"
                value={s.shadowBlur ?? 10}
                format={(v) => `${v}px`}
                onChange={(v) => patch({ shadowBlur: v })} />
              <Slider label="Offset X" min="-20" max="20"
                value={s.shadowOffsetX ?? 4}
                format={(v) => `${v}px`}
                onChange={(v) => patch({ shadowOffsetX: v })} />
              <Slider label="Offset Y" min="-20" max="20"
                value={s.shadowOffsetY ?? 4}
                format={(v) => `${v}px`}
                onChange={(v) => patch({ shadowOffsetY: v })} />
              <Slider label="Shadow opacity" min="0" max="1" step="0.05"
                value={s.shadowOpacity ?? 0.3}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => patch({ shadowOpacity: v })} />
            </div>
          )}
        </>
      )}

      {/* ---- Blur filter ---- */}
      {!isConn && (
        <Slider label="Blur" min="0" max="20"
          value={s.blurRadius ?? 0}
          format={(v) => (v ? `${v}px` : 'None')}
          onChange={(v) => patch({ blurRadius: v })} />
      )}

      <Slider label="Opacity" min="0" max="1" step="0.05"
        value={s.opacity ?? 1}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => patch({ opacity: v })} />

      {!isConn && (
        <Slider label="Rotation" min="0" max="360"
          value={Math.round(normalizeAngle(s.rotation))}
          format={(v) => `${v}°`}
          // Pivots about the shape's centre, so this agrees with the
          // Transformer's rotate handle instead of swinging the shape away.
          onChange={(v) => patch(rotateAboutCentre(s, v))} />
      )}

      <label className="prop-label">Arrange</label>
      <div className="prop-btn-row">
        <button className="fmt icon" title="Bring forward" onClick={() => onReorder?.('forward')}>▲</button>
        <button className="fmt icon" title="Send backward" onClick={() => onReorder?.('backward')}>▼</button>
        <button className="fmt icon" title="Duplicate (Ctrl+D)" onClick={onDuplicate}>⧉</button>
        <button className={'fmt icon' + (s.locked ? ' on' : '')}
          title={s.locked ? 'Unlock' : 'Lock (prevents moving and resizing)'}
          onClick={() => patch({ locked: !s.locked })}>
          {s.locked ? '🔒' : '🔓'}
        </button>
      </div>

      {/* ---- Reset: put every appearance effect back to its default ---- */}
      <div className="prop-btn-row">
        <button className="fmt grow subtle" title="Reset effects, opacity and rotation to their defaults"
          onClick={() => patch({
            fillType: 'solid',
            fillGradientAngle: 0,
            shadowEnabled: false,
            blurRadius: 0,
            opacity: 1,
            ...(supportsCornerRadius(s.type) ? { cornerRadius: 0 } : {}),
            ...(isConn ? {} : rotateAboutCentre(s, 0))
          })}>
          Reset appearance
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
/** Same idea, but for a value that is DERIVED from a record rather than read. */
function sharedBy(list, fn) {
  let seen = false;
  let val;
  for (const s of list) {
    const v = fn(s);
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
 *   • Stroke  — only if every object has a stroke (no text / images / strokes).
 *   • Opacity — always (every object type has it).
 *   • Arrange — reorder / duplicate / delete / lock, applied to all.
 * A value that differs across the selection is reported as "Mixed" and left
 * un-highlighted until the user picks one, which then unifies it.
 */
function MultiProperties({ selection, patch, onDelete, onDuplicate, onReorder }) {
  const canFillAll = selection.every(
    (s) => !isConnector(s.type) && !isImageType(s.type) &&
           (isFillable(s.type) || isTextType(s.type))
  );
  const canStrokeAll = selection.every(
    (s) => !isTextType(s.type) && !isImageType(s.type) &&
           !isConnector(s.type) && s.type !== 'path'
  );
  const anyConn = selection.some((s) => isConnector(s.type));

  const fillVal = shared(selection, 'fill');
  const strokeVal = shared(selection, 'stroke');
  const strokeWidthVal = shared(selection, 'strokeWidth', 2);
  const opacityVal = shared(selection, 'opacity', 1);
  // Derived from strokeWidth AND dash, exactly like the single-select panel.
  const borderVal = sharedBy(selection, borderStyleOf);
  const allLocked = selection.every((s) => s.locked);

  const mixedTag = <span className="prop-num mixed">Mixed</span>;

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
          <label className="prop-label between">
            <span>Fill</span>
            {fillVal === MIXED ? mixedTag : null}
          </label>
          <div className="swatch-row">
            {FILLS.map((c) => (
              <button
                key={c}
                className={'mini-swatch' + (fillVal === c ? ' active' : '') + (c === 'transparent' ? ' none' : '')}
                style={c === 'transparent' ? {} : { background: c }}
                onClick={() => patch({ fillType: 'solid', fill: c })}
                title={c === 'transparent' ? 'Transparent' : c}
              />
            ))}
            <input type="color" className="color-pick" title="Custom fill colour"
              value={typeof fillVal === 'string' && fillVal.startsWith('#') ? fillVal : '#6366f1'}
              onChange={(e) => patch({ fillType: 'solid', fill: e.target.value })} />
          </div>
        </>
      )}

      {canStrokeAll && (
        <>
          <label className="prop-label between">
            <span>Stroke</span>
            {strokeVal === MIXED ? mixedTag : null}
          </label>
          <div className="swatch-row">
            {FILLS.filter((c) => c !== 'transparent').map((c) => (
              <button key={c} title={c}
                className={'mini-swatch' + (strokeVal === c ? ' active' : '')}
                style={{ background: c }}
                onClick={() => patch({ stroke: c })} />
            ))}
            <input type="color" className="color-pick" title="Custom stroke colour"
              value={typeof strokeVal === 'string' && strokeVal.startsWith('#') ? strokeVal : '#111827'}
              onChange={(e) => patch({ stroke: e.target.value })} />
          </div>

          <Slider label="Stroke width" min="0" max="20"
            value={strokeWidthVal === MIXED ? 2 : strokeWidthVal}
            format={(v) => (strokeWidthVal === MIXED ? 'Mixed' : `${v}px`)}
            onChange={(v) => patch({ strokeWidth: v })} />

          <label className="prop-label between">
            <span>Border</span>
            {borderVal === MIXED ? mixedTag : null}
          </label>
          {/* Was hardcoded to value="mixed", so it could never reflect the
              selection even when every object agreed. */}
          <select className="prop-select"
            value={borderVal === MIXED ? '__mixed' : borderVal}
            onChange={(e) => {
              const style = e.target.value;
              if (style === '__mixed') return;
              patch(borderPatch(style, strokeWidthVal === MIXED ? 2 : strokeWidthVal));
            }}>
            {borderVal === MIXED && <option value="__mixed" disabled>Mixed</option>}
            {BORDERS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </>
      )}

      <Slider label="Opacity" min="0" max="1" step="0.05"
        value={opacityVal === MIXED ? 1 : opacityVal}
        format={(v) => (opacityVal === MIXED ? 'Mixed' : `${Math.round(v * 100)}%`)}
        onChange={(v) => patch({ opacity: v })} />

      <label className="prop-label">Arrange</label>
      <div className="prop-btn-row">
        {!anyConn && (
          <>
            <button className="fmt icon" title="Bring forward" onClick={() => onReorder?.('forward')}>▲</button>
            <button className="fmt icon" title="Send backward" onClick={() => onReorder?.('backward')}>▼</button>
          </>
        )}
        <button className="fmt icon" title="Duplicate (Ctrl+D)" onClick={onDuplicate}>⧉</button>
        <button className={'fmt icon' + (allLocked ? ' on' : '')}
          title={allLocked ? 'Unlock all' : 'Lock all'}
          onClick={() => patch({ locked: !allLocked })}>
          {allLocked ? '🔒' : '🔓'}
        </button>
      </div>
    </div>
  );
}
