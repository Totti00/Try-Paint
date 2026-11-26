#!/usr/bin/env node
// render.mjs — render deterministico fotogramma per fotogramma: Chromium (Playwright)
// chiama window.renderAt(i / fps), cattura il viewport (canvas + overlay HTML) e
// invia i JPEG a ffmpeg (libx264, yuv420p, crf 18, +faststart).
//
//   node render.mjs                         1920x1080, 30 fps -> montaggio-tavolo-levante.mp4
//   node render.mjs --preview --out /tmp/p.mp4      960x540, 15 fps
//   node render.mjs --stills 12,30.5 --stills-dir /tmp/st   solo fotogrammi PNG
//   node render.mjs --poster [secondi]       poster.jpg (1920x1080, default t = 2.4: tavolo finito + titolo)
//   node render.mjs --from 40 --to 52 --out clip.mp4         solo un intervallo
//   node render.mjs --workers 2              piu' pagine in parallelo (segmenti concatenati)
//   node render.mjs --serve                  server locale per l'anteprima nel browser
//   node render.mjs --cad models/tavolo.glb  usa il modello CAD reale (vedi README)

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, extname, resolve, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');            // manuale-tavolo-levante/ (serve anche ../assets)
const PAGE = '/video/src/index.html';

// ---------------------------------------------------------------- argomenti
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const preview = !!opt('preview', false);
const width = +opt('width', preview ? 960 : 1920);
const height = +opt('height', preview ? 540 : 1080);
const fps = +opt('fps', preview ? 15 : 30);
const out = resolve(opt('out', join(HERE, preview ? 'preview.mp4' : 'montaggio-tavolo-levante.mp4')));
const workers = Math.max(1, +opt('workers', 1));
const quality = +opt('jpeg', 93);
const ffmpegBin = opt('ffmpeg', existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg');
// modello CAD reale (GLB) al posto del modello parametrico: percorso del file, deve stare
// dentro manuale-tavolo-levante/ (es. video/models/tavolo.glb)
const cad = opt('cad', null);
const cadQuery = cad ? '&cad=' + encodeURIComponent('/' + relative(ROOT, resolve(cad)).split('\\').join('/')) + (opt('cad-rot-y', null) ? '&cadRotY=' + opt('cad-rot-y') : '') : '';

// ---------------------------------------------------------------- server statico
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};
function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(ROOT, url));
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

// ---------------------------------------------------------------- browser
function loadPlaywright() {
  try { return require('playwright'); } catch {
    try { return require('playwright-core'); } catch {
      console.error('Playwright non trovato: installarlo (npm i -D playwright) oppure impostare NODE_PATH.');
      process.exit(1);
    }
  }
}

async function openPage(browser, base) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${base}${PAGE}?render&w=${width}&h=${height}${cadQuery}`, { waitUntil: 'load' });
  await page.evaluate(() => window.ready);
  return page;
}

async function renderFrame(page, t, type = 'jpeg') {
  await page.evaluate((tt) => window.renderAt(tt), t);
  return page.screenshot(type === 'png' ? { type: 'png' } : { type: 'jpeg', quality });
}

function startFfmpeg(file) {
  const ff = spawn(ffmpegBin, [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(opt('crf', 18)), '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-movflags', '+faststart', file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
  return { ff, done };
}

const write = (stream, buf) => new Promise((r) => (stream.write(buf) ? r() : stream.once('drain', r)));

async function renderRange(browser, base, f0, f1, file, label) {
  const page = await openPage(browser, base);
  const { ff, done } = startFfmpeg(file);
  const t0 = Date.now();
  for (let i = f0; i < f1; i++) {
    const buf = await renderFrame(page, i / fps);
    await write(ff.stdin, buf);
    if ((i - f0) % 30 === 0 || i === f1 - 1) {
      const el = (Date.now() - t0) / 1000, n = i - f0 + 1;
      process.stdout.write(`\r${label} frame ${n}/${f1 - f0}  ${(el / n * 1000).toFixed(0)} ms/frame  ETA ${((f1 - f0 - n) * el / n).toFixed(0)} s   `);
    }
  }
  ff.stdin.end();
  await done;
  await page.close();
  return (Date.now() - t0) / (f1 - f0);
}

// ---------------------------------------------------------------- main
const server = await startServer(opt('serve', false) ? +opt('port', 8123) : 0);
const base = `http://127.0.0.1:${server.address().port}`;

if (opt('serve', false)) {
  console.log(`Anteprima: ${base}${PAGE}   (spazio = pausa, frecce = ±2 s, ?t=secondi)`);
} else {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const stills = opt('stills', null);
    const poster = opt('poster', null);
    if (poster) {
      const t = poster === true ? 2.4 : +poster;
      const page = await openPage(browser, base);
      await page.evaluate((tt) => window.renderAt(tt), t);
      const f = resolve(opt('out', join(HERE, 'poster.jpg')).replace(/\.mp4$/, '.jpg'));
      writeFileSync(f, await page.screenshot({ type: 'jpeg', quality: 90 }));
      console.log(f);
    } else if (stills) {
      const dir = resolve(opt('stills-dir', join(os.tmpdir(), 'levante-stills')));
      mkdirSync(dir, { recursive: true });
      const page = await openPage(browser, base);
      for (const s of String(stills).split(',').map(Number)) {
        const t1 = Date.now();
        const buf = await renderFrame(page, s, 'png');
        const f = join(dir, `still_${s.toFixed(2).padStart(6, '0')}.png`);
        writeFileSync(f, buf);
        console.log(f, `${Date.now() - t1} ms`);
      }
    } else {
      const page = await openPage(browser, base);
      const info = await page.evaluate(() => window.timeline);
      await page.close();
      const from = +opt('from', 0), to = Math.min(+opt('to', info.duration), info.duration);
      const F0 = Math.round(from * fps), F1 = Math.round(to * fps);
      console.log(`${width}x${height} @ ${fps} fps, ${((F1 - F0) / fps).toFixed(2)} s = ${F1 - F0} fotogrammi -> ${out}`);
      const t0 = Date.now();
      if (workers === 1) {
        const ms = await renderRange(browser, base, F0, F1, out, '');
        console.log(`\nmedia ${ms.toFixed(0)} ms/fotogramma`);
      } else {
        const tmp = out + '.parts';
        mkdirSync(tmp, { recursive: true });
        const per = Math.ceil((F1 - F0) / workers);
        const jobs = [];
        for (let w = 0; w < workers; w++) {
          const a = F0 + w * per, b = Math.min(F1, a + per);
          if (a < b) jobs.push({ a, b, file: join(tmp, `seg${w}.mp4`) });
        }
        await Promise.all(jobs.map((j, w) => renderRange(browser, base, j.a, j.b, j.file, `[w${w}]`)));
        writeFileSync(join(tmp, 'list.txt'), jobs.map((j) => `file '${j.file}'`).join('\n'));
        await new Promise((res, rej) => spawn(ffmpegBin, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(tmp, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' })
          .on('close', (c) => (c === 0 ? res() : rej(new Error('concat ' + c)))));
        rmSync(tmp, { recursive: true, force: true });
      }
      const sec = (Date.now() - t0) / 1000;
      console.log(`\nfatto in ${sec.toFixed(0)} s (${(sec * 1000 / (F1 - F0)).toFixed(0)} ms/fotogramma effettivi) -> ${out}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}
