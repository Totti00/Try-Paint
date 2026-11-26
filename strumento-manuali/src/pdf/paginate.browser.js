/* Impaginazione automatica nel browser (Chromium via Playwright).
 * - distribuisce i blocchi di #flow in pagine A4 (modello #tpl-page), un capitolo per volta;
 * - un blocco non si spezza mai (un passo resta con le sue figure); titoli e fasi restano col blocco seguente;
 * - se un blocco non entra in una pagina vuota, le sue figure si riducono; come ultima risorsa il testo
 *   prosegue nella pagina dopo ("segue");
 * - bilanciamento: piuttosto che lasciare un blocco piccolo da solo in fondo (o un buco grande), le figure
 *   della pagina si riducono leggermente (al massimo del 18%);
 * - QR code del video (se c'è #tpl-qr): riquadro in fondo alla prima pagina interna (pagina 2), che ha quindi
 *   un'area utile più corta;
 * - alla fine: numeri di pagina, testate, rimandi "pag. N" della panoramica, verifica che nulla sbordi.
 * Espone window.__paginate() → resoconto (JSON) e window.__verifyLayout().
 */
(function () {
  'use strict';
  var MM = 96 / 25.4;
  var SAFETY = 0.8 * MM;     // margine di sicurezza in fondo alla pagina (px)
  var BALANCE_FLOOR = 0.82;  // riduzione massima delle figure per bilanciare le pagine
  var CW = 174;              // larghezza utile in mm (misurata davvero all'avvio)
  var QR_GAP = 7;            // mm tra l'area utile e il riquadro del QR code
  var meta = {};
  var report = { pages: [], scaled: [], splits: [], forced: [], overflow: [], stepPages: {} };

  function mm(v) { return (Math.round(v * 100) / 100) + 'mm'; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function waitAssets() {
    var faces = [];
    document.fonts.forEach(function (f) { faces.push(f.load().catch(function () { return null; })); });
    return Promise.all(faces).then(function () { return document.fonts.ready; }).then(function () {
      var imgs = Array.prototype.slice.call(document.images);
      return Promise.all(imgs.map(function (im) {
        if (im.complete) return im.decode ? im.decode().catch(function () {}) : null;
        return new Promise(function (r) { im.onload = im.onerror = function () { r(); }; });
      }));
    });
  }

  // ------------------------------------------------------------------ figure
  function sizeImg(im, w, h) { im.style.width = mm(w); im.style.height = mm(h); }
  function fill(im) { im.style.width = '100%'; im.style.height = '100%'; }

  var layouts = {
    step: function (blk, s) {
      var layout = blk.dataset.layout;
      var figs = Array.prototype.slice.call(blk.querySelectorAll('.fig'));
      if (!figs.length) { blk.dataset.smin = '1'; return; }
      var W = CW - 22;
      var article = blk.querySelector('.step');
      var h0, h, smin = 0.5;
      if (layout === 'side') {
        var f = figs[0], im = f.querySelector('img'), a = +f.dataset.aspect, bleed = f.dataset.bleed === '1';
        var pad = bleed ? 0 : 5;
        var maxW = a > 1.3 ? 76 : 92; // immagine orizzontale di fianco al testo: colonna più stretta
        var tl = +blk.dataset.textlen || 0; // testo lungo: più spazio alla colonna del testo
        if (tl > 700) maxW = Math.min(maxW, 70); else if (tl > 420) maxW = Math.min(maxW, 80);
        h0 = Math.min(86, (maxW - 2 * pad) / a);
        h = h0 * s;
        var w = h * a;
        var frameW = bleed ? w : Math.max(56, w + 2 * pad);
        article.style.setProperty('--side-w', mm(frameW));
        f.style.width = mm(frameW);
        f.style.height = mm(h + 2 * pad);
        if (bleed) fill(im); else sizeImg(im, w, h);
        smin = clamp(42 / h0, 0.5, 1);
      } else if (layout === 'wide') {
        var f1 = figs[0], im1 = f1.querySelector('img'), a1 = +f1.dataset.aspect;
        if (f1.dataset.bleed === '1') {
          h0 = Math.min(W / a1, 105);
          h = h0 * s;
          f1.style.width = mm(h * a1); f1.style.height = mm(h); fill(im1);
        } else {
          h0 = Math.min((W - 10) / a1, 100);
          h = h0 * s;
          f1.style.width = mm(W); f1.style.height = mm(h + 10); sizeImg(im1, h * a1, h);
        }
        smin = clamp(45 / h0, 0.5, 1);
      } else if (layout === 'row') {
        // stessa altezza esterna H per tutte; quelle su sfondo bianco hanno 4 mm di margine interno
        var gap = 4, n = figs.length, sumA = 0, sumANb = 0, nNb = 0;
        figs.forEach(function (fg) { var aa = +fg.dataset.aspect; sumA += aa; if (fg.dataset.bleed !== '1') { sumANb += aa; nNb++; } });
        var H0 = Math.min(92, (W - (n - 1) * gap + 8 * sumANb - 8 * nNb) / sumA);
        var H = H0 * s;
        figs.forEach(function (fg) {
          var aa = +fg.dataset.aspect, img = fg.querySelector('img');
          if (fg.dataset.bleed === '1') { fg.style.width = mm(H * aa); fg.style.height = mm(H); fill(img); }
          else { fg.style.width = mm((H - 8) * aa + 8); fg.style.height = mm(H); sizeImg(img, (H - 8) * aa, H - 8); }
        });
        h0 = H0;
        smin = clamp(40 / H0, 0.5, 1);
      } else if (layout === 'grid') {
        var cols = figs.length <= 4 ? 2 : 3, g = 4;
        var cellW = (W - (cols - 1) * g) / cols, avg = 0;
        figs.forEach(function (fg) { avg += +fg.dataset.aspect; });
        avg /= figs.length;
        var HC0 = clamp(cellW / avg, 38, 75);
        var HC = HC0 * s;
        figs.forEach(function (fg) {
          var aa = +fg.dataset.aspect, img = fg.querySelector('img');
          fg.style.width = mm(cellW); fg.style.height = mm(HC);
          if (fg.dataset.bleed === '1') fill(img);
          else { var ih = Math.min(HC - 6, (cellW - 6) / aa); sizeImg(img, ih * aa, ih); }
        });
        h0 = HC0;
        smin = clamp(32 / HC0, 0.5, 1);
      }
      blk.dataset.smin = String(smin);
    },
    nb: function (blk, s) {
      var box = blk.querySelector('.nb-img');
      if (!box) { blk.dataset.smin = '1'; return; }
      var im = box.querySelector('img'), a = +box.dataset.aspect, bleed = box.dataset.bleed === '1';
      var pad = bleed ? 0 : 3;
      var h0 = Math.min(72, (66 - 2 * pad) / a);
      var h = h0 * s, w = h * a;
      blk.style.setProperty('--nb-w', mm(Math.max(36, w + 2 * pad)));
      sizeImg(im, w, h);
      blk.dataset.smin = String(clamp(30 / h0, 0.45, 1));
    },
    cards: function (blk, s) {
      blk.style.setProperty('--img-h', mm(+blk.dataset.h0 * s));
      blk.dataset.smin = '0.7';
    },
  };
  function setScale(blk, s) {
    var fn = layouts[blk.dataset.kind];
    blk.__s = s;
    if (fn) fn(blk, s);
  }
  function scaleOf(blk) { return blk.__s == null ? 1 : blk.__s; }

  /** Cambia la disposizione di un passo con una sola figura: 'wide' (sotto il testo) ↔ 'side' (di fianco). */
  function setLayout(blk, layout) {
    if (blk.dataset.layout === layout) return;
    var art = blk.querySelector('.step'), fig = blk.querySelector('.fig'), wrap = blk.querySelector('.figs');
    if (!art || !fig || !wrap) return;
    if (layout === 'side') { fig.classList.add('fig-side'); art.insertBefore(fig, wrap); }
    else { fig.classList.remove('fig-side'); wrap.appendChild(fig); }
    art.classList.remove('l-' + blk.dataset.layout);
    art.classList.add('l-' + layout);
    art.style.removeProperty('--side-w');
    blk.dataset.layout = layout;
  }
  /** Prova la disposizione alternativa dei blocchi del gruppo (eventualmente riducendo le figure). */
  function tryAlt(pg, group, shrinkBlocks, floor) {
    var alts = group.filter(function (b) { return b.dataset.alt && b.dataset.layout !== b.dataset.alt; });
    if (!alts.length) return false;
    var saved = alts.map(function (b) { return [b.dataset.layout, scaleOf(b)]; });
    alts.forEach(function (b) { setLayout(b, b.dataset.alt); setScale(b, 1); });
    if (fits(pg)) return true;
    if (shrinkBlocks && shrinkToFit(pg, shrinkBlocks(), floor)) return true;
    alts.forEach(function (b, i) { setLayout(b, saved[i][0]); setScale(b, saved[i][1]); });
    return false;
  }

  function shrinkable(blk) { return !!layouts[blk.dataset.kind] && (+blk.dataset.smin || 1) < 1; }

  // ------------------------------------------------------------------ pagine
  var book, backPage, tpl, qrTpl = null, qrPage = null, pages = [];
  /** Riquadro del QR in fondo alla pagina: l'area utile finisce QR_GAP mm sopra il riquadro. */
  function attachQr(pg) {
    var box = qrTpl.content.firstElementChild.cloneNode(true);
    pg.el.appendChild(box);
    pg.el.classList.add('has-qr');
    var pr = pg.el.getBoundingClientRect(), br = box.getBoundingClientRect();
    pg.content.style.bottom = mm((pr.bottom - br.top) / MM + QR_GAP);
    qrPage = pg;
  }
  function newPage(chapter, continued) {
    var el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.chapter = chapter.name;
    book.insertBefore(el, backPage);
    var pg = { el: el, content: el.querySelector('.content'), chapter: chapter.name };
    pages.push(pg);
    if (qrTpl && !qrPage && chapter.name !== 'probe') attachQr(pg);
    if (continued && chapter.title) {
      var t = chapter.title.cloneNode(true);
      t.classList.add('cont');
      t.removeAttribute('data-keep');
      var h1 = t.querySelector('h1');
      if (h1) h1.insertAdjacentHTML('beforeend', ' <span class="cont">(segue)</span>');
      pg.content.appendChild(t);
    }
    return pg;
  }

  function fits(pg) {
    var c = pg.content, cr = c.getBoundingClientRect();
    var kids = c.children;
    if (!kids.length) return true;
    var maxB = cr.top;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (r.bottom > maxB) maxB = r.bottom;
      if (r.right > cr.right + 1) return false;
    }
    return maxB <= cr.bottom - SAFETY && c.scrollWidth <= c.clientWidth + 1;
  }
  function contentH(pg) { return pg.content.getBoundingClientRect().height; }

  /** Riduce le figure di `blocks` finché la pagina entra; floor = scala minima consentita (null = minimo del blocco). */
  function shrinkToFit(pg, blocks, floor) {
    var list = blocks.filter(shrinkable);
    if (!list.length) return false;
    var saved = list.map(scaleOf);
    function lim(b) { return Math.max(+b.dataset.smin || 1, floor == null ? 0 : floor); }
    function apply(t) { list.forEach(function (b, i) { setScale(b, Math.min(saved[i], 1 - t * (1 - lim(b)))); }); }
    apply(1);
    if (!fits(pg)) { list.forEach(function (b, i) { setScale(b, saved[i]); }); return false; }
    var lo = 0, hi = 1;
    for (var k = 0; k < 9; k++) {
      var mid = (lo + hi) / 2;
      apply(mid);
      if (fits(pg)) hi = mid; else lo = mid;
    }
    apply(hi);
    return true;
  }

  function splitParagraph(p, target, pg) {
    var words = p.textContent.split(/\s+/).filter(Boolean);
    if (words.length < 8) return false;
    var lo = 1, hi = words.length - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      p.textContent = words.slice(0, mid).join(' ');
      if (fits(pg)) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (!best) { p.textContent = words.join(' '); return false; }
    p.textContent = words.slice(0, best).join(' ');
    var p2 = document.createElement('p');
    p2.textContent = words.slice(best).join(' ');
    target.insertBefore(p2, firstUnit(target));
    return true;
  }
  function isHead(el) { return el.matches('h3, .nb-tag'); }
  function firstUnit(body) {
    for (var i = 0; i < body.children.length; i++) if (!isHead(body.children[i])) return body.children[i];
    return null;
  }

  /** Ultima risorsa: il testo del blocco prosegue in un blocco "segue" (senza figure). */
  function splitToFit(pg, blk) {
    var body = blk.querySelector('[data-split]');
    if (!body) return null;
    var cont = blk.cloneNode(true);
    cont.classList.add('cont');
    ['data-keep', 'data-alt', 'data-grow'].forEach(function (a) { cont.removeAttribute(a); });
    cont.dataset.layout0 = 'text';
    Array.prototype.forEach.call(cont.querySelectorAll('.fig, .figs, .nb-img, .step > .note'), function (e) { e.remove(); });
    cont.classList.remove('has-img');
    if (cont.dataset.kind === 'step') {
      cont.dataset.layout = 'text';
      cont.querySelector('.step').className = 'step l-text';
      var lbl = cont.querySelector('.step-num span');
      if (lbl) lbl.textContent = 'Segue';
    }
    var cbody = cont.querySelector('[data-split]');
    Array.prototype.slice.call(cbody.children).forEach(function (el) { if (!isHead(el)) el.remove(); });
    var head = cbody.querySelector('h3');
    if (head && !head.querySelector('.cont')) head.insertAdjacentHTML('beforeend', ' <span class="cont">(segue)</span>');
    var moved = 0;
    var warn = blk.querySelector('.step > .note');
    if (warn) { cont.querySelector('.step').appendChild(warn); moved++; }
    while (!fits(pg)) {
      var units = Array.prototype.filter.call(body.children, function (el) { return !isHead(el); });
      if (units.length <= 1) break;
      cbody.insertBefore(units[units.length - 1], firstUnit(cbody));
      moved++;
    }
    if (!fits(pg)) {
      var rest = Array.prototype.filter.call(body.children, function (el) { return !isHead(el); });
      if (rest.length === 1 && rest[0].tagName === 'P' && splitParagraph(rest[0], cbody, pg)) moved++;
    }
    if (!moved) return null;
    report.splits.push(blockName(blk));
    return cont;
  }

  function blockName(b) {
    if (b.dataset.step) return 'passo ' + b.dataset.step + (b.classList.contains('cont') ? ' (segue)' : '');
    if (b.classList.contains('nb')) return 'nota';
    if (b.classList.contains('phase-label')) return 'fase ' + (+b.dataset.phase + 1);
    if (b.classList.contains('grid-row')) return 'righe-contenuto';
    if (b.classList.contains('ov-row')) return 'riga-panoramica';
    if (b.classList.contains('blk-title')) return 'titolo';
    if (b.classList.contains('blk-sec')) return 'sezione';
    return b.className;
  }

  function place(pg, group, queue, chapter) {
    group.forEach(function (b) { pg.content.appendChild(b); });
    if (fits(pg)) return pg;
    var others = pg.content.children.length - group.length;
    if (others > 0 && !(others === 1 && pg.content.firstElementChild.classList.contains('cont') && pg.content.firstElementChild.classList.contains('blk-title'))) {
      var H = contentH(pg);
      var top0 = group[0].getBoundingClientRect().top - pg.content.getBoundingClientRect().top;
      var gh = group[group.length - 1].getBoundingClientRect().bottom - group[0].getBoundingClientRect().top;
      var lonely = queue.length === 0 && gh < 0.45 * H;
      var hole = top0 / H < 0.65;
      var pageBlocks = function () { return Array.prototype.slice.call(pg.content.children); };
      var balance = lonely || hole;
      if (tryAlt(pg, group, null, null)) return pg;
      if (balance && shrinkToFit(pg, pageBlocks(), BALANCE_FLOOR)) return pg;
      // anche i passi già nella pagina possono mettere la figura di fianco al testo
      if (balance && tryAlt(pg, pageBlocks(), pageBlocks, BALANCE_FLOOR)) return pg;
      group.forEach(function (b) { b.remove(); });
      pg = newPage(chapter, true);
      group.forEach(function (b) { pg.content.appendChild(b); });
      if (fits(pg)) return pg;
    }
    if (shrinkToFit(pg, group, null)) return pg;
    if (tryAlt(pg, group, function () { return group; }, null)) return pg;
    var cont = splitToFit(pg, group[group.length - 1]);
    if (cont) {
      setScale(cont, 1);
      queue.unshift(cont);
      return pg;
    }
    report.forced.push(group.map(blockName).join(' + '));
    return pg;
  }

  function fillOf(pg) {
    var cr = pg.content.getBoundingClientRect(), maxB = cr.top;
    Array.prototype.forEach.call(pg.content.children, function (b) { maxB = Math.max(maxB, b.getBoundingClientRect().bottom); });
    return (maxB - cr.top) / cr.height;
  }
  /** Pagine dei passi rimaste vuote in basso: le figure quasi quadrate passano sotto il testo, più grandi. */
  function growPass(pg) {
    if (pg.chapter !== 'passi' || fillOf(pg) > 0.8) return;
    Array.prototype.forEach.call(pg.content.querySelectorAll('.blk-step[data-grow]'), function (b) {
      if (b.dataset.layout === b.dataset.grow) return;
      var prev = [b.dataset.layout, scaleOf(b)];
      setLayout(b, b.dataset.grow);
      setScale(b, 1);
      if (fits(pg) || shrinkToFit(pg, [b], 0.86)) { report.grown = (report.grown || []).concat(blockName(b)); return; }
      setLayout(b, prev[0]);
      setScale(b, prev[1]);
    });
  }

  function sectionName(pg, chapterSection) {
    if (pg.chapter !== 'passi') return chapterSection;
    var phs = [];
    Array.prototype.forEach.call(pg.content.querySelectorAll('[data-phase]'), function (e) {
      var v = +e.dataset.phase;
      if (phs.indexOf(v) < 0) phs.push(v);
    });
    phs.sort(function (a, b) { return a - b; });
    var titles = meta.phases || [];
    if (phs.length === 1) return 'Fase ' + (phs[0] + 1) + (titles[phs[0]] ? ' · ' + titles[phs[0]] : '');
    if (phs.length === 2) return 'Fasi ' + (phs[0] + 1) + ' e ' + (phs[1] + 1);
    if (phs.length > 2) return 'Fasi ' + (phs[0] + 1) + '–' + (phs[phs.length - 1] + 1);
    var nums = [];
    Array.prototype.forEach.call(pg.content.querySelectorAll('.blk-step[data-step]'), function (e) {
      if (nums.indexOf(e.dataset.step) < 0) nums.push(e.dataset.step);
    });
    if (nums.length === 1) return 'Passo ' + nums[0];
    if (nums.length > 1) return 'Passi ' + nums[0] + '–' + nums[nums.length - 1];
    return 'Note';
  }

  function fitCover() {
    var cover = document.querySelector('.page.cover');
    if (!cover) return;
    var title = cover.querySelector('.cover-title'), h1 = cover.querySelector('h1');
    var prods = cover.querySelector('.cover-products'), band = cover.querySelector('.cover-band');
    for (var k = 0; k < 40; k++) {
      var tr = title.getBoundingClientRect(), br = band.getBoundingClientRect();
      var ok = tr.bottom <= br.bottom - 8 * MM && tr.right <= br.right - 10 * MM;
      if (prods) {
        var pr = prods.getBoundingClientRect();
        ok = ok && pr.top >= tr.bottom + 8 * MM && pr.right <= br.right + 1;
      }
      if (ok) break;
      var ts = parseFloat(getComputedStyle(h1).fontSize), ps = prods ? parseFloat(getComputedStyle(prods).fontSize) : 0;
      if (ts > 24 * 96 / 72) cover.style.setProperty('--title-size', (ts * 0.94 * 72 / 96) + 'pt');
      if (prods && ps > 9 * 96 / 72) cover.style.setProperty('--prod-size', (ps * 0.94 * 72 / 96) + 'pt');
    }
  }

  // ------------------------------------------------------------------ verifica
  function clipAncestors(el, stop) {
    var out = [];
    for (var a = el.parentElement; a && a !== stop.parentElement; a = a.parentElement) {
      var cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push(a);
      if (a === stop) break;
    }
    return out;
  }
  function inside(r, box, tol) {
    return r.left >= box.left - tol && r.right <= box.right + tol && r.top >= box.top - tol && r.bottom <= box.bottom + tol;
  }
  /** Tutto il testo visibile e ogni immagine stanno nella loro pagina (e nell'area utile per le pagine interne). */
  function verifyLayout() {
    var problems = [];
    var all = document.querySelectorAll('#book > .page');
    Array.prototype.forEach.call(all, function (page, idx) {
      var pr = page.getBoundingClientRect();
      var content = page.querySelector('.content');
      var area = content ? content.getBoundingClientRect() : pr;
      var walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue.trim()) continue;
        var el = node.parentElement;
        if (!el || el.closest('svg') || el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
        var range = document.createRange();
        range.selectNodeContents(node);
        var rects = range.getClientRects();
        var clips = clipAncestors(el, page);
        var inContent = content && content.contains(el);
        for (var i = 0; i < rects.length; i++) {
          var r = rects[i];
          if (!r.width || !r.height) continue;
          if (!inside(r, pr, 0.5) || (inContent && !inside(r, area, 1))) {
            problems.push({ page: idx + 1, kind: 'fuori-pagina', text: node.nodeValue.trim().slice(0, 40) });
            break;
          }
          var clipped = clips.some(function (c) {
            if (c.matches('.run-head .brand, .run-head .section-name, .run-foot .foot-text')) return false; // ellissi volute
            return !inside(r, c.getBoundingClientRect(), 1);
          });
          if (clipped) { problems.push({ page: idx + 1, kind: 'testo-tagliato', text: node.nodeValue.trim().slice(0, 40) }); break; }
        }
      }
      Array.prototype.forEach.call(page.querySelectorAll('img'), function (im) {
        if (!im.naturalWidth) problems.push({ page: idx + 1, kind: 'immagine-mancante', src: (im.getAttribute('src') || '').slice(-60) });
        var r = im.getBoundingClientRect();
        var box = im.closest('.card-img, .ov-img, .fig, .nb-img, .cover-hero');
        var vis = box ? box.getBoundingClientRect() : r;
        var visible = { left: Math.max(r.left, vis.left), right: Math.min(r.right, vis.right), top: Math.max(r.top, vis.top), bottom: Math.min(r.bottom, vis.bottom) };
        if (visible.right - visible.left < 2 || visible.bottom - visible.top < 2) problems.push({ page: idx + 1, kind: 'immagine-invisibile', src: (im.getAttribute('src') || '').slice(-60) });
        else if (!inside(visible, pr, 0.5) || (content && content.contains(im) && !inside(visible, area, 1))) problems.push({ page: idx + 1, kind: 'immagine-fuori', src: (im.getAttribute('src') || '').slice(-60) });
      });
      if (content) {
        var cr = content.getBoundingClientRect();
        Array.prototype.forEach.call(content.children, function (b) {
          var r = b.getBoundingClientRect();
          if (r.bottom > cr.bottom + 0.5 || r.right > cr.right + 0.5) problems.push({ page: idx + 1, kind: 'blocco-sborda', block: blockName(b) });
        });
      }
      // riquadro del QR: dentro la pagina, sotto l'area utile, sopra il piè di pagina
      Array.prototype.forEach.call(page.querySelectorAll('.qr-box'), function (q) {
        var qr = q.getBoundingClientRect(), foot = page.querySelector('.run-foot');
        if (!inside(qr, pr, 0.5) || (content && content.getBoundingClientRect().bottom > qr.top + 0.5) ||
            (foot && foot.getBoundingClientRect().top < qr.bottom - 0.5)) problems.push({ page: idx + 1, kind: 'qr-sovrapposto' });
      });
    });
    // il numero del passo non deve invadere il testo
    Array.prototype.forEach.call(document.querySelectorAll('#book .step-num'), function (n) {
      var body = n.parentElement.querySelector('.step-body');
      var range = document.createRange();
      range.selectNodeContents(n.lastChild);
      var r = range.getBoundingClientRect();
      if (body && r.right > body.getBoundingClientRect().left + 0.5) problems.push({ kind: 'numero-passo-largo', text: n.textContent });
    });
    return problems;
  }

  // ------------------------------------------------------------------ principale
  function paginate() {
    var metaEl = document.getElementById('meta');
    try { meta = metaEl ? JSON.parse(metaEl.textContent) : {}; } catch (e) { meta = {}; }
    book = document.getElementById('book');
    backPage = book.querySelector('.page.back');
    tpl = document.getElementById('tpl-page');
    qrTpl = document.getElementById('tpl-qr');
    fitCover();

    var chapters = Array.prototype.map.call(document.querySelectorAll('#flow > .chapter'), function (ch) {
      return {
        name: ch.dataset.chapter, section: ch.dataset.section,
        blocks: Array.prototype.slice.call(ch.children),
        title: ch.querySelector('.blk-title'),
      };
    });
    // larghezza utile reale
    var probe = newPage({ name: 'probe' });
    CW = probe.content.getBoundingClientRect().width / MM;
    probe.el.remove();
    pages.pop();

    chapters.forEach(function (ch) {
      if (ch.title) ch.title = ch.title.cloneNode(true);
      ch.blocks.forEach(function (b) { setScale(b, 1); });
      var queue = ch.blocks.slice();
      var pg = newPage(ch, false);
      // contenuto e panoramica: se riducendo le immagini (fino al 70%) stanno in una pagina, meglio una pagina sola
      if ((ch.name === 'contenuto' || ch.name === 'panoramica') && ch.blocks.length > 1) {
        ch.blocks.forEach(function (b) { pg.content.appendChild(b); });
        if (fits(pg) || shrinkToFit(pg, ch.blocks, null)) queue = [];
        else ch.blocks.forEach(function (b) { b.remove(); setScale(b, 1); });
      }
      while (queue.length) {
        var group = [queue.shift()];
        while (group[group.length - 1].hasAttribute('data-keep') && queue.length) group.push(queue.shift());
        pg = place(pg, group, queue, ch);
      }
      pages.forEach(function (p) {
        if (p.chapter !== ch.name || p.section) return;
        growPass(p);
        p.section = sectionName(p, ch.section);
      });
    });
    var flow = document.getElementById('flow');
    if (flow) flow.remove();
    if (qrTpl) qrTpl.remove();

    // numerazione, testate, rimandi
    var all = Array.prototype.slice.call(document.querySelectorAll('#book > .page'));
    all.forEach(function (p, i) {
      p.dataset.n = String(i + 1);
      var f = p.querySelector('.folio');
      if (f) f.textContent = String(i + 1).padStart(2, '0');
    });
    pages.forEach(function (p) {
      var s = p.el.querySelector('.section-name');
      if (s) s.textContent = p.section || '';
    });
    all.forEach(function (p) {
      Array.prototype.forEach.call(p.querySelectorAll('.blk-step[data-step]'), function (b) {
        if (!b.classList.contains('cont') && !(b.dataset.step in report.stepPages)) report.stepPages[b.dataset.step] = +p.dataset.n;
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.ov-p[data-ref]'), function (el) {
      var n = report.stepPages[el.dataset.ref];
      el.textContent = n ? 'pag. ' + n : '';
    });
    if (qrPage) {
      var qb = qrPage.el.querySelector('.qr-box');
      report.qr = { page: +qrPage.el.dataset.n, url: qb.dataset.videoUrl, size_mm: Math.round(qb.querySelector('.qr-code').getBoundingClientRect().width / MM * 10) / 10 };
    }

    all.forEach(function (p) {
      var entry = { n: +p.dataset.n, kind: p.dataset.kind || 'inner', chapter: p.dataset.chapter || null };
      var c = p.querySelector('.content');
      if (c) {
        var cr = c.getBoundingClientRect(), maxB = cr.top;
        Array.prototype.forEach.call(c.children, function (b) { maxB = Math.max(maxB, b.getBoundingClientRect().bottom); });
        entry.fill = Math.round(((maxB - cr.top) / cr.height) * 100) / 100;
        entry.blocks = Array.prototype.map.call(c.children, blockName);
        entry.section = (p.querySelector('.section-name') || {}).textContent || '';
        Array.prototype.forEach.call(c.children, function (b) {
          if (b.__s != null && b.__s < 0.999) report.scaled.push({ page: entry.n, block: blockName(b), scale: Math.round(b.__s * 1000) / 1000 });
        });
      }
      report.pages.push(entry);
    });
    report.overflow = verifyLayout();
    document.documentElement.dataset.paginated = '1';
    return report;
  }

  window.__verifyLayout = verifyLayout;
  window.__paginate = function () {
    return waitAssets().then(paginate);
  };
})();
