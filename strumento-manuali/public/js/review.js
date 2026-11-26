// Revisione della scheda (ManualData): editor comprensibile per chi non è tecnico, con il documento originale a fianco.
import { h, replace, icon, toast, confirmDialog, notice, modal, imagePreview, plural } from './ui.js';
import { get, put, patch } from './api.js';
import { startPdf } from './job.js';

const KIND_LABEL = { correzione: 'Correzione', uniformazione: 'Uniformazione', aggiunta: 'Aggiunta', incongruenza: 'Incongruenza' };
const SIDE_KEY = 'manuali.revisione.documento';

function readPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
}
function writePref(key, v) {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* memoria del browser non disponibile */ }
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.min(600, Math.max(t.scrollHeight + 2, 44))}px`;
}

export function renderReview(ctx) {
  const el = h('div', { class: 'review-layout' });
  const main = h('div', { class: 'review-main', style: 'min-width:0' });
  const side = h('aside', { class: 'side', 'aria-label': 'Documento originale' });
  el.append(main, side);

  let manual = null;
  let catalog = [];
  const catMap = new Map();
  let dirty = false;
  let saving = false;
  let issues = [];
  let softWarnings = [];
  let sideOpen = window.innerWidth >= 1180 && readPref(SIDE_KEY, true);
  let sideTab = 'documento';
  let destroyed = false;

  const sections = {};
  const saveState = h('span', { class: 'save-state', 'aria-live': 'polite' });
  const saveBtn = h('button', { class: 'btn', type: 'button' }, icon('check', 18), 'Salva');
  const pdfBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('pdf', 18), 'Crea il PDF', icon('right', 18));
  const sideBtn = h('button', { class: 'btn btn-ghost', type: 'button', 'aria-pressed': String(sideOpen), title: 'Mostra o nascondi il documento originale' }, icon('panel', 18), 'Originale');
  const errorsBox = h('div');
  const warnBox = h('div');
  const toc = h('nav', { class: 'toc', 'aria-label': 'Sezioni della scheda' });

  // ------------------------------------------------------------------------------- stato di salvataggio
  const renderSaveState = () => {
    saveState.classList.toggle('dirty', dirty);
    replace(saveState, h('span', { class: 'dot' }), saving ? 'Salvataggio…' : dirty ? 'Modifiche non salvate' : 'Tutto salvato');
    saveBtn.disabled = saving || !dirty;
    saveBtn.classList.toggle('btn-dark', dirty && !saving);
  };
  const markDirty = () => { if (!dirty) { dirty = true; renderSaveState(); } };

  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
    // Ctrl+B nei testi dei passi, nelle avvertenze e nelle note: evidenzia (o toglie l'evidenza) alla selezione
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B') && isEmphasisField(document.activeElement)) {
      e.preventDefault();
      toggleEmphasis(document.activeElement);
    }
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------------------- evidenziazione (**parola**)
  const isEmphasisField = (node) => !!node && node.tagName === 'TEXTAREA' && el.contains(node) &&
    /^(steps\.\d+\.(paragraphs\.\d+|warning)|notes\.\d+\.text)$/.test(node.dataset.path || '');
  /** Mette tra ** ** la parte selezionata (o la parola sotto il cursore); se è già evidenziata, toglie gli asterischi. */
  function toggleEmphasis(ta) {
    const v = ta.value;
    let a = ta.selectionStart ?? 0;
    let b = ta.selectionEnd ?? a;
    if (a === b) { // nessuna selezione: la parola sotto il cursore
      while (a > 0 && /[\p{L}\p{N}'’×,.-]/u.test(v[a - 1]) && v[a - 1] !== ' ') a--;
      while (b < v.length && /[\p{L}\p{N}'’×,.-]/u.test(v[b])) b++;
      while (b > a && /[,.]/.test(v[b - 1])) b--; // la punteggiatura finale resta fuori
      if (a === b) { toast('Seleziona prima la parola o la frase da evidenziare.', 'info'); return; }
    }
    while (a < b && v[a] === ' ') a++;
    while (b > a && v[b - 1] === ' ') b--;
    let out, selA, selB;
    const inner = v.slice(a, b);
    if (v.slice(a - 2, a) === '**' && v.slice(b, b + 2) === '**') { // già evidenziata (asterischi fuori dalla selezione)
      out = v.slice(0, a - 2) + inner + v.slice(b + 2); selA = a - 2; selB = b - 2;
    } else if (inner.startsWith('**') && inner.endsWith('**') && inner.length >= 4) { // asterischi compresi nella selezione
      out = v.slice(0, a) + inner.slice(2, -2) + v.slice(b); selA = a; selB = b - 4;
    } else {
      out = v.slice(0, a) + '**' + inner.replace(/\*\*/g, '') + '**' + v.slice(b); selA = a + 2; selB = selA + inner.replace(/\*\*/g, '').length;
    }
    ta.value = out;
    ta.setSelectionRange(selA, selB);
    ta.dispatchEvent(new Event('input', { bubbles: true })); // aggiorna la scheda e lo stato «non salvato»
    ta.focus();
  }
  /** Pulsante «Evidenzia» per i testi di un riquadro (agisce sull'ultimo campo usato al suo interno). */
  function emphasisButton(box) {
    let last = null;
    box.addEventListener('focusin', (e) => { if (isEmphasisField(e.target)) last = e.target; });
    const btn = h('button', { class: 'btn btn-sm btn-ghost emph-btn', type: 'button', title: 'Evidenzia la parte selezionata (Ctrl+B): nel PDF diventa grassetto sottolineato' }, h('b', 'G'), 'Evidenzia');
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // la selezione nel testo resta
    btn.addEventListener('click', () => {
      const ta = last && last.isConnected ? last : box.querySelector('textarea');
      if (ta) toggleEmphasis(ta);
    });
    return btn;
  }

  // ------------------------------------------------------------------------------- campi
  const clearInvalid = (node) => node.classList.remove('invalid');
  function textField(obj, key, { path, placeholder = '', multiline = false, nullable = false, cls = '', onInput, ariaLabel } = {}) {
    const node = multiline
      ? h('textarea', { class: ['textarea', cls], rows: 2, placeholder, 'aria-label': ariaLabel || null })
      : h('input', { class: ['input', cls], type: 'text', placeholder, 'aria-label': ariaLabel || null });
    node.value = obj[key] ?? '';
    if (path) node.dataset.path = path;
    node.addEventListener('input', () => {
      obj[key] = nullable && node.value.trim() === '' ? null : node.value;
      markDirty();
      clearInvalid(node);
      if (multiline) autoGrow(node);
      if (onInput) onInput(node.value);
    });
    if (multiline) requestAnimationFrame(() => autoGrow(node));
    return node;
  }
  function numField(obj, key, { path, ariaLabel } = {}) {
    const node = h('input', { class: 'input input-sm input-num', type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: '—', 'aria-label': ariaLabel || 'Quantità', title: 'Lascia vuoto se il documento non indica la quantità' });
    node.value = obj[key] ?? '';
    if (path) node.dataset.path = path;
    node.addEventListener('input', () => {
      const v = node.value.trim();
      obj[key] = v === '' || Number.isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v)));
      markDirty();
      clearInvalid(node);
    });
    return node;
  }
  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);

  // ------------------------------------------------------------------------------- immagini
  const thumbUrl = (id) => `/api/jobs/${ctx.id}/image/${id}?thumb=1`;
  const fullUrl = (id) => `/api/jobs/${ctx.id}/image/${id}`;

  /** Dove è usata ogni immagine (per aiutare a scegliere). */
  function usageMap() {
    const map = new Map();
    const add = (id, where) => { if (!id) return; if (!map.has(id)) map.set(id, []); map.get(id).push(where); };
    add(manual.cover_image_id, 'Copertina');
    add(manual.brand_logo_image_id, 'Logo');
    manual.hardware.forEach((x) => add(x.image_id, x.id || 'Ferramenta'));
    manual.components.forEach((x) => add(x.image_id, x.code || 'Componente'));
    manual.steps.forEach((s) => s.image_ids.forEach((id) => add(id, `Passo ${s.number}`)));
    manual.notes.forEach((n) => add(n.image_id, n.label || 'Nota'));
    return map;
  }

  function pickerTile(c, { selected, order, usage, onClick }) {
    return h('button', { class: ['thumb', selected ? 'sel' : ''], type: 'button', onclick: onClick, title: c.id },
      order ? h('span', { class: 'order' }, String(order)) : null,
      h('span', { class: 'ti' }, h('img', { src: thumbUrl(c.id), alt: c.id, loading: 'lazy' })),
      h('span', { class: 'tl' }, h('b', c.id), h('span', c.page ? `pag. ${c.page}` : '')),
      h('span', { class: 'tl', style: 'border-top:0;padding-top:0' }, h('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, usage && usage.length ? usage.join(', ') : 'non usata')));
  }

  /** Finestra di scelta delle immagini. Restituisce gli id scelti (array) oppure null se annullata. */
  function openPicker({ title, multi = false, selected = [], nullable = true }) {
    return new Promise((resolve) => {
      let done = false;
      let sel = [...selected];
      const usage = usageMap();
      const list = catalog.filter((c) => !c.duplicate_of || selected.includes(c.id));
      const grid = h('div', { class: 'thumbs', style: 'grid-template-columns:repeat(auto-fill,minmax(150px,1fr));padding:4px' });
      const countEl = h('span', { class: 'muted small' });
      const okBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Usa le immagini scelte');
      const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
      const renderGrid = () => {
        replace(grid);
        if (!multi && nullable) {
          grid.append(h('button', { class: ['thumb', 'none', !sel.length ? 'sel' : ''], type: 'button', onclick: () => finish([]) },
            h('span', { class: 'ti' }, icon('x', 28), h('span', null, 'Nessuna immagine')), h('span', { class: 'tl' }, h('b', '—'))));
        }
        for (const c of list) {
          const idx = sel.indexOf(c.id);
          grid.append(pickerTile(c, {
            selected: idx >= 0, order: multi && idx >= 0 ? idx + 1 : null, usage: usage.get(c.id),
            onClick: () => {
              if (!multi) { finish([c.id]); return; }
              if (idx >= 0) sel.splice(idx, 1); else sel.push(c.id);
              renderGrid();
            },
          }));
        }
        if (!list.length) grid.append(h('p', { class: 'muted' }, 'Il documento non contiene immagini.'));
        countEl.textContent = multi ? (sel.length ? `${plural(sel.length, 'immagine scelta', 'immagini scelte')}, nell’ordine indicato dai numeri` : 'Nessuna immagine scelta') : '';
      };
      okBtn.addEventListener('click', () => finish(sel));
      const m = modal({
        title, size: 'wide',
        body: h('div', null, h('p', { class: 'muted small', style: 'margin-top:0' }, multi ? 'Clicca le immagini da usare, nell’ordine in cui devono comparire. Clicca di nuovo per toglierne una.' : 'Clicca l’immagine da usare.'), grid),
        footer: multi ? [countEl, h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, 'Annulla'), okBtn] : [h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, 'Annulla')],
        onClose: () => { if (!done) { done = true; resolve(null); } },
      });
      renderGrid();
    });
  }

  function imageSlot(obj, key, { path, big = false, title = 'Scegli l’immagine', onChange } = {}) {
    const slot = h('button', { class: ['img-slot', big ? 'big' : ''], type: 'button', title: 'Clicca per scegliere un’altra immagine' });
    if (path) slot.dataset.path = path;
    const paint = () => {
      const id = obj[key];
      slot.classList.toggle('filled', !!id);
      slot.classList.toggle('missing', !!id && catalog.length > 0 && !catMap.has(id));
      if (!id) replace(slot, h('span', { style: 'display:grid;place-items:center;gap:2px;font-size:12px' }, icon('image', 22), big ? 'Scegli' : null));
      else if (catalog.length && !catMap.has(id)) replace(slot, `${id} non esiste`);
      else replace(slot, h('img', { src: thumbUrl(id), alt: id }), h('span', { class: 'lbl' }, id));
    };
    slot.addEventListener('click', async () => {
      const r = await openPicker({ title, multi: false, selected: obj[key] ? [obj[key]] : [], nullable: true });
      if (r === null) return;
      obj[key] = r[0] ?? null;
      markDirty();
      paint();
      if (onChange) onChange();
    });
    paint();
    return slot;
  }

  function imageList(arr, { path, title }) {
    const box = h('div', { class: 'img-list' });
    if (path) box.dataset.path = path;
    const paint = () => {
      replace(box);
      arr.forEach((id, i) => {
        const missing = catalog.length && !catMap.has(id);
        box.append(h('div', { class: 'img-item' },
          h('button', { class: ['img-slot', 'big', 'filled', missing ? 'missing' : ''], type: 'button', title: 'Ingrandisci', onclick: () => { if (!missing) imagePreview(fullUrl(id), id); } },
            missing ? `${id} non esiste` : [h('img', { src: thumbUrl(id), alt: id }), h('span', { class: 'lbl' }, id)]),
          h('button', { class: 'rm', type: 'button', title: 'Togli questa immagine', 'aria-label': `Togli ${id}`, onclick: () => { arr.splice(i, 1); markDirty(); paint(); } }, icon('x', 13)),
          arr.length > 1 ? h('div', { class: 'mv' },
            i > 0 ? h('button', { type: 'button', title: 'Sposta prima', 'aria-label': 'Sposta prima', onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; markDirty(); paint(); } }, icon('left', 13)) : null,
            i < arr.length - 1 ? h('button', { type: 'button', title: 'Sposta dopo', 'aria-label': 'Sposta dopo', onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; markDirty(); paint(); } }, icon('right', 13)) : null) : null));
      });
      box.append(h('button', { class: 'img-slot big', type: 'button', title: 'Scegli le immagini', onclick: async () => {
        const r = await openPicker({ title, multi: true, selected: [...arr] });
        if (r === null) return;
        arr.splice(0, arr.length, ...r);
        markDirty();
        paint();
      } }, h('span', { style: 'display:grid;place-items:center;gap:2px;font-size:13px;font-weight:600;text-align:center;line-height:1.2' }, icon('plus', 22), arr.length ? 'Aggiungi o togli' : 'Aggiungi immagini')));
    };
    paint();
    return box;
  }

  // ------------------------------------------------------------------------------- sezioni
  const section = (key, id, title, desc) => {
    const body = h('div');
    const countEl = h('span', { class: 'count' });
    const node = h('section', { class: 'card rsec', id },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, title, countEl), desc ? h('p', desc) : null)), body);
    sections[key] = { node, body, countEl };
    return node;
  };
  const setCount = (key, n) => { sections[key].countEl.textContent = String(n); sections[key].countEl.hidden = n === null; };

  function renderToc() {
    const verified = new Set(ctx.job().review?.verified || []);
    const pending = manual.changes.filter((c, i) => c.needs_confirmation && !verified.has(i)).length;
    const link = (id, label, n, attn) => h('a', { href: `#${id}`, class: attn ? 'attn' : '', onclick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, label, n !== null ? h('span', { class: 'n' }, `(${n})`) : null);
    replace(toc,
      link('sez-modifiche', pending ? `Da verificare` : 'Modifiche dell’AI', pending || manual.changes.length, pending > 0),
      link('sez-generali', 'Dati generali', null),
      link('sez-ferramenta', 'Ferramenta', manual.hardware.length),
      link('sez-componenti', 'Componenti', manual.components.length),
      link('sez-passi', 'Passi', manual.steps.length),
      link('sez-fasi', 'Fasi', manual.phases.length),
      link('sez-note', 'Note', manual.notes.length));
  }

  // --- modifiche fatte dall'AI
  function renderChanges() {
    const s = sections.changes;
    const verified = new Set(ctx.job().review?.verified || []);
    const pending = manual.changes.filter((c, i) => c.needs_confirmation && !verified.has(i)).length;
    setCount('changes', manual.changes.length);
    if (!manual.changes.length) {
      replace(s.body, h('p', { class: 'muted', style: 'margin:0' }, 'Claude non ha segnalato correzioni o aggiunte rispetto al documento.'));
      return;
    }
    const saveVerified = async (set) => {
      try {
        const j = await patch(`/api/jobs/${ctx.id}`, { review: { verified: [...set] } });
        Object.assign(ctx.job(), { review: j.review });
      } catch (err) { toast(err.message, 'err'); }
      renderChanges();
      renderToc();
    };
    replace(s.body,
      pending ? notice('accent', pending === 1 ? 'Un punto da verificare' : `${pending} punti da verificare`,
        h('p', 'Controlla sul documento originale le voci evidenziate e spunta «Ho verificato». Se serve, correggi la scheda qui sotto.')) : null,
      h('div', { class: ['changes', pending ? 'mt-16' : ''] }, manual.changes.map((c, i) => {
        const isV = verified.has(i);
        return h('div', { class: ['change', c.needs_confirmation ? 'attn' : '', isV ? 'verified' : ''] },
          h('span', { class: ['pill', 'kind', `kind-${c.kind}`] }, KIND_LABEL[c.kind] || c.kind),
          h('div', { class: 'desc' }, c.description),
          c.needs_confirmation
            ? h('label', { class: 'checkbox ver' }, h('input', { type: 'checkbox', checked: isV, onchange: (e) => {
              const set = new Set(ctx.job().review?.verified || []);
              if (e.target.checked) set.add(i); else set.delete(i);
              saveVerified(set);
            } }), isV ? 'Verificato' : 'Ho verificato')
            : h('span', { class: 'tiny muted ver' }, ''));
      })));
  }

  // --- dati generali
  function renderGeneral() {
    const s = sections.general;
    const productsBox = h('div');
    const renderProducts = () => {
      replace(productsBox, manual.products.map((g, i) => {
        const names = h('input', { class: 'input', value: g.names.join(', '), placeholder: 'Levante, Libeccio, Maestrale', 'aria-label': 'Nomi dei modelli' });
        names.dataset.path = `products.${i}.names`;
        names.addEventListener('input', () => { g.names = names.value.split(',').map((x) => x.trim()).filter(Boolean); markDirty(); });
        return h('div', { class: 'product-row' },
          field('Categoria', textField(g, 'category', { path: `products.${i}.category`, placeholder: 'es. Tavoli' })),
          field('Modelli (separati da virgola)', names),
          h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Togli questo gruppo', 'aria-label': 'Togli questo gruppo', onclick: () => { manual.products.splice(i, 1); markDirty(); renderProducts(); } }, icon('trash', 18)));
      }), h('button', { class: 'btn btn-sm mt-8', type: 'button', onclick: () => { manual.products.push({ category: '', names: [] }); markDirty(); renderProducts(); } }, icon('plus', 16), 'Aggiungi un gruppo di prodotti'));
    };
    renderProducts();
    replace(s.body,
      h('div', { class: 'grid-2' },
        field('Titolo del documento', textField(manual, 'document_title', { path: 'document_title', placeholder: 'Istruzioni di montaggio' })),
        field('Nome breve', textField(manual, 'short_name', { path: 'short_name', placeholder: 'es. Tavolo Levante' }), 'Compare in copertina e nei nomi dei file (Istruzioni_Montaggio_….pdf).')),
      field('Testo a piè di pagina', textField(manual, 'footer_text', { path: 'footer_text', placeholder: 'es. Levante · Libeccio · Maestrale' }), 'Riga piccola in fondo a ogni pagina.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Prodotti'), productsBox),
      h('div', { class: 'covers mt-16' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Immagine di copertina'), imageSlot(manual, 'cover_image_id', { path: 'cover_image_id', big: true, title: 'Immagine di copertina' })),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Logo del produttore'), imageSlot(manual, 'brand_logo_image_id', { path: 'brand_logo_image_id', big: true, title: 'Logo del produttore' }), h('span', { class: 'field-hint' }, 'Va sul retro del manuale. Facoltativo.'))));
  }

  // --- ferramenta e componenti
  /** Cambio di sigla: aggiorna anche i "pezzi usati" nei passi. */
  function renameRef(oldRef, newRef) {
    if (!oldRef || !newRef || oldRef === newRef) return 0;
    let n = 0;
    manual.steps.forEach((s) => s.uses.forEach((u) => { if (u.ref === oldRef) { u.ref = newRef; n++; } }));
    return n;
  }
  function refField(obj, key, path, label) {
    const node = textField(obj, key, { path, cls: 'input-sm', ariaLabel: label });
    node.dataset.old = obj[key] || '';
    node.style.fontWeight = '700';
    node.addEventListener('change', () => {
      const n = renameRef(node.dataset.old, node.value.trim());
      node.dataset.old = node.value.trim();
      obj[key] = node.value.trim();
      if (n) { toast(`Sigla aggiornata anche in ${plural(n, 'passo', 'passi')}.`, 'ok'); renderSteps(); }
    });
    return node;
  }
  async function removeRef(list, i, ref, what) {
    const used = manual.steps.filter((s) => s.uses.some((u) => u.ref === ref)).map((s) => s.number);
    if (used.length) {
      const ok = await confirmDialog({ title: `Togliere ${what}?`, message: `«${ref}» è indicato nei passi ${used.join(', ')}: verrà tolto anche da lì.`, confirmLabel: 'Togli', danger: true });
      if (!ok) return false;
      manual.steps.forEach((s) => { s.uses = s.uses.filter((u) => u.ref !== ref); });
    }
    list.splice(i, 1);
    markDirty();
    return true;
  }
  function renderHardware() {
    const s = sections.hardware;
    setCount('hardware', manual.hardware.length);
    const rows = manual.hardware.map((x, i) => h('tr', null,
      h('td', { class: 'c-img' }, imageSlot(x, 'image_id', { path: `hardware.${i}.image_id`, title: `Immagine di ${x.name || x.id}` })),
      h('td', { class: 'c-code' }, refField(x, 'id', `hardware.${i}.id`, 'Sigla')),
      h('td', null, textField(x, 'name', { path: `hardware.${i}.name`, placeholder: 'es. Vite inox M8×20', cls: 'input-sm', ariaLabel: 'Nome' })),
      h('td', null, textField(x, 'spec', { path: `hardware.${i}.spec`, placeholder: 'es. con flangia', cls: 'input-sm', ariaLabel: 'Specifica' })),
      h('td', { class: 'c-qty' }, numField(x, 'qty', { path: `hardware.${i}.qty` })),
      h('td', { class: 'c-act' }, h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Togli', 'aria-label': `Togli ${x.name || x.id}`, onclick: async () => { if (await removeRef(manual.hardware, i, x.id, 'questa ferramenta')) { renderHardware(); renderSteps(); renderToc(); } } }, icon('trash', 18)))));
    replace(s.body,
      manual.hardware.length ? h('table', { class: 'etable' },
        h('thead', null, h('tr', null, h('th', 'Immagine'), h('th', 'Sigla'), h('th', 'Nome'), h('th', 'Specifica'), h('th', 'Q.tà'), h('th', ''))),
        h('tbody', null, rows)) : h('p', { class: 'muted' }, 'Nessuna ferramenta.'),
      h('button', { class: 'btn btn-sm mt-16', type: 'button', onclick: () => {
        let n = manual.hardware.length + 1;
        while (manual.hardware.some((x) => x.id === `H${n}`)) n++;
        manual.hardware.push({ id: `H${n}`, name: '', spec: '', qty: null, image_id: null });
        markDirty(); renderHardware(); renderToc();
      } }, icon('plus', 16), 'Aggiungi ferramenta'));
  }
  function renderComponents() {
    const s = sections.components;
    setCount('components', manual.components.length);
    const rows = manual.components.map((x, i) => h('tr', null,
      h('td', { class: 'c-img' }, imageSlot(x, 'image_id', { path: `components.${i}.image_id`, title: `Immagine di ${x.name || x.code}` })),
      h('td', { class: 'c-code' }, refField(x, 'code', `components.${i}.code`, 'Sigla')),
      h('td', null, textField(x, 'name', { path: `components.${i}.name`, placeholder: 'es. Fianchi in alluminio', cls: 'input-sm', ariaLabel: 'Nome' })),
      h('td', { class: 'c-qty' }, numField(x, 'qty', { path: `components.${i}.qty` })),
      h('td', { class: 'c-act' }, h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Togli', 'aria-label': `Togli ${x.name || x.code}`, onclick: async () => { if (await removeRef(manual.components, i, x.code, 'questo componente')) { renderComponents(); renderSteps(); renderToc(); } } }, icon('trash', 18)))));
    replace(s.body,
      manual.components.length ? h('table', { class: 'etable' },
        h('thead', null, h('tr', null, h('th', 'Immagine'), h('th', 'Sigla'), h('th', 'Nome'), h('th', 'Q.tà'), h('th', ''))),
        h('tbody', null, rows)) : h('p', { class: 'muted' }, 'Nessun componente.'),
      h('button', { class: 'btn btn-sm mt-16', type: 'button', onclick: () => {
        manual.components.push({ code: '', name: '', qty: null, image_id: null });
        markDirty(); renderComponents(); renderToc();
      } }, icon('plus', 16), 'Aggiungi un componente'));
  }

  // --- passi
  function refOptions() {
    const short = (s, n = 34) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    return [
      ...manual.components.filter((c) => c.code).map((c) => ({ value: c.code, label: `${c.code} — ${short(c.name || 'componente')}` })),
      ...manual.hardware.filter((x) => x.id).map((x) => ({ value: x.id, label: `${x.id} — ${short(x.name || 'ferramenta')}` })),
    ];
  }
  /** Rinumerazione dopo spostamenti/inserimenti/cancellazioni, con le fasi aggiornate di conseguenza. */
  function restructureSteps(mutate) {
    const oldNum = new Map(manual.steps.map((s) => [s, s.number]));
    const result = mutate();
    const map = new Map();
    manual.steps.forEach((s, i) => { if (oldNum.has(s)) map.set(oldNum.get(s), i + 1); s.number = i + 1; });
    manual.phases.forEach((p) => {
      p.step_numbers = [...new Set(p.step_numbers.map((n) => map.get(n)).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
    });
    if (result && result.newStep && result.afterNumber !== undefined) {
      const ph = manual.phases.find((p) => p.step_numbers.includes(map.get(result.afterNumber)));
      if (ph) { ph.step_numbers.push(result.newStep.number); ph.step_numbers.sort((a, b) => a - b); }
    }
    markDirty();
    renderSteps();
    renderPhases();
    renderToc();
  }
  const newStep = () => ({ number: 0, title: '', paragraphs: [''], image_ids: [], uses: [], warning: null });

  function stepCard(st, si) {
    const paraBox = h('div');
    const renderParas = () => {
      replace(paraBox, st.paragraphs.map((p, pi) => h('div', { class: 'para-row' },
        textField(st.paragraphs, pi, { path: `steps.${si}.paragraphs.${pi}`, multiline: true, placeholder: 'Testo del passo…', ariaLabel: `Paragrafo ${pi + 1}` }),
        st.paragraphs.length > 1 ? h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Togli il paragrafo', 'aria-label': 'Togli il paragrafo', onclick: () => { st.paragraphs.splice(pi, 1); markDirty(); renderParas(); } }, icon('x', 18)) : null)),
      h('button', { class: 'btn btn-sm mt-8', type: 'button', onclick: () => { st.paragraphs.push(''); markDirty(); renderParas(); paraBox.querySelectorAll('textarea')[st.paragraphs.length - 1]?.focus(); } }, icon('plus', 16), 'Aggiungi un paragrafo'));
    };
    renderParas();

    const usesBox = h('div', { class: 'uses' });
    const renderUses = () => {
      const opts = refOptions();
      replace(usesBox, st.uses.map((u, ui) => {
        const known = opts.some((o) => o.value === u.ref);
        const chip = h('span', { class: ['use-chip', known ? '' : 'bad'] });
        const sel = h('select', { 'aria-label': 'Pezzo usato', title: known ? '' : 'Questa sigla non è nell’elenco dei componenti o della ferramenta' },
          known ? null : h('option', { value: u.ref, selected: true }, `${u.ref || '—'} (non in elenco)`),
          opts.map((o) => h('option', { value: o.value, selected: o.value === u.ref }, o.label)));
        sel.dataset.path = `steps.${si}.uses.${ui}.ref`;
        sel.addEventListener('change', () => { u.ref = sel.value; markDirty(); renderUses(); });
        const qty = numField(u, 'qty', { path: `steps.${si}.uses.${ui}.qty`, ariaLabel: 'Quantità usata' });
        qty.className = '';
        qty.style.width = '58px';
        chip.append(sel, h('span', { class: 'x' }, '×'), qty,
          h('button', { class: 'rm', type: 'button', title: 'Togli', 'aria-label': 'Togli questo pezzo', onclick: () => { st.uses.splice(ui, 1); markDirty(); renderUses(); } }, icon('x', 15)));
        return chip;
      }), h('button', { class: 'btn btn-sm', type: 'button', disabled: !opts.length, onclick: () => { const o = refOptions()[0]; st.uses.push({ ref: o ? o.value : '', qty: null }); markDirty(); renderUses(); } }, icon('plus', 16), 'Aggiungi un pezzo'));
    };
    renderUses();

    const warnBoxStep = h('div');
    const renderWarning = () => {
      if (st.warning === null || st.warning === undefined) {
        replace(warnBoxStep, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { st.warning = ''; markDirty(); renderWarning(); warnBoxStep.querySelector('textarea')?.focus(); } }, icon('alert', 16), 'Aggiungi un’avvertenza'));
      } else {
        const ta = textField(st, 'warning', { path: `steps.${si}.warning`, multiline: true, placeholder: 'Testo dell’avvertenza (riquadro evidenziato nel PDF)', ariaLabel: 'Avvertenza' });
        replace(warnBoxStep, h('div', { class: 'para-row warning-box' }, ta,
          h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Togli l’avvertenza', 'aria-label': 'Togli l’avvertenza', onclick: () => { st.warning = null; markDirty(); renderWarning(); } }, icon('x', 18))));
      }
    };
    renderWarning();

    const n = manual.steps.length;
    return h('article', { class: 'step-card', id: `passo-${si + 1}` },
      h('div', { class: 'step-card-head' },
        h('span', { class: 'step-badge', title: `Passo ${st.number}` }, String(st.number)),
        textField(st, 'title', { path: `steps.${si}.title`, placeholder: 'Titolo breve del passo', ariaLabel: `Titolo del passo ${st.number}` }),
        h('div', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' },
          h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Sposta su', 'aria-label': 'Sposta su', disabled: si === 0, onclick: () => restructureSteps(() => { const a = manual.steps; [a[si - 1], a[si]] = [a[si], a[si - 1]]; }) }, icon('up', 18)),
          h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Sposta giù', 'aria-label': 'Sposta giù', disabled: si === n - 1, onclick: () => restructureSteps(() => { const a = manual.steps; [a[si + 1], a[si]] = [a[si], a[si + 1]]; }) }, icon('down', 18)),
          h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Inserisci un passo dopo questo', 'aria-label': 'Inserisci un passo dopo questo', onclick: () => restructureSteps(() => { const s = newStep(); manual.steps.splice(si + 1, 0, s); return { newStep: s, afterNumber: st.number }; }) }, icon('plus', 18)),
          h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Elimina il passo', 'aria-label': 'Elimina il passo', onclick: async () => {
            const ok = await confirmDialog({ title: `Eliminare il passo ${st.number}?`, message: `«${st.title || 'senza titolo'}» verrà tolto dalla scheda. I passi successivi verranno rinumerati.`, confirmLabel: 'Elimina', danger: true });
            if (ok) restructureSteps(() => { manual.steps.splice(si, 1); });
          } }, icon('trash', 18)))),
      h('div', { class: 'step-grid' },
        h('div', null, h('div', { class: 'sub-label' }, 'Testo', h('span', { class: 'hint' }, emphasisButton(paraBox), h('span', { class: 'emph-note' }, 'o Ctrl+B · nel testo appare come ', h('code', '**parola**')))), paraBox),
        h('div', null, h('div', { class: 'sub-label' }, 'Immagini del passo'), imageList(st.image_ids, { path: `steps.${si}.image_ids`, title: `Immagini del passo ${st.number}` })),
        h('div', null, h('div', { class: 'sub-label' }, 'Pezzi usati in questo passo', h('span', { class: 'hint' }, 'sigla × quantità (vuota se non indicata)')), usesBox),
        h('div', null, h('div', { class: 'sub-label' }, 'Avvertenza'), warnBoxStep)));
  }
  function renderSteps() {
    const s = sections.steps;
    setCount('steps', manual.steps.length);
    replace(s.body,
      manual.steps.length ? manual.steps.map((st, si) => stepCard(st, si)) : h('p', { class: 'muted' }, 'Nessun passo.'),
      h('button', { class: 'btn mt-16', type: 'button', onclick: () => restructureSteps(() => { manual.steps.push(newStep()); }) }, icon('plus', 18), 'Aggiungi un passo in fondo'));
  }

  // --- fasi
  function renderPhases() {
    const s = sections.phases;
    setCount('phases', manual.phases.length);
    const nums = manual.steps.map((x) => x.number);
    replace(s.body,
      manual.phases.map((p, i) => h('div', { class: 'phase-row' },
        field('Nome della fase', textField(p, 'title', { path: `phases.${i}.title`, placeholder: 'es. Struttura in alluminio' })),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Passi della fase'),
          h('div', { class: 'chips', dataset: { path: `phases.${i}.step_numbers` } }, nums.map((n) => h('button', {
            class: ['chip-toggle', p.step_numbers.includes(n) ? 'on' : ''], type: 'button', 'aria-pressed': String(p.step_numbers.includes(n)), title: `Passo ${n}`,
            onclick: () => {
              if (p.step_numbers.includes(n)) p.step_numbers = p.step_numbers.filter((x) => x !== n);
              else { p.step_numbers.push(n); p.step_numbers.sort((a, b) => a - b); }
              markDirty();
              renderPhases();
            },
          }, String(n))))),
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Togli la fase', 'aria-label': 'Togli la fase', onclick: () => { manual.phases.splice(i, 1); markDirty(); renderPhases(); renderToc(); } }, icon('trash', 18)))),
      !manual.phases.length ? h('p', { class: 'muted' }, 'Nessuna fase: i passi verranno presentati in un unico elenco.') : null,
      h('button', { class: 'btn btn-sm mt-16', type: 'button', onclick: () => { manual.phases.push({ title: '', step_numbers: [] }); markDirty(); renderPhases(); renderToc(); } }, icon('plus', 16), 'Aggiungi una fase'));
  }

  // --- note
  function renderNotes() {
    const s = sections.notes;
    setCount('notes', manual.notes.length);
    replace(s.body,
      manual.notes.map((nt, i) => h('div', { class: 'note-row' },
        imageSlot(nt, 'image_id', { path: `notes.${i}.image_id`, big: true, title: 'Immagine della nota' }),
        h('div', null,
          h('div', { class: 'grid-2' },
            field('Etichetta', textField(nt, 'label', { path: `notes.${i}.label`, placeholder: 'es. N.B., Attenzione' })),
            field('Titolo', textField(nt, 'title', { path: `notes.${i}.title` }))),
          field('Testo', textField(nt, 'text', { path: `notes.${i}.text`, multiline: true }))),
        h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Togli la nota', 'aria-label': 'Togli la nota', onclick: () => { manual.notes.splice(i, 1); markDirty(); renderNotes(); renderToc(); } }, icon('trash', 18)))),
      !manual.notes.length ? h('p', { class: 'muted' }, 'Nessuna nota.') : null,
      h('button', { class: 'btn btn-sm mt-16', type: 'button', onclick: () => { manual.notes.push({ label: 'N.B.', title: '', text: '', image_id: null }); markDirty(); renderNotes(); renderToc(); } }, icon('plus', 16), 'Aggiungi una nota'));
  }

  // ------------------------------------------------------------------------------- documento a fianco
  function renderSide() {
    side.hidden = !sideOpen;
    el.classList.toggle('no-side', !sideOpen);
    sideBtn.setAttribute('aria-pressed', String(sideOpen));
    sideBtn.classList.toggle('btn-dark', sideOpen && window.innerWidth < 1180);
    if (!sideOpen) return;
    const job = ctx.job();
    const isDocx = job.input_kind === 'docx';
    const nImg = catalog.filter((c) => !c.duplicate_of).length;
    const usage = manual ? usageMap() : new Map();
    const tab = (key, label) => h('button', { class: ['tab', sideTab === key ? 'on' : ''], type: 'button', onclick: () => { sideTab = key; renderSide(); } }, label);
    let body;
    if (sideTab === 'documento') {
      body = isDocx
        ? h('iframe', { src: `/api/jobs/${ctx.id}/document/preview`, title: 'Testo del documento Word', sandbox: 'allow-same-origin' })
        : h('iframe', { src: `/api/jobs/${ctx.id}/document#view=FitH&pagemode=none&navpanes=0`, title: 'Documento originale (PDF)' });
    } else {
      body = h('div', { class: 'thumbs' }, catalog.filter((c) => !c.duplicate_of).map((c) => pickerTile(c, { usage: usage.get(c.id), onClick: () => imagePreview(fullUrl(c.id), `${c.id}${c.page ? ` · pagina ${c.page}` : ''}`) })));
    }
    replace(side,
      h('div', { class: 'side-head' },
        h('div', { class: 'tabs', role: 'tablist' }, tab('documento', isDocx ? 'Testo del documento' : 'Documento originale'), tab('immagini', `Immagini (${nImg})`)),
        h('div', { class: 'row', style: 'gap:4px' },
          h('a', { class: 'btn btn-ghost btn-icon', href: `/api/jobs/${ctx.id}/document${isDocx ? '?download=1' : ''}`, target: '_blank', rel: 'noopener', title: isDocx ? 'Scarica il documento Word' : 'Apri in una nuova scheda', 'aria-label': 'Apri il documento originale' }, icon(isDocx ? 'download' : 'external', 18)),
          h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Chiudi il pannello', 'aria-label': 'Chiudi il pannello', onclick: () => { sideOpen = false; writePref(SIDE_KEY, false); renderSide(); } }, icon('x', 18)))),
      h('div', { class: 'side-body' }, body));
  }
  sideBtn.addEventListener('click', () => { sideOpen = !sideOpen; writePref(SIDE_KEY, sideOpen); renderSide(); });

  // ------------------------------------------------------------------------------- errori e salvataggio
  function focusPath(p) {
    const parts = p.split('.');
    for (let n = parts.length; n > 0; n--) {
      const node = main.querySelector(`[data-path="${parts.slice(0, n).join('.')}"]`);
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (node.focus) setTimeout(() => node.focus({ preventScroll: true }), 350);
        return;
      }
    }
    const sec = { steps: 'sez-passi', hardware: 'sez-ferramenta', components: 'sez-componenti', phases: 'sez-fasi', notes: 'sez-note', changes: 'sez-modifiche' }[parts[0]] || 'sez-generali';
    document.getElementById(sec)?.scrollIntoView({ behavior: 'smooth' });
  }
  function markInvalid() {
    main.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
    for (const is of issues) {
      const node = main.querySelector(`[data-path="${is.path}"]`);
      if (node) node.classList.add('invalid');
    }
  }
  function renderErrors() {
    replace(errorsBox, issues.length ? h('div', { class: 'errors-box' }, notice('err', issues.length === 1 ? 'C’è un errore da correggere' : `Ci sono ${issues.length} errori da correggere`,
      h('ul', issues.slice(0, 12).map((is) => h('li', null, h('a', { onclick: () => focusPath(is.path) }, is.label), `: ${is.message}`))))) : null);
    replace(warnBox, softWarnings.length ? h('div', { class: 'errors-box' }, notice('warn', 'Da controllare', h('ul', softWarnings.slice(0, 12).map((w) => h('li', w))))) : null);
    markInvalid();
  }
  function recomputeUnused() {
    const used = usageMap();
    manual.unused_image_ids = catalog.filter((c) => !c.duplicate_of && !used.has(c.id)).map((c) => c.id);
  }
  async function save({ quiet = false } = {}) {
    if (!manual || saving) return !dirty;
    saving = true;
    renderSaveState();
    if (document.activeElement && document.activeElement.blur && main.contains(document.activeElement)) {
      document.activeElement.dispatchEvent(new Event('change'));
    }
    recomputeUnused();
    try {
      const res = await put(`/api/jobs/${ctx.id}/manual`, manual);
      dirty = false;
      issues = [];
      softWarnings = res.warnings || [];
      if (res.job) Object.assign(ctx.job(), { name: res.job.name, manual_saved_at: res.job.manual_saved_at });
      renderErrors();
      if (!quiet) toast(softWarnings.length ? 'Scheda salvata (ci sono punti da controllare).' : 'Scheda salvata.', 'ok');
      return true;
    } catch (err) {
      issues = err.data?.issues || [];
      renderErrors();
      toast(issues.length ? 'La scheda non è stata salvata: correggi i campi evidenziati.' : err.message, 'err', 7000);
      if (issues.length) errorsBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    } finally {
      saving = false;
      renderSaveState();
    }
  }
  saveBtn.addEventListener('click', () => save());
  pdfBtn.addEventListener('click', async () => {
    pdfBtn.disabled = true;
    try {
      if (dirty && !(await save({ quiet: true }))) return;
      await startPdf(ctx, { manual });
    } finally {
      pdfBtn.disabled = false;
    }
  });

  // ------------------------------------------------------------------------------- caricamento
  main.append(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Caricamento della scheda…'));
  renderSide();
  Promise.all([get(`/api/jobs/${ctx.id}/manual`), get(`/api/jobs/${ctx.id}/catalog`)]).then(([m, cat]) => {
    if (destroyed) return;
    manual = m;
    catalog = Array.isArray(cat) ? cat : [];
    catalog.forEach((c) => catMap.set(c.id, c));
    for (const k of ['products', 'hardware', 'components', 'phases', 'steps', 'notes', 'changes', 'unused_image_ids']) if (!Array.isArray(manual[k])) manual[k] = [];
    manual.steps.forEach((s) => { if (!Array.isArray(s.paragraphs) || !s.paragraphs.length) s.paragraphs = ['']; s.image_ids = s.image_ids || []; s.uses = s.uses || []; });
    replace(main,
      h('div', { class: 'review-bar' },
        h('div', { class: 'row', style: 'gap:14px' }, h('h2', { style: 'font-size:20px' }, 'Revisione'), saveState),
        h('div', { class: 'row', style: 'gap:8px' }, sideBtn, saveBtn, pdfBtn)),
      notice('accent', null, h('p', null, 'Controlla quello che Claude ha ricavato dal documento e correggi dove serve: ', h('b', 'il PDF e il video useranno esattamente questa scheda'), '. Le modifiche si salvano con «Salva» (oppure Ctrl+S).')),
      h('div', { class: 'mt-16' }),
      errorsBox, warnBox, toc,
      section('changes', 'sez-modifiche', 'Modifiche fatte dall’AI', 'Correzioni, uniformazioni e aggiunte rispetto al documento originale.'),
      section('general', 'sez-generali', 'Dati generali', 'Titolo, nome breve, prodotti, copertina e logo.'),
      section('hardware', 'sez-ferramenta', 'Ferramenta', 'Viti, rondelle e minuteria contenute nella confezione.'),
      section('components', 'sez-componenti', 'Componenti', 'I pezzi principali, con la sigla usata nei passi.'),
      section('steps', 'sez-passi', 'Passi di montaggio', 'Ogni passo diventa una sezione illustrata del PDF e una scena del video.'),
      section('phases', 'sez-fasi', 'Fasi', 'Raggruppano i passi (facoltativo).'),
      section('notes', 'sez-note', 'Note', 'Avvertenze generali, manutenzione, varianti.'),
      h('div', { class: 'row-between mt-24' },
        h('a', { class: 'btn', href: `#/lavoro/${ctx.id}/analisi` }, icon('left', 18), 'Analisi'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => save() }, icon('check', 18), 'Salva'),
          h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => pdfBtn.click() }, icon('pdf', 20), 'Crea il PDF', icon('right', 18)))));
    renderChanges(); renderGeneral(); renderHardware(); renderComponents(); renderSteps(); renderPhases(); renderNotes(); renderToc();
    renderSaveState();
    renderSide();
  }).catch((err) => {
    if (!destroyed) replace(main, notice('err', 'Impossibile leggere la scheda', h('p', err.message)));
  });

  // ------------------------------------------------------------------------------- uscita
  async function canLeave(hash) {
    if (!dirty) return true;
    if (hash === `#/lavoro/${ctx.id}/revisione`) return true;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
      const m = modal({
        title: 'Modifiche non salvate',
        body: h('p', { style: 'margin:0' }, 'Hai modificato la scheda senza salvare. Vuoi salvare le modifiche?'),
        footer: [
          h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Resta qui'),
          h('button', { class: 'btn btn-danger', type: 'button', onclick: () => { dirty = false; finish(true); } }, 'Non salvare'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => { const ok = await save({ quiet: true }); if (ok) finish(true); else finish(false); } }, 'Salva e continua'),
        ],
        onClose: () => { if (!done) { done = true; resolve(false); } },
      });
    });
  }

  return {
    el,
    update: () => {},
    canLeave,
    cleanup: () => {
      destroyed = true;
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('keydown', onKey);
    },
  };
}
