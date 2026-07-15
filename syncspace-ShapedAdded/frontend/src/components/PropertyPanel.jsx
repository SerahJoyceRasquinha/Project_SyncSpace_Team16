import { isFillable, isTextType } from '../canvas/shapes.jsx';

const FONTS = ['Inter', 'Arial', 'Calibri', 'Verdana', 'Roboto', 'Times New Roman', 'Courier New', 'Georgia', 'Trebuchet MS'];
const FILLS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#111827', '#ffffff', 'transparent'];
const BORDERS = [
  { label: 'Solid', value: 'solid' },
  { label: 'Dashed', value: 'dashed' },
  { label: 'Dotted', value: 'dotted' },
  { label: 'None', value: 'none' }
];

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
 * Contextual property panel. Shown only when something is selected. Fill/stroke/
 * opacity/border for shapes; a full formatting strip for text. Every control
 * calls patch(), which writes straight to Yjs, so a colour change is live for
 * everyone the instant it happens.
 */
export default function PropertyPanel({ selected, patch, onDelete }) {
  if (!selected) return null;
  const s = selected;
  const isText = isTextType(s.type);
  const canFill = isFillable(s.type) || isText;

  return (
    <div className="prop-panel">
      <div className="prop-head">
        <span>{isText ? 'Text' : s.type}</span>
        <button className="prop-del" onClick={onDelete} title="Delete">Delete</button>
      </div>

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
                onClick={() => patch({ fill: c })}
                title={c}
              />
            ))}
            <input type="color" className="color-pick"
              value={s.fill && s.fill.startsWith('#') ? s.fill : '#6366f1'}
              onChange={(e) => patch({ fill: e.target.value })} />
          </div>
        </>
      )}

      {!isText && (
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

      <label className="prop-label">Opacity</label>
      <input type="range" min="0.1" max="1" step="0.05"
        value={s.opacity ?? 1}
        onChange={(e) => patch({ opacity: Number(e.target.value) })} />

      <label className="prop-label">Rotation</label>
      <input type="range" min="0" max="360"
        value={Math.round(s.rotation || 0)}
        onChange={(e) => patch({ rotation: Number(e.target.value) })} />

      <div className="prop-meta">created by {s.creator || 'anon'}</div>
    </div>
  );
}
