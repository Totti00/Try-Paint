// ManualData → documento HTML del manuale (copertina, contenuto, panoramica, passi, note, retro).
// L'impaginazione vera e propria (distribuzione dei blocchi nelle pagine A4, riduzione delle figure)
// avviene nel browser con paginate.browser.js.
import { escapeHtml as esc, inline, paragraphs, warningHtml, shortLabel, hardwareChip, typo } from './text.js';

const BARS_SVG = '<svg class="bars" viewBox="0 0 24 18" aria-hidden="true"><rect width="24" height="4"/><rect y="7" width="24" height="4"/><rect y="14" width="24" height="4"/></svg>';
const WARN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 1.5 21h21L12 2.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 9.5v5.5M12 17.6v.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_HW = '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M14 6h20l-3 7H17z"/><path d="M19 13v29l5 4 5-4V13"/><path d="M19 20l10 4M19 27l10 4M19 34l10 4"/></svg>';
const ICON_COMP = '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M24 4 42 14v20L24 44 6 34V14z"/><path d="M6 14l18 10 18-10M24 24v20"/></svg>';

/** Niente parole brevi ("di", "e", "a"…) a fine riga nei titoli grandi: spazio non separabile dopo di esse. */
const noShortWordAtEnd = (html) => html.replace(/(^|[\s>])(\p{L}{1,3})\s+(?=\p{L})/gu, '$1$2&nbsp;');
const qtyText = (q) => (Number.isInteger(q) && q > 0 ? `×${q}` : '');

/** Colonne e altezza delle immagini delle griglie del "Contenuto della confezione". */
function hwGrid(n) {
  const cols = n <= 3 ? 3 : ({ 4: 4, 5: 3, 6: 3, 7: 4, 8: 4, 9: 3 })[n] ?? 4;
  return { cols, h0: cols === 3 ? 42 : 32 };
}
function compGrid(n) {
  if (n <= 4) return { cols: 2, h0: 46 };
  if (n <= 6) return { cols: 3, h0: 38 };
  if (n <= 9) return { cols: 3, h0: 34 };
  return { cols: 4, h0: 28 };
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * @param {object} manual  ManualData
 * @param {object} ctx     { images: Map<id,{src,width,height,aspect,bleed}>, css, fontCss, themeCss, script, backLogo }
 */
export function buildManualHtml(manual, ctx) {
  const images = ctx.images || new Map();
  const img = (id) => (id && images.has(id) ? images.get(id) : null);
  const imgTag = (im, alt = '') => `<img src="${esc(im.src)}" alt="${esc(alt)}" data-aspect="${im.aspect.toFixed(4)}" decoding="sync">`;

  const docTitle = typo(manual.document_title || 'Istruzioni di montaggio');
  const shortName = typo(manual.short_name || '');
  const footer = typo(manual.footer_text || manual.short_name || '');
  const hardware = manual.hardware || [];
  const components = manual.components || [];
  const steps = manual.steps || [];
  const notes = manual.notes || [];
  const phases = manual.phases || [];

  // fase di ogni passo (la prima che lo contiene)
  const phaseOf = new Map();
  phases.forEach((ph, i) => (ph.step_numbers || []).forEach((n) => { if (!phaseOf.has(n)) phaseOf.set(n, i); }));
  const phaseLabel = (i, attrs = '') =>
    `<div class="blk phase-label" data-keep data-phase="${i}"${attrs}><span>Fase ${i + 1}</span>${inline(phases[i].title || '')}</div>`;

  const hwById = new Map(hardware.map((h) => [h.id, h]));
  const compByCode = new Map(components.map((c) => [c.code, c]));
  const usedRefs = new Set(steps.flatMap((s) => (s.uses || []).map((u) => u.ref)));

  // ------------------------------------------------------------------ copertina
  const hero = img(manual.cover_image_id);
  const groups = (manual.products || []).filter((g) => (g.names || []).length);
  let productsHtml = '';
  const totalNames = groups.reduce((a, g) => a + g.names.length, 0);
  if (groups.length) {
    productsHtml = groups.map((g) => {
      const cols = g.names.length > 6 ? ' class="cols2"' : '';
      return `<div class="group">${g.category ? `<span class="cat">${inline(g.category)}</span>` : ''}<ul${cols}>${g.names.map((n) => `<li>${inline(n)}</li>`).join('')}</ul></div>`;
    }).join('');
  }
  // senza elenco prodotti il nome breve va sotto il titolo
  const coverName = !groups.length && shortName ? `<div class="cover-name">${inline(shortName)}</div>` : '';
  const titleLen = docTitle.length;
  const titleSize = titleLen <= 26 ? 50 : titleLen <= 40 ? 42 : titleLen <= 60 ? 34 : 28;
  const prodSize = totalNames > 10 ? 11 : totalNames > 6 ? 13 : 15;
  const cover = `
<section class="page cover${hero ? '' : ' no-hero'}" data-kind="cover" style="--title-size:${titleSize}pt;--prod-size:${prodSize}pt">
  <div class="cover-band">
    <div class="cover-title"><h1>${noShortWordAtEnd(inline(docTitle))}</h1><span class="rule"></span>${coverName}</div>
    ${productsHtml ? `<div class="cover-products">${productsHtml}</div>` : ''}
    ${hero ? '' : `<div class="cover-mark">${BARS_SVG}</div>`}
  </div>
  ${hero ? `<div class="cover-hero${hero.bleed ? ' bleed' : ''}">${imgTag(hero, shortName)}</div>` : ''}
</section>`;

  // ------------------------------------------------------------------ contenuto della confezione
  const chapters = [];
  if (hardware.length || components.length) {
    const blocks = [`<div class="blk blk-title" data-keep><h1 class="page-title">Contenuto della confezione</h1></div>`];
    let letter = 0;
    if (hardware.length) {
      const g = hwGrid(hardware.length);
      blocks.push(`<div class="blk blk-sec" data-keep><h2 class="sec"><span class="sec-n">${'ABC'[letter++]}</span>Ferramenta in dotazione</h2></div>`);
      // nessuna figura (es. Word con immagini EMF saltate): elenco compatto invece di riquadri vuoti
      if (!hardware.some((h) => img(h.image_id))) {
        for (const row of chunk(hardware, 2)) {
          const items = row.map((h) => {
            const q = qtyText(h.qty);
            return `<div class="li"><span class="code${h.id ? '' : ' none'}">${esc(typo(h.id || ''))}</span><p><b>${inline(h.name)}</b>${h.spec ? `<span>${inline(h.spec)}</span>` : ''}</p>${q ? `<span class="qty-inline">${q}</span>` : '<span></span>'}</div>`;
          }).join('');
          blocks.push(`<div class="blk list-row">${items}</div>`);
        }
      }
      else for (const row of chunk(hardware, g.cols)) {
        const cards = row.map((h) => {
          const im = img(h.image_id);
          const chip = hardwareChip(h);
          const tag = chip.badge === h.id && usedRefs.has(h.id) ? `<span class="tag">${esc(h.id)}</span>` : '';
          const q = qtyText(h.qty);
          return `<div class="card hw">
  <div class="card-img${im ? (im.bleed ? ' bleed' : '') : ' empty'}">${im ? imgTag(im, h.name) : ICON_HW}</div>
  ${q ? `<span class="qty">${q}</span>` : ''}${tag}
  <div class="card-txt"><b>${inline(h.name)}</b>${h.spec ? `<span>${inline(h.spec)}</span>` : ''}</div>
</div>`;
        }).join('');
        blocks.push(`<div class="blk grid-row cols-${g.cols}" data-kind="cards" data-h0="${g.h0}" style="--cols:${g.cols}">${cards}</div>`);
      }
    }
    if (components.length) {
      const g = compGrid(components.length);
      blocks.push(`<div class="blk blk-sec" data-keep><h2 class="sec"><span class="sec-n">${'ABC'[letter++]}</span>Componenti</h2></div>`);
      if (!components.some((c) => img(c.image_id))) {
        for (const row of chunk(components, 2)) {
          const items = row.map((c) => {
            const q = qtyText(c.qty);
            return `<div class="li"><span class="code">${esc(typo(c.code))}</span><p><b>${inline(c.name)}</b></p>${q ? `<span class="qty-inline">${q}</span>` : '<span></span>'}</div>`;
          }).join('');
          blocks.push(`<div class="blk list-row">${items}</div>`);
        }
      }
      else for (const row of chunk(components, g.cols)) {
        const cards = row.map((c) => {
          const im = img(c.image_id);
          const q = qtyText(c.qty);
          return `<div class="card comp">
  <div class="card-img${im ? (im.bleed ? ' bleed' : '') : ' empty'}">${im ? imgTag(im, c.name) : ICON_COMP}</div>
  <div class="card-txt"><span class="code">${esc(typo(c.code))}</span><p>${inline(c.name)}</p>${q ? `<span class="qty-inline">${q}</span>` : '<span></span>'}</div>
</div>`;
        }).join('');
        blocks.push(`<div class="blk grid-row cols-${g.cols}" data-kind="cards" data-h0="${g.h0}" style="--cols:${g.cols}">${cards}</div>`);
      }
    }
    chapters.push({ name: 'contenuto', section: 'Prima di iniziare', blocks });
  }

  // gruppi consecutivi di passi con la stessa fase (per panoramica e passi)
  const runs = [];
  for (const s of steps) {
    const ph = phaseOf.has(s.number) ? phaseOf.get(s.number) : null;
    if (!runs.length || runs[runs.length - 1].phase !== ph) runs.push({ phase: ph, steps: [] });
    runs[runs.length - 1].steps.push(s);
  }
  const stepImages = (s) => [...new Set((s.image_ids || []).filter((id) => img(id)))];

  // ------------------------------------------------------------------ panoramica
  if (steps.length >= 4) {
    const cols = steps.length <= 9 ? 3 : 4;
    const h0 = cols === 3 ? 46 : 34;
    const blocks = [`<div class="blk blk-title" data-keep><h1 class="page-title">Sequenza di montaggio</h1></div>`];
    for (const run of runs) {
      if (run.phase !== null) blocks.push(phaseLabel(run.phase));
      for (const row of chunk(run.steps, cols)) {
        const cards = row.map((s) => {
          const first = stepImages(s)[0];
          const im = img(first);
          return `<div class="ov">
  <div class="ov-img${im ? (im.bleed ? ' bleed' : '') : ' empty'}">${im ? imgTag(im, s.title) : `<span>${esc(s.number)}</span>`}</div>
  <div class="ov-txt"><span class="ov-n">${esc(s.number)}</span><b>${inline(s.title)}</b><span class="ov-p" data-ref="${esc(s.number)}">pag. 00</span></div>
</div>`;
        }).join('');
        blocks.push(`<div class="blk ov-row cols-${cols}" data-kind="cards" data-h0="${h0}" style="--cols:${cols}">${cards}</div>`);
      }
    }
    chapters.push({ name: 'panoramica', section: 'Panoramica', blocks });
  }

  // ------------------------------------------------------------------ passi + note
  const stepBlocks = [];
  for (const run of runs) {
    if (run.phase !== null) stepBlocks.push(phaseLabel(run.phase));
    for (const s of run.steps) stepBlocks.push(stepBlock(s, run.phase));
  }
  for (const n of notes) stepBlocks.push(noteBlock(n));
  if (stepBlocks.length) chapters.push({ name: 'passi', section: steps.length ? 'Montaggio' : 'Note', blocks: stepBlocks });

  function chipsHtml(s) {
    const items = (s.uses || []).map((u) => {
      const q = qtyText(u.qty);
      const qty = q ? `<i>${q}</i>` : '';
      const comp = compByCode.get(u.ref);
      if (comp) return `<li><b>${esc(typo(comp.code))}</b>${esc(shortLabel(comp.name))}${qty}</li>`;
      const hw = hwById.get(u.ref);
      if (hw) {
        const c = hardwareChip(hw);
        return `<li><b>${esc(c.badge)}</b>${esc(c.label)}${qty}</li>`;
      }
      return `<li><b>${esc(typo(u.ref))}</b>${qty}</li>`;
    });
    return items.length ? `<ul class="chips">${items.join('')}</ul>` : '';
  }

  function figHtml(id, cls = '') {
    const im = img(id);
    return `<figure class="fig${cls}${im.bleed ? ' bleed' : ''}" data-aspect="${im.aspect.toFixed(4)}" data-bleed="${im.bleed ? 1 : 0}">${imgTag(im)}</figure>`;
  }

  function stepBlock(s, phase) {
    const ids = stepImages(s);
    let layout = 'text';
    let alt = '';
    let grow = '';
    if (ids.length === 1) {
      const im = img(ids[0]);
      layout = im.aspect <= 1.3 ? 'side' : 'wide';
      // oggetto su fondo bianco, orizzontale ma non panoramico: se serve spazio può stare di fianco al testo
      if (layout === 'wide' && !im.bleed && im.aspect <= 2.4) alt = 'side';
      // quasi quadrata: se nella pagina avanza spazio può diventare grande sotto il testo
      if (layout === 'side' && im.aspect >= 0.85) grow = 'wide';
    }
    else if (ids.length >= 2 && ids.length <= 3) layout = 'row';
    else if (ids.length >= 4) layout = 'grid';
    const num = String(s.number);
    const textLen = (s.paragraphs || []).join(' ').length + String(s.warning || '').length;
    const numCls = num.length >= 3 ? ' n3' : num.length === 2 ? ' n2' : '';
    const paras = (s.paragraphs || []).filter((p) => String(p).trim()).map((p) => `<p>${inline(p)}</p>`).join('');
    let figs = '';
    if (layout === 'side') figs = `${figHtml(ids[0], ' fig-side')}<div class="figs"></div>`;
    else if (layout !== 'text') figs = `<div class="figs">${ids.map((id) => figHtml(id)).join('')}</div>`;
    const warn = s.warning && String(s.warning).trim()
      ? `<aside class="note warn">${WARN_SVG}<p>${warningHtml(s.warning)}</p></aside>` : '';
    return `<section class="blk blk-step" data-kind="step" data-layout="${layout}" data-layout0="${layout}"${alt ? ` data-alt="${alt}"` : ''}${grow ? ` data-grow="${grow}"` : ''} data-textlen="${textLen}" data-step="${esc(num)}"${phase !== null ? ` data-phase="${phase}"` : ''}>
  <hr class="step-sep">
  <article class="step l-${layout}">
    <div class="step-num${numCls}"><span>Passo</span>${esc(num)}</div>
    <div class="step-body" data-split><h3>${inline(s.title)}</h3>${paras}${chipsHtml(s)}</div>
    ${figs}${warn}
  </article>
</section>`;
  }

  function noteBlock(n) {
    const im = img(n.image_id);
    const paras = paragraphs(n.text).map((p) => `<p>${inline(p)}</p>`).join('');
    const imgHtml = im
      ? `<div class="nb-img${im.bleed ? ' bleed' : ''}" data-aspect="${im.aspect.toFixed(4)}" data-bleed="${im.bleed ? 1 : 0}">${imgTag(im)}</div>` : '';
    return `<aside class="blk nb${im ? ' has-img' : ''}" data-kind="nb">
  <div class="nb-txt" data-split><span class="nb-tag">${inline(n.label || 'N.B.')}</span>${n.title ? `<h3>${inline(n.title)}</h3>` : ''}${paras}</div>
  ${imgHtml}
</aside>`;
  }

  // ------------------------------------------------------------------ retro
  const logo = ctx.backLogo;
  const back = `
<section class="page back" data-kind="back"${logo?.bg ? ` style="--back-bg:${esc(logo.bg)}"` : ''}>
  ${logo ? `<img class="back-logos${logo.mode === 'card' ? ' card' : ''}" src="${esc(logo.src)}" alt="">`
    : `<div class="back-mark">${BARS_SVG}${shortName ? `<span>${esc(shortName)}</span>` : ''}</div>`}
</section>`;

  // testata: "Istruzioni di montaggio · Nome"; con un titolo lungo basta il nome breve
  const brandText = docTitle.length <= 32 || !shortName
    ? `<b>${esc(docTitle)}</b>${shortName ? ` · ${esc(shortName)}` : ''}`
    : `<b>${esc(shortName)}</b>`;
  const brand = `${BARS_SVG}<span>${brandText}</span>`;
  const tpl = `<template id="tpl-page"><section class="page inner" data-kind="inner">
  <header class="run-head"><div class="brand">${brand}</div><div class="section-name"></div></header>
  <main class="content"></main>
  <footer class="run-foot"><span class="foot-text">${esc(footer)}</span><span class="folio"></span></footer>
</section></template>`;

  const flow = chapters.map((c) =>
    `<div class="chapter" data-chapter="${c.name}" data-section="${esc(c.section)}">\n${c.blocks.join('\n')}\n</div>`).join('\n');

  const title = [docTitle, shortName].filter(Boolean).join(' – ');
  const metaJson = JSON.stringify({ phases: phases.map((p) => typo(p.title || '')) }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${esc(manual.language || 'it')}">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${ctx.fontCss || ''}</style>
<style>${ctx.themeCss || ''}</style>
<style>${ctx.css || ''}</style>
</head>
<body>
<div id="book">${cover}${back}</div>
<div id="flow">${flow}</div>
${tpl}
<script type="application/json" id="meta">${metaJson}</script>
<script>${ctx.script || ''}</script>
</body>
</html>`;
}

