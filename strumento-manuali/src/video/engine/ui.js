// ui.js — grafica 2D comune ai due video (HTML sopra il canvas): intestazione, didascalia con
// barra di avanzamento, avvertenza, cartello finale. Tutto in funzione del tempo t (niente timer).

import { windowFade, clamp01, EASE } from './anim.js';
import { esc, markup, fitText } from './text.js';

export const ICON = {
  box: `<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="4.5" stroke-linejoin="round"><path d="M8 20 L32 8 L56 20 L56 46 L32 58 L8 46 Z"/><path d="M8 20 L32 32 L56 20"/><path d="M32 32 L32 58"/><path d="M20 14 L44 26" stroke-width="3.5"/></svg>`,
  check: `<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="square" stroke-linejoin="miter"><path d="M12 33 L26 47 L53 18"/></svg>`,
  info: `<svg viewBox="0 0 64 64" fill="#fff"><rect x="27" y="26" width="10" height="28"/><rect x="27" y="10" width="10" height="10"/></svg>`,
  warn: `<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"><path d="M32 6 L60 56 L4 56 Z"/><path d="M32 24 L32 40" stroke-linecap="square"/><circle cx="32" cy="48" r="1.5" fill="#fff"/></svg>`,
};

export const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export function vis(e, a) {
  e.style.opacity = a.toFixed(3);
  e.style.visibility = a > 0.002 ? 'visible' : 'hidden';
}

/** intestazione in alto a sinistra: NOME · titolo del documento */
export class Brand {
  constructor(stage, name, docTitle) {
    this.e = el('div', null, `<b>${esc(name)}</b><i></i><span>${esc(docTitle)}</span>`);
    this.e.id = 'brand';
    stage.appendChild(this.e);
  }
  width() { return this.e.offsetWidth; }
  update(a) { vis(this.e, a); }
}

/**
 * Didascalia in basso: badge arancio (numero / icona), titolo, testo, barra a segmenti,
 * colonna facoltativa "Occorrente". Il pannello resta pieno: cambiano solo i contenuti.
 */
export class Caption {
  constructor(stage, { total, wide = false, usesColumn = false }) {
    this.total = total;
    this.e = el('div', null,
      '<div class="badge"></div><div class="text"><div class="title"></div><div class="body"></div>' +
      '<div class="progress"><div class="segs">' + Array.from({ length: Math.max(1, total) }, () => '<div class="seg"><i></i></div>').join('') +
      '</div><div class="count"></div></div></div>' + (usesColumn ? '<div class="uses"></div>' : ''));
    this.e.id = 'caption';
    if (wide) this.e.classList.add('wide');
    if (!total) this.e.querySelector('.segs').style.visibility = 'hidden';
    stage.appendChild(this.e);
    this.badge = this.e.querySelector('.badge');
    this.text = this.e.querySelector('.text');
    this.title = this.e.querySelector('.title');
    this.body = this.e.querySelector('.body');
    this.count = this.e.querySelector('.count');
    this.uses = this.e.querySelector('.uses');
    this.segs = [...this.e.querySelectorAll('.seg')];
    this.cur = null;
    this.glyph = null;
  }

  height() { return this.e.offsetHeight; }

  /** item: { id, kind:'step'|'check'|'box'|'info', n, title, body (testo con **enfasi**), uses:[{code?, img?, name, q}] } */
  setItem(item) {
    if (this.cur === item) return;
    this.cur = item;
    this.title.style.fontSize = '';
    this.title.textContent = item.title || '';
    this.body.innerHTML = item.body ? markup(item.body) : '';
    this.body.style.display = item.body ? '' : 'none';
    if (item.kind === 'check') {
      this.badge.innerHTML = `<span class="glyph">${ICON.check}</span>`;
      this.count.innerHTML = '<em>Completato</em>';
    } else if (item.kind === 'step') {
      this.badge.innerHTML = `<span class="glyph num">${esc(item.n)}</span>`;
      this.count.innerHTML = this.total ? `Passo <em>${esc(item.n)}</em> / ${this.total}` : `Passo <em>${esc(item.n)}</em>`;
    } else if (item.kind === 'info') {
      this.badge.innerHTML = `<span class="glyph">${ICON.info}</span>`;
      this.count.textContent = item.countText || 'Nota';
    } else {
      this.badge.innerHTML = `<span class="glyph">${ICON.box}</span>`;
      this.count.textContent = item.countText || 'Contenuto';
    }
    // numeri a piu' cifre: badge un po' piu' piccolo
    const num = this.badge.querySelector('.num');
    if (num && String(item.n).length > 2) num.style.fontSize = '64px';
    this.glyph = this.badge.firstChild;
    if (this.uses) {
      const list = (item.uses || []).slice(0, 3);
      this.uses.style.display = list.length ? '' : 'none';
      this.uses.innerHTML = list.length ? '<h4>Occorrente</h4>' + list.map((u) =>
        `<div class="use">${u.img ? `<div class="ph"><img src="${esc(u.img)}" alt=""></div>` : `<div class="code">${esc(u.code || '•')}</div>`}` +
        `<div class="nm">${esc(u.name || '')}</div><div class="q">${esc(u.q || '')}</div></div>`).join('') : '';
    }
    // titolo su una riga
    const maxW = this.text.clientWidth - 80;
    if (maxW > 200) fitText(this.title, { maxW, min: 34 });
  }

  /**
   * @param a      visibilita' del pannello (0..1)
   * @param fills  riempimento dei segmenti [0..1] e indice del segmento corrente
   * @param textA  opacita' del testo (cambio di passo)
   */
  update(t, { a, fills = [], curIndex = -1, textA = 1, slide = 0 }) {
    vis(this.e, a);
    this.text.style.opacity = textA.toFixed(3);
    if (this.uses) this.uses.style.opacity = textA.toFixed(3);
    if (this.glyph) this.glyph.style.opacity = textA.toFixed(3);
    this.text.style.transform = `translateY(${slide.toFixed(2)}px)`;
    for (let i = 0; i < this.segs.length; i++) {
      this.segs[i].firstChild.style.width = ((fills[i] || 0) * 100).toFixed(2) + '%';
      this.segs[i].classList.toggle('cur', i === curIndex);
    }
  }
}

/** avvertenza in alto a destra (tag arancio "Attenzione" + testo) */
export class Warning {
  constructor(stage) {
    this.e = el('div', null, `<div class="tag">${ICON.warn}<span>Attenzione</span></div><div class="msg"></div>`);
    this.e.id = 'warn';
    this.msg = this.e.querySelector('.msg');
    this.cur = null;
    stage.appendChild(this.e);
    vis(this.e, 0);
  }
  set(text, maxWidth) {
    if (this.cur === text) return;
    this.cur = text;
    this.msg.innerHTML = markup(text || '');
    this.e.style.maxWidth = Math.max(560, maxWidth) + 'px';
  }
  update(a, slide = 0) {
    vis(this.e, a);
    this.e.style.transform = `translateY(${slide.toFixed(1)}px)`;
  }
}

/** cartello finale: logo (sullo sfondo del suo colore d'angolo) oppure nome del prodotto */
export class EndCard {
  constructor(stage, { logoUrl, name, docTitle, foot }) {
    this.e = el('div');
    this.e.id = 'endcard';
    if (logoUrl) {
      this.img = el('img');
      this.img.src = logoUrl;
      this.img.alt = '';
      this.e.appendChild(this.img);
    } else {
      this.e.innerHTML = `<div class="name">${esc(name)}</div><div class="rule"></div><div class="sub">${esc(docTitle)}</div>`;
      this.nameEl = this.e.querySelector('.name');
    }
    if (foot) this.e.appendChild(el('div', 'foot', esc(foot)));
    stage.appendChild(this.e);
    vis(this.e, 0);
  }
  /** colore di fondo = pixel d'angolo del logo (cosi' il riquadro del logo non si vede) */
  async prepare() {
    if (this.nameEl) { this.nameEl.style.whiteSpace = 'nowrap'; vis(this.e, 1); fitText(this.nameEl, { maxW: 1600, min: 40 }); vis(this.e, 0); }
    if (!this.img) return;
    try {
      if (!this.img.complete) await new Promise((r) => { this.img.onload = r; this.img.onerror = r; });
      await this.img.decode().catch(() => {});
      const c = document.createElement('canvas');
      c.width = this.img.naturalWidth; c.height = this.img.naturalHeight;
      if (!c.width) return;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(this.img, 0, 0);
      const px = (x, y) => g.getImageData(x, y, 1, 1).data;
      const s = [px(2, Math.floor(c.height / 2)), px(c.width - 3, Math.floor(c.height / 2)), px(Math.floor(c.width / 2), c.height - 3), px(2, c.height - 3)];
      const avg = [0, 1, 2].map((i) => Math.round(s.reduce((n, p) => n + p[i], 0) / s.length));
      const alpha = s.reduce((n, p) => n + p[3], 0) / s.length;
      if (alpha > 200) this.e.style.background = `rgb(${avg[0]},${avg[1]},${avg[2]})`;
      // bordo dell'immagine leggermente diverso dal fondo: rifilo di 1% per sicurezza
      this.img.style.clipPath = 'inset(0.6%)';
    } catch { /* fondo beige predefinito */ }
  }
  update(a) { vis(this.e, a); }
}

/** progresso di una sequenza di passi: riempimenti dei segmenti per l'istante t */
export function segmentFills(steps, t, done = false) {
  return steps.map((s) => (done || t >= s.t1 ? 1 : t <= s.t0 ? 0 : clamp01((t - s.t0) / (s.t1 - s.t0))));
}

export { windowFade, clamp01, EASE };
