// model3d.js — import dei modelli 3D e viste delle parti per Claude.
//
//   importModel(jobDir, modelPath, onProgress, { upAxis:'auto'|'y'|'z', signal }?) -> { glbPath, parts, meta }
//     Formati: .step .stp .iges .igs (occt-import-js, WASM), .glb .gltf, .obj, .stl.
//     Scrive <jobDir>/model.glb (un nodo per parte: nome = key, extras = { key, name, similar_group }),
//     <jobDir>/parts.json (PartsSummary, array) e <jobDir>/model.meta.json (unità, asse verticale scelto
//     e motivo, dimensioni: parts.json resta un array come da contratto).
//   renderPartViews(jobDir, parts, { max: 24, signal }) -> [{ key, label, file, path, keys }]
//   signal (AbortSignal, facoltativo): annullando si chiude il browser e si lancia un AbortError.
//     PNG 640x480 in <jobDir>/viste_parti/: vista d'insieme + un gruppo di parti identiche per vista
//     (parti in arancio, resto "fantasma", riquadro di dettaglio per i pezzi piccoli).
//
// Il lavoro si svolge in Chromium headless (three.js + occt-import-js serviti in locale, niente CDN).

import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import { startServer, standardMounts } from './server.js';
import { launchBrowser, openPage, withTimeout } from './browser.js';

export const MODEL_EXTENSIONS = ['step', 'stp', 'iges', 'igs', 'glb', 'gltf', 'obj', 'stl'];

const noop = () => {};

function safeProgress(onProgress) {
  let last = -1;
  return (pct, msg) => {
    if (typeof onProgress !== 'function') return;
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (p === last && !msg) return;
    last = p;
    try { onProgress(p, msg); } catch { /* il chiamante non deve interrompere il lavoro */ }
  };
}

/** messaggio d'errore pulito (senza prefissi di Playwright ne' stack della pagina) */
function cleanError(e) {
  const msg = String((e && e.message) || e)
    .replace(/^(page\.evaluate|page\.goto|locator\.\w+):\s*/i, '')
    .replace(/^Error:\s*/, '')
    .split(/\n\s+at\s/)[0]
    .trim();
  return new Error(msg);
}

function abortError(what) {
  const e = new Error(`${what} annullata.`);
  e.name = 'AbortError';
  e.code = 'cancelled';
  return e;
}

async function withPage({ jobDir, extraMounts = [], uploadAllow, log, signal, what = 'Operazione' }, fn) {
  if (signal?.aborted) throw abortError(what);
  const server = await startServer({
    mounts: [...standardMounts(), { prefix: '/job/', dir: jobDir }, ...extraMounts],
    upload: { dir: jobDir, allow: uploadAllow },
  });
  let browser = null;
  // annullando si chiude subito il browser: la pagina smette di lavorare (e di scrivere nella cartella del lavoro)
  const onAbort = () => { if (browser) browser.close().catch(noop); server.close().catch(noop); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    browser = await launchBrowser({ needWebGL: true });
    if (signal?.aborted) throw abortError(what);
    const { page } = await openPage(browser, `${server.base}/engine/import.html`, { width: 800, height: 600, log });
    return await fn(page, server);
  } catch (e) {
    if (signal?.aborted) throw abortError(what);
    throw cleanError(e);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (browser) await browser.close().catch(noop);
    await server.close().catch(noop);
  }
}

/**
 * Importa e normalizza un modello 3D.
 * @param {string} jobDir
 * @param {string} modelPath   file 3D (di solito <jobDir>/modello/<file>)
 * @param {(pct:number, msg:string)=>void} [onProgress]
 * @param {{ upAxis?: 'auto'|'y'|'z', log?: (s:string)=>void, signal?: AbortSignal }} [options]
 */
export async function importModel(jobDir, modelPath, onProgress, options = {}) {
  const progress = safeProgress(onProgress);
  if (!jobDir || !modelPath) throw new Error('importModel: cartella del lavoro e file 3D sono obbligatori');
  const abs = path.resolve(modelPath);
  if (!existsSync(abs)) throw new Error('File 3D non trovato: ' + path.basename(abs));
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!MODEL_EXTENSIONS.includes(ext)) {
    throw new Error(`Formato 3D non supportato (.${ext}). Formati ammessi: STEP/STP, IGES/IGS, GLB/GLTF, OBJ, STL.`);
  }
  const st = await fsp.stat(abs);
  if (!st.size) throw new Error('Il file 3D è vuoto.');
  await fsp.mkdir(jobDir, { recursive: true });
  progress(1, 'Preparazione del lettore 3D…');

  const srcDir = path.dirname(abs);
  const result = await withPage({
    jobDir,
    extraMounts: [{ prefix: '/src/', dir: srcDir }],
    uploadAllow: (name) => name === 'model.glb',
    log: options.log,
    signal: options.signal,
    what: 'Lettura del modello 3D',
  }, async (page) => {
    await page.exposeFunction('__progress', (pct, msg) => progress(pct * 0.97, msg));
    const url = '/src/' + encodeURIComponent(path.basename(abs));
    const timeout = Math.max(5 * 60000, Math.min(30 * 60000, st.size / 1e6 * 60000));   // ~1 min per MB, 5–30 min
    return withTimeout(
      page.evaluate((o) => window.importModel(o), { url, ext, fileName: path.basename(abs), upAxis: options.upAxis || 'auto' }),
      timeout, 'l’import del modello 3D');
  });

  if (options.signal?.aborted) throw abortError('Lettura del modello 3D');
  const glbPath = path.join(jobDir, 'model.glb');
  if (!existsSync(glbPath)) throw new Error('Il modello normalizzato (model.glb) non è stato scritto.');
  await fsp.writeFile(path.join(jobDir, 'parts.json'), JSON.stringify(result.parts, null, 2) + '\n');
  await fsp.writeFile(path.join(jobDir, 'model.meta.json'), JSON.stringify({ ...result.meta, created_at: new Date().toISOString() }, null, 2) + '\n');
  progress(100, `Modello 3D pronto: ${result.meta.part_count} ${result.meta.part_count === 1 ? 'parte' : 'parti'}`);
  return { glbPath, parts: result.parts, meta: result.meta };
}

/**
 * Viste PNG per riconoscere le parti.
 * @param {string} jobDir
 * @param {object[]} [parts]  PartsSummary (se assente si legge parts.json)
 * @param {{ max?: number, width?: number, height?: number, theme?: object, onProgress?: Function, signal?: AbortSignal }} [opts]
 */
export async function renderPartViews(jobDir, parts, opts = {}) {
  const { max = 24, width = 640, height = 480, theme = null } = opts;
  const progress = safeProgress(opts.onProgress);
  const glb = path.join(jobDir, 'model.glb');
  if (!existsSync(glb)) throw new Error('Manca il modello normalizzato (model.glb): importare prima il file 3D.');
  if (!Array.isArray(parts) || !parts.length) {
    try { parts = JSON.parse(await fsp.readFile(path.join(jobDir, 'parts.json'), 'utf8')); } catch { parts = null; }
  }
  if (!Array.isArray(parts) || !parts.length) throw new Error('Elenco delle parti (parts.json) mancante o vuoto.');
  const dir = 'viste_parti';
  await fsp.rm(path.join(jobDir, dir), { recursive: true, force: true });
  const views = await withPage({
    jobDir,
    uploadAllow: (name) => name.startsWith(dir + '/') && /^[\w.\-/]+\.png$/.test(name) && name.split('/').length === 2,
    log: opts.log,
    signal: opts.signal,
    what: 'Preparazione delle viste delle parti',
  }, async (page) => {
    await page.exposeFunction('__progress', (pct, msg) => progress(pct, msg));
    return withTimeout(page.evaluate((o) => window.renderViews(o), {
      glbUrl: '/job/model.glb', parts, max: Math.max(1, Math.min(60, max | 0 || 24)), width, height, theme, dir,
    }), 15 * 60000, 'il disegno delle viste delle parti');
  });
  return views.map((v) => ({ ...v, path: path.join(jobDir, ...v.file.split('/')) }));
}
