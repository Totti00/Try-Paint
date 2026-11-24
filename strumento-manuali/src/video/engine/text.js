// text.js — testi e colori: escape HTML, enfasi **parola**, accorciamento, tema.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** testo con **enfasi** -> HTML (grassetto) */
export function markup(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*\*/g, '');
}

export const strip = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

/**
 * Accorcia un testo a max caratteri: preferisce finire a fine frase, poi a una virgola/punto e
 * virgola, infine a fine parola con "…". Conserva le **enfasi** se complete.
 */
export function shorten(s, max = 120) {
  const plain = String(s ?? '').replace(/\s+/g, ' ').trim();
  const visible = strip(plain);
  if (visible.length <= max) return plain;
  // lavoriamo sul testo senza marcatori per non spezzare un'enfasi
  const t = visible;
  const sentences = t.match(/[^.!?;]+[.!?;]+(\s|$)/g);
  if (sentences) {
    let acc = '';
    for (const se of sentences) {
      if ((acc + se).trim().length > max) break;
      acc += se;
    }
    acc = acc.trim();
    if (acc.length >= max * 0.45) return acc.replace(/;$/, '.');
  }
  const cut = t.slice(0, max - 1);
  const comma = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf(' – '), cut.lastIndexOf(' — '));
  if (comma > max * 0.55) return cut.slice(0, comma).trim() + '…';
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.4 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '') + '…';
}

export function qtyLabel(q) {
  return q === null || q === undefined || q === '' ? '' : '×' + q;
}

// ------------------------------------------------------------------------------- colori / tema

export const DEFAULT_THEME = {
  accent: '#FF7E00', accentInk: '#B45700', beige: '#DBD3CB', beigeSoft: '#F2EEE9',
  ink: '#1F1C1A', text: '#3B3632', muted: '#766D66', line: '#E4DED7',
};

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

export function mixHex(a, b, u) {
  const A = hexToRgb(a), B = hexToRgb(b);
  if (!A || !B) return a;
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * u));
}

export function rgba(hex, alpha) {
  const c = hexToRgb(hex) || [0, 0, 0];
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** tinta chiara dell'accento per le superfici evidenziate (resa ~accento dopo l'illuminazione) */
export function highlightTint(accent) {
  const rgb = hexToRgb(accent) || [255, 126, 0];
  const [h, s, l] = rgbToHsl(rgb);
  return rgbToHex(hslToRgb([(h + 8 / 360) % 1, Math.max(0.75, s), Math.min(0.7, Math.max(0.6, l + 0.18))]));
}

/** tema completo con colori derivati */
export function resolveTheme(theme) {
  const t = { ...DEFAULT_THEME };
  for (const [k, v] of Object.entries(theme || {})) if (hexToRgb(v)) t[k] = v;
  t.paper = mixHex(t.beigeSoft, '#FFFFFF', 0.45);
  t.paperDeep = t.beigeSoft;
  return t;
}

/** variabili CSS del tema sulla radice del documento */
export function applyThemeCss(t) {
  const r = document.documentElement.style;
  r.setProperty('--accent', t.accent);
  r.setProperty('--accent-ink', t.accentInk);
  r.setProperty('--beige', t.beige);
  r.setProperty('--beige-soft', t.beigeSoft);
  r.setProperty('--paper', t.paper);
  r.setProperty('--ink', t.ink);
  r.setProperty('--text', t.text);
  r.setProperty('--muted', t.muted);
  r.setProperty('--line', t.line);
  r.setProperty('--ink-a62', rgba(t.ink, 0.62));
  r.setProperty('--ink-a80', rgba(t.ink, 0.8));
  r.setProperty('--ink-a13', rgba(t.ink, 0.13));
  r.setProperty('--ink-a10', rgba(t.ink, 0.10));
  r.setProperty('--panel', rgba(t.paper, 0.95));
  r.setProperty('--studio', `radial-gradient(120% 95% at 52% 38%, ${mixHex(t.paper, '#FFFFFF', 0.35)} 0%, ${t.paper} 42%, ${mixHex(t.beigeSoft, t.beige, 0.45)} 78%, ${t.beige} 100%)`);
}

/** riduce la dimensione del carattere finche' l'elemento sta in maxW x maxH (px dello stage) */
export function fitText(el, { maxW, maxH = Infinity, min = 18 }) {
  let size = parseFloat(getComputedStyle(el).fontSize);
  let guard = 0;
  while (guard++ < 80 && size > min && (el.scrollWidth > maxW + 0.5 || el.scrollHeight > maxH + 0.5)) {
    size *= 0.95;
    el.style.fontSize = size.toFixed(1) + 'px';
  }
  return size;
}
