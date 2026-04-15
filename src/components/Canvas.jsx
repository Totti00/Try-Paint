import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'

const TOOLS = {
  BRUSH: 'brush',
  ERASER: 'eraser',
  LINE: 'line',
  RECTANGLE: 'rectangle',
  CIRCLE: 'circle',
}

const Canvas = forwardRef(function Canvas(
  { activeTool, primaryColor, secondaryColor, brushSize, opacity },
  ref,
) {
  const canvasRef = useRef(null)
  const isDrawing = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const snapshotRef = useRef(null)

  // undo / redo stacks
  const undoStack = useRef([])
  const redoStack = useRef([])

  // save current canvas state to the undo stack
  const saveState = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    undoStack.current.push(canvas.toDataURL())
    // cap history at 50 steps
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = []
  }, [])

  const restoreState = useCallback((dataURL) => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const img = new Image()
    img.src = dataURL
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
    }
  }, [])

  // expose imperative API to parent via ref
  useImperativeHandle(ref, () => ({
    undo() {
      if (undoStack.current.length === 0) return
      const canvas = canvasRef.current
      redoStack.current.push(canvas.toDataURL())
      const prev = undoStack.current.pop()
      restoreState(prev)
    },
    redo() {
      if (redoStack.current.length === 0) return
      const canvas = canvasRef.current
      undoStack.current.push(canvas.toDataURL())
      const next = redoStack.current.pop()
      restoreState(next)
    },
    clearCanvas() {
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')
      saveState()
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    },
    downloadImage() {
      const canvas = canvasRef.current
      const link = document.createElement('a')
      link.download = 'painting.png'
      link.href = canvas.toDataURL('image/png')
      link.click()
    },
    canUndo: () => undoStack.current.length > 0,
    canRedo: () => redoStack.current.length > 0,
  }))

  // initialise canvas once on mount
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }, [])

  const getPos = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    if (e.touches) {
      return {
        x: (e.touches[0].clientX - rect.left) * scaleX,
        y: (e.touches[0].clientY - rect.top) * scaleY,
      }
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const startDrawing = useCallback(
    (e) => {
      e.preventDefault()
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')
      const pos = getPos(e)
      isDrawing.current = true
      lastPos.current = pos

      // save snapshot for shape previews
      snapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height)
      saveState()
    },
    [saveState],
  )

  const draw = useCallback(
    (e) => {
      if (!isDrawing.current) return
      e.preventDefault()
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')
      const pos = getPos(e)

      ctx.globalAlpha = opacity / 100
      ctx.lineWidth = brushSize
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      const color = e.buttons === 2 || e.button === 2 ? secondaryColor : primaryColor

      if (activeTool === TOOLS.BRUSH) {
        ctx.strokeStyle = color
        ctx.globalCompositeOperation = 'source-over'
        ctx.beginPath()
        ctx.moveTo(lastPos.current.x, lastPos.current.y)
        ctx.lineTo(pos.x, pos.y)
        ctx.stroke()
        lastPos.current = pos
      } else if (activeTool === TOOLS.ERASER) {
        ctx.globalCompositeOperation = 'destination-out'
        ctx.beginPath()
        ctx.moveTo(lastPos.current.x, lastPos.current.y)
        ctx.lineTo(pos.x, pos.y)
        ctx.stroke()
        lastPos.current = pos
      } else {
        // shape tools: restore snapshot then draw preview
        ctx.putImageData(snapshotRef.current, 0, 0)
        ctx.globalCompositeOperation = 'source-over'
        ctx.strokeStyle = color
        ctx.fillStyle = color

        if (activeTool === TOOLS.LINE) {
          ctx.beginPath()
          ctx.moveTo(lastPos.current.x, lastPos.current.y)
          ctx.lineTo(pos.x, pos.y)
          ctx.stroke()
        } else if (activeTool === TOOLS.RECTANGLE) {
          ctx.strokeRect(
            lastPos.current.x,
            lastPos.current.y,
            pos.x - lastPos.current.x,
            pos.y - lastPos.current.y,
          )
        } else if (activeTool === TOOLS.CIRCLE) {
          const radiusX = Math.abs(pos.x - lastPos.current.x) / 2
          const radiusY = Math.abs(pos.y - lastPos.current.y) / 2
          const centerX = lastPos.current.x + (pos.x - lastPos.current.x) / 2
          const centerY = lastPos.current.y + (pos.y - lastPos.current.y) / 2
          ctx.beginPath()
          ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    },
    [activeTool, primaryColor, secondaryColor, brushSize, opacity],
  )

  const stopDrawing = useCallback(() => {
    if (!isDrawing.current) return
    isDrawing.current = false
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    snapshotRef.current = null
  }, [])

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto bg-gray-200 p-4">
      <canvas
        ref={canvasRef}
        width={1200}
        height={800}
        className="cursor-crosshair rounded shadow-lg"
        style={{ maxWidth: '100%', maxHeight: '100%', background: '#fff' }}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
        onTouchStart={startDrawing}
        onTouchMove={draw}
        onTouchEnd={stopDrawing}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  )
})

export default Canvas
