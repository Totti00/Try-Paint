// anim.js — easing e valutazione deterministica delle tracce a keyframe.
//
// Una traccia e' un array di keyframe { t, <canale>: valore, ease? }.
// Ogni canale (p, r, o, s, h, hb, …) si interpola SOLO tra i keyframe che lo
// definiscono, quindi posizione e rotazione possono avere tempi indipendenti.
// `ease` del keyframe di ARRIVO governa il segmento che vi termina.

export const EASE = {
  linear: (u) => u,
  in: (u) => u * u * u,
  out: (u) => 1 - Math.pow(1 - u, 3),
  outQuint: (u) => 1 - Math.pow(1 - u, 5),
  inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  smooth: (u) => u * u * u * (u * (u * 6 - 15) + 10),
  inQuad: (u) => u * u,
  outQuad: (u) => 1 - (1 - u) * (1 - u),
  step: (u) => (u >= 1 ? 1 : 0),
};

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const lerp = (a, b, u) => a + (b - a) * u;

function mix(a, b, u) {
  if (Array.isArray(a)) return a.map((v, i) => lerp(v, b[i], u));
  return lerp(a, b, u);
}

/** prepara una traccia: ordina e indicizza per canale */
export function compileTrack(keys) {
  const sorted = keys.slice().sort((a, b) => a.t - b.t);
  const channels = {};
  for (const k of sorted) {
    for (const c of Object.keys(k)) {
      if (c === 't' || c === 'ease') continue;
      (channels[c] ||= []).push({ t: k.t, v: k[c], ease: k.ease || 'inOut' });
    }
  }
  return channels;
}

export function evalChannel(list, t, def) {
  if (!list || !list.length) return def;
  if (t <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (t >= last.t) return last.v;
  // ricerca binaria del segmento
  let lo = 0, hi = list.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = list[lo], b = list[hi];
  const span = b.t - a.t;
  const u = span <= 0 ? 1 : (t - a.t) / span;
  const f = EASE[b.ease] || EASE.inOut;
  return mix(a.v, b.v, f(clamp01(u)));
}

export const PART_DEFAULTS = { p: [0, 0, 0], r: [0, 0, 0], o: 1, s: 0, h: 0, hb: 0 };

export function evalPart(channels, t) {
  const out = {};
  for (const c of Object.keys(PART_DEFAULTS)) out[c] = evalChannel(channels[c], t, PART_DEFAULTS[c]);
  return out;
}

/** finestra di dissolvenza: 0 fuori, 1 dentro, rampe di durata fin/fout */
export function windowFade(t, t0, t1, fin = 0.35, fout = 0.35) {
  if (t <= t0 || t >= t1) return 0;
  const a = fin > 0 ? clamp01((t - t0) / fin) : 1;
  const b = fout > 0 ? clamp01((t1 - t) / fout) : 1;
  return EASE.smooth(Math.min(a, b));
}
