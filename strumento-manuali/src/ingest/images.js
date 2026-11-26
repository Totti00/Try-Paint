// Preparazione delle immagini estratte per la stampa:
//   immagini/orig/<id>.png   copia intatta (es. per i loghi)
//   immagini/final/<id>.png  rifilata, sfondo quasi bianco → bianco puro, ingrandita ×2 se piccola
//   immagini/thumb/<id>.jpg  miniatura per l'interfaccia (lato lungo ≤ 360 px)
// Come tools/prepara_immagini.py del manuale fatto a mano: lo sfondo dei render CAD (~#FAFBFB) diventa
// bianco scalando i canali (255/250 e taglio), solo se lo sfondo è davvero quasi bianco: sfondi colorati o
// beige (loghi) non vengono toccati.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { makeProgress, ensureDir, throwIfAborted } from './common.js';

const NEAR_WHITE = 245;      // sfondo considerato "quasi bianco" se ogni canale ≥ 245
const CONTENT_DELTA = 12;    // dopo lo sbiancamento, un pixel è contenuto se un canale < 255-12
const BLEED_FRACTION = 0.12; // se più del 12% del bordo non è bianco, la figura arriva ai bordi (primo piano)
const UPSCALE_BELOW = 1400;
const UPSCALE_CAP = 2600;
const THUMB_SIDE = 360;
const SNAP_WHITE = 251;     // dopo lo sbiancamento, ≥ 251 su tutti i canali diventa 255

function median(arr) {
  if (!arr.length) return 0;
  const a = Uint8Array.from(arr).sort();
  return a[a.length >> 1];
}

/** Analisi del bordo (anello di 2 px) di un'immagine RGB grezza. */
export function analyzeBorder(data, width, height, ring = 2) {
  const r = [], g = [], b = [];
  let nonWhite = 0;
  let count = 0;
  const k = Math.max(1, Math.min(ring, Math.floor(Math.min(width, height) / 4)));
  const push = (x, y) => {
    const i = (y * width + x) * 3;
    r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]);
    if (Math.min(data[i], data[i + 1], data[i + 2]) < 235) nonWhite++;
    count++;
  };
  for (let y = 0; y < height; y++) {
    if (y < k || y >= height - k) { for (let x = 0; x < width; x++) push(x, y); }
    else { for (let x = 0; x < k; x++) { push(x, y); push(width - 1 - x, y); } }
  }
  const bg = [median(r), median(g), median(b)];
  return { bg, nonWhiteFraction: count ? nonWhite / count : 0 };
}

/** Riquadro del contenuto (pixel non bianchi) o null se l'immagine è vuota. */
function contentBox(data, width, height, limit) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    let row = y * width * 3;
    for (let x = 0; x < width; x++, row += 3) {
      if (data[row] < limit || data[row + 1] < limit || data[row + 2] < limit) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Elabora una singola immagine; restituisce informazioni utili (per log e test). */
export async function prepareOne(srcFile, finalFile, thumbFile) {
  const { data, info } = await sharp(srcFile, { limitInputPixels: false, failOn: 'none' })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let { width, height } = info;
  if (info.channels !== 3) throw new Error(`canali inattesi: ${info.channels}`);
  const { bg, nonWhiteFraction } = analyzeBorder(data, width, height);
  const nearWhite = bg.every((v) => v >= NEAR_WHITE);
  const bleed = nonWhiteFraction > BLEED_FRACTION;
  const result = { orig: [width, height], nearWhite, bleed, bg, factor: 1, trimmed: false, pre: null, final: null };

  let pixels = data;
  if (nearWhite) {
    const level = Math.min(...bg);
    if (level < 255) {
      const factor = 255 / level;
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.round(v * factor));
      pixels = Buffer.allocUnsafe(data.length);
      for (let i = 0; i < data.length; i++) pixels[i] = lut[data[i]];
      result.factor = Math.round(factor * 10000) / 10000;
    }
    // residui quasi bianchi (artefatti di compressione) → bianco puro: niente riquadri grigini in stampa
    if (pixels === data) pixels = Buffer.from(data);
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] >= SNAP_WHITE && pixels[i + 1] >= SNAP_WHITE && pixels[i + 2] >= SNAP_WHITE) { pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; }
    }
  }

  let img = sharp(pixels, { raw: { width, height, channels: 3 }, limitInputPixels: false });
  if (nearWhite && !bleed) {
    const box = contentBox(pixels, width, height, 255 - CONTENT_DELTA);
    if (box && (box.width < width || box.height < height)) {
      const margin = Math.max(4, Math.round(0.025 * Math.max(box.width, box.height)));
      const cropped = await img.extract(box).toBuffer();
      img = sharp(cropped, { raw: { width: box.width, height: box.height, channels: 3 } })
        .extend({ top: margin, bottom: margin, left: margin, right: margin, background: '#ffffff' });
      width = box.width + 2 * margin;
      height = box.height + 2 * margin;
      result.trimmed = true;
      const buf = await img.raw().toBuffer();
      img = sharp(buf, { raw: { width, height, channels: 3 }, limitInputPixels: false });
    }
  }

  result.pre = [width, height]; // dopo la rifilatura, prima dell'ingrandimento
  const long = Math.max(width, height);
  if (long < UPSCALE_BELOW) {
    const target = Math.min(UPSCALE_CAP, long * 2);
    const scale = target / long;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const buf = await img.resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer();
    width = w; height = h;
    img = sharp(buf, { raw: { width, height, channels: 3 }, limitInputPixels: false });
  }
  const pngBuf = await img.png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
  await fs.writeFile(finalFile, pngBuf);
  result.final = [width, height];

  await sharp(pngBuf)
    .resize(THUMB_SIDE, THUMB_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(thumbFile);
  return result;
}

/**
 * prepareImages(jobDir, catalog, onProgress, { signal }?) → { prepared, warnings }
 * (il contratto prevede void: il valore di ritorno è solo informativo)
 */
export async function prepareImages(jobDir, catalog, onProgress, { signal } = {}) {
  const progress = makeProgress(onProgress);
  const dOrig = await ensureDir(path.join(jobDir, 'immagini', 'orig'));
  const dFinal = await ensureDir(path.join(jobDir, 'immagini', 'final'));
  const dThumb = await ensureDir(path.join(jobDir, 'immagini', 'thumb'));
  const list = Array.isArray(catalog) ? catalog.filter((c) => c && c.id && c.file) : [];
  const warnings = [];
  const prepared = {};
  for (let i = 0; i < list.length; i++) {
    throwIfAborted(signal);
    const entry = list[i];
    progress((i / Math.max(1, list.length)) * 100, `Preparazione immagine ${i + 1} di ${list.length}…`);
    const src = path.join(jobDir, entry.file);
    try {
      await fs.copyFile(src, path.join(dOrig, `${entry.id}.png`));
      prepared[entry.id] = await prepareOne(src, path.join(dFinal, `${entry.id}.png`), path.join(dThumb, `${entry.id}.jpg`));
    } catch (err) {
      warnings.push(`Immagine ${entry.id}: non è stato possibile prepararla (${err?.message || err}).`);
    }
  }
  progress(100, `Immagini pronte: ${Object.keys(prepared).length}.`);
  return { prepared, warnings };
}
