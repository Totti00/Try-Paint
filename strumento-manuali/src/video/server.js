// Piccolo server HTTP locale (solo 127.0.0.1) usato da Chromium headless per:
//  - servire il motore video (src/video/engine), three.js e occt-import-js da node_modules,
//    i font Barlow e i file del lavoro (immagini, model.glb, ...);
//  - servire contenuti in memoria (es. /config.json);
//  - ricevere file prodotti nella pagina (model.glb, viste PNG) con PUT /__upload/<nome>,
//    limitati a un elenco di nomi ammessi.

import http from 'node:http';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');
export const ENGINE_DIR = path.join(HERE, 'engine');
export const FONTS_DIR = path.join(PROJECT_ROOT, 'assets', 'fonts');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.obj': 'text/plain; charset=utf-8', '.mtl': 'text/plain; charset=utf-8', '.stl': 'application/octet-stream',
  '.step': 'application/octet-stream', '.stp': 'application/octet-stream', '.iges': 'application/octet-stream',
  '.igs': 'application/octet-stream',
};

/** cartella di un pacchetto in node_modules (risolta da Node, con ripiego sul percorso classico) */
export function packageDir(name) {
  try {
    return path.dirname(require.resolve(name + '/package.json'));
  } catch {
    try {
      // pacchetti che non esportano package.json: si risale dal file principale
      let d = path.dirname(require.resolve(name));
      while (d !== path.dirname(d)) {
        if (path.basename(d) === name || d.endsWith(path.sep + name.replace('/', path.sep))) return d;
        d = path.dirname(d);
      }
    } catch { /* sotto */ }
    return path.join(PROJECT_ROOT, 'node_modules', name);
  }
}

/** montaggi standard: motore, three.js, occt, font */
export function standardMounts() {
  return [
    { prefix: '/engine/', dir: ENGINE_DIR },
    { prefix: '/vendor/three/', dir: packageDir('three') },
    { prefix: '/vendor/occt/', dir: path.join(packageDir('occt-import-js'), 'dist') },
    { prefix: '/fonts/', dir: FONTS_DIR },
  ];
}

function inside(dir, file) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Avvia il server.
 * @param {object} o
 * @param {{prefix:string, dir:string}[]} o.mounts   prefisso URL -> cartella (sola lettura)
 * @param {Record<string, {type?:string, body:string|Buffer}>} [o.memory]  percorsi serviti dalla memoria
 * @param {{dir:string, allow:(name:string)=>boolean, maxBytes?:number}} [o.upload]  PUT /__upload/<nome>
 * @returns {Promise<{ base:string, close:()=>Promise<void>, memory:object, uploads:string[] }>}
 */
export async function startServer({ mounts = [], memory = {}, upload = null } = {}) {
  const uploads = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }

      if (req.method === 'PUT' || req.method === 'POST') {
        if (!upload || !pathname.startsWith('/__upload/')) { res.writeHead(404); res.end(); return; }
        const name = pathname.slice('/__upload/'.length).replace(/\\/g, '/');
        if (!name || name.includes('..') || !upload.allow(name)) { res.writeHead(403); res.end('nome non ammesso'); return; }
        const dest = path.join(upload.dir, ...name.split('/'));
        if (!inside(upload.dir, dest)) { res.writeHead(403); res.end(); return; }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const tmp = dest + '.part';
        const max = upload.maxBytes || 1024 * 1024 * 1024;
        let size = 0, aborted = false;
        const ws = createWriteStream(tmp);
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > max && !aborted) { aborted = true; req.unpipe(ws); ws.destroy(); res.writeHead(413); res.end('file troppo grande'); }
        });
        req.pipe(ws);
        ws.on('finish', async () => {
          if (aborted) return;
          try {
            await fsp.rename(tmp, dest);
            uploads.push(name);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, bytes: size }));
          } catch (e) { res.writeHead(500); res.end(String(e.message)); }
        });
        ws.on('error', (e) => { if (!res.headersSent) { res.writeHead(500); res.end(String(e.message)); } });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

      const mem = memory[pathname];
      if (mem) {
        const body = typeof mem.body === 'string' ? Buffer.from(mem.body, 'utf8') : mem.body;
        res.writeHead(200, { 'Content-Type': mem.type || MIME[path.extname(pathname).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      // montaggio con il prefisso piu' lungo
      const m = mounts.filter((x) => pathname.startsWith(x.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
      if (!m) { res.writeHead(404); res.end('non trovato'); return; }
      const rel = pathname.slice(m.prefix.length);
      const file = path.join(m.dir, ...rel.split('/').filter(Boolean));
      if (!inside(m.dir, file)) { res.writeHead(403); res.end(); return; }
      let st;
      try { st = await fsp.stat(file); } catch { res.writeHead(404); res.end('non trovato'); return; }
      if (!st.isFile()) { res.writeHead(404); res.end('non trovato'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size, 'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500); res.end(String(e && e.message)); } else res.destroy();
    }
  });
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    memory,
    uploads,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
