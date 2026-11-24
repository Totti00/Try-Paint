// Colori del manuale. I valori predefiniti sono quelli di ARCHITETTURA.md (marchio del manuale "Tavolo Levante").
export const DEFAULT_THEME = Object.freeze({
  accent: '#FF7E00',
  accentInk: '#B45700',
  beige: '#DBD3CB',
  beigeSoft: '#F2EEE9',
  ink: '#1F1C1A',
  text: '#3B3632',
  muted: '#766D66',
  line: '#E4DED7',
});

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Tema valido: solo colori esadecimali (#rgb o #rrggbb), il resto torna al predefinito. */
export function normalizeTheme(theme) {
  const out = { ...DEFAULT_THEME };
  if (theme && typeof theme === 'object') {
    for (const key of Object.keys(DEFAULT_THEME)) {
      const v = typeof theme[key] === 'string' ? theme[key].trim() : '';
      if (HEX.test(v)) out[key] = v.length === 4 ? '#' + [...v.slice(1)].map((c) => c + c).join('') : v;
    }
  }
  return out;
}

export function hexToRgb(hex) {
  const h = normalizeTheme({ beige: hex }).beige.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** Variabili CSS del tema. */
export function themeCss(theme) {
  const t = normalizeTheme(theme);
  return `:root{--accent:${t.accent};--accent-ink:${t.accentInk};--beige:${t.beige};--beige-soft:${t.beigeSoft};` +
    `--ink:${t.ink};--text:${t.text};--muted:${t.muted};--line:${t.line};` +
    `--accent-tint:color-mix(in srgb, var(--accent) 10%, #fff);}`;
}
