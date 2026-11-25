// render.js — generazione del video di montaggio.
//
//   renderVideo(jobDir, { mode:'3d'|'immagini', manual, plan, glbPath, quality:'1080p'|'720p'|'anteprima',
//                         theme, onProgress, workers?, signal?, log? })
//     -> { videoPath: <jobDir>/out/video.mp4, posterPath: <jobDir>/out/poster.jpg, duration, frames, width, height, fps }
//
// Un piccolo server locale serve il motore (src/video/engine), three.js, i font e i file del lavoro;
// Chromium headless (Playwright) apre la pagina, chiama window.renderAt(i / fps) per ogni fotogramma,
// cattura il viewport e invia i JPEG a ffmpeg-static (libx264, yuv420p, +faststart). Con 2 pagine in
// parallelo ogni pagina produce un segmento; i segmenti vengono poi uniti senza ricodifica.

import { promises as fsp, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualData, AnimationPlan } from '../schema.js';
import { startServer, standardMounts } from './server.js';
import { launchBrowser, openPage, startEncoder, runFfmpeg } from './browser.js';
import { renameWithRetry } from '../fsutil.js';

export const QUALITIES = {
  '1080p': { width: 1920, height: 1080, fps: 30, crf: 20, jpeg: 92, preset: 'medium' },
  '720p': { width: 1280, height: 720, fps: 30, crf: 21, jpeg: 90, preset: 'medium' },
  anteprima: { width: 960, height: 540, fps: 15, crf: 23, jpeg: 88, preset: 'veryfast' },
};

const noop = () => {};

function fmtEta(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 50) return `circa ${Math.max(5, Math.round(sec / 5) * 5)} s`;
  const m = Math.round(sec / 60);
  return m <= 1 ? 'circa 1 min' : `circa ${m} min`;
}

/** id delle immagini citate dal manuale */
function referencedImages(manual) {
  const ids = new Set();
  const add = (id) => { if (id) ids.add(id); };
  add(manual.cover_image_id); add(manual.brand_logo_image_id);
  for (const h of manual.hardware || []) add(h.image_id);
  for (const c of manual.components || []) add(c.image_id);
  for (const s of manual.steps || []) for (const id of s.image_ids || []) add(id);
  for (const n of manual.notes || []) add(n.image_id);
  return [...ids];
}

/** file dell'immagine nel lavoro (versione per la stampa, altrimenti quella estratta) */
function findImage(jobDir, id) {
  if (!/^[\w.-]+$/.test(id)) return null;
  for (const rel of [['immagini', 'final', id + '.png'], ['immagini', 'final', id + '.jpg'], ['immagini', 'final', id + '.jpeg'], ['estratte', id + '.png'], ['estratte', id + '.jpg']]) {
    if (existsSync(path.join(jobDir, ...rel))) return rel.join('/');
  }
  return null;
}

function zodMessage(err) {
  return (err.issues || []).slice(0, 4).map((i) => `${(i.path || []).join('.') || '(radice)'}: ${i.message}`).join('; ');
}

/** valida gli input e prepara configurazione + server locale (comune a video e fotogrammi singoli) */
async function prepareSession(jobDir, opts) {
  const { mode = 'immagini', manual, plan = null, glbPath = null, quality = '1080p', theme = null } = opts;
  if (!jobDir) throw new Error('renderVideo: cartella del lavoro mancante');
  if (mode !== '3d' && mode !== 'immagini') throw new Error(`Modalità video non valida: ${mode} (usare '3d' o 'immagini')`);
  const Q = QUALITIES[quality];
  if (!Q) throw new Error(`Qualità non valida: ${quality} (usare '1080p', '720p' o 'anteprima')`);
  const mres = ManualData.safeParse(manual);
  if (!mres.success) throw new Error('Dati del manuale non validi per il video: ' + zodMessage(mres.error));
  const man = mres.data;

  let parts = null, glbFile = null, planData = null;
  if (mode === '3d') {
    if (!plan) throw new Error('Per il video 3D serve il piano dell’animazione (plan.json).');
    const pres = AnimationPlan.safeParse(plan);
    if (!pres.success) throw new Error('Piano dell’animazione non valido: ' + zodMessage(pres.error));
    planData = pres.data;
    glbFile = path.resolve(glbPath || path.join(jobDir, 'model.glb'));
    if (!existsSync(glbFile)) throw new Error('Manca il modello 3D normalizzato (model.glb): importare prima il file 3D.');
    const partsFile = path.join(path.dirname(glbFile), 'parts.json');
    try { parts = JSON.parse(await fsp.readFile(partsFile, 'utf8')); } catch { parts = null; }
    if (!Array.isArray(parts) || !parts.length) throw new Error('Manca l’elenco delle parti (parts.json) accanto a model.glb.');
  }
  const images = {};
  for (const id of referencedImages(man)) {
    const rel = findImage(jobDir, id);
    if (rel) images[id] = { url: '/job/' + rel.split('/').map(encodeURIComponent).join('/') };
  }
  const config = {
    mode, width: Q.width, height: Q.height, fps: Q.fps, quality,
    theme: theme || null, manual: man, plan: planData, parts,
    glbUrl: glbFile ? '/glb/' + encodeURIComponent(path.basename(glbFile)) : null,
    images,
  };
  const mounts = [...standardMounts(), { prefix: '/job/', dir: path.resolve(jobDir) }];
  if (glbFile) mounts.push({ prefix: '/glb/', dir: path.dirname(glbFile) });
  const server = await startServer({ mounts, memory: { '/config.json': { body: JSON.stringify(config) } } });
  return { Q, config, server, mode };
}

/**
 * Singoli fotogrammi PNG (verifiche, anteprime nell'interfaccia).
 * @param {number[]} times  istanti in secondi
 * @returns {Promise<{ files: string[], duration: number, chapters: object[] }>}
 */
export async function renderStills(jobDir, opts, times, outDir) {
  await fsp.mkdir(outDir, { recursive: true });
  const { Q, server, mode } = await prepareSession(jobDir, opts);
  let browser = null;
  try {
    browser = await launchBrowser({ needWebGL: mode === '3d' });
    const { page } = await openPage(browser, `${server.base}/engine/index.html?render`, { width: Q.width, height: Q.height, log: opts.log, timeoutMs: 10 * 60000 });
    const info = await page.evaluate(() => window.getInfo());
    const files = [];
    for (const t of times) {
      await page.evaluate((x) => window.renderAt(x), t);
      const f = path.join(outDir, `still_${t.toFixed(2).padStart(6, '0')}.png`);
      await fsp.writeFile(f, await page.screenshot({ type: 'png' }));
      files.push(f);
    }
    return { files, duration: info.duration, chapters: info.chapters, warnings: info.warnings };
  } finally {
    if (browser) await browser.close().catch(noop);
    await server.close().catch(noop);
  }
}

/**
 * Genera <jobDir>/out/video.mp4 e <jobDir>/out/poster.jpg.
 * @param {string} jobDir
 * @param {{ mode:'3d'|'immagini', manual:object, plan?:object, glbPath?:string, quality?:'1080p'|'720p'|'anteprima',
 *           theme?:object, onProgress?:(pct:number, msg:string)=>void, workers?:number, signal?:AbortSignal, log?:(s:string)=>void }} opts
 */
export async function renderVideo(jobDir, opts = {}) {
  const { onProgress = null, signal = null, log = null } = opts;
  const progress = (pct, msg) => { if (typeof onProgress === 'function') { try { onProgress(Math.max(0, Math.min(100, Math.round(pct))), msg); } catch { /* ignora */ } } };
  const outDir = path.join(jobDir, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  const { Q, server, mode } = await prepareSession(jobDir, opts);
  const videoPath = path.join(outDir, 'video.mp4');
  const posterPath = path.join(outDir, 'poster.jpg');
  const tmpVideo = path.join(outDir, `video.tmp-${process.pid}-${Date.now()}.mp4`);
  const tmpPoster = path.join(outDir, `poster.tmp-${process.pid}-${Date.now()}.jpg`);

  let browser = null;
  const encoders = [];
  const segFiles = [];
  try {
    progress(1, 'Avvio del motore di rendering…');
    browser = await launchBrowser({ needWebGL: mode === '3d' });
    const pageUrl = `${server.base}/engine/index.html?render`;
    const open = () => openPage(browser, pageUrl, { width: Q.width, height: Q.height, log, timeoutMs: 10 * 60000 });
    const first = await open();
    const info = await first.page.evaluate(() => window.getInfo());
    if (!(info.duration > 0)) throw new Error('Il video risulta vuoto (durata 0).');
    if (log && info.warnings && info.warnings.length) for (const w of info.warnings) log('[video] ' + w);
    const total = Math.max(1, Math.round(info.duration * Q.fps));
    const autoWorkers = total > 240 && os.cpus().length >= 4 ? 2 : 1;
    const nWorkers = Math.max(1, Math.min(4, opts.workers || autoWorkers));
    progress(3, `Fotogramma 0 / ${total}`);

    const pages = [first.page];
    for (let w = 1; w < nWorkers; w++) pages.push((await open()).page);
    const per = Math.ceil(total / nWorkers);
    let doneFrames = 0;
    const t0 = Date.now();
    let lastReport = 0;
    const report = () => {
      const now = Date.now();
      if (now - lastReport < 700 && doneFrames < total) return;
      lastReport = now;
      const el = (now - t0) / 1000;
      const eta = doneFrames > 5 ? (total - doneFrames) * el / doneFrames : NaN;
      progress(3 + 92 * doneFrames / total, `Fotogramma ${doneFrames} / ${total}${eta ? ' · ' + fmtEta(eta) : ''}`);
    };
    const runSegment = async (page, a, b, file) => {
      const enc = startEncoder(file, { fps: Q.fps, crf: Q.crf, preset: Q.preset });
      encoders.push(enc);
      for (let i = a; i < b; i++) {
        if (signal && signal.aborted) throw new Error('Generazione del video annullata.');
        await page.evaluate((t) => window.renderAt(t), i / Q.fps);
        const buf = await page.screenshot({ type: 'jpeg', quality: Q.jpeg });
        await enc.write(buf);
        doneFrames++;
        report();
      }
      await enc.end();
    };
    const jobs = [];
    for (let w = 0; w < nWorkers; w++) {
      const a = w * per, b = Math.min(total, a + per);
      if (a >= b) continue;
      const file = nWorkers === 1 ? tmpVideo : path.join(outDir, `seg${w}-${process.pid}.mp4`);
      if (nWorkers > 1) segFiles.push(file);
      jobs.push(runSegment(pages[w], a, b, file));
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;

    if (nWorkers > 1) {
      progress(96, 'Unione dei segmenti video…');
      const list = path.join(outDir, `segments-${process.pid}.txt`);
      await fsp.writeFile(list, segFiles.map((f) => `file '${f.split(path.sep).join('/').replace(/'/g, "'\\''")}'`).join('\n'));
      const r = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', tmpVideo]);
      await fsp.rm(list, { force: true });
      if (r.code !== 0) throw new Error('Unione dei segmenti video non riuscita: ' + r.stderr.trim().split('\n').slice(-2).join(' '));
    }

    progress(98, 'Immagine di anteprima…');
    await first.page.evaluate((t) => window.renderAt(t), info.posterTime || 0);
    // copertina in un file temporaneo, rinominata solo dopo il video: in caso di errore restano coerenti
    await fsp.writeFile(tmpPoster, await first.page.screenshot({ type: 'jpeg', quality: 90 }));
    await renameWithRetry(tmpVideo, videoPath);
    await renameWithRetry(tmpPoster, posterPath).catch((e) => { if (log) log('[video] copertina non aggiornata: ' + (e?.message || e)); });
    const secs = (Date.now() - t0) / 1000;
    progress(100, `Video pronto (${Math.round(info.duration)} s, generato in ${Math.round(secs)} s)`);
    return {
      videoPath, posterPath, duration: total / Q.fps, frames: total, width: Q.width, height: Q.height, fps: Q.fps,
      workers: nWorkers, renderSeconds: secs, chapters: info.chapters, warnings: info.warnings || [],
    };
  } finally {
    for (const e of encoders) e.kill();
    if (browser) await browser.close().catch(noop);
    await server.close().catch(noop);
    for (const f of segFiles) await fsp.rm(f, { force: true }).catch(noop);
    await fsp.rm(tmpVideo, { force: true }).catch(noop);
    await fsp.rm(tmpPoster, { force: true }).catch(noop);
  }
}
