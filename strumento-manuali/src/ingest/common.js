// Funzioni comuni all'ingest (PDF, DOCX, immagini).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

/** Errore con messaggio italiano per l'utente; `code` serve a chi lo intercetta. */
export class IngestError extends Error {
  constructor(message, { code = 'ingest', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'IngestError';
    this.code = code;
  }
}

/** Avvolge onProgress: facoltativo, mai bloccante, errori del callback ignorati. */
export function makeProgress(onProgress, from = 0, to = 100) {
  return (pct, message) => {
    if (typeof onProgress !== 'function') return;
    const p = Math.max(0, Math.min(100, Math.round(from + ((to - from) * pct) / 100)));
    try {
      const r = onProgress(p, message);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* il callback non deve mai interrompere il lavoro */
    }
  };
}

export const imageId = (n) => 'img_' + String(n).padStart(2, '0');

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Scrittura atomica di un JSON (file temporaneo + rename). */
export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

/** Percorso relativo alla cartella del lavoro, sempre con "/" (anche su Windows). */
export const relPath = (jobDir, file) => path.relative(jobDir, file).split(path.sep).join('/');

/**
 * Porta pixel grezzi (1, 2, 3 o 4 canali, 8 bit) alla forma canonica RGB, o RGBA se c'è trasparenza.
 * Serve sia per l'hash (stessi pixel = stesso hash, comunque fossero codificati) sia per il PNG.
 */
export function canonicalPixels(data, width, height, channels) {
  const n = width * height;
  if (channels === 3) return { buf: Buffer.from(data.buffer, data.byteOffset, n * 3), channels: 3 };
  if (channels === 4) {
    let opaque = true;
    for (let i = 3; i < n * 4; i += 4) if (data[i] !== 255) { opaque = false; break; }
    if (!opaque) return { buf: Buffer.from(data.buffer, data.byteOffset, n * 4), channels: 4 };
    const out = Buffer.allocUnsafe(n * 3);
    for (let i = 0, j = 0; i < n * 4; i += 4, j += 3) { out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2]; }
    return { buf: out, channels: 3 };
  }
  if (channels === 1 || channels === 2) {
    let opaque = true;
    if (channels === 2) for (let i = 1; i < n * 2; i += 2) if (data[i] !== 255) { opaque = false; break; }
    const outCh = opaque ? 3 : 4;
    const out = Buffer.allocUnsafe(n * outCh);
    for (let i = 0, j = 0; i < n; i++, j += outCh) {
      const g = data[i * channels];
      out[j] = g; out[j + 1] = g; out[j + 2] = g;
      if (outCh === 4) out[j + 3] = data[i * 2 + 1];
    }
    return { buf: out, channels: outCh };
  }
  throw new Error(`Numero di canali non gestito: ${channels}`);
}

export function pixelHash(buf, width, height, channels) {
  return crypto.createHash('sha1').update(`${width}x${height}x${channels}:`).update(buf).digest('hex');
}

/** Scrive un PNG da pixel grezzi canonici. */
export async function writeRawPng(file, buf, width, height, channels) {
  await ensureDir(path.dirname(file));
  await sharp(buf, { raw: { width, height, channels }, limitInputPixels: false })
    .png({ compressionLevel: 6, adaptiveFiltering: true })
    .toFile(file);
}

/** Decodifica un'immagine qualsiasi supportata da sharp in pixel canonici (RGB/RGBA). */
export async function decodeToCanonical(input) {
  const { data, info } = await sharp(input, { limitInputPixels: false, failOn: 'none' })
    .rotate() // applica l'orientamento EXIF (foto da telefono)
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const c = canonicalPixels(data, info.width, info.height, info.channels);
  return { ...c, width: info.width, height: info.height };
}

/** Tipo di file dal contenuto (non ci si fida dell'estensione). */
export async function sniffFile(file) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.indexOf('%PDF-') !== -1 && head.indexOf('%PDF-') < 1024) return 'pdf';
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'cfb'; // .doc o docx cifrato
    if (head.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
    return 'unknown';
  } finally {
    await fh.close();
  }
}
