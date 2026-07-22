import { BRUSHES, PEN_PALETTE, dashArray, brushDef } from '../canvas/brushes.js';

/**
 * The floating Pen / Eraser panel. Appears only while the Pen or Eraser tool is
 * active, anchored to the top-left of the canvas so it never blocks the right-
 * hand property panel. Every control writes straight into the persisted pen/
 * eraser settings, so a chosen brush stays active until the user changes it —
 * it does NOT reset each time the tool is picked. Newly drawn strokes copy these
 * values once, at creation, so editing the panel never alters existing strokes.
 */
export default function BrushPanel({
  tool, pen, setPen, eraser, setEraser, recentColors, onColor
}) {
  if (tool !== 'pen' && tool !== 'eraser') return null;
  const isEraser = tool === 'eraser';

  return (
    <div className="brush-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="brush-head">{isEraser ? 'Eraser' : 'Brush'}</div>

      {isEraser ? (
        <EraserBody eraser={eraser} setEraser={setEraser} />
      ) : (
        <PenBody pen={pen} setPen={setPen} recentColors={recentColors} onColor={onColor} />
      )}
    </div>
  );
}

function BrushPreview({ pen }) {
  // A sample squiggle drawn with the current brush settings.
  const def = brushDef(pen.brush);
  const w = pen.size;
  const path = 'M8 30 C 30 8, 55 8, 78 24 S 130 44, 152 20';
  const dash = dashArray(pen.brush, w);
  const dashStr = dash ? dash.join(' ') : undefined;
  const isHi = pen.brush === 'highlighter';
  return (
    <svg className="brush-preview" viewBox="0 0 160 40" width="100%" height="40">
      {pen.brush === 'calligraphy' ? (
        // fake the nib swell with two offset strokes
        <>
          <path d={path} fill="none" stroke={pen.color} strokeWidth={w}
            strokeLinecap="round" opacity={pen.opacity} />
          <path d={path} fill="none" stroke={pen.color} strokeWidth={Math.max(1, w * 0.35)}
            strokeLinecap="round" opacity={pen.opacity} transform="translate(1.5,1.5)" />
        </>
      ) : (
        <path
          d={path}
          fill="none"
          stroke={pen.color}
          strokeWidth={w}
          strokeLinecap={def.cap === 'butt' ? 'butt' : 'round'}
          strokeLinejoin="round"
          strokeDasharray={dashStr}
          opacity={pen.opacity}
          style={isHi ? { mixBlendMode: 'multiply' } : undefined}
        />
      )}
    </svg>
  );
}

function PenBody({ pen, setPen, recentColors, onColor }) {
  const pickColor = (c) => { setPen({ color: c }); onColor(c); };

  return (
    <>
      {/* live preview of the current brush */}
      <BrushPreview pen={pen} />

      {/* brush styles */}
      <div className="brush-label">Style</div>
      <div className="brush-grid">
        {BRUSHES.map((b) => (
          <button
            key={b.id}
            className={'brush-cell' + (pen.brush === b.id ? ' active' : '')}
            title={b.label}
            onClick={() => setPen({ brush: b.id })}
          >
            <BrushGlyph brush={b.id} />
            <span>{b.label}</span>
          </button>
        ))}
      </div>

      {/* colours */}
      <div className="brush-label">Colour</div>
      <div className="brush-swatches">
        {PEN_PALETTE.map((c) => (
          <button
            key={c}
            className={'brush-swatch' + (pen.color === c ? ' active' : '')}
            style={{ background: c }}
            title={c}
            onClick={() => pickColor(c)}
          />
        ))}
        <label className="brush-picker" title="Custom colour">
          <input type="color" value={pen.color.startsWith('#') ? pen.color : '#111827'}
            onChange={(e) => pickColor(e.target.value)} />
          <span>+</span>
        </label>
      </div>

      {recentColors.length > 0 && (
        <>
          <div className="brush-label">Recent</div>
          <div className="brush-swatches">
            {recentColors.map((c) => (
              <button key={c} className={'brush-swatch' + (pen.color === c ? ' active' : '')}
                style={{ background: c }} title={c} onClick={() => pickColor(c)} />
            ))}
          </div>
        </>
      )}

      {/* thickness */}
      <div className="brush-label between">
        <span>Thickness</span><span className="brush-num">{pen.size}px</span>
      </div>
      <input type="range" min="1" max="60" value={pen.size}
        onChange={(e) => setPen({ size: Number(e.target.value) })} />

      {/* opacity */}
      <div className="brush-label between">
        <span>Opacity</span><span className="brush-num">{Math.round(pen.opacity * 100)}%</span>
      </div>
      <input type="range" min="0.05" max="1" step="0.05" value={pen.opacity}
        onChange={(e) => setPen({ opacity: Number(e.target.value) })} />

      {/* toggles */}
      <div className="brush-toggles">
        <button className={'brush-toggle' + (pen.smoothing ? ' on' : '')}
          onClick={() => setPen({ smoothing: !pen.smoothing })}
          title="Round off shaky lines">Smoothing</button>
        <button className={'brush-toggle' + (pen.pressure ? ' on' : '')}
          onClick={() => setPen({ pressure: !pen.pressure })}
          title="Vary width with speed (best with Calligraphy)">Pressure</button>
      </div>

      {pen.brush === 'calligraphy' && (
        <>
          <div className="brush-label between">
            <span>Nib angle</span><span className="brush-num">{pen.nibAngle}°</span>
          </div>
          <input type="range" min="0" max="180" value={pen.nibAngle}
            onChange={(e) => setPen({ nibAngle: Number(e.target.value) })} />
        </>
      )}
    </>
  );
}

function EraserBody({ eraser, setEraser }) {
  return (
    <>
      <div className="eraser-preview">
        <span className="eraser-ring" style={{
          width: Math.min(64, eraser.size * 2),
          height: Math.min(64, eraser.size * 2)
        }} />
      </div>
      <div className="brush-label between">
        <span>Eraser size</span><span className="brush-num">{eraser.size}px</span>
      </div>
      <input type="range" min="6" max="80" value={eraser.size}
        onChange={(e) => setEraser({ size: Number(e.target.value) })} />
      <p className="brush-hint">
        Drag across a stroke to rub out just the part you touch — the rest of the
        line stays. Shapes, text and connectors aren’t affected; select them and
        press Delete instead.
      </p>
    </>
  );
}

/** Tiny inline glyph for each brush style button. */
function BrushGlyph({ brush }) {
  const s = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' };
  const d = 'M2 14 C 8 6, 16 6, 22 12';
  switch (brush) {
    case 'pencil': return <svg viewBox="0 0 24 18" width="26" height="18"><path d={d} {...s} strokeWidth="1.4" /></svg>;
    case 'marker': return <svg viewBox="0 0 24 18" width="26" height="18"><path d={d} {...s} strokeWidth="5" /></svg>;
    case 'highlighter': return <svg viewBox="0 0 24 18" width="26" height="18"><path d={d} {...s} strokeWidth="7" opacity="0.4" /></svg>;
    case 'calligraphy': return <svg viewBox="0 0 24 18" width="26" height="18"><path d="M3 15 L21 5" {...s} strokeWidth="4.5" /></svg>;
    case 'dashed': return <svg viewBox="0 0 24 18" width="26" height="18"><path d={d} {...s} strokeWidth="2.4" strokeDasharray="5 3.5" /></svg>;
    case 'dotted': return <svg viewBox="0 0 24 18" width="26" height="18"><path d={d} {...s} strokeWidth="2.6" strokeDasharray="0.1 4.5" /></svg>;
    default: return <svg viewBox="0 0 24 18" width="26" height="18"><path d={d} {...s} strokeWidth="2.6" /></svg>;
  }
}
