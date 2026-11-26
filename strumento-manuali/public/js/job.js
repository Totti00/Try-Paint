// Pagina di un lavoro: intestazione, percorso in 4 passi (Analisi → Revisione → PDF → Video) e contenuto del passo.
import { h, replace, icon, fmtDate, fmtEta, fmtDuration, fmtBytes, toast, confirmDialog, notice, progressBar, modal, imagePreview, plural } from './ui.js';
import { get, post, patch, del, upload, subscribe } from './api.js';
import { navigate, setLeaveGuard, state } from './app.js';
import { renderReview } from './review.js';

const BUSY = new Set(['nuovo', 'estrazione', 'analisi', 'pdf', 'video']);
const MODEL_EXTS = ['step', 'stp', 'iges', 'igs', 'glb', 'gltf', 'obj', 'stl'];
const STEP_KEYS = ['analisi', 'revisione', 'pdf', 'video'];

export const hasManual = (job) => !!job.manual_saved_at;

/**
 * Il PDF/video è stato creato da una versione precedente della scheda? Si confronta l'ultimo salvataggio con la
 * versione letta dall'operazione (outputs.pdf_manual_at / video_manual_at); per i lavori più vecchi, con la data di
 * creazione del file.
 */
export function isStale(job, kind) {
  const o = job.outputs || {};
  if (!o[kind] || !job.manual_saved_at) return false;
  const base = o[`${kind}_manual_at`] || o[`${kind}_at`];
  return !!base && job.manual_saved_at > base;
}
export const runningTask = (job) => (BUSY.has(job.status) && job.task ? job.task : null);

function defaultStep(job) {
  if (!hasManual(job) || runningTask(job) === 'analisi') return 'analisi';
  if (job.status === 'errore') return job.error?.task === 'analisi' ? 'analisi' : job.error?.task || 'revisione';
  if (job.status === 'pdf' || job.status === 'pdf_pronto') return 'pdf';
  if (job.status === 'video' || job.status === 'completato') return 'video';
  return 'revisione';
}

function stepStates(job) {
  const t = runningTask(job);
  const err = job.status === 'errore' ? job.error?.task : null;
  const pctText = (job.progress && !job.progress.queued) ? `In corso · ${job.progress.pct || 0} %` : 'In attesa…';
  const man = hasManual(job);
  return {
    analisi: {
      enabled: true,
      state: t === 'analisi' ? 'running' : err === 'analisi' ? 'error' : man ? 'done' : 'todo',
      sub: t === 'analisi' ? pctText : err === 'analisi' ? 'Non riuscita' : man ? 'Completata' : 'Claude legge il documento',
    },
    revisione: {
      enabled: man && t !== 'analisi',
      state: man && (job.outputs?.pdf || job.outputs?.video) ? 'done' : 'todo',
      sub: man ? 'Controlla e correggi' : 'Dopo l’analisi',
    },
    pdf: {
      enabled: man && t !== 'analisi',
      state: t === 'pdf' ? 'running' : err === 'pdf' ? 'error' : job.outputs?.pdf ? 'done' : 'todo',
      sub: t === 'pdf' ? pctText : err === 'pdf' ? 'Non riuscito' : job.outputs?.pdf ? 'Pronto' : 'Manuale impaginato',
    },
    video: {
      enabled: man && t !== 'analisi',
      state: t === 'video' ? 'running' : err === 'video' ? 'error' : job.outputs?.video ? 'done' : 'todo',
      sub: t === 'video' ? pctText : err === 'video' ? 'Non riuscito' : job.outputs?.video ? 'Pronto' : '3D o con immagini',
    },
  };
}

const STEP_LABEL = { analisi: 'Analisi', revisione: 'Revisione', pdf: 'PDF', video: 'Video' };
const TASK_TITLE = { analisi: 'Analisi del documento', pdf: 'Creazione del PDF', video: 'Creazione del video' };

// ------------------------------------------------------------------------------------------ componenti comuni

/**
 * Riquadro di avanzamento di un'operazione, aggiornabile senza ricostruirlo.
 * hint: testo fisso oppure funzione (job) => testo, ricalcolata a ogni aggiornamento (cambia con la fase).
 */
function taskCard({ title, iconName, hint, substeps, ctx }) {
  const pctEl = h('div', { class: 'pct' }, '0 %');
  const bar = progressBar(0);
  const msg = h('div', { class: 'task-msg' });
  const eta = h('div', { class: 'eta mt-8', hidden: true });
  const subList = substeps ? h('ul', { class: 'substeps' }) : null;
  const cancelBtn = h('button', { class: 'btn', type: 'button' }, icon('stop', 16), 'Annulla');
  cancelBtn.addEventListener('click', async () => {
    const j = ctx.job();
    const ok = await confirmDialog({ title: 'Annullare l’operazione?', message: `${TASK_TITLE[j.task] || 'L’operazione'} verrà interrotta. Potrai ripeterla quando vuoi.`, confirmLabel: 'Sì, annulla', cancelLabel: 'No, continua', danger: true });
    if (!ok) return;
    try { await post(`/api/jobs/${ctx.id}/cancel`, {}); } catch (err) { toast(err.message, 'err'); }
  });
  const titleEl = h('h2', title);
  const hintEl = hint ? h('p', { class: 'muted', style: 'margin:4px 0 0' }, typeof hint === 'function' ? '' : hint) : null;
  const el = h('section', { class: 'card task-card' },
    h('div', { class: 'task-title' }, h('div', { class: 'ico' }, icon(iconName, 26)), h('div', { class: 'grow' }, titleEl, hintEl), pctEl),
    bar, msg, eta, subList,
    h('div', { class: 'row mt-24' }, cancelBtn));
  const update = (job) => {
    const p = job.progress || {};
    const pct = Math.round(p.pct || 0);
    pctEl.textContent = p.queued ? '' : `${pct} %`;
    titleEl.textContent = p.queued ? title.replace(/ in corso$/, ' in attesa') : title; // in coda dietro a un altro lavoro
    bar.firstChild.style.width = `${pct}%`;
    bar.classList.toggle('indeterminate', !!p.queued);
    msg.textContent = p.message || '';
    if (hintEl && typeof hint === 'function') hintEl.textContent = hint(job) || '';
    if (p.eta_s) { eta.hidden = false; replace(eta, icon('clock', 16, { style: 'vertical-align:-3px;margin-right:6px' }), `Tempo rimanente: ${fmtEta(p.eta_s)}`); } else eta.hidden = true;
    cancelBtn.disabled = !!p.cancelling;
    if (subList) {
      const idx = substeps.findIndex((s) => s.stages.includes(p.stage));
      replace(subList, substeps.map((s, i) => h('li', { class: i < idx ? 'done' : i === idx && !p.queued ? 'active' : '' },
        h('span', { class: 'si' }, i < idx ? icon('check', 14) : null), s.label)));
    }
  };
  return { el, update };
}

function errorCard(job, ctx, { title, back = false }) {
  const e = job.error || {};
  const needsKey = ['missing_key', 'invalid_key', 'permission', 'billing', 'spend_limit', 'model_not_found'].includes(e.code) || /Impostazioni/.test(e.message || '');
  // documento illeggibile (rovinato, protetto, formato sbagliato): riprovare con lo stesso file non serve
  const badDoc = e.task === 'analisi' && /^(pdf_(corrupt|empty|password)|docx_(corrupt|invalid|password)|empty_file|unsupported\w*)$/.test(e.code || '');
  // senza chiave valida riprovare non serve: prima si va in Impostazioni (pulsante principale)
  const retry = h('button', { class: badDoc || needsKey ? 'btn' : 'btn btn-primary', type: 'button' }, icon('refresh', 18), 'Riprova');
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try { await post(`/api/jobs/${ctx.id}/retry`, {}); } catch (err) { toast(err.message, 'err', 7000); retry.disabled = false; }
  });
  const shown = e.code === 'interrupted' ? `${TASK_TITLE[e.task] || 'Operazione'} interrotta` : title;
  return h('section', { class: 'card' },
    notice('err', shown, h('p', e.message || 'Errore sconosciuto.'),
      h('div', { class: 'actions' },
        badDoc ? h('a', { class: 'btn btn-primary', href: '#/' }, icon('upload', 18), 'Carica un altro file') : null,
        needsKey ? h('a', { class: 'btn btn-primary', href: '#/impostazioni' }, icon('key', 18), 'Vai a Impostazioni') : null,
        retry,
        back ? h('a', { class: 'btn', href: `#/lavoro/${ctx.id}/revisione` }, icon('left', 18), 'Torna alla revisione') : null)),
    h('p', { class: 'small muted mt-16', style: 'margin-bottom:0' }, 'Se il problema si ripete, il ', h('a', { href: `/api/jobs/${ctx.id}/log?download=1` }, 'registro del lavoro'), ' contiene i dettagli tecnici.'));
}

function warningsNotice(title, list) {
  if (!list || !list.length) return null;
  return notice('warn', title, h('ul', list.map((w) => h('li', w))));
}

/** Avvia la creazione del PDF, avvisando se restano modifiche dell'AI da verificare. */
export async function startPdf(ctx, { manual } = {}) {
  try {
    const m = manual || await get(`/api/jobs/${ctx.id}/manual`);
    const verified = new Set(ctx.job().review?.verified || []);
    const pending = (m.changes || []).map((c, i) => ({ c, i })).filter(({ c, i }) => c.needs_confirmation && !verified.has(i));
    if (pending.length) {
      const ok = await confirmDialog({
        title: pending.length === 1 ? 'C’è una modifica dell’AI da verificare' : `Ci sono ${pending.length} modifiche dell’AI da verificare`,
        message: h('div', null, h('p', 'Claude ha segnalato dei punti che richiedono il tuo controllo:'),
          h('ul', { style: 'margin:0 0 10px;padding-left:18px' }, pending.slice(0, 4).map(({ c }) => h('li', c.description))),
          h('p', { style: 'margin:0' }, 'Vuoi creare il PDF lo stesso?')),
        confirmLabel: 'Crea il PDF lo stesso', cancelLabel: 'Torna a controllare',
      });
      if (!ok) { navigate(`#/lavoro/${ctx.id}/revisione`); setTimeout(() => document.getElementById('sez-modifiche')?.scrollIntoView({ behavior: 'smooth' }), 300); return false; }
    }
    await post(`/api/jobs/${ctx.id}/pdf`, {});
    navigate(`#/lavoro/${ctx.id}/pdf`);
    return true;
  } catch (err) {
    toast(err.message, 'err', 7000);
    return false;
  }
}

// ------------------------------------------------------------------------------------------ passo 1: analisi

function analisiView(ctx) {
  const el = h('div');
  let mode = null;
  let card = null;
  let summaryLoaded = false;
  const render = (job) => {
    const t = runningTask(job);
    const m = t === 'analisi' ? 'running' : job.status === 'errore' && job.error?.task === 'analisi' ? 'error' : hasManual(job) ? 'done' : 'error';
    if (m === mode && m === 'running') { card.update(job); return; }
    if (m === mode && m === 'done' && summaryLoaded) return;
    mode = m;
    if (m === 'running') {
      card = taskCard({
        ctx, title: 'Analisi del documento in corso', iconName: 'sparkle',
        hint: job.test_mode || state.settings?.testMode?.ai ? 'Modalità test: bastano pochi secondi.' : 'Di solito servono da 2 a 5 minuti. Puoi lasciare aperta questa pagina: alla fine si passa da sola alla revisione.',
        substeps: [
          { label: 'Lettura del documento', stages: ['estrazione'] },
          { label: 'Preparazione delle immagini', stages: ['immagini'] },
          { label: 'Analisi con Claude', stages: ['analisi'] },
        ],
      });
      replace(el, card.el);
      card.update(job);
    } else if (m === 'error') {
      replace(el, errorCard(job, ctx, { title: 'L’analisi non è riuscita' }));
    } else {
      summaryLoaded = true;
      replace(el, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Caricamento…'));
      Promise.all([get(`/api/jobs/${ctx.id}/manual`), get(`/api/jobs/${ctx.id}/catalog`)]).then(([man, cat]) => {
        const toCheck = man.changes.filter((c) => c.needs_confirmation).length;
        const reBtn = h('button', { class: 'btn', type: 'button' }, icon('refresh', 18), 'Rifai l’analisi con Claude');
        reBtn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Rifare l’analisi?',
            message: 'Claude rilegge il documento da capo e prepara una nuova scheda. La scheda attuale, con le tue modifiche, viene conservata come copia di sicurezza (manual.precedente.json). L’analisi ha di nuovo un costo.',
            confirmLabel: 'Rifai l’analisi',
          });
          if (!ok) return;
          try { await post(`/api/jobs/${ctx.id}/reanalyze`, {}); mode = null; } catch (err) { toast(err.message, 'err'); }
        });
        const j = ctx.job();
        replace(el, h('section', { class: 'card' },
          notice('ok', 'Analisi completata', h('p', j.test_mode
            ? 'MODALITÀ TEST: è stata caricata la scheda di prova, senza chiamare Claude. Ora controllala nella revisione.'
            : `Claude ha preparato la scheda del manuale${j.analysed_at ? ` (${fmtDate(j.analysed_at)})` : ''}. Ora controllala nella revisione.`),
          j.cost ? h('p', { class: 'small' }, `Costo stimato delle chiamate a Claude per questo lavoro: ${j.cost.text}${j.cost.approx ? ' (approssimativo)' : ''}, addebitato sull’account Anthropic della chiave.`) : null),
          h('div', { class: 'stats' },
            h('div', { class: 'stat' }, h('b', man.steps.length), h('span', 'passi di montaggio')),
            h('div', { class: 'stat' }, h('b', man.components.length), h('span', 'componenti')),
            h('div', { class: 'stat' }, h('b', man.hardware.length), h('span', 'tipi di ferramenta')),
            h('div', { class: 'stat' }, h('b', cat.filter((c) => !c.duplicate_of).length), h('span', 'immagini estratte')),
            h('div', { class: 'stat' }, h('b', toCheck), h('span', toCheck === 1 ? 'punto da verificare' : 'punti da verificare'))),
          warningsNotice('Avvisi sulla lettura del documento', [...(j.warnings?.ingest || []), ...(j.warnings?.images || [])]),
          h('div', { class: 'row mt-16' },
            h('a', { class: 'btn btn-primary btn-lg', href: `#/lavoro/${ctx.id}/revisione` }, 'Vai alla revisione', icon('right', 18)),
            reBtn)));
      }).catch((err) => replace(el, notice('err', 'Impossibile leggere la scheda', h('p', err.message))));
    }
  };
  return { el, update: render };
}

// ------------------------------------------------------------------------------------------ link del video (QR nel PDF)

/** Il PDF esistente ha un QR code diverso dal link attuale (link aggiunto, cambiato o tolto dopo averlo creato)? */
export const isPdfLinkStale = (job) => !!job.outputs?.pdf && (job.video_url || null) !== (job.outputs?.pdf_video_url || null);

/**
 * Campo «Link al video di montaggio» (passi PDF e video). L'elemento resta lo stesso tra un aggiornamento e l'altro
 * (quello che si sta scrivendo non si perde); update(job) aggiorna solo lo stato sotto il campo.
 * @param {{ where: string, title?: string, intro?: string }} opts
 */
function videoLinkBox(ctx, { where, title = null, intro = null }) {
  const id = `video-url-${where}`;
  let saved = ctx.job().video_url || '';
  const input = h('input', {
    class: 'input', type: 'url', id, value: saved, placeholder: 'https://youtu.be/…', inputmode: 'url',
    spellcheck: 'false', autocomplete: 'off', 'aria-describedby': `${id}-hint`,
    oninput: () => input.classList.remove('invalid'),
  });
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva');
  const status = h('div');
  const save = async (e) => {
    e.preventDefault();
    let v = input.value.trim();
    // «youtu.be/abc» → «https://youtu.be/abc»
    if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s/]+\.[^\s/]+/.test(v)) v = `https://${v}`;
    if (v === saved) { input.value = v; toast(v ? 'Il link è già salvato.' : 'Nessun link da salvare.', 'ok'); return; }
    saveBtn.disabled = true;
    try {
      const j = await patch(`/api/jobs/${ctx.id}`, { video_url: v });
      saved = j.video_url || '';
      input.value = saved;
      Object.assign(ctx.job(), { video_url: j.video_url, outputs: j.outputs });
      update(ctx.job());
      toast(saved ? (j.outputs?.pdf ? 'Link salvato: ricrea il PDF per aggiornare il QR code.' : 'Link salvato: il QR code sarà a pagina 2 del PDF.') : 'Link tolto: il PDF non avrà il QR code.', 'ok', 6000);
    } catch (err) {
      input.classList.add('invalid');
      toast(err.message, 'err', 8000);
      input.focus();
    } finally {
      saveBtn.disabled = false;
    }
  };
  const el = h('div', { class: 'qr-link' },
    title ? h('h3', null, icon('play', 18), title) : null,
    intro ? h('p', { class: 'small muted' }, intro) : null,
    h('form', { onsubmit: save, novalidate: true },
      h('label', { class: 'field-label', for: id }, 'Link al video di montaggio (per il QR code nel PDF)'),
      h('div', { class: 'input-group' }, input, saveBtn),
      h('span', { class: 'field-hint', id: `${id}-hint` }, 'Carica il video su YouTube (anche “non in elenco”) o sul tuo sito e incolla qui il link')),
    status);

  function update(job) {
    const server = job.video_url || '';
    // aggiornato altrove (altra scheda): si allinea solo se qui non si sta scrivendo
    if (server !== saved && document.activeElement !== input && input.value.trim() === saved) input.value = server;
    saved = server;
    const busy = runningTask(job) === 'pdf';
    const o = job.outputs || {};
    let content = null;
    if (busy) {
      content = h('p', { class: 'small muted qr-link-status' }, h('span', { class: 'spinner', style: 'width:14px;height:14px' }), 'Creazione del PDF in corso…');
    } else if (isPdfLinkStale(job)) {
      const redo = h('button', { class: 'btn btn-dark', type: 'button', onclick: () => startPdf(ctx) }, icon('refresh', 18), 'Ricrea il PDF');
      const [t, p] = !job.video_url
        ? ['Hai tolto il link del video', 'Il PDF attuale contiene ancora il QR code: ricrea il PDF per toglierlo.']
        : o.pdf_video_url
          ? ['Il link del video è cambiato', 'Il QR code del PDF attuale porta ancora al link precedente: ricrea il PDF per aggiornarlo.']
          : ['Il PDF attuale non ha ancora il QR code', 'Ricrea il PDF per aggiungere il QR code del video a pagina 2.'];
      content = notice('warn', t, h('p', p), h('div', { class: 'actions' }, redo));
    } else if (job.video_url && o.pdf) {
      content = h('p', { class: 'small qr-link-status' }, h('span', { class: 'pill pill-ok' }, icon('check', 14), 'QR code nel PDF, a pagina 2'),
        h('span', { class: 'muted' }, 'Prima di stampare, inquadralo con il telefono per controllare che apra il video.'));
    } else if (job.video_url) {
      content = h('p', { class: 'small muted qr-link-status' }, 'Il QR code comparirà a pagina 2 quando crei il PDF.');
    }
    replace(status, content ? h('div', { class: 'mt-16' }, content) : null);
  }
  update(ctx.job());
  return { el, update };
}

/** Ridisegna senza far perdere il cursore a un campo che sta dentro `keep` (spostato con il resto). */
function keepFocus(keep, fn) {
  const a = document.activeElement;
  const inside = !!a && keep.contains(a);
  const sel = inside && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  fn();
  if (inside && document.contains(a) && document.activeElement !== a) {
    a.focus({ preventScroll: true });
    if (sel) { try { a.setSelectionRange(sel[0], sel[1]); } catch { /* ignora */ } }
  }
}

// ------------------------------------------------------------------------------------------ passo 3: PDF

const pdfKey = (job) => [job.outputs?.pdf_at, job.outputs?.pdf_manual_at, job.manual_saved_at].join('|');

function pdfView(ctx) {
  const el = h('div');
  const link = videoLinkBox(ctx, { where: 'pdf', title: 'QR code del video (facoltativo)', intro: 'Con il link del video, a pagina 2 del PDF compare un QR code: inquadrandolo con il telefono si apre il video di montaggio.' });
  let mode = null;
  let card = null;
  let lastAt = null;
  const render = (job) => {
    link.update(job);
    keepFocus(link.el, () => draw(job));
  };
  const draw = (job) => {
    const t = runningTask(job);
    const m = t === 'pdf' ? 'running' : job.status === 'errore' && job.error?.task === 'pdf' ? 'error' : job.outputs?.pdf ? 'done' : 'empty';
    if (m === mode && m === 'running') { card.update(job); return; }
    if (m === mode && m === 'done' && lastAt === pdfKey(job)) return;
    if (m === mode && m !== 'done') return;
    mode = m;
    if (m === 'running') {
      card = taskCard({ ctx, title: 'Creazione del PDF in corso', iconName: 'pdf', hint: 'L’impaginazione automatica richiede di solito meno di un minuto.' });
      replace(el, card.el);
      card.update(job);
    } else if (m === 'error') {
      lastAt = null;
      replace(el, errorCard(job, ctx, { title: 'Il PDF non è stato creato', back: true }), h('section', { class: 'card' }, link.el), job.outputs?.pdf ? resultCard(job, { previous: true }) : null);
    } else if (m === 'empty') {
      const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => startPdf(ctx) }, icon('pdf', 20), 'Crea il PDF');
      replace(el, h('section', { class: 'card', style: 'text-align:center;padding:48px 24px' },
        h('div', { style: 'display:inline-grid;place-items:center;width:72px;height:72px;border-radius:18px;background:var(--accent-tint);color:var(--accent-ink);margin-bottom:14px' }, icon('pdf', 34)),
        h('h2', 'Il PDF non è ancora stato creato'),
        h('p', { class: 'muted', style: 'max-width:520px;margin:8px auto 22px' }, 'Quando la scheda è a posto, crea il manuale impaginato: copertina, componenti, ferramenta, passi illustrati e note.'),
        h('div', { class: 'row', style: 'justify-content:center' }, btn, h('a', { class: 'btn btn-lg', href: `#/lavoro/${ctx.id}/revisione` }, icon('left', 18), 'Torna alla revisione')),
        h('div', { class: 'qr-link-wrap' }, link.el)));
    } else {
      lastAt = pdfKey(job);
      replace(el, resultCard(job));
    }
  };
  /** PDF già creato (previous = mostrato sotto l'errore di un nuovo tentativo). */
  const resultCard = (job, { previous = false } = {}) => {
    const stale = !previous && isStale(job, 'pdf');
    const src = `/api/jobs/${ctx.id}/files/manuale.pdf?v=${encodeURIComponent(job.outputs.pdf_at || '')}`;
    return (
      h('section', { class: 'card' },
        h('div', { class: 'result-head' },
          h('div', null, h('h2', 'Il tuo manuale PDF'),
            h('div', { class: 'meta' }, `Creato ${fmtDate(job.outputs.pdf_at)}${job.outputs.pdf_pages ? ` · ${plural(job.outputs.pdf_pages, 'pagina', 'pagine')}` : ''}`)),
          h('div', { class: 'row' },
            h('a', { class: 'btn btn-primary btn-lg', href: `${src}&download=1`, download: '' }, icon('download', 20), 'Scarica il PDF'),
            h('a', { class: 'btn btn-lg', href: src, target: '_blank', rel: 'noopener' }, icon('external', 18), 'Apri in una scheda'))),
        stale ? notice('warn', 'Hai modificato la scheda dopo aver creato questo PDF',
          h('p', 'Crea di nuovo il PDF per includere le ultime modifiche.'),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-dark', type: 'button', onclick: () => startPdf(ctx) }, icon('refresh', 18), 'Ricrea il PDF'))) : null,
        warningsNotice('Avvisi sull’impaginazione', job.warnings?.pdf),
        previous ? null : link.el,
        h('iframe', { class: 'pdf-frame mt-16', src: `${src}#view=Fit&pagemode=none&navpanes=0`, title: 'Anteprima del PDF' }),
        h('div', { class: 'notice pdf-mobile-note mt-16' }, icon('info', 22), h('div', { class: 'grow' },
          h('p', { style: 'margin:0' }, 'Su questo schermo l’anteprima non si vede: usa «Apri in una scheda» o «Scarica il PDF».'))),
        h('div', { class: 'row-between mt-16' },
          h('div', { class: 'row' },
            h('a', { class: 'btn', href: `#/lavoro/${ctx.id}/revisione` }, icon('left', 18), 'Torna alla revisione'),
            stale || previous ? null : h('button', { class: 'btn', type: 'button', onclick: () => startPdf(ctx) }, icon('refresh', 18), 'Ricrea il PDF')),
          h('a', { class: 'btn btn-dark', href: `#/lavoro/${ctx.id}/video` }, 'Passa al video', icon('right', 18)))));
  };
  return { el, update: render };
}

// ------------------------------------------------------------------------------------------ passo 4: video

const QUALITY_OPTIONS = [
  { value: '1080p', label: '1080p Full HD', note: 'consigliata, la più nitida' },
  { value: '720p', label: '720p', note: 'più leggera, più veloce' },
  { value: 'anteprima', label: 'Anteprima veloce', note: 'bassa qualità, per un controllo' },
];
/** "p01 ×2 ‘F1_L’" → "F1_L (×2)": etichetta delle viste delle parti più leggibile. */
function viewLabel(label) {
  const m = /^p\d+\s*(?:×\s*(\d+))?\s*[‘'"](.+)[’'"]\s*$/.exec(String(label || ''));
  if (!m) return String(label || '');
  return m[1] ? `${m[2]} (×${m[1]})` : m[2];
}
const QUALITY_LABEL = { '1080p': '1080p Full HD', '720p': '720p', anteprima: 'Anteprima veloce' };

/** Suggerimento sotto il titolo del riquadro di avanzamento del video, secondo la fase in corso. */
function videoHint(job) {
  const p = job.progress || {};
  if (p.queued) return 'Il video partirà appena finisce l’operazione in corso. Puoi lasciare aperta questa pagina.';
  if (p.stage === 'modello') return 'Lettura del modello 3D: con i file STEP grandi può richiedere qualche minuto.';
  if (p.stage === 'piano') return job.test_mode ? 'Modalità test: piano dell’animazione di prova.' : 'Claude decide quali pezzi si montano in ogni passo e come inquadrarli.';
  return 'Il motore disegna i fotogrammi uno per uno, poi monta il video. Puoi lasciare aperta questa pagina: il video comparirà qui.';
}

function videoView(ctx) {
  const el = h('div');
  const j0 = ctx.job();
  const ui = {
    mode: j0.model_file ? '3d' : (j0.video_mode || 'immagini'),
    quality: j0.video_quality && j0.video_quality !== 'anteprima' ? j0.video_quality : '1080p',
    replan: false,
  };
  let sig = null;
  let card = null;
  let uploading = null; // { pct }
  const link = videoLinkBox(ctx, { where: 'video', title: 'Video online e QR code nel PDF', intro: 'Quando il video è pronto, mettilo online e incolla qui il link: a pagina 2 del PDF comparirà un QR code che lo apre dal telefono.' });
  const linkCard = h('section', { class: 'card' }, link.el);

  const modelSection = (job) => {
    const m = job.model3d || {};
    const box = h('div', { class: 'model-box' });
    if (uploading) {
      box.append(h('div', { class: 'label-row mt-0' }, 'Caricamento del modello 3D…'), progressBar(uploading.pct), h('div', { class: 'small muted mt-8' }, `${uploading.pct} %`));
      return box;
    }
    if (!job.model_file) {
      const input = h('input', { type: 'file', accept: MODEL_EXTS.map((e) => '.' + e).join(','), 'aria-label': 'Carica il modello 3D' });
      input.addEventListener('change', () => { if (input.files?.[0]) uploadModel(input.files[0]); });
      const zone = h('div', { class: 'drop drop-secondary', style: 'min-height:190px' },
        h('div', { class: 'drop-icon' }, icon('cube', 26)), h('h3', 'Carica il modello 3D'),
        h('p', 'Trascina qui il file oppure clicca per sceglierlo'),
        h('div', { class: 'formats', html: '<b>STEP</b> (.step, .stp), <b>IGES</b>, <b>GLB/GLTF</b>, <b>OBJ</b>, <b>STL</b> · fino a 300 MB' }), input);
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
      zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dragover'); const f = e.dataTransfer?.files?.[0]; if (f) uploadModel(f); });
      box.append(zone, h('ul', { class: 'tips small' },
        h('li', null, 'Il formato migliore è lo ', h('b', 'STEP'), ': da SolidWorks, Fusion 360, Inventor, Solid Edge, FreeCAD… scegli «Salva con nome / Esporta → STEP».'),
        h('li', null, 'Esporta l’', h('b', 'assieme completo, già montato'), ', con i pezzi come ', h('b', 'parti separate'), ' (non un unico corpo).'),
        h('li', null, 'Viti e rondelle incluse rendono il video più chiaro.')));
      return box;
    }
    const fileRow = h('div', { class: 'row-between' },
      h('div', null, h('div', { class: 'label-row mt-0', style: 'margin:0' }, 'Modello 3D'), h('div', { class: 'small muted' }, job.model_name || job.model_file)),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => pickModel() }, icon('upload', 16), 'Carica un altro file'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => removeModel() }, icon('trash', 16), 'Togli')));
    box.append(fileRow);
    if (m.status === 'in_coda' || m.status === 'importazione' || m.status === 'nessuno') {
      const queued = m.status !== 'importazione';
      box.append(h('div', { class: 'mt-16' }, progressBar(m.pct || 0, { indeterminate: queued }),
        h('div', { class: 'small mt-8' }, queued ? (m.message || 'In attesa di leggere il modello 3D…') : `Lettura del modello 3D · ${m.pct || 0} % — ${m.message || ''}`)));
    } else if (m.status === 'errore') {
      // file rovinato o non supportato: rileggere lo stesso file di solito non serve → prima «Carica un altro file»
      const interrupted = /annullat|interrott/i.test(m.error || '');
      const retry = h('button', { class: interrupted ? 'btn btn-primary' : 'btn', type: 'button' }, icon('refresh', 18), 'Riprova');
      retry.addEventListener('click', async () => { retry.disabled = true; try { await post(`/api/jobs/${ctx.id}/retry`, { what: 'modello' }); } catch (err) { toast(err.message, 'err'); retry.disabled = false; } });
      const other = interrupted ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => pickModel() }, icon('upload', 18), 'Carica un altro file');
      box.append(h('div', { class: 'mt-16' }, notice('err', 'Il modello 3D non è stato letto', h('p', m.error || 'Errore sconosciuto.'),
        /STEP/.test(m.error || '') || interrupted ? null : h('p', { class: 'small' }, 'Prova a esportarlo di nuovo in STEP, con le parti separate.'),
        h('div', { class: 'actions' }, other, retry))));
    } else if (m.status === 'pronto') {
      box.append(h('div', { class: 'model-facts' },
        h('span', { class: 'pill pill-ok' }, icon('check', 14), 'Modello letto'),
        m.part_count ? h('span', { class: 'pill' }, plural(m.part_count, 'parte', 'parti')) : null,
        m.group_count ? h('span', { class: 'pill' }, plural(m.group_count, 'tipo di pezzo', 'tipi di pezzi')) : null,
        m.size_text ? h('span', { class: 'pill' }, m.size_text.replace(/\s*\(.*\)$/, '')) : null));
      if (m.views?.length) {
        box.append(h('div', { class: 'views' }, m.views.map((v, i) => {
          // copia senza l'etichetta tecnica (nomi del CAD, misure) pensata per Claude, se c'è
          const src = `/api/jobs/${ctx.id}/views/${encodeURIComponent(v.ui_name || v.name)}?v=${encodeURIComponent(m.imported_at || '')}`;
          const label = v.ref_label || viewLabel(v.label);
          return h('figure', { class: i === 0 ? 'overview' : '', onclick: () => imagePreview(src, label), title: v.label },
            h('img', { src, alt: label, loading: 'lazy' }), h('figcaption', label));
        })));
      }
      const other = m.up_axis === 'z' ? 'y' : 'z';
      const reimport = h('button', { class: 'btn btn-sm btn-dark', type: 'button' }, icon('rotate', 16), `Rileggi con l’asse ${other.toUpperCase()} in alto`);
      reimport.addEventListener('click', async () => {
        reimport.disabled = true;
        try { await post(`/api/jobs/${ctx.id}/model/reimport`, { upAxis: other }); } catch (err) { toast(err.message, 'err'); reimport.disabled = false; }
      });
      box.append(h('div', { class: 'notice mt-16' }, icon('info', 22), h('div', { class: 'grow' },
        h('h3', 'Il modello è capovolto o sdraiato?'),
        h('p', 'Guarda la vista d’insieme: il prodotto deve essere in piedi, come quando è montato. Se appare sdraiato o sottosopra, rileggilo con l’altro asse verticale.'),
        h('div', { class: 'actions' }, reimport,
          m.up_axis_requested !== 'auto' ? h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { try { await post(`/api/jobs/${ctx.id}/model/reimport`, { upAxis: 'auto' }); } catch (err) { toast(err.message, 'err'); } } }, 'Torna al riconoscimento automatico') : null))));
      if (job.warnings?.model?.length) box.append(h('div', { class: 'mt-16' }, warningsNotice('Note sul modello', job.warnings.model)));
    }
    return box;
  };

  const pickModel = () => {
    const input = h('input', { type: 'file', accept: MODEL_EXTS.map((e) => '.' + e).join(',') });
    input.addEventListener('change', () => { if (input.files?.[0]) uploadModel(input.files[0]); });
    input.click();
  };
  const uploadModel = async (file) => {
    const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] || '').toLowerCase();
    if (!MODEL_EXTS.includes(ext)) { toast(`«${file.name}» non è un formato 3D supportato (STEP, IGES, GLB, OBJ, STL).`, 'err', 6000); return; }
    uploading = { pct: 0 };
    sig = null; render(ctx.job());
    const fd = new FormData();
    fd.append('modello3d', file, file.name);
    try {
      await upload(`/api/jobs/${ctx.id}/model`, fd, (f) => { uploading = { pct: Math.round(f * 100) }; sig = null; render(ctx.job()); });
      toast(`Modello caricato (${fmtBytes(file.size)}): lettura in corso.`, 'ok');
    } catch (err) {
      toast(err.message, 'err', 8000);
    }
    uploading = null;
    sig = null; render(ctx.job());
  };
  const removeModel = async () => {
    const ok = await confirmDialog({ title: 'Togliere il modello 3D?', message: 'Il file 3D e le sue viste verranno eliminati da questo lavoro. Potrai caricarne un altro.', confirmLabel: 'Togli il modello', danger: true });
    if (!ok) return;
    try { await del(`/api/jobs/${ctx.id}/model`); ui.mode = 'immagini'; sig = null; } catch (err) { toast(err.message, 'err'); }
  };

  const startVideo = async () => {
    const job = ctx.job();
    if (ui.mode === '3d' && !job.model_file) { toast('Per il video 3D carica prima il modello 3D (oppure scegli «Video con immagini»).', 'err', 6000); return; }
    try {
      await post(`/api/jobs/${ctx.id}/video`, { mode: ui.mode, quality: ui.quality, replan: ui.replan });
      ui.replan = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { toast(err.message, 'err', 7000); }
  };

  const optionsCard = (job, { title, sub }) => {
    const m = job.model3d || {};
    const modeCard = (value, ico, name, desc) => h('button', { class: ['mode-card', ui.mode === value ? 'on' : ''], type: 'button', 'aria-pressed': String(ui.mode === value), onclick: () => { ui.mode = value; sig = null; render(ctx.job()); } },
      h('span', { class: 'mc-ico' }, icon(ico, 24)), h('span', null, h('strong', name), h('span', desc)), h('span', { class: 'radio' }));
    const qualityRow = h('div', { class: 'quality', role: 'radiogroup', 'aria-label': 'Qualità del video' }, QUALITY_OPTIONS.map((q) => {
      const input = h('input', { type: 'radio', name: 'quality', value: q.value, checked: ui.quality === q.value });
      input.addEventListener('change', () => { ui.quality = q.value; qualityRow.querySelectorAll('label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked)); });
      return h('label', { class: ui.quality === q.value ? 'on' : '' }, input, h('span', null, h('b', q.label), h('small', q.note)));
    }));
    const ready3d = job.model_file && m.status === 'pronto';
    const modelBroken = ui.mode === '3d' && job.model_file && m.status === 'errore';
    const canStart = ui.mode === 'immagini' || (!!job.model_file && !modelBroken);
    const replanBox = ui.mode === '3d' && ready3d && m.plan_sig ? h('label', { class: 'checkbox mt-16', style: 'font-weight:500' },
      h('input', { type: 'checkbox', checked: ui.replan, onchange: (e) => { ui.replan = e.target.checked; } }),
      'Chiedi di nuovo a Claude il piano dell’animazione (nuovo costo)') : null;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', title), sub ? h('p', sub) : null)),
      h('div', { class: 'mode-cards' },
        modeCard('3d', 'cube', 'Video 3D', 'Il modello 3D si monta pezzo dopo pezzo, passo per passo. Serve il modello 3D.'),
        modeCard('immagini', 'film', 'Video con immagini', 'Le figure del manuale, animate con le didascalie dei passi. Sempre disponibile.')),
      ui.mode === '3d' ? modelSection(job) : null,
      h('div', { class: 'label-row' }, 'Qualità'),
      qualityRow,
      replanBox,
      h('div', { class: 'row mt-24' },
        h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: !canStart || !!uploading, onclick: startVideo }, icon('play', 18), job.outputs?.video ? 'Crea di nuovo il video' : 'Crea il video'),
        h('span', { class: 'small muted' }, ui.mode === '3d'
          ? (ready3d ? (m.plan_sig ? 'Il piano dell’animazione già pronto verrà riutilizzato.' : 'Claude prepara prima il piano dell’animazione, poi parte il video.')
            : modelBroken ? 'Il modello 3D non è stato letto: caricane un altro (o premi «Riprova»), oppure scegli «Video con immagini».'
              : job.model_file ? 'Il video partirà dopo la lettura del modello.' : 'Carica prima il modello 3D qui sopra.')
          : 'Il video con immagini è pronto in pochi minuti.')));
  };

  const resultCard = (job) => {
    const v = encodeURIComponent(job.outputs.video_at || '');
    const src = `/api/jobs/${ctx.id}/files/video.mp4?v=${v}`;
    const poster = job.outputs.poster ? `/api/jobs/${ctx.id}/files/poster.jpg?v=${v}` : null;
    const stale = isStale(job, 'video');
    return h('section', { class: 'card' },
      h('div', { class: 'result-head' },
        h('div', null, h('h2', 'Il tuo video di montaggio'),
          h('div', { class: 'meta' }, [job.video_mode === '3d' ? 'Video 3D' : 'Video con immagini', QUALITY_LABEL[job.video_quality], job.video_duration ? fmtDuration(job.video_duration) : null, `creato ${fmtDate(job.outputs.video_at)}`].filter(Boolean).join(' · '))),
        h('div', { class: 'row' },
          h('a', { class: 'btn btn-primary btn-lg', href: `${src}&download=1`, download: '' }, icon('download', 20), 'Scarica il video'),
          poster ? h('a', { class: 'btn btn-lg', href: `${poster}&download=1`, download: '' }, icon('image', 18), 'Copertina (JPG)') : null)),
      stale ? notice('warn', 'Hai modificato la scheda dopo aver creato questo video', h('p', 'Crea di nuovo il video per includere le ultime modifiche.')) : null,
      warningsNotice('Avvisi sul video', job.warnings?.video),
      h('div', { class: 'video-wrap mt-16' }, h('video', { controls: true, preload: 'metadata', src, poster, playsinline: true })),
      job.video_quality === 'anteprima' ? h('p', { class: 'small muted mt-8', style: 'margin-bottom:0' }, 'Questa è un’anteprima a bassa qualità: per il video definitivo scegli 1080p qui sotto.') : null);
  };

  let seenVideoAt = j0.outputs?.video_at || null;
  const render = (job) => {
    link.update(job);
    keepFocus(link.el, () => draw(job));
  };
  const draw = (job) => {
    const t = runningTask(job);
    const isErr = job.status === 'errore' && job.error?.task === 'video';
    // finita un'anteprima veloce: per il prossimo video si propone di nuovo la qualità definitiva
    if ((job.outputs?.video_at || null) !== seenVideoAt) {
      seenVideoAt = job.outputs?.video_at || null;
      if (job.video_quality === 'anteprima') ui.quality = '1080p';
    }
    const m = job.model3d || {};
    const key = JSON.stringify([t === 'video' ? 'run' : 'idle', isErr, job.outputs?.video_at, job.model_file, m.status, m.status === 'importazione' || m.status === 'in_coda' ? m.pct : 0, m.imported_at, m.error, m.plan_sig, job.manual_saved_at, ui.mode, !!uploading, uploading?.pct]);
    if (t === 'video' && card && sig && sig.startsWith('["run"')) { card.update(job); return; }
    if (key === sig) return;
    sig = key;
    if (t === 'video') {
      card = taskCard({
        ctx, title: 'Creazione del video in corso', iconName: 'film',
        hint: videoHint,
        substeps: job.task_params?.mode === '3d' || job.progress?.stage === 'modello' || job.progress?.stage === 'piano'
          ? [{ label: 'Lettura del modello 3D', stages: ['modello'] }, { label: 'Piano dell’animazione', stages: ['piano'] }, { label: 'Fotogrammi e montaggio del video', stages: ['render'] }]
          : null,
      });
      replace(el, card.el);
      card.update(job);
      return;
    }
    card = null;
    const parts = [];
    if (isErr) parts.push(errorCard(job, ctx, { title: 'Il video non è stato creato', back: true }));
    if (job.outputs?.video) {
      parts.push(resultCard(job));
      parts.push(linkCard);
      parts.push(optionsCard(job, { title: 'Crea un altro video', sub: 'Cambia tipo o qualità e crealo di nuovo.' }));
    } else {
      parts.push(optionsCard(job, { title: 'Scegli il tipo di video', sub: 'Il video segue i passi della scheda che hai rivisto.' }));
      parts.push(linkCard);
    }
    replace(el, parts);
  };
  return { el, update: render };
}

// ------------------------------------------------------------------------------------------ pagina

export async function renderJob(root, params) {
  const id = params.id;
  let job;
  try {
    job = await get(`/api/jobs/${id}`);
  } catch (err) {
    replace(root, h('div', { class: 'page' }, h('a', { class: 'back-link', href: '#/' }, icon('left', 18), 'Tutti i lavori'),
      notice('err', err.status === 404 ? 'Lavoro non trovato' : 'Impossibile aprire il lavoro', h('p', err.message))));
    return {};
  }
  let current = params.step || defaultStep(job);
  let view = null;
  const ctx = {
    id,
    job: () => job,
    navigate: (step) => navigate(`#/lavoro/${id}/${step}`),
  };

  const headEl = h('div', { class: 'job-head' });
  const stepper = h('nav', { class: 'stepper', 'aria-label': 'Passi del lavoro' });
  const activity = h('div');
  const content = h('div');
  const page = h('div', { class: 'page page-wide' },
    h('a', { class: 'back-link', href: '#/' }, icon('left', 18), 'Tutti i lavori'),
    headEl, stepper, activity, content);
  replace(root, page);

  const renderHead = () => {
    const cost = job.cost;
    replace(headEl,
      h('div', { style: 'min-width:0' },
        h('h1', job.name),
        h('div', { class: 'job-meta muted' },
          h('span', null, icon(job.input_kind === 'docx' ? 'file' : 'pdf', 16, { style: 'vertical-align:-3px;margin-right:5px' }),
            h('a', { href: `/api/jobs/${id}/document${job.input_kind === 'docx' ? '?download=1' : ''}`, target: '_blank', rel: 'noopener', title: 'Apri il documento originale' }, job.input_name || 'Documento')),
          job.model_name ? h('span', null, icon('cube', 16, { style: 'vertical-align:-3px;margin-right:5px' }), job.model_name) : null,
          h('span', null, `Creato ${fmtDate(job.created_at)}`))),
      h('div', { class: 'chips' },
        job.test_mode ? h('span', { class: 'pill pill-test', title: 'Nessuna chiamata a Claude: scheda e piano di prova' }, 'Modalità test') : null,
        cost ? h('span', { class: 'pill', title: (cost.items || []).map((i) => `${i.label}: ${i.text}`).join('\n') }, icon('sparkle', 14), `Costo Claude stimato: ${cost.text}`) : null));
  };

  const renderStepper = () => {
    const st = stepStates(job);
    replace(stepper, STEP_KEYS.map((k, i) => {
      const s = st[k];
      const b = h('button', {
        class: ['step-tab', s.state, current === k ? 'current' : ''], type: 'button', disabled: !s.enabled,
        'aria-current': current === k ? 'step' : null,
        onclick: () => { if (s.enabled) navigate(`#/lavoro/${id}/${k}`); },
      },
      h('span', { class: 'step-num' }, s.state === 'done' && current !== k ? icon('check', 20) : s.state === 'running' ? h('span', { class: 'spinner', style: 'width:20px;height:20px' }) : s.state === 'error' ? icon('alert', 18) : String(i + 1)),
      h('span', { class: 'step-text' }, h('strong', STEP_LABEL[k]), h('span', s.sub)));
      return b;
    }));
  };

  const renderActivity = () => {
    const t = runningTask(job);
    const items = [];
    const viewOf = { analisi: 'analisi', pdf: 'pdf', video: 'video' };
    if (t && viewOf[t] !== current) {
      const p = job.progress || {};
      items.push(h('div', { class: 'activity' }, h('span', { class: 'spinner' }),
        h('div', { class: 'grow' }, h('div', null, h('strong', TASK_TITLE[t]), ` · ${p.queued ? 'in attesa' : `${p.pct || 0} %`}`, p.message ? h('span', { class: 'small', style: 'opacity:.8' }, ` — ${p.message}`) : null), progressBar(p.pct || 0, { small: true, indeterminate: !!p.queued })),
        h('a', { class: 'btn btn-sm', href: `#/lavoro/${id}/${viewOf[t]}` }, 'Mostra')));
    }
    const m = job.model3d || {};
    if ((m.status === 'importazione' || m.status === 'in_coda') && current !== 'video' && t !== 'video') {
      items.push(h('div', { class: 'activity', style: 'background:#3A3430' }, icon('cube', 20),
        h('div', { class: 'grow' }, h('div', null, h('strong', 'Lettura del modello 3D'), m.status === 'importazione' ? ` · ${m.pct || 0} %` : ' · in attesa', h('span', { class: 'small', style: 'opacity:.8' }, ' — per il video 3D, intanto puoi continuare'))),
        hasManual(job) ? h('a', { class: 'btn btn-sm', href: `#/lavoro/${id}/video` }, 'Mostra') : null));
    }
    replace(activity, items);
  };

  const showStep = (step) => {
    if (view && view.cleanup) { try { view.cleanup(); } catch { /* ignora */ } }
    current = step;
    const st = stepStates(job)[step];
    if (!st || !st.enabled) current = defaultStep(job);
    if (current === 'analisi') view = analisiView(ctx);
    else if (current === 'revisione') view = renderReview(ctx);
    else if (current === 'pdf') view = pdfView(ctx);
    else view = videoView(ctx);
    replace(content, view.el);
    view.update(job);
    renderStepper();
    renderActivity();
  };

  renderHead();
  showStep(current);

  setLeaveGuard(async (hash) => (view && view.canLeave ? view.canLeave(hash) : true), root);

  const stop = subscribe(`/api/jobs/${id}/events`, (j) => {
    const prev = job;
    job = j;
    if (prev.name !== j.name || prev.cost?.text !== j.cost?.text || prev.test_mode !== j.test_mode || prev.model_name !== j.model_name) renderHead();
    renderStepper();
    renderActivity();
    // fine dell'analisi mentre si guarda l'avanzamento: si passa alla revisione
    if (current === 'analisi' && runningTask(prev) === 'analisi' && j.status === 'revisione') {
      toast('Analisi completata: controlla la scheda.', 'ok');
      navigate(`#/lavoro/${id}/revisione`);
      return;
    }
    if (runningTask(prev) === 'pdf' && j.status !== 'errore' && !runningTask(j) && j.outputs?.pdf) toast('Il PDF è pronto.', 'ok');
    if (runningTask(prev) === 'video' && j.status === 'completato') toast('Il video è pronto.', 'ok');
    if (runningTask(prev) && j.status === 'errore' && current !== j.error?.task && j.error?.task !== 'analisi') toast(`${TASK_TITLE[j.error.task] || 'Operazione'}: non riuscita.`, 'err', 6000);
    if (view && view.update) {
      // un errore di disegno non deve bloccare la pagina in silenzio (gli aggiornamenti successivi continuano)
      try { view.update(j); } catch (err) {
        console.error(err);
        toast(`La pagina non si è aggiornata correttamente (${err?.message || err}): ricaricala con F5.`, 'err', 8000);
      }
    }
  }, {
    onDeleted: () => { toast('Questo lavoro è stato eliminato.', 'err'); navigate('#/'); },
  });

  return {
    cleanup: () => { stop(); if (view && view.cleanup) view.cleanup(); },
    update: (p) => {
      const step = p.step || defaultStep(job);
      if (step !== current) showStep(step);
    },
  };
}
