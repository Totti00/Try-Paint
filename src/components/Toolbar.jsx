const tools = [
  {
    id: 'brush',
    label: 'Brush',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-.999 2-2 3s1 3 3 3z" />
      </svg>
    ),
  },
  {
    id: 'eraser',
    label: 'Eraser',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <path d="M20 20H7L3 16l13.5-13.5a2 2 0 0 1 2.83 0l2.17 2.17a2 2 0 0 1 0 2.83L9 20" />
        <path d="M6.5 17.5 3 21" />
      </svg>
    ),
  },
  {
    id: 'line',
    label: 'Line',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <line x1="5" y1="19" x2="19" y2="5" />
      </svg>
    ),
  },
  {
    id: 'rectangle',
    label: 'Rectangle',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </svg>
    ),
  },
  {
    id: 'circle',
    label: 'Circle',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
  },
]

export default function Toolbar({ activeTool, onToolChange }) {
  return (
    <aside className="flex flex-col gap-1 bg-gray-800 p-2 pt-3">
      {tools.map((tool) => (
        <button
          key={tool.id}
          title={tool.label}
          onClick={() => onToolChange(tool.id)}
          className={`flex flex-col items-center justify-center gap-0.5 rounded p-2 text-xs transition-colors ${
            activeTool === tool.id
              ? 'bg-blue-500 text-white'
              : 'text-gray-300 hover:bg-gray-700 hover:text-white'
          }`}
        >
          {tool.icon}
          <span className="text-[10px] leading-none">{tool.label}</span>
        </button>
      ))}
    </aside>
  )
}
