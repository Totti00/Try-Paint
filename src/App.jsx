import { useState, useRef, useEffect, useCallback } from 'react'
import Canvas from './components/Canvas'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'

export default function App() {
  const [activeTool, setActiveTool] = useState('brush')
  const [primaryColor, setPrimaryColor] = useState('#000000')
  const [secondaryColor, setSecondaryColor] = useState('#ffffff')
  const [brushSize, setBrushSize] = useState(6)
  const [opacity, setOpacity] = useState(100)

  const canvasRef = useRef(null)

  // keyboard shortcuts
  const handleKeyDown = useCallback((e) => {
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault()
      canvasRef.current?.undo()
    } else if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === 'y' || (e.shiftKey && e.key === 'z'))
    ) {
      e.preventDefault()
      canvasRef.current?.redo()
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-white">
      {/* ── Header ── */}
      <header className="flex items-center gap-3 bg-gray-900 px-4 py-2 shadow">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-6 w-6 text-blue-400"
        >
          <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-.999 2-2 3s1 3 3 3z" />
        </svg>
        <h1 className="text-lg font-bold tracking-wide">Try-Paint</h1>
        <span className="ml-auto text-xs text-gray-500 hidden sm:block">
          Left-click = primary color · Right-click = secondary color · Ctrl+Z / Ctrl+Y = undo/redo
        </span>
      </header>

      {/* ── Main area ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tool sidebar */}
        <Toolbar activeTool={activeTool} onToolChange={setActiveTool} />

        {/* Canvas */}
        <Canvas
          ref={canvasRef}
          activeTool={activeTool}
          primaryColor={primaryColor}
          secondaryColor={secondaryColor}
          brushSize={brushSize}
          opacity={opacity}
        />

        {/* Settings sidebar */}
        <Sidebar
          primaryColor={primaryColor}
          secondaryColor={secondaryColor}
          onPrimaryChange={setPrimaryColor}
          onSecondaryChange={setSecondaryColor}
          brushSize={brushSize}
          onBrushSizeChange={setBrushSize}
          opacity={opacity}
          onOpacityChange={setOpacity}
          onClear={() => canvasRef.current?.clearCanvas()}
          onUndo={() => canvasRef.current?.undo()}
          onRedo={() => canvasRef.current?.redo()}
          onDownload={() => canvasRef.current?.downloadImage()}
        />
      </div>
    </div>
  )
}
