// modeImages.js — "video con immagini" (senza modello 3D): motion graphics da ManualData e dalle
// immagini del manuale (immagini/final/*.png). Sequenza: titolo con copertina, componenti, ferramenta,
// (fasi), passi con immagini grandi e movimento lento "Ken Burns", note, completato, cartello finale.

import { EASE, clamp01, windowFade, prog } from './anim.js';
import { esc, markup, strip, shorten, qtyLabel, fitText } from './text.js';
import { Brand, Caption, Warning, EndCard, ICON, el, vis } from './ui.js';

const XF = 0.7;              // durata delle dissolvenze tra scene
const SW = 1920, SH = 1080;  // stage

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'sync';
    img.onload = async () => { try { await img.decode(); } catch { /* ok */ } resolve(img.naturalWidth ? img : null); };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** scheda bianca con l'immagine adattata (contain) al rettangolo, centrata */
function placeCard(parent, img, rect, { pad = 26, maxScale = 2.6 } = {}) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const s = Math.min((rect.w - 2 * pad) / nw, (rect.h - 2 * pad) / nh, maxScale);
  const iw = Math.round(nw * s), ih = Math.round(nh * s);
  const cw = iw + 2 * pad, ch = ih + 2 * pad;
  const card = el('div', 'card');
  Object.assign(card.style, { left: Math.round(rect.x + (rect.w - cw) / 2) + 'px', top: Math.round(rect.y + (rect.h - ch) / 2) + 'px', width: cw + 'px', height: ch + 'px' });
  const im = img.cloneNode();
  Object.assign(im.style, { left: pad + 'px', top: pad + 'px', width: iw + 'px', height: ih + 'px' });
  card.appendChild(im);
  parent.appendChild(card);
  return card;
}

/** griglia di schede: colonne scelte per massimizzare la dimensione */
function gridLayout(n, area, { gap = 32, aspect = 1.0, maxAspect = 1.35, maxW = 470, maxH = 560 } = {}) {
  let best = null;
  for (let cols = 1; cols <= Math.min(n, 5); cols++) {
    const rows = Math.ceil(n / cols);
    let w = (area.w - (cols - 1) * gap) / cols;
    const h = (area.h - (rows - 1) * gap) / rows;
    w = Math.min(w, h * maxAspect);
    const score = Math.min(w / aspect, h);
    if (!best || score > best.score + 1) best = { cols, rows, w, h: Math.min(h, w / aspect * 1.25), score };
  }
  // schede non enormi quando sono poche
  if (best.w > maxW) { best.h *= maxW / best.w; best.w = maxW; }
  if (best.h > maxH) { best.w *= maxH / best.h; best.h = maxH; }
  const totalW = best.cols * best.w + (best.cols - 1) * gap;
  const totalH = best.rows * best.h + (best.rows - 1) * gap;
  const x0 = area.x + (area.w - totalW) / 2, y0 = area.y + (area.h - totalH) / 2;
  const cells = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / best.cols), c = i % best.cols;
    // ultima riga incompleta: centrata
    const inRow = r === best.rows - 1 ? n - r * best.cols : best.cols;
    const off = (best.cols - inRow) * (best.w + gap) / 2;
    cells.push({ x: x0 + off + c * (best.w + gap), y: y0 + r * (best.h + gap), w: best.w, h: best.h });
  }
  return cells;
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

export async function createEngine({ cfg, theme, stage }) {
  const M = cfg.manual;
  if (!M || !Array.isArray(M.steps)) throw new Error('Dati del manuale mancanti per il video');
  const warnings = [];

  // ----------------------------------------------------------------- immagini
  const imgs = new Map();
  await Promise.all(Object.entries(cfg.images || {}).map(async ([id, info]) => {
    const img = await loadImage(info.url);
    if (img) imgs.set(id, img); else warnings.push(`Immagine ${id} non caricabile`);
  }));
  const getImg = (id) => (id && imgs.get(id)) || null;
  const imgUrl = (id) => (id && imgs.get(id) ? imgs.get(id).src : null);

  const compByCode = new Map((M.components || []).map((c) => [c.code, c]));
  const hwById = new Map((M.hardware || []).map((h) => [h.id, h]));

  const scenes = [];
  let T = 0;
  const add = (sc, dur) => {
    sc.t0 = T; sc.t1 = T + dur;
    T = sc.t1 - XF;
    scenes.push(sc);
    sc.root.classList.add('scene');
    vis(sc.root, 0);
    stage.appendChild(sc.root);
    return sc;
  };

  // ----------------------------------------------------------------- titolo
  {
    const root = el('div');
    const cover = getImg(M.cover_image_id);
    const txt = el('div', 'intro-text' + (cover ? '' : ' centered'));
    const prods = (M.products || []).filter((p) => p.names && p.names.length);
    const prodHtml = prods.length
      ? prods.map((p) => (p.category ? `<b>${esc(p.category)}</b>` : '') + esc(p.names.join(' · '))).join('')
      : (M.footer_text ? esc(M.footer_text) : '');
    txt.innerHTML = `<div class="kicker">${esc(M.document_title || 'Istruzioni di montaggio')}</div>` +
      `<h1>${esc(M.short_name || '')}</h1><div class="rule"></div><div class="products">${prodHtml}</div>`;
    root.appendChild(txt);
    let card = null;
    if (cover) card = placeCard(root, cover, { x: 980, y: 120, w: 844, h: 840 }, { pad: 30, maxScale: 2 });
    const sc = { kind: 'intro', root, txt, card };
    sc.layout = () => {
      const h1 = txt.querySelector('h1');
      if (!cover) h1.style.whiteSpace = 'nowrap';
      fitText(h1, { maxW: cover ? 820 : 1700, maxH: cover ? 270 : 150, min: 54 });
      const p = txt.querySelector('.products');
      fitText(p, { maxW: cover ? 820 : 1600, maxH: 300, min: 22 });
    };
    sc.update = (t, a) => {
      const u = prog(t, sc.t0, sc.t1);
      txt.style.transform = `translateY(${((1 - EASE.out(clamp01((t - sc.t0) / 1.0))) * 30).toFixed(1)}px)`;
      if (card) card.style.transform = `translate(${(-10 + 20 * u).toFixed(2)}px, 0) scale(${(1.0 + 0.045 * u).toFixed(4)})`;
    };
    add(sc, 5.5);
  }

  // ----------------------------------------------------------------- componenti e ferramenta
  const tilesScene = (title, sub, items, render, maxPer = 8) => {
    const nPages = Math.ceil(items.length / maxPer);
    const pages = chunk(items, Math.ceil(items.length / nPages));
    pages.forEach((page, pi) => {
      const root = el('div');
      const head = el('div', 'sec-head', `<div class="bar"></div><h2>${esc(title)}</h2><div class="sub">${esc(sub)}${pages.length > 1 ? ` · ${pi + 1}/${pages.length}` : ''}</div>`);
      root.appendChild(head);
      const cells = gridLayout(page.length, { x: 96, y: 250, w: 1728, h: 770 }, { aspect: 1.05 });
      const tiles = page.map((it, i) => {
        const tile = el('div', 'tile');
        Object.assign(tile.style, { left: cells[i].x + 'px', top: cells[i].y + 'px', width: cells[i].w + 'px', height: cells[i].h + 'px' });
        tile.innerHTML = render(it);
        root.appendChild(tile);
        return tile;
      });
      const sc = { kind: 'tiles', root, tiles, head };
      sc.layout = () => {
        for (const tile of tiles) {
          const nm = tile.querySelector('.nm');
          if (nm) fitText(nm, { maxW: nm.clientWidth, maxH: 3 * 32, min: 18 });
        }
      };
      sc.update = (t) => {
        head.style.transform = `translateY(${((1 - EASE.out(clamp01((t - sc.t0) / 0.8))) * 20).toFixed(1)}px)`;
        tiles.forEach((tile, i) => {
          const a = EASE.out(clamp01((t - sc.t0 - 0.35 - i * 0.12) / 0.55));
          tile.style.opacity = a.toFixed(3);
          tile.style.transform = `translateY(${((1 - a) * 26).toFixed(1)}px)`;
        });
      };
      add(sc, Math.min(9, Math.max(4.5, 3.2 + 0.55 * page.length)));
    });
  };

  if ((M.components || []).length) {
    tilesScene('Componenti', 'Verificare il contenuto della confezione', M.components, (c) => {
      const u = imgUrl(c.image_id);
      return `<div class="img${u ? '' : ' none'}">${u ? `<img src="${esc(u)}" alt="">` : ''}</div>` +
        `<div class="foot"><div class="code">${esc(c.code)}</div><div class="nm">${esc(c.name)}</div><div class="q">${esc(qtyLabel(c.qty))}</div></div>`;
    });
  }
  if ((M.hardware || []).length) {
    tilesScene('Ferramenta in dotazione', 'Viti e accessori nella confezione', M.hardware, (h) => {
      const u = imgUrl(h.image_id);
      return `<div class="img${u ? '' : ' none'}">${u ? `<img src="${esc(u)}" alt="">` : ''}</div>` +
        `<div class="foot"><div class="nm">${esc(h.name)}${h.spec ? `<small>${esc(h.spec)}</small>` : ''}</div><div class="q">${esc(qtyLabel(h.qty))}</div></div>`;
    });
  }

  // ----------------------------------------------------------------- passi
  const steps = M.steps.slice();
  const phaseOf = new Map();
  const phases = (M.phases || []).filter((p) => p.step_numbers && p.step_numbers.length);
  phases.forEach((p, i) => { const first = Math.min(...p.step_numbers); phaseOf.set(first, { ...p, index: i }); });
  const stepScenes = [];
  const CAP_H = 236;          // altezza fissa del pannello didascalia (stage px)
  const AREA = { x: 96, y: 150, w: 1728, h: SH - 64 - CAP_H - 34 - 150 };

  steps.forEach((s, si) => {
    const ph = phases.length >= 2 ? phaseOf.get(s.number) : null;
    if (ph) {
      const root = el('div');
      const nums = ph.step_numbers.slice().sort((a, b) => a - b);
      const range = nums.length > 1 ? `Passi ${nums[0]}–${nums[nums.length - 1]}` : `Passo ${nums[0]}`;
      root.appendChild(el('div', 'phase', `<div class="num">Fase ${ph.index + 1} di ${phases.length}</div><h2>${esc(ph.title)}</h2><div class="rule"></div><div class="steps">${range}</div>`));
      const sc = { kind: 'phase', root };
      sc.layout = () => fitText(root.querySelector('h2'), { maxW: 1650, maxH: 250, min: 50 });
      sc.update = (t) => { root.firstChild.style.transform = `translateX(${((1 - EASE.out(clamp01((t - sc.t0) / 0.9))) * -40).toFixed(1)}px)`; };
      add(sc, 2.8);
    }

    const root = el('div');
    const ims = (s.image_ids || []).map(getImg).filter(Boolean);
    const paras = (s.paragraphs || []).filter((p) => strip(p));
    const bodyFull = paras.join(' ');
    const body = shorten(bodyFull, 128);
    const warn = s.warning ? shorten(s.warning, 150) : null;
    let cards = [];
    let groups = [];
    if (ims.length === 1) {
      cards = [placeCard(root, ims[0], AREA)];
      groups = [[0]];
    } else if (ims.length === 2) {
      const half = { ...AREA, w: (AREA.w - 40) / 2 };
      cards = [placeCard(root, ims[0], half), placeCard(root, ims[1], { ...half, x: AREA.x + half.w + 40 })];
      groups = [[0, 1]];
    } else if (ims.length > 2) {
      // a coppie, in sequenza
      const half = { ...AREA, w: (AREA.w - 40) / 2 };
      chunk(ims, 2).forEach((pair, gi) => {
        const idx = [];
        if (pair.length === 1) { cards.push(placeCard(root, pair[0], AREA)); idx.push(cards.length - 1); }
        else {
          cards.push(placeCard(root, pair[0], half)); idx.push(cards.length - 1);
          cards.push(placeCard(root, pair[1], { ...half, x: AREA.x + half.w + 40 })); idx.push(cards.length - 1);
        }
        groups.push(idx);
      });
    } else {
      // nessuna immagine: scheda di testo
      const tc = el('div', 'textcard', `<div class="bignum">${esc(s.number)}</div><div class="paras">${paras.map((p) => `<p>${markup(shorten(p, 260))}</p>`).join('') || `<p>${esc(s.title)}</p>`}</div>`);
      const tw = Math.min(AREA.w, 1500);
      Object.assign(tc.style, { left: (AREA.x + (AREA.w - tw) / 2) + 'px', top: AREA.y + 'px', width: tw + 'px', maxHeight: AREA.h + 'px' });
      root.appendChild(tc);
      tc.dataset.center = '1';
      cards = [tc];
      groups = [[0]];
    }
    const uses = (s.uses || []).map((u) => {
      const c = compByCode.get(u.ref), h = hwById.get(u.ref);
      if (c) return { code: c.code, name: c.name, q: qtyLabel(u.qty) };
      if (h) return { img: imgUrl(h.image_id), code: h.id, name: h.name, q: qtyLabel(u.qty) };
      return { code: u.ref, name: '', q: qtyLabel(u.qty) };
    });
    const chars = strip(s.title).length + strip(body).length + (warn ? strip(warn).length * 0.8 : 0);
    let dur = 2.9 + chars * 0.038 + (warn ? 1.2 : 0) + (groups.length > 1 ? 1.6 * (groups.length - 1) : 0);
    dur = Math.max(4, Math.min(groups.length > 1 ? 11 : 9, dur));
    const sc = {
      kind: 'step', root, cards, groups, step: s, si,
      item: { id: 's' + si, kind: 'step', n: s.number, title: s.title, body, uses },
      warn,
    };
    sc.layout = () => {
      if (!ims.length) {
        const pe = root.querySelector('.paras');
        fitText(pe, { maxW: pe.clientWidth, maxH: AREA.h - 112, min: 24 });
        const tc = root.querySelector('.textcard');
        tc.style.top = Math.round(AREA.y + Math.max(0, (AREA.h - tc.offsetHeight) / 2)) + 'px';
      }
    };
    sc.update = (t) => {
      const u = prog(t, sc.t0, sc.t1);
      const dir = si % 2 ? -1 : 1;
      const ng = groups.length;
      groups.forEach((g, gi) => {
        // gruppi in sequenza dentro il passo
        const g0 = sc.t0 + (sc.t1 - sc.t0) * gi / ng, g1 = sc.t0 + (sc.t1 - sc.t0) * (gi + 1) / ng;
        const a = ng === 1 ? 1 : windowFade(t, gi === 0 ? -1 : g0 - 0.25, gi === ng - 1 ? 1e9 : g1 + 0.25, 0.5, 0.5);
        const lu = ng === 1 ? u : prog(t, g0, g1);
        for (const ci of g) {
          const c = cards[ci];
          c.style.opacity = a.toFixed(3);
          if (ims.length) c.style.transform = `translate(${(dir * (-8 + 16 * lu)).toFixed(2)}px, ${(4 - 8 * lu).toFixed(2)}px) scale(${(1.0 + 0.04 * lu).toFixed(4)})`;
          else c.style.transform = `translateY(${((1 - EASE.out(clamp01((t - sc.t0) / 0.8))) * 20).toFixed(1)}px)`;
        }
      });
    };
    add(sc, dur);
    stepScenes.push(sc);
  });

  // ----------------------------------------------------------------- note
  for (const n of M.notes || []) {
    const root = el('div');
    const img = getImg(n.image_id);
    const txt = el('div', 'note-text' + (img ? '' : ' full'),
      `<div class="ntag">${esc(n.label || 'Nota')}</div>${n.title ? `<h2>${esc(n.title)}</h2>` : ''}<p>${markup(shorten(n.text, 420))}</p>`);
    root.appendChild(txt);
    const card = img ? placeCard(root, img, { x: 1100, y: 150, w: 724, h: 820 }, { maxScale: 2 }) : null;
    const sc = { kind: 'note', root, card };
    sc.layout = () => {
      const h2 = txt.querySelector('h2');
      if (h2) fitText(h2, { maxW: img ? 900 : 1500, maxH: 180, min: 40 });
      fitText(txt.querySelector('p'), { maxW: img ? 900 : 1500, maxH: 440, min: 24 });
    };
    sc.update = (t) => {
      const u = prog(t, sc.t0, sc.t1);
      txt.style.transform = `translateY(${((1 - EASE.out(clamp01((t - sc.t0) / 0.9))) * 24).toFixed(1)}px)`;
      if (card) card.style.transform = `scale(${(1 + 0.035 * u).toFixed(4)})`;
    };
    add(sc, Math.max(4.5, Math.min(8, 3 + strip(n.text).length * 0.03)));
  }

  // ----------------------------------------------------------------- completato
  {
    const root = el('div');
    const sub = M.footer_text || ((M.products || []).flatMap((p) => p.names || []).join(' · ')) || '';
    root.appendChild(el('div', 'done', `<div class="check">${ICON.check}</div><h2>Montaggio completato</h2>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`));
    const sc = { kind: 'done', root };
    sc.update = (t) => {
      const k = EASE.outQuint(clamp01((t - sc.t0) / 0.8));
      root.querySelector('.check').style.transform = `scale(${(0.6 + 0.4 * k).toFixed(3)})`;
    };
    add(sc, 3.6);
  }

  // ----------------------------------------------------------------- cartello finale
  const endScene = { kind: 'end', root: el('div') };
  const end = new EndCard(endScene.root, { logoUrl: imgUrl(M.brand_logo_image_id), name: M.short_name, docTitle: M.document_title || 'Istruzioni di montaggio' });
  endScene.update = () => {};
  add(endScene, 4.2);
  const DURATION = endScene.t1;
  end.update(1);

  // ----------------------------------------------------------------- overlay persistente
  const brand = new Brand(stage, M.short_name || '', M.document_title || 'Istruzioni di montaggio');
  const caption = new Caption(stage, { total: stepScenes.length, wide: true, usesColumn: true });
  caption.e.style.height = CAP_H + 'px';
  const warning = new Warning(stage);
  const brandFrom = scenes.length > 1 ? scenes[1].t0 : 0;
  const doneScene = scenes.find((s) => s.kind === 'done');
  const brandTo = doneScene ? doneScene.t0 + XF : DURATION;

  // impaginazione che richiede le misure del DOM
  for (const sc of scenes) { vis(sc.root, 1); if (sc.layout) sc.layout(); vis(sc.root, 0); }
  await end.prepare();
  end.update(1);
  // tutte le didascalie una volta (misure), poi la prima
  for (const sc of stepScenes) caption.setItem(sc.item);
  const warnMax = 1728 - brand.width() - 60;

  // intervalli consecutivi di passi (il pannello resta visibile)
  const runs = [];
  for (const sc of stepScenes) {
    const last = runs[runs.length - 1];
    if (last && scenes.indexOf(sc) === scenes.indexOf(last.lastScene) + 1) { last.t1 = sc.t1; last.lastScene = sc; }
    else runs.push({ t0: sc.t0, t1: sc.t1, lastScene: sc });
  }
  // finestra di testo di ogni passo: cambia a meta' dissolvenza
  stepScenes.forEach((sc) => { sc.c0 = sc.t0 + XF / 2; sc.c1 = sc.t1 - XF / 2; });

  function renderAt(t) {
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      const first = i === 0, last = i === scenes.length - 1;
      const a = windowFade(t, first ? -1 : sc.t0, last ? DURATION + 10 : sc.t1, first ? 0 : XF, last ? 0 : XF);
      const a0 = first ? Math.min(1, t / 0.6 + 0.0001) * a : a;    // il titolo entra dal fondo
      vis(sc.root, a0);
      if (a0 > 0.002) {
        sc.update(t, a0);
        // leggero ingresso/uscita in scala
        const k = 1 - a0;
        if (sc.kind !== 'end') sc.root.style.transform = `scale(${(1 - 0.012 * k).toFixed(4)})`;
      }
    }
    brand.update(windowFade(t, brandFrom, brandTo, 0.5, 0.5));

    // didascalia
    let capA = 0;
    for (const r of runs) capA = Math.max(capA, windowFade(t, r.t0, r.t1, 0.55, 0.55));
    const cur = stepScenes.find((s) => t >= s.c0 && t < s.c1) || stepScenes.filter((s) => s.c0 <= t).pop() || stepScenes[0];
    if (cur) {
      caption.setItem(cur.item);
      const isRunEnd = !stepScenes.some((s) => s.c0 >= cur.c1 - 1e-6 && Math.abs(s.c0 - cur.c1) < 0.01);
      const textA = windowFade(t, cur.c0 - 0.001, isRunEnd ? cur.c1 + 10 : cur.c1, 0.25, 0.15);
      const slide = (1 - EASE.out(clamp01((t - cur.c0) / 0.5))) * 16;
      const fills = stepScenes.map((s) => (t >= s.c1 ? 1 : t <= s.c0 ? 0 : clamp01((t - s.c0) / (s.c1 - s.c0))));
      caption.update(t, { a: capA, fills, curIndex: stepScenes.indexOf(cur), textA, slide });
      caption.e.style.transform = `translateY(${((1 - capA) * 30).toFixed(1)}px)`;
      // avvertenza
      if (cur.warn) {
        warning.set(cur.warn, warnMax);
        const wa = windowFade(t, cur.c0 + 0.5, cur.c1, 0.4, 0.25) * capA;
        warning.update(wa, (1 - EASE.out(clamp01((t - cur.c0 - 0.5) / 0.5))) * -14);
      } else warning.update(0);
    } else {
      vis(caption.e, 0);
      warning.update(0);
    }
  }

  const intro = scenes[0];
  return {
    duration: DURATION,
    posterTime: Math.min(intro.t1 - XF - 0.2, 2.8),
    chapters: scenes.map((s) => ({ kind: s.kind, t0: +s.t0.toFixed(2), t1: +s.t1.toFixed(2), title: s.item ? s.item.title : undefined })),
    warnings,
    renderAt,
  };
}
