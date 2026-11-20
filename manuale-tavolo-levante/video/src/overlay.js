// overlay.js — didascalie, etichette e cartelli in HTML sopra il canvas WebGL.
// Tutto e' funzione del tempo t (nessun timer, nessuna transizione CSS).

import { windowFade, clamp01, EASE } from './anim.js';

const IMG_DIR = '../../assets/estratte/';
const BOX_ICON = `<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="4.5" stroke-linejoin="round">
  <path d="M8 20 L32 8 L56 20 L56 46 L32 58 L8 46 Z"/><path d="M8 20 L32 32 L56 20"/><path d="M32 32 L32 58"/><path d="M20 14 L44 26" stroke-width="3.5"/></svg>`;

const CHECK_ICON = `<svg viewBox="0 0 64 64" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="square" stroke-linejoin="miter">
  <path d="M12 33 L26 47 L53 18"/></svg>`;

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export class Overlay {
  constructor(stage, timeline) {
    this.tl = timeline;
    this.ov = timeline.overlay;
    this.stage = stage;
    this.captionSteps = timeline.steps.filter((s) => s.title);
    this.numbered = timeline.steps.filter((s) => s.n);

    // intestazione
    this.brand = el('div', null, '<b>Tavolo Levante</b><i></i><span>Istruzioni di montaggio</span>');
    this.brand.id = 'brand';
    // titolo iniziale
    this.intro = el('div', null,
      '<div class="kicker">Istruzioni di montaggio</div><h1>Tavolo Levante</h1><div class="rule"></div>' +
      '<div class="sub">Tavolo da esterno in alluminio e legno</div>');
    this.intro.id = 'intro';
    // linee guida etichette
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.id = 'leaders';
    this.svg.setAttribute('viewBox', '0 0 1920 1080');
    // etichette parti
    this.labels = this.ov.labels.map((l) => {
      const e = el('div', 'label', `<span class="code">${l.code}</span><span class="name">${l.name}</span><span class="qty">${l.qty}</span>`);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('stroke', '#1F1C1A'); line.setAttribute('stroke-width', '2.5');
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '8'); dot.setAttribute('fill', '#FF7E00'); dot.setAttribute('stroke', '#fff'); dot.setAttribute('stroke-width', '3');
      this.svg.append(line, dot);
      return { spec: l, e, line, dot };
    });
    // ferramenta
    const hw = this.ov.hardware;
    this.hw = el('div', null, '<h3>Ferramenta in dotazione</h3>' + hw.rows.map((r) =>
      `<div class="row"><div class="ph"><img src="${IMG_DIR + r.img}" alt=""></div><div class="nm">${r.name}</div><div class="q">${r.qty}</div></div>`).join(''));
    this.hw.id = 'hw';
    // etichette quantita'
    this.tags = this.ov.tags.map((g) => ({ spec: g, e: el('div', 'tag', g.text) }));
    // didascalia
    this.caption = el('div', null,
      '<div class="badge"><span class="num"></span></div><div class="text"><div class="title"></div><div class="body"></div>' +
      '<div class="progress"><div class="segs">' + this.numbered.map(() => '<div class="seg"><i></i></div>').join('') +
      '</div><div class="count"></div></div></div>');
    this.caption.id = 'caption';
    this.cBadge = this.caption.querySelector('.badge');
    this.cText = this.caption.querySelector('.text');
    this.cTitle = this.caption.querySelector('.title');
    this.cBody = this.caption.querySelector('.body');
    this.cCount = this.caption.querySelector('.count');
    this.cSegs = [...this.caption.querySelectorAll('.seg')];
    // cartello finale
    this.end = el('div', null, `<img src="${IMG_DIR}img-014.png" alt="Ramberti group">`);
    this.end.id = 'endcard';

    stage.append(this.svg, this.brand, this.intro, ...this.labels.map((l) => l.e), this.hw,
      ...this.tags.map((t) => t.e), this.caption, this.end);
    this.curStep = null;
  }

  images() { return [...this.stage.querySelectorAll('img')]; }

  /**
   * @param project (partName, point) => {x, y, behind} in coordinate stage 1920x1080
   * @param cam     { dist } distanza della camera (mm): nei primi piani l'intestazione si attenua
   */
  update(t, project, cam = {}) {
    const ov = this.ov;
    const vis = (e, a) => { e.style.opacity = a.toFixed(3); e.style.visibility = a > 0.002 ? 'visible' : 'hidden'; };

    // intro
    const ai = windowFade(t, 0.15, ov.intro.t1, 0.7, 0.6);
    vis(this.intro, ai);
    this.intro.style.transform = `translateY(${(1 - EASE.out(clamp01((t - 0.15) / 0.9))) * 30}px)`;

    // intestazione + didascalia
    const ap = windowFade(t, ov.captionsFrom, ov.captionsTo, 0.5, 0.5);
    const near = cam.dist ? clamp01((cam.dist - 900) / 1300) : 1;
    vis(this.brand, windowFade(t, ov.brandFrom, ov.captionsTo, 0.5, 0.5) * (0.38 + 0.62 * near));
    vis(this.caption, ap);
    this.caption.style.transform = `translateY(${(1 - EASE.out(clamp01((t - ov.captionsFrom) / 0.7))) * 40}px)`;

    const step = this.captionSteps.find((s) => t >= s.t0 && t < s.t1) || null;
    if (step && step !== this.curStep) {
      this.curStep = step;
      this.cTitle.textContent = step.title;
      this.cBody.textContent = step.body || '';
      if (step.icon === 'check') {
        this.cBadge.innerHTML = `<span class="glyph">${CHECK_ICON}</span>`;
        this.cCount.innerHTML = `<em>Completato</em>`;
      } else if (step.n) {
        this.cBadge.innerHTML = `<span class="glyph num">${step.n}</span>`;
        this.cCount.innerHTML = `Passo <em>${step.n}</em> / ${this.numbered.length}`;
      } else {
        this.cBadge.innerHTML = `<span class="glyph">${BOX_ICON}</span>`;
        this.cCount.textContent = 'Contenuto';
      }
      this.cGlyph = this.cBadge.firstChild;
    }
    if (step) {
      const last = step === this.captionSteps[this.captionSteps.length - 1];
      const t0 = Math.max(step.t0, ov.captionsFrom);
      // il pannello e il fondo arancio del badge restano pieni: cambiano solo testo e cifra
      const a = windowFade(t, t0 - 0.001, last ? step.t1 + 10 : step.t1, 0.25, 0.15);
      this.cText.style.opacity = a.toFixed(3);
      this.cGlyph.style.opacity = a.toFixed(3);
      const slide = (1 - EASE.out(clamp01((t - t0) / 0.5))) * 16;
      this.cText.style.transform = `translateY(${slide}px)`;
      for (let i = 0; i < this.cSegs.length; i++) {
        const sn = this.numbered[i];
        let f = 0;
        if (step.icon === 'check') f = 1;
        else if (step.n) f = sn.n < step.n ? 1 : sn.n === step.n ? clamp01((t - sn.t0) / (sn.t1 - sn.t0)) : 0;
        this.cSegs[i].firstChild.style.width = (f * 100).toFixed(2) + '%';
        this.cSegs[i].classList.toggle('cur', sn.n === step.n && step.icon !== 'check');
      }
    }

    // etichette parti
    for (const L of this.labels) {
      const s = L.spec;
      const a = windowFade(t, s.t0, s.t1, 0.35, 0.35);
      vis(L.e, a);
      L.line.setAttribute('opacity', a.toFixed(3));
      L.dot.setAttribute('opacity', a.toFixed(3));
      if (a <= 0) continue;
      const p = project(s.part, s.point);
      const w = L.e.offsetWidth, h = L.e.offsetHeight;
      const cx = p.x + s.dx, cy = p.y + s.dy;
      const left = s.dx >= 0 ? cx : cx - w;
      L.e.style.left = left.toFixed(1) + 'px';
      L.e.style.top = (cy - h / 2).toFixed(1) + 'px';
      L.line.setAttribute('x1', p.x.toFixed(1)); L.line.setAttribute('y1', p.y.toFixed(1));
      L.line.setAttribute('x2', cx.toFixed(1)); L.line.setAttribute('y2', cy.toFixed(1));
      L.dot.setAttribute('cx', p.x.toFixed(1)); L.dot.setAttribute('cy', p.y.toFixed(1));
    }

    // ferramenta
    const ah = windowFade(t, ov.hardware.t0, ov.hardware.t1, 0.5, 0.4);
    vis(this.hw, ah);
    this.hw.style.transform = `translateX(${(1 - EASE.out(clamp01((t - ov.hardware.t0) / 0.7))) * 60}px)`;

    // quantita'
    for (const T of this.tags) {
      const s = T.spec;
      const a = windowFade(t, s.t0, s.t1, 0.3, 0.3);
      vis(T.e, a);
      if (a <= 0) continue;
      const p = project(s.part, s.point);
      const w = T.e.offsetWidth, h = T.e.offsetHeight;
      const pop = 0.85 + 0.15 * EASE.out(clamp01((t - s.t0) / 0.35));
      T.e.style.left = (s.center ? p.x - w / 2 : p.x + s.dx).toFixed(1) + 'px';
      T.e.style.top = (p.y + s.dy - h / 2).toFixed(1) + 'px';
      T.e.style.transform = `scale(${pop.toFixed(3)})`;
    }

    // cartello finale
    vis(this.end, windowFade(t, ov.endcard.t0, ov.endcard.t1, 0.8, 0.01));
  }
}
