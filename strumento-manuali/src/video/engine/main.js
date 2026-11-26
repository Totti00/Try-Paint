// main.js — avvio della pagina video: legge /config.json (preparato da render.js), applica il tema,
// carica i font e crea il motore della modalita' richiesta ('3d' o 'immagini').
//
// Espone: window.ready (Promise), window.renderAt(t) (posa tutto per l'istante t e disegna in modo
// sincrono e deterministico), window.getDuration(), window.getInfo() { duration, posterTime, chapters, tags, warnings }.
// Parametri URL: ?config=/altro.json  ?render (nessuna anteprima interattiva)  ?t=12.5

import { resolveTheme, applyThemeCss } from './text.js';

const qs = new URLSearchParams(location.search);

async function loadFonts() {
  const specs = [
    '400 30px "Barlow"', '500 30px "Barlow"', '600 30px "Barlow"', '700 30px "Barlow"',
    '500 30px "Barlow Semi Condensed"', '600 30px "Barlow Semi Condensed"', '700 30px "Barlow Semi Condensed"', '800 30px "Barlow Semi Condensed"',
    '600 30px "Barlow Condensed"', '700 30px "Barlow Condensed"', '800 30px "Barlow Condensed"',
  ];
  await Promise.all(specs.map((f) => document.fonts.load(f, 'Aàèéìòù×—’0123456789ĂŁ').catch(() => {})));
  await document.fonts.ready;
}

async function init() {
  const res = await fetch(qs.get('config') || '/config.json');
  if (!res.ok) throw new Error('configurazione del video non trovata');
  const cfg = await res.json();
  const W = +cfg.width || window.innerWidth || 1920;
  const H = +cfg.height || window.innerHeight || 1080;
  document.body.classList.add('mode-' + (cfg.mode === '3d' ? '3d' : 'immagini'));
  const theme = resolveTheme(cfg.theme);
  applyThemeCss(theme);
  await loadFonts();
  const stage = document.getElementById('stage');
  stage.style.transform = `scale(${W / 1920})`;

  const mod = cfg.mode === '3d' ? await import('./mode3d.js') : await import('./modeImages.js');
  const engine = await mod.createEngine({ cfg, theme, stage, W, H });

  window.renderAt = (t) => { engine.renderAt(Math.max(0, Math.min(engine.duration, +t || 0))); return t; };
  window.getDuration = () => engine.duration;
  window.getInfo = () => ({ duration: engine.duration, posterTime: engine.posterTime, chapters: engine.chapters || [], tags: engine.tags || [], warnings: engine.warnings || [] });
  window.renderAt(+qs.get('t') || 0);
  if (!qs.has('render')) startPreview(window.renderAt, engine.duration);
  return true;
}

/** anteprima interattiva nel browser: spazio = pausa, frecce = ±2 s */
function startPreview(renderAt, duration) {
  const bar = document.createElement('input');
  Object.assign(bar, { type: 'range', min: 0, max: duration, step: 0.01, value: 0 });
  Object.assign(bar.style, { position: 'fixed', left: '2%', bottom: '6px', width: '96%', zIndex: 10, opacity: 0.6 });
  document.body.appendChild(bar);
  let t = +qs.get('t') || 0, playing = true, last = performance.now();
  bar.addEventListener('input', () => { t = +bar.value; });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') playing = !playing;
    if (e.code === 'ArrowRight') t = Math.min(duration, t + 2);
    if (e.code === 'ArrowLeft') t = Math.max(0, t - 2);
  });
  const loop = (now) => {
    if (playing) t = (t + (now - last) / 1000) % duration;
    last = now;
    bar.value = t;
    renderAt(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

window.ready = init().catch((e) => {
  console.error(e);
  window.initError = String((e && e.message) || e);
  throw e;
});
