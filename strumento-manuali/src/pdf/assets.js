// Immagini per il PDF: risoluzione dei file, analisi (proporzioni, figura "al vivo"), logo per il retro.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { hexToRgb, rgbToHex } from './theme.js';

const exists = (f) => fs.access(f).then(() => true, () => false);

/** File migliore per un id: immagini/final, altrimenti l'estratta (se prepareImages non è stato eseguito). */
export async function resolveImageFile(jobDir, id) {
  if (!/^[\w.-]+$/.test(String(id))) return null;
  for (const f of [path.join(jobDir, 'immagini', 'final', `${id}.png`), path.join(jobDir, 'estratte', `${id}.png`)]) {
    if (await exists(f)) return f;
  }
  return null;
}

/**
 * { width, height, aspect, bleed } — bleed = il soggetto arriva ai bordi (primo piano, foto, sfondo colorato):
 * la figura riempie la cornice; altrimenti sta su bianco con margine.
 */
export async function analyzeImage(file) {
  const meta = await sharp(file, { failOn: 'none' }).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const { data, info } = await sharp(file, { failOn: 'none' })
    .resize(240, 240, { fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  let n = 0, nonWhite = 0;
  const check = (x, y) => {
    const i = (y * w + x) * channels;
    if (Math.min(data[i], data[i + 1], data[i + 2]) < 235) nonWhite++;
    n++;
  };
  for (let x = 0; x < w; x++) { check(x, 0); check(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { check(0, y); check(w - 1, y); }
  return { width, height, aspect: width / height, bleed: n ? nonWhite / n > 0.12 : false };
}

function borderStats(data, w, h, ch) {
  const r = [], g = [], b = [], a = [];
  const push = (x, y) => {
    const i = (y * w + x) * ch;
    r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]); a.push(ch === 4 ? data[i + 3] : 255);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, 1); push(x, h - 1); push(x, h - 2); }
  for (let y = 2; y < h - 2; y++) { push(0, y); push(1, y); push(w - 1, y); push(w - 2, y); }
  const med = (arr) => Uint8Array.from(arr).sort()[arr.length >> 1];
  const bg = [med(r), med(g), med(b)];
  let close = 0, transparent = 0;
  for (let i = 0; i < r.length; i++) {
    if (Math.max(Math.abs(r[i] - bg[0]), Math.abs(g[i] - bg[1]), Math.abs(b[i] - bg[2])) <= 10) close++;
    if (a[i] < 250) transparent++;
  }
  return { bg, uniform: close / r.length, transparent: transparent / r.length };
}

/**
 * Logo per il retro beige, senza "riquadro" visibile:
 *  - sfondo già quasi beige → i pixel vicini al beige diventano esattamente il beige del tema (come a mano);
 *  - sfondo bianco → il bianco diventa trasparente (color-to-alpha), il logo galleggia sul beige;
 *  - sfondo uniforme di altro colore → il retro prende il colore del logo;
 *  - logo già trasparente → così com'è; sfondo non uniforme (foto) → logo su riquadro bianco.
 * @returns {Promise<{src:string, mode:string, bg:string|null}|null>}
 */
export async function prepareBackLogo(jobDir, id, theme, outDir) {
  if (!id) return null;
  let src = null;
  for (const f of [path.join(jobDir, 'immagini', 'orig', `${id}.png`), path.join(jobDir, 'estratte', `${id}.png`), path.join(jobDir, 'immagini', 'final', `${id}.png`)]) {
    if (/^[\w.-]+$/.test(String(id)) && await exists(f)) { src = f; break; }
  }
  if (!src) return null;
  let img = sharp(src, { failOn: 'none' }).toColourspace('srgb').ensureAlpha();
  const meta = await sharp(src).metadata();
  const long = Math.max(meta.width || 0, meta.height || 0);
  if (long && long < 1400) {
    const k = Math.min(2600, long * 2) / long;
    img = img.resize(Math.round(meta.width * k), Math.round(meta.height * k), { kernel: 'lanczos3' });
  }
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const px = Buffer.from(data);
  const st = borderStats(px, w, h, 4);
  const beige = hexToRgb(theme.beige);
  const near = (i, c, tol) => Math.abs(px[i] - c[0]) <= tol && Math.abs(px[i + 1] - c[1]) <= tol && Math.abs(px[i + 2] - c[2]) <= tol;
  let mode;
  let bg = theme.beige;

  if (st.transparent > 0.5) {
    mode = 'trasparente';
  } else if (st.uniform < 0.85) {
    mode = 'card';
  } else if (Math.max(...st.bg.map((v, k) => Math.abs(v - beige[k]))) <= 14) {
    mode = 'beige';
    for (let i = 0; i < px.length; i += 4) {
      if (near(i, st.bg, 8) || near(i, beige, 6)) { px[i] = beige[0]; px[i + 1] = beige[1]; px[i + 2] = beige[2]; px[i + 3] = 255; }
    }
  } else if (Math.min(...st.bg) >= 238) {
    mode = 'alfa';
    const f = 255 / Math.min(...st.bg);
    for (let i = 0; i < px.length; i += 4) {
      let amax = 0;
      const c = [Math.min(255, px[i] * f), Math.min(255, px[i + 1] * f), Math.min(255, px[i + 2] * f)];
      for (let k = 0; k < 3; k++) amax = Math.max(amax, (255 - c[k]) / 255);
      if (amax < 0.03) { px[i + 3] = 0; continue; }
      for (let k = 0; k < 3; k++) px[i + k] = Math.round(Math.max(0, Math.min(255, (c[k] - 255) / amax + 255)));
      px[i + 3] = Math.round(amax * (px[i + 3] / 255) * 255);
    }
  } else {
    mode = 'colore';
    bg = rgbToHex(st.bg);
    for (let i = 0; i < px.length; i += 4) {
      if (near(i, st.bg, 8)) { px[i] = st.bg[0]; px[i + 1] = st.bg[1]; px[i + 2] = st.bg[2]; px[i + 3] = 255; }
    }
  }
  const out = path.join(outDir, `logo-retro-${id}.png`);
  await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 6 }).toFile(out);
  return { src: pathToFileURL(out).href, file: out, mode: mode === 'card' ? 'card' : 'plain', kind: mode, bg };
}
