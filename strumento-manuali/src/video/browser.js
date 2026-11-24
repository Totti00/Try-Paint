// Avvio di Chromium (Playwright) e di ffmpeg (ffmpeg-static), con messaggi d'errore in italiano.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SOFTWARE_GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    throw new Error('Il modulo Playwright non è installato: eseguire «npm install» nella cartella dello strumento.');
  }
}

function friendlyLaunchError(e) {
  const msg = String((e && e.message) || e);
  if (/Executable doesn't exist|browserType\.launch: .*not found|playwright install/i.test(msg)) {
    return new Error('Il browser Chromium usato per il rendering non è installato. Eseguire una volta: «npx playwright install chromium» (oppure «npm run setup»).');
  }
  return new Error('Impossibile avviare Chromium per il rendering: ' + msg.split('\n')[0]);
}

/**
 * Avvia Chromium headless con WebGL funzionante.
 * Prima prova la configurazione predefinita (usa la GPU se disponibile); se WebGL non è
 * disponibile, riprova con il rendering software SwiftShader. MANUALI_VIDEO_GL=software forza
 * subito il rendering software.
 */
export async function launchBrowser({ needWebGL = true } = {}) {
  const { chromium } = loadPlaywright();
  const forceSoftware = String(process.env.MANUALI_VIDEO_GL || '').toLowerCase() === 'software';
  const attempts = forceSoftware ? [SOFTWARE_GL_ARGS] : [[], SOFTWARE_GL_ARGS];
  let lastErr = null;
  for (const args of attempts) {
    let browser;
    try {
      browser = await chromium.launch({ args });
    } catch (e) {
      throw friendlyLaunchError(e);
    }
    if (!needWebGL) return browser;
    try {
      const page = await browser.newPage();
      const ok = await page.evaluate(() => {
        try {
          const c = document.createElement('canvas');
          return !!(c.getContext('webgl2') || c.getContext('webgl'));
        } catch { return false; }
      });
      await page.close();
      if (ok) return browser;
      lastErr = new Error('WebGL non disponibile');
    } catch (e) {
      lastErr = e;
    }
    await browser.close().catch(() => {});
  }
  throw new Error('WebGL non è disponibile in Chromium su questo computer (' + (lastErr && lastErr.message) + '). Il video 3D non può essere generato.');
}

/**
 * Apre una pagina e ne inoltra gli errori; attende window.ready.
 * @returns {Promise<{page, errors:string[]}>}
 */
export async function openPage(browser, url, { width = 1280, height = 720, timeoutMs = 180000, log = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (/GL Driver Message|GPU stall|Automatic fallback to software WebGL/i.test(text)) return;
    if (t === 'error') { errors.push(text); if (log) log('[pagina] ' + text); }
    else if (t === 'warning' && log) log('[pagina] ' + text);
  });
  page.on('pageerror', (e) => { errors.push(e.message); if (log) log('[pagina] ' + e.message); });
  page.setDefaultTimeout(timeoutMs);
  await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  try {
    await withTimeout(page.evaluate(() => window.ready), timeoutMs, 'preparazione della pagina di rendering');
  } catch (e) {
    const detail = await page.evaluate(() => window.initError || null).catch(() => null);
    await page.close().catch(() => {});
    throw new Error(String(detail || e.message || e).split('\n')[0]);
  }
  return { page, errors };
}

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Tempo scaduto durante ${what}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------- ffmpeg

export function ffmpegPath() {
  let p = null;
  try { p = require('ffmpeg-static'); } catch { p = null; }
  if (!p) throw new Error('ffmpeg non è disponibile (pacchetto ffmpeg-static mancante o non supportato su questo sistema): eseguire «npm install».');
  return p;
}

/** esegue ffmpeg e restituisce { code, stderr } */
export function runFfmpeg(args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    let ff;
    try {
      ff = spawn(ffmpegPath(), args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) { reject(e); return; }
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    ff.on('error', (e) => reject(new Error('Impossibile avviare ffmpeg: ' + e.message)));
    ff.on('close', (code) => resolve({ code, stderr }));
    if (input) { ff.stdin.on('error', () => {}); ff.stdin.end(input); }
  });
}

/**
 * Avvia un encoder H.264 che riceve JPEG sullo stdin.
 * @returns {{ write:(buf)=>Promise<void>, end:()=>Promise<void>, kill:()=>void }}
 */
export function startEncoder(outFile, { fps, crf = 20, preset = 'medium' }) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-movflags', '+faststart', outFile,
  ];
  const ff = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  let failed = null;
  ff.stderr.on('data', (d) => { stderr += d; if (stderr.length > 100000) stderr = stderr.slice(-50000); });
  const done = new Promise((resolve, reject) => {
    ff.on('error', (e) => { failed = e; reject(new Error('Impossibile avviare ffmpeg: ' + e.message)); });
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else { failed = new Error('ffmpeg ha terminato con errore (' + code + '): ' + stderr.trim().split('\n').slice(-3).join(' ')); reject(failed); }
    });
  });
  done.catch(() => {});
  ff.stdin.on('error', (e) => { if (!failed) failed = e; });
  return {
    write(buf) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        const ok = ff.stdin.write(buf, (err) => { if (err) reject(failed || err); });
        if (ok) resolve(); else ff.stdin.once('drain', resolve);
      });
    },
    async end() { ff.stdin.end(); await done; },
    kill() { try { ff.stdin.destroy(); ff.kill('SIGKILL'); } catch { /* già chiuso */ } },
  };
}

/** durata (s), dimensioni e fps di un video, leggendo l'intestazione stampata da ffmpeg */
export async function probeVideo(file) {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file]);
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const v = /Stream #[^\n]*Video:\s*([a-z0-9]+)[^\n]*?,\s*(\d{2,5})x(\d{2,5})[^\n]*?,\s*([\d.]+)\s*fps/.exec(stderr);
  if (!d) throw new Error('Video non leggibile: ' + file);
  return {
    duration: +d[1] * 3600 + +d[2] * 60 + +d[3],
    codec: v ? v[1] : null,
    width: v ? +v[2] : null,
    height: v ? +v[3] : null,
    fps: v ? +v[4] : null,
  };
}
