// Piccoli strumenti per costruire l'interfaccia senza framework: h(), icone, finestre, avvisi, formati.

/**
 * Crea un elemento: h('button', { class: 'btn', onclick: fn }, 'Testo', altroNodo)
 * Attributi speciali: class, style (stringa o oggetto), dataset, on<evento>, value, checked, disabled, hidden.
 */
export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'rect' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'multiple' || k === 'required') el[k] = !!v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

// ------------------------------------------------------------------------------------------ icone
const P = {
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  cube: '<path d="M12 2.8 20 7.3v9.4l-8 4.5-8-4.5V7.3z"/><path d="M4 7.3l8 4.5 8-4.5M12 11.8v9.4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  check: '<path d="M5 12.5 9.5 17 19 7.5"/>',
  alert: '<path d="M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4 19.5h16"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  settings: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9.5 9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3 3.9M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
  sparkle: '<path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5V5.5M20 18v3H6.5"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 16.5v-4h1.2a1.2 1.2 0 0 1 0 2.4H8.5M13 12.5v4h.8a1.6 1.6 0 0 0 1.6-1.6v-.8a1.6 1.6 0 0 0-1.6-1.6z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14 4v16"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
};

export function icon(name, size = 20, attrs = {}) {
  const span = document.createElement('span');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  const svg = span.firstChild;
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  if (name === 'play') svg.setAttribute('fill', 'currentColor');
  return svg;
}

// ------------------------------------------------------------------------------------------ formati
const dateFmt = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const numFmt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d).replace(',', ' alle');
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024 * 1024) return `${numFmt.format(Math.max(1, n / 1024))} KB`;
  return `${numFmt.format(n / 1024 / 1024)} MB`;
}

export function fmtEta(s) {
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 50) return `circa ${Math.max(5, Math.round(s / 5) * 5)} secondi`;
  const m = Math.round(s / 60);
  return m <= 1 ? 'circa 1 minuto' : `circa ${m} minuti`;
}

export function fmtDuration(s) {
  if (!Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} min ${String(r).padStart(2, '0')} s` : `${r} s`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ------------------------------------------------------------------------------------------ avvisi
export function toast(message, kind = 'info', ms = 4200) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: ['toast', kind], role: kind === 'err' ? 'alert' : 'status' },
    icon(kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'info', 18), h('div', message));
  box.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, ms);
}

/**
 * Finestra modale. Restituisce { el, body, close }. onClose viene chiamata alla chiusura.
 */
export function modal({ title, body, footer, size = '', onClose, labelledBy } = {}) {
  const prevFocus = document.activeElement;
  const titleId = labelledBy || `m-${Math.random().toString(36).slice(2)}`;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const bodyEl = h('div', { class: ['modal-body', size === 'full' || size === 'flush' ? 'flush' : ''] }, body);
  const box = h('div', { class: ['modal', size], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title),
      h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Chiudi', onclick: () => close() }, icon('x'))),
    bodyEl,
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, box);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => {
    const f = box.querySelector('[autofocus], .modal-foot .btn-primary, .modal-foot .btn-danger, input, button');
    if (f) f.focus();
  }, 20);
  return { el: box, body: bodyEl, close };
}

/** Domanda sì/no. Restituisce una Promise<boolean>. */
export function confirmDialog({ title, message, confirmLabel = 'Conferma', cancelLabel = 'Annulla', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal({
      title,
      body: typeof message === 'string' ? h('p', { style: 'margin:0' }, message) : message,
      footer: [
        h('button', { class: 'btn', onclick: () => finish(false) }, cancelLabel),
        h('button', { class: ['btn', danger ? 'btn-danger' : 'btn-primary'], onclick: () => finish(true) }, confirmLabel),
      ],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}

export function imagePreview(src, title) {
  modal({ title, size: 'wide', body: h('img', { class: 'big-img', src, alt: title }) });
}

/** Riquadro di avviso con icona. kind: accent | warn | err | ok | dark */
export function notice(kind, title, ...content) {
  const ico = { accent: 'info', warn: 'alert', err: 'alert', ok: 'check', dark: 'info' }[kind] || 'info';
  return h('div', { class: ['notice', `notice-${kind}`] }, icon(ico, 22), h('div', { class: 'grow' }, title ? h('h3', title) : null, ...content));
}

export function progressBar(pct, { indeterminate = false, small = false } = {}) {
  const inner = h('div', { style: { width: `${Math.max(0, Math.min(100, pct || 0))}%` } });
  return h('div', { class: ['progress', indeterminate ? 'indeterminate' : '', small ? 'progress-sm' : ''], role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct || 0)) }, inner);
}

/** Testo con **parola** reso in grassetto sottolineato (anteprima come nel PDF). */
export function richText(s) {
  const out = [];
  String(s || '').split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) out.push(h('u', h('b', part.slice(2, -2))));
    else if (part) out.push(part);
  });
  return out;
}
