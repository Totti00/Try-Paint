// anim.js — easing e valutazione deterministica delle tracce a keyframe (nessun orologio).
//
// Una traccia e' un array di keyframe { t, <canale>: valore, ease? }. Ogni canale si interpola
// SOLO tra i keyframe che lo definiscono. `ease` del keyframe di ARRIVO governa il segmento.

export const EASE = {
  linear: (u) => u,
  in: (u) => u * u * u,
  out: (u) => 1 - Math.pow(1 - u, 3),
  outQuint: (u) => 1 - Math.pow(1 - u, 5),
  inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  smooth: (u) => u * u * u * (u * (u * 6 - 15) + 10),
  inQuad: (u) => u * u,
  outQuad: (u) => 1 - (1 - u) * (1 - u),
  inOutQuad: (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  step: (u) => (u >= 1 ? 1 : 0),
};

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const lerp = (a, b, u) => a + (b - a) * u;

function mix(a, b, u) {
  if (Array.isArray(a)) return a.map((v, i) => lerp(v, b[i], u));
  return lerp(a, b, u);
}

/** prepara una traccia: ordina (stabile) e indicizza per canale */
export function compileTrack(keys) {
  const sorted = keys.map((k, i) => [k, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map((x) => x[0]);
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

/** finestra di dissolvenza: 0 fuori, 1 dentro, rampe di durata fin/fout */
export function windowFade(t, t0, t1, fin = 0.35, fout = 0.35) {
  if (t <= t0 || t >= t1) return 0;
  const a = fin > 0 ? clamp01((t - t0) / fin) : 1;
  const b = fout > 0 ? clamp01((t1 - t) / fout) : 1;
  return EASE.smooth(Math.min(a, b));
}

/** progresso 0..1 di t nell'intervallo [t0, t1] con easing */
export function prog(t, t0, t1, ease = 'linear') {
  if (t1 <= t0) return t >= t1 ? 1 : 0;
  return (EASE[ease] || EASE.linear)(clamp01((t - t0) / (t1 - t0)));
}
