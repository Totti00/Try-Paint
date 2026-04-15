# Try-Paint

A web-based paint application that replicates the core functionality of classic Windows Paint, built with **React 19** and **Tailwind CSS v4**, powered by **Vite**.

---

## Features

| Feature | Details |
|---|---|
| **Drawing Tools** | Brush, Eraser, Line, Rectangle, Circle |
| **Color Picker** | 20-color palette, primary & secondary colors, native color picker, custom hex input |
| **Brush Settings** | Size slider (1–80 px) and Opacity slider (1–100 %) |
| **Canvas Actions** | Clear Canvas, Undo / Redo (up to 50 steps), Download as PNG |
| **Keyboard Shortcuts** | `Ctrl+Z` undo · `Ctrl+Y` or `Ctrl+Shift+Z` redo |
| **Mouse Buttons** | Left-click = primary color · Right-click = secondary color |
| **Touch Support** | Basic touch drawing on mobile/tablet |

---

## Tech Stack

- [React 19](https://react.dev/) – `useState`, `useRef`, `useCallback`, `useImperativeHandle`
- [Tailwind CSS v4](https://tailwindcss.com/) (via `@tailwindcss/vite`)
- [Vite 8](https://vitejs.dev/) – development server & bundler
- HTML5 Canvas API

---

## Project Structure

```
Try-Paint/
├── index.html
├── vite.config.js
├── package.json
└── src/
    ├── main.jsx          # React entry point
    ├── index.css         # Tailwind CSS import
    ├── App.jsx           # Root component (state management)
    └── components/
        ├── Canvas.jsx    # HTML5 Canvas engine (drawing, undo/redo)
        ├── Toolbar.jsx   # Tool-selection sidebar
        └── Sidebar.jsx   # Color picker, brush settings, action buttons
```

---

## Installation & Usage

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- npm ≥ 9

### 1. Clone the repository

```bash
git clone https://github.com/Totti00/Try-Paint.git
cd Try-Paint
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the development server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### 4. Build for production

```bash
npm run build
```

The optimised output will be in the `dist/` folder.

### 5. Preview the production build

```bash
npm run preview
```

---

## License

MIT
