const PALETTE = [
  '#000000', '#ffffff', '#808080', '#c0c0c0',
  '#800000', '#ff0000', '#ff8040', '#ff8000',
  '#808000', '#ffff00', '#008000', '#00ff00',
  '#008080', '#00ffff', '#000080', '#0000ff',
  '#800080', '#ff00ff', '#804000', '#ff8080',
]

function ColorSwatch({ color, selected, onClick, title }) {
  return (
    <button
      title={title || color}
      onClick={onClick}
      className={`w-7 h-7 rounded border-2 transition-transform hover:scale-110 ${
        selected ? 'border-blue-400 scale-110' : 'border-transparent'
      }`}
      style={{ backgroundColor: color }}
    />
  )
}

export default function Sidebar({
  primaryColor,
  secondaryColor,
  onPrimaryChange,
  onSecondaryChange,
  brushSize,
  onBrushSizeChange,
  opacity,
  onOpacityChange,
  onClear,
  onUndo,
  onRedo,
  onDownload,
}) {
  const handleHexInput = (e, setPrimary) => {
    const val = e.target.value
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      if (setPrimary) onPrimaryChange(val)
      else onSecondaryChange(val)
    }
  }

  return (
    <aside className="flex w-52 flex-col gap-4 overflow-y-auto bg-gray-800 p-3 text-sm text-gray-200">
      {/* ── Colors ── */}
      <section>
        <h3 className="mb-2 font-semibold uppercase tracking-wide text-gray-400 text-xs">
          Colors
        </h3>

        {/* primary / secondary color indicators */}
        <div className="relative mb-3 h-12">
          {/* secondary (background) */}
          <div
            className="absolute bottom-0 right-3 h-8 w-8 rounded border-2 border-gray-600"
            style={{ backgroundColor: secondaryColor }}
            title="Secondary color (right-click to use)"
          />
          {/* primary (foreground) */}
          <div
            className="absolute left-0 top-0 h-8 w-8 rounded border-2 border-white cursor-pointer"
            style={{ backgroundColor: primaryColor }}
            title="Primary color"
          />
        </div>

        {/* palette swatches */}
        <div className="grid grid-cols-5 gap-1">
          {PALETTE.map((c) => (
            <ColorSwatch
              key={c}
              color={c}
              selected={primaryColor === c}
              onClick={() => onPrimaryChange(c)}
            />
          ))}
        </div>

        {/* primary hex input */}
        <div className="mt-3">
          <label className="mb-1 block text-xs text-gray-400">Primary (hex)</label>
          <div className="flex gap-2">
            <input
              type="color"
              value={primaryColor}
              onChange={(e) => onPrimaryChange(e.target.value)}
              className="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
              title="Pick primary color"
            />
            <input
              type="text"
              defaultValue={primaryColor}
              key={primaryColor}
              maxLength={7}
              onBlur={(e) => handleHexInput(e, true)}
              onKeyDown={(e) => e.key === 'Enter' && handleHexInput(e, true)}
              className="w-full rounded bg-gray-700 px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* secondary hex input */}
        <div className="mt-2">
          <label className="mb-1 block text-xs text-gray-400">Secondary (hex)</label>
          <div className="flex gap-2">
            <input
              type="color"
              value={secondaryColor}
              onChange={(e) => onSecondaryChange(e.target.value)}
              className="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
              title="Pick secondary color"
            />
            <input
              type="text"
              defaultValue={secondaryColor}
              key={secondaryColor}
              maxLength={7}
              onBlur={(e) => handleHexInput(e, false)}
              onKeyDown={(e) => e.key === 'Enter' && handleHexInput(e, false)}
              className="w-full rounded bg-gray-700 px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </section>

      {/* ── Brush Settings ── */}
      <section>
        <h3 className="mb-2 font-semibold uppercase tracking-wide text-gray-400 text-xs">
          Brush Settings
        </h3>

        <div className="mb-3">
          <div className="mb-1 flex justify-between text-xs">
            <span>Size</span>
            <span className="font-mono">{brushSize}px</span>
          </div>
          <input
            type="range"
            min={1}
            max={80}
            value={brushSize}
            onChange={(e) => onBrushSizeChange(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
        </div>

        <div>
          <div className="mb-1 flex justify-between text-xs">
            <span>Opacity</span>
            <span className="font-mono">{opacity}%</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={opacity}
            onChange={(e) => onOpacityChange(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
        </div>
      </section>

      {/* ── Actions ── */}
      <section>
        <h3 className="mb-2 font-semibold uppercase tracking-wide text-gray-400 text-xs">
          Actions
        </h3>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onUndo}
            className="flex items-center justify-center gap-1 rounded bg-gray-700 px-2 py-1.5 text-xs hover:bg-gray-600 active:bg-gray-500"
            title="Undo (Ctrl+Z)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
            Undo
          </button>

          <button
            onClick={onRedo}
            className="flex items-center justify-center gap-1 rounded bg-gray-700 px-2 py-1.5 text-xs hover:bg-gray-600 active:bg-gray-500"
            title="Redo (Ctrl+Y)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M15 14l5-5-5-5" />
              <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
            </svg>
            Redo
          </button>

          <button
            onClick={onClear}
            className="col-span-2 flex items-center justify-center gap-1 rounded bg-red-700 px-2 py-1.5 text-xs hover:bg-red-600 active:bg-red-500"
            title="Clear canvas"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4h6v2" />
            </svg>
            Clear Canvas
          </button>

          <button
            onClick={onDownload}
            className="col-span-2 flex items-center justify-center gap-1 rounded bg-green-700 px-2 py-1.5 text-xs hover:bg-green-600 active:bg-green-500"
            title="Download as PNG"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download PNG
          </button>
        </div>
      </section>
    </aside>
  )
}
