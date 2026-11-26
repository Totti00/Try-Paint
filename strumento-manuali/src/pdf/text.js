// Testo → HTML per il manuale: escape, **enfasi**, piccole correzioni tipografiche, etichette brevi.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Caratteri senza glifo nei font Barlow incorporati: sostituiti con equivalenti, così nel PDF finisce solo Barlow.
const GLYPH_FALLBACK = {
  '→': '›', '⇒': '›', '➔': '›', '←': '‹', '⌀': 'Ø', '∅': 'Ø',
  '●': '•', '▪': '•', '■': '•', '◦': '•', '✓': '•', '✔': '•', '\uf0b7': '•',
  '≈': '~', '\u2009': ' ', '\u202f': '\u00a0',
};

/** Correzioni tipografiche sicure (non cambiano il contenuto). */
export function typo(s) {
  let t = String(s ?? '');
  t = t.replace(/[→⇒➔←⌀∅●▪■◦✓✔≈\u2009\u202f\uf0b7]/g, (c) => GLYPH_FALLBACK[c] ?? c);
  t = t.replace(/(\p{L})'(?=\p{L}|\s|$|[.,;:!?)])/gu, '$1’');       // apostrofo tipografico
  for (let i = 0; i < 3; i++) t = t.replace(/(\d)\s?[xX]\s?(\d)/g, '$1×$2'); // 17x2x8 → 17×2×8
  t = t.replace(/\s-\s/g, ' – ');                                        // trattino lungo
  t = t.replace(/\.\.\./g, '…');
  return t;
}

/** Spazi non separabili davanti/dietro ai numeri brevi ("passo 5", "10 viti"). */
function nbsp(html) {
  return html
    .replace(/\b(passo|passi|pag\.|fig\.|figura|n\.)\s+(\d)/gi, '$1&nbsp;$2')
    .replace(/(^|[\s(])(\d{1,4}(?:[.,]\d+)?)\s+(?=[\p{L}])/gu, '$1$2&nbsp;');
}

/** Testo semplice → HTML in linea: escape, **x** → <strong class="key">x</strong>, a capo → <br>. */
export function inline(text) {
  let html = escapeHtml(typo(text));
  html = html.replace(/\*\*([^*][\s\S]*?)\*\*/g, (m, x) => `<strong class="key">${x.trim()}</strong>`);
  html = html.replace(/\*\*/g, ''); // asterischi rimasti spaiati
  html = nbsp(html);
  return html.replace(/\r?\n/g, '<br>');
}

/** Paragrafi di un testo lungo (righe vuote = nuovo paragrafo). */
export function paragraphs(text) {
  return String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Avvertenza: se ha più frasi e nessuna enfasi, la prima frase va in grassetto. */
export function warningHtml(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (!t.includes('**')) {
    const m = /^(.+?[.!?])\s+(?=[A-ZÀ-ÖØ-Ý0-9«"“])/su.exec(t);
    if (m && m[1].length < t.length - 3) return `<b>${inline(m[1])}</b> ${inline(t.slice(m[0].length))}`;
  }
  return inline(t);
}

const PREP = new Set(['di', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'in', 'con', 'a', 'al', 'alla', 'ai', 'agli', 'alle',
  'per', 'da', 'dal', 'dalla', 'su', 'sul', 'sulla', 'tra', 'fra', 'of', 'with', 'for', 'in', 'on']);

/** Nome breve per le etichette dei passi: "Fianchi tavolo in alluminio con asole" → "Fianchi tavolo". */
export function shortLabel(name, max = 26) {
  const words = typo(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  let out = [words[0]];
  for (let i = 1; i < words.length; i++) {
    if (PREP.has(words[i].toLowerCase())) break;
    out.push(words[i]);
  }
  let s = out.join(' ');
  if (s.length > max) {
    s = '';
    for (const w of out) {
      if ((s + ' ' + w).trim().length > max) break;
      s = (s + ' ' + w).trim();
    }
    if (!s) s = out[0].slice(0, max);
  }
  return s;
}

const DIM = /\bM\d+(?:[.,]\d+)?(?:\s?[x×]\s?\d+(?:[.,]\d+)?)*\b|\b\d+(?:[.,]\d+)?(?:\s?[x×]\s?\d+(?:[.,]\d+)?)+\b/i;

/**
 * Sigla e descrizione di una ferramenta per i chip dei passi:
 * { name:"Vite inox M8×20", spec:"con flangia" } → { badge:"M8×20", label:"Vite inox con flangia" }
 */
export function hardwareChip(h) {
  const name = typo(h?.name || '').trim();
  const spec = typo(h?.spec || '').trim();
  let badge = '';
  let label = name;
  let rest = spec;
  const mName = DIM.exec(name);
  if (mName) {
    badge = mName[0];
    label = (name.slice(0, mName.index) + name.slice(mName.index + mName[0].length)).replace(/\s{2,}/g, ' ').replace(/^[\s,–-]+|[\s,–-]+$/g, '');
  } else {
    const mSpec = DIM.exec(spec);
    if (mSpec) {
      badge = mSpec[0];
      rest = (spec.slice(0, mSpec.index) + spec.slice(mSpec.index + mSpec[0].length)).replace(/^[\s,–-]+|[\s,–-]+$/g, '');
    }
  }
  if (rest && !(badge && rest === badge) && (label + ' ' + rest).length <= 34) label = `${label} ${rest}`.trim();
  badge = badge ? badge.replace(/\s/g, '').replace(/(\d)x(?=\d)/gi, '$1×') : String(h?.id || '');
  return { badge, label: label || name };
}
