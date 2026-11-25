// Pagina iniziale: caricamento del manuale (e del modello 3D facoltativo) + elenco dei lavori.
import { h, replace, icon, fmtDate, fmtBytes, toast, confirmDialog, notice, progressBar } from './ui.js';
import { get, del, upload, subscribe } from './api.js';
import { state, navigate } from './app.js';

const DOC_EXTS = ['pdf', 'docx'];
const MODEL_EXTS = ['step', 'stp', 'iges', 'igs', 'glb', 'gltf', 'obj', 'stl'];

export const STATUS = {
  nuovo: { label: 'In coda', cls: 'pill-accent', busy: true },
  estrazione: { label: 'Lettura del documento', cls: 'pill-accent', busy: true },
  analisi: { label: 'Analisi con Claude', cls: 'pill-accent', busy: true },
  revisione: { label: 'Da rivedere', cls: 'pill-warn' },
  pdf: { label: 'Creazione del PDF', cls: 'pill-accent', busy: true },
  pdf_pronto: { label: 'PDF pronto', cls: 'pill-ok' },
  video: { label: 'Creazione del video', cls: 'pill-accent', busy: true },
  completato: { label: 'PDF e video pronti', cls: 'pill-ok' },
  errore: { label: 'Errore', cls: 'pill-err' },
};

export function statusPill(job) {
  const s = STATUS[job.status] || { label: job.status, cls: '' };
  let label = s.label;
  if (job.status === 'errore' && job.error?.task) label = { analisi: 'Analisi non riuscita', pdf: 'PDF non riuscito', video: 'Video non riuscito' }[job.error.task] || label;
  if (job.status === 'completato' && !job.outputs?.pdf) label = 'Video pronto';
  // operazione in coda dietro a quella di un altro lavoro: non è ancora iniziata
  const queued = !!(s.busy && job.progress?.queued);
  if (queued) label = { estrazione: 'Analisi in coda', pdf: 'PDF in coda', video: 'Video in coda' }[job.status] || 'In coda';
  return h('span', { class: ['pill', s.cls] }, h('span', { class: ['dot', s.busy && !queued ? 'pulse' : ''] }), label);
}

const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();

function dropZone({ main, title, text, formats, accept, exts, onFile, iconName }) {
  let file = null;
  const input = h('input', { type: 'file', accept, 'aria-label': title });
  const zone = h('div', { class: ['drop', main ? 'drop-main' : 'drop-secondary'] });
  const render = () => {
    replace(zone);
    zone.classList.toggle('has-file', !!file);
    if (!file) {
      zone.append(
        h('div', { class: 'drop-icon' }, icon(iconName, main ? 30 : 24)),
        h('h3', title),
        h('p', text),
        h('div', { class: 'formats', html: formats }),
        input,
      );
    } else {
      zone.append(
        h('div', { class: 'file-chosen' },
          h('div', { class: 'fc-icon' }, icon(main ? 'file' : 'cube', 22)),
          h('div', { class: 'grow' }, h('div', { class: 'fc-name' }, file.name), h('div', { class: 'fc-size' }, fmtBytes(file.size))),
          h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Togli il file', title: 'Togli il file', onclick: (e) => { e.stopPropagation(); set(null); } }, icon('x'))),
        h('button', { class: 'btn-link mt-16', type: 'button', onclick: () => { input.value = ''; input.click(); } }, 'Scegli un altro file'),
        input,
      );
    }
  };
  const set = (f) => {
    if (f) {
      const ext = extOf(f.name);
      if (!exts.includes(ext)) {
        toast(main ? `«${f.name}» non è un PDF né un documento Word (.docx).` : `«${f.name}» non è un formato 3D supportato (STEP, IGES, GLB, OBJ, STL).`, 'err', 6000);
        return;
      }
    }
    file = f;
    onFile(f);
    render();
  };
  input.addEventListener('change', () => { if (input.files && input.files[0]) set(input.files[0]); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragover'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) set(f);
  });
  render();
  return { el: zone, set, get: () => file };
}

export function jobThumb(job) {
  if (job.thumb) {
    return h('img', { src: `/api/jobs/${job.id}/image/${job.thumb}?thumb=1`, alt: '', loading: 'lazy', onerror: (e) => { e.target.replaceWith(icon('book', 44, { class: 'ph' })); } });
  }
  return icon(job.input_kind === 'docx' ? 'file' : 'book', 44, { class: 'ph' });
}

export async function renderHome(root) {
  const settings = state.settings || {};
  let docFile = null;
  let modelFile = null;
  let busy = false;

  const banner = h('div');
  if (settings.testMode?.ai) {
    banner.append(notice('dark', 'Modalità test attiva', h('p', 'L’analisi usa una scheda di prova: Claude non viene chiamato e non ci sono costi.')));
  } else if (!settings.hasApiKey) {
    banner.append(notice('accent', 'Per iniziare serve la chiave API di Claude',
      h('p', 'Claude legge il manuale e ne ricava la scheda da controllare. Inserisci la chiave una sola volta: resta salvata su questo computer.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn btn-dark', href: '#/impostazioni' }, icon('key', 18), 'Vai a Impostazioni'))));
  }

  const startBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button', disabled: true }, icon('sparkle', 20), 'Avvia l’analisi');
  const progressBox = h('div', { class: 'upload-progress', hidden: true });

  const doc = dropZone({
    main: true,
    title: 'Carica il manuale (PDF o Word)',
    text: 'Trascina qui il file oppure clicca per sceglierlo',
    formats: '<b>PDF</b> o <b>Word (.docx)</b> · fino a 100 MB',
    accept: '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    exts: DOC_EXTS,
    iconName: 'upload',
    onFile: (f) => { docFile = f; startBtn.disabled = !docFile || busy; },
  });
  const model = dropZone({
    main: false,
    title: 'Modello 3D (facoltativo)',
    text: 'Serve per il video 3D. Puoi aggiungerlo anche dopo.',
    formats: '<b>STEP</b>, <b>IGES</b>, <b>GLB/GLTF</b>, <b>OBJ</b>, <b>STL</b> · fino a 300 MB',
    accept: '.step,.stp,.iges,.igs,.glb,.gltf,.obj,.stl',
    exts: MODEL_EXTS,
    iconName: 'cube',
    onFile: (f) => { modelFile = f; },
  });

  startBtn.addEventListener('click', async () => {
    if (!docFile || busy) return;
    busy = true;
    startBtn.disabled = true;
    const fd = new FormData();
    fd.append('documento', docFile, docFile.name);
    if (modelFile) fd.append('modello3d', modelFile, modelFile.name);
    const bar = progressBar(0);
    const label = h('div', { class: 'small muted mt-8' }, 'Caricamento del file…');
    replace(progressBox, bar, label);
    progressBox.hidden = false;
    try {
      const res = await upload('/api/jobs', fd, (f) => {
        bar.firstChild.style.width = `${Math.round(f * 100)}%`;
        label.textContent = f < 1 ? `Caricamento del file… ${Math.round(f * 100)} %` : 'Controllo del file…';
      });
      navigate(`#/lavoro/${res.id}/analisi`);
    } catch (err) {
      toast(err.message, 'err', 8000);
      progressBox.hidden = true;
      busy = false;
      startBtn.disabled = !docFile;
    }
  });

  const jobsBox = h('div', { class: 'jobs' }, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Caricamento dei lavori…'));
  const countEl = h('span', { class: 'muted small' });

  const page = h('div', { class: 'page' },
    h('section', { class: 'hero' },
      h('div', null,
        h('div', { class: 'eyebrow' }, 'Manuali di montaggio'),
        h('h1', null, 'Dal manuale al ', h('em', 'PDF impaginato'), ' e al ', h('em', 'video di montaggio')),
        h('p', 'Carica il manuale che hai già: Claude lo legge e prepara una scheda che puoi controllare e correggere. Poi lo strumento crea il PDF professionale e il video.')),
      h('ol', { class: 'how', 'aria-label': 'Come funziona' },
        h('li', h('strong', 'Analisi'), h('span', 'Claude legge testi e figure')),
        h('li', h('strong', 'Revisione'), h('span', 'Controlli e correggi la scheda')),
        h('li', h('strong', 'PDF'), h('span', 'Manuale impaginato, pronto da stampare')),
        h('li', h('strong', 'Video'), h('span', '3D dal modello, oppure con le immagini')))),
    banner,
    h('section', { class: 'card upload-card mt-24', 'aria-label': 'Nuovo lavoro' },
      h('div', { class: 'upload-grid' }, doc.el, model.el),
      h('div', { class: 'upload-actions' }, startBtn,
        h('div', { class: 'note' }, settings.testMode?.ai
          ? 'Modalità test: l’analisi richiede pochi secondi.'
          : 'L’analisi con Claude richiede di solito qualche minuto. Il costo (addebitato sul tuo account Anthropic) è in genere di qualche euro per manuale.')),
      progressBox),
    h('div', { class: 'section-title' }, h('h2', 'I tuoi lavori'), countEl),
    jobsBox);
  replace(root, page);

  let jobs = [];
  const cards = new Map();
  const renderCard = (job) => {
    const open = () => navigate(`#/lavoro/${job.id}`);
    const s = STATUS[job.status] || {};
    const card = h('article', { class: 'job-card', dataset: { id: job.id } },
      h('div', { class: 'job-thumb', onclick: open }, jobThumb(job)),
      h('div', { class: 'job-body' },
        h('h3', { onclick: open }, job.name),
        h('div', { class: 'job-meta' }, `${job.input_name || ''}${job.input_name ? ' · ' : ''}${fmtDate(job.created_at)}`),
        h('div', { class: 'row' }, statusPill(job), job.test_mode ? h('span', { class: 'pill pill-test' }, 'Test') : null),
        s.busy && job.progress ? h('div', null, progressBar(job.progress.pct || 0, { small: true }), h('div', { class: 'tiny muted mt-8' }, job.progress.message || '')) : null,
        h('div', { class: 'job-foot' },
          h('a', { class: 'btn btn-sm', href: `#/lavoro/${job.id}` }, 'Apri', icon('right', 16)),
          h('button', { class: 'btn btn-ghost btn-icon', title: 'Elimina il lavoro', 'aria-label': `Elimina il lavoro ${job.name}`, onclick: () => removeJob(job) }, icon('trash', 18)))));
    return card;
  };
  const renderList = () => {
    countEl.textContent = jobs.length ? `${jobs.length} ${jobs.length === 1 ? 'lavoro' : 'lavori'}` : '';
    if (!jobs.length) {
      replace(jobsBox, h('div', { class: 'empty', style: 'grid-column:1/-1' }, h('p', { style: 'margin:0' }, 'Nessun lavoro ancora: carica il primo manuale qui sopra.')));
      return;
    }
    cards.clear();
    replace(jobsBox, jobs.map((j) => { const c = renderCard(j); cards.set(j.id, c); return c; }));
  };
  const removeJob = async (job) => {
    const ok = await confirmDialog({
      title: 'Eliminare il lavoro?',
      message: `«${job.name}» verrà eliminato insieme al PDF, al video e a tutti i file del lavoro. Non si può annullare.`,
      confirmLabel: 'Elimina', danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/jobs/${job.id}`);
      jobs = jobs.filter((j) => j.id !== job.id);
      renderList();
      toast('Lavoro eliminato.', 'ok');
    } catch (err) {
      toast(err.message, 'err', 7000);
    }
  };

  try {
    jobs = await get('/api/jobs');
    renderList();
  } catch (err) {
    replace(jobsBox, notice('err', 'Impossibile leggere i lavori', h('p', err.message)));
  }

  const stop = subscribe('/api/events', (j) => {
    const i = jobs.findIndex((x) => x.id === j.id);
    if (i === -1) { jobs.unshift(j); renderList(); return; }
    jobs[i] = j;
    const old = cards.get(j.id);
    if (old) { const c = renderCard(j); old.replaceWith(c); cards.set(j.id, c); }
  }, {
    onDeleted: ({ id }) => {
      if (!id) return;
      jobs = jobs.filter((j) => j.id !== id);
      renderList();
    },
    // la scheda torna visibile dopo una pausa: gli aggiornamenti persi si recuperano rileggendo l'elenco
    onReopen: () => { get('/api/jobs').then((list) => { jobs = list; renderList(); }).catch(() => {}); },
  });

  return { cleanup: () => stop() };
}
