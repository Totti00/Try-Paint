// Riparazione dei riferimenti nelle risposte di Claude (o nelle schede caricate in modalità test).
//
//   repairManual(manual, catalog)              → { manual, repairs[] }   (manual valida per ManualData)
//   repairPlan(plan, parts, manual, { upAxis }) → { plan, repairs[], warnings[] }  (plan valido per AnimationPlan)
//
// Le riparazioni sono conservative: si tolgono o si correggono solo riferimenti che non possono funzionare
// (immagini, sigle, chiavi o passi inesistenti), mai il contenuto. Ogni intervento finisce in `repairs`
// (che il chiamante scrive nel registro del lavoro).

import { ManualData, AnimationPlan } from '../schema.js';

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const normRef = (s) => str(s).toUpperCase().replace(/[\s().,;:_\-–—]/g, '');
const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

// ------------------------------------------------------------------------------------- ManualData

/**
 * @param {object} input     ManualData (già validata da zod)
 * @param {object[]|null} catalog  ImageCatalog; null = sconosciuto (gli id immagine non si controllano)
 */
export function repairManual(input, catalog) {
  const m = clone(input);
  const repairs = [];
  const note = (s) => repairs.push(s);
  const known = Array.isArray(catalog) ? catalog.map((c) => c.id) : null;
  const knownSet = known ? new Set(known) : null;
  const byNumber = new Map();
  if (known) for (const id of known) { const n = /^img_(\d+)$/.exec(id); if (n) byNumber.set(Number(n[1]), id); }

  const fixImage = (id, where) => {
    if (id == null) return null;
    const t = str(id);
    if (!t) return null;
    if (!knownSet || knownSet.has(t)) return t;
    const n = /^im(?:g|age|magine)?[\s_\-]?0*(\d+)$/i.exec(t);
    if (n && byNumber.has(Number(n[1]))) {
      const fixed = byNumber.get(Number(n[1]));
      note(`${where}: id immagine «${t}» corretto in «${fixed}»`);
      return fixed;
    }
    note(`${where}: immagine «${t}» inesistente nel catalogo, rimossa`);
    return null;
  };

  m.version = 1;
  for (const k of ['language', 'document_title', 'short_name', 'footer_text']) m[k] = str(m[k]);
  if (!m.language) { m.language = 'it'; note('lingua mancante: impostata a «it»'); }

  m.products = (m.products || []).map((p) => ({ category: str(p.category), names: (p.names || []).map(str).filter(Boolean) }))
    .filter((p) => p.names.length || p.category);

  m.cover_image_id = fixImage(m.cover_image_id, 'copertina');
  m.brand_logo_image_id = fixImage(m.brand_logo_image_id, 'logo');

  // --- ferramenta: id unici e non vuoti
  const usedHw = new Set();
  let hwN = 1;
  const nextHw = () => { while (usedHw.has(`H${hwN}`)) hwN++; return `H${hwN}`; };
  for (const h of m.hardware || []) { const id = str(h.id); if (id) usedHw.add(id); }
  const seenHw = new Set();
  m.hardware = (m.hardware || []).map((h, i) => {
    let id = str(h.id);
    if (!id || seenHw.has(id)) {
      const old = id;
      id = nextHw();
      usedHw.add(id);
      note(old ? `ferramenta n. ${i + 1}: id «${old}» duplicato, rinominato in «${id}»` : `ferramenta n. ${i + 1}: id mancante, assegnato «${id}»`);
    }
    seenHw.add(id);
    let qty = h.qty;
    if (qty != null && !posInt(qty)) { note(`ferramenta ${id}: quantità ${qty} non valida, tolta`); qty = null; }
    return { id, name: str(h.name), spec: str(h.spec), qty, image_id: fixImage(h.image_id, `ferramenta ${id}`) };
  });

  // --- componenti
  const seenCodes = new Set();
  m.components = (m.components || []).map((c, i) => {
    const code = str(c.code);
    if (!code) note(`componente n. ${i + 1} («${str(c.name)}») senza sigla`);
    else if (seenCodes.has(code)) note(`sigla componente «${code}» ripetuta`);
    seenCodes.add(code);
    let qty = c.qty;
    if (qty != null && !posInt(qty)) { note(`componente ${code}: quantità ${qty} non valida, tolta`); qty = null; }
    return { code, name: str(c.name), qty, image_id: fixImage(c.image_id, `componente ${code || i + 1}`) };
  });
  for (const h of m.hardware) if (seenCodes.has(h.id)) note(`la sigla «${h.id}» è usata sia per un componente sia per la ferramenta`);

  // --- risoluzione dei riferimenti `uses`
  const refs = new Map(); // normalizzato → sigla/id vero
  for (const c of m.components) if (c.code) refs.set(normRef(c.code), c.code);
  for (const h of m.hardware) if (!refs.has(normRef(h.id))) refs.set(normRef(h.id), h.id);
  const byName = new Map();
  for (const c of m.components) if (c.name && c.code) byName.set(c.name.toLowerCase(), c.code);
  for (const h of m.hardware) if (h.name) byName.set(h.name.toLowerCase(), h.id);
  const exact = new Set([...m.components.map((c) => c.code), ...m.hardware.map((h) => h.id)].filter(Boolean));
  const resolveRef = (r) => {
    const t = str(r);
    if (exact.has(t)) return t;
    return refs.get(normRef(t)) || byName.get(t.toLowerCase()) || null;
  };

  // --- passi: ordine dell'array, numerati 1..n
  const oldToNew = new Map();
  m.steps = (m.steps || []).map((s, i) => {
    const number = i + 1;
    if (!oldToNew.has(s.number)) oldToNew.set(s.number, number); // numeri doppi: vale il primo
    const where = `passo ${number}`;
    const image_ids = [];
    for (const id of s.image_ids || []) {
      const f = fixImage(id, where);
      if (f && !image_ids.includes(f)) image_ids.push(f);
    }
    const uses = [];
    for (const u of s.uses || []) {
      const ref = resolveRef(u.ref);
      if (!ref) {
        note(`${where}: riferimento «${str(u.ref)}» inesistente tra componenti e ferramenta, tolto dai pezzi usati`);
        m.changes = m.changes || [];
        m.changes.push({
          kind: 'incongruenza',
          description: `Passo ${number}: il riferimento «${str(u.ref)}» non corrisponde a nessun componente o ferramenta dell’elenco ed è stato tolto dai pezzi usati.`,
          needs_confirmation: true,
        });
        continue;
      }
      if (ref !== str(u.ref)) note(`${where}: riferimento «${str(u.ref)}» corretto in «${ref}»`);
      let qty = u.qty;
      if (qty != null && !posInt(qty)) { note(`${where}: quantità ${qty} per «${ref}» non valida, tolta`); qty = null; }
      const prev = uses.find((x) => x.ref === ref);
      if (prev) {
        prev.qty = prev.qty != null && qty != null ? prev.qty + qty : null;
        note(`${where}: «${ref}» elencato due volte, righe unite`);
      } else uses.push({ ref, qty });
    }
    const paragraphs = (s.paragraphs || []).map(str).filter(Boolean);
    const warning = str(s.warning) || null;
    return { number, title: str(s.title), paragraphs, image_ids, uses, warning };
  });
  if (m.steps.length && (oldToNew.size !== m.steps.length || [...oldToNew].some(([a, b]) => a !== b))) {
    note('passi rinumerati da 1 nell’ordine della scheda');
  }

  // --- fasi
  const nSteps = m.steps.length;
  const inPhase = new Set();
  m.phases = (m.phases || []).map((ph) => {
    const nums = [];
    for (const n of ph.step_numbers || []) {
      const mapped = oldToNew.has(n) ? oldToNew.get(n) : n;
      if (!Number.isInteger(mapped) || mapped < 1 || mapped > nSteps) { note(`fase «${str(ph.title)}»: passo ${n} inesistente, tolto`); continue; }
      if (inPhase.has(mapped)) { note(`fase «${str(ph.title)}»: passo ${mapped} già in un’altra fase, tolto`); continue; }
      inPhase.add(mapped);
      nums.push(mapped);
    }
    nums.sort((a, b) => a - b);
    return { title: str(ph.title), step_numbers: nums };
  }).filter((ph) => {
    if (!ph.step_numbers.length) { note(`fase «${ph.title}» senza passi validi, tolta`); return false; }
    return true;
  });

  // --- note
  m.notes = (m.notes || []).map((n, i) => ({
    label: str(n.label), title: str(n.title), text: str(n.text), image_id: fixImage(n.image_id, `nota ${i + 1}`),
  })).filter((n) => n.text || n.title);

  // --- immagini non usate: solo id validi, non usati altrove; aggiunte quelle dimenticate
  const used = new Set([m.cover_image_id, m.brand_logo_image_id,
    ...m.hardware.map((h) => h.image_id), ...m.components.map((c) => c.image_id),
    ...m.steps.flatMap((s) => s.image_ids), ...m.notes.map((n) => n.image_id)].filter(Boolean));
  const unused = [];
  for (const id of m.unused_image_ids || []) {
    const f = fixImage(id, 'immagini non usate');
    if (!f || unused.includes(f)) continue;
    if (used.has(f)) { note(`immagine ${f} indicata come non usata ma usata nella scheda: tolta dalle non usate`); continue; }
    unused.push(f);
  }
  if (known) {
    const forgotten = known.filter((id) => !used.has(id) && !unused.includes(id));
    if (forgotten.length) note(`immagini non citate aggiunte alle non usate: ${forgotten.join(', ')}`);
    unused.push(...forgotten);
    unused.sort((a, b) => known.indexOf(a) - known.indexOf(b));
  }
  m.unused_image_ids = unused;

  m.changes = (m.changes || []).map((c) => ({ kind: c.kind, description: str(c.description), needs_confirmation: !!c.needs_confirmation }))
    .filter((c) => c.description);

  return { manual: ManualData.parse(m), repairs };
}

// ------------------------------------------------------------------------------------- AnimationPlan

const round3 = (v) => Math.round(v * 1000) / 1000;

function unitVector(d) {
  if (!Array.isArray(d) || d.length !== 3 || !d.every((x) => Number.isFinite(x))) return null;
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-6) return null;
  return d.map((x) => round3(x / len) + 0); // +0: niente -0
}

/**
 * @param {object} input     AnimationPlan (già validato da zod)
 * @param {object[]} parts   PartsSummary
 * @param {object|null} manual  ManualData (per le sigle valide)
 * @param {{ upAxis?: 'y'|'z'|null }} [o]  asse verticale deciso dal caricatore del modello (model.meta.json)
 */
export function repairPlan(input, parts, manual, { upAxis = null } = {}) {
  const p = clone(input);
  const repairs = [];
  const warnings = [];
  const note = (s) => repairs.push(s);
  const keys = new Set((parts || []).map((x) => x.key));
  const validRefs = new Map();
  for (const c of manual?.components || []) if (c.code) validRefs.set(normRef(c.code), c.code);
  for (const h of manual?.hardware || []) if (h.id && !validRefs.has(normRef(h.id))) validRefs.set(normRef(h.id), h.id);

  p.version = 1;
  p.title = str(p.title) || str(manual?.short_name);
  p.subtitle = str(p.subtitle);
  p.final_caption_title = str(p.final_caption_title);
  p.final_caption_body = str(p.final_caption_body);
  if (upAxis === 'y' || upAxis === 'z') {
    if (p.up_axis_in_source !== upAxis) note(`asse verticale ${p.up_axis_in_source} → ${upAxis} (deciso dal caricatore del modello)`);
    p.up_axis_in_source = upAxis;
  }

  // --- ruoli
  const seenRole = new Set();
  p.parts = (p.parts || []).filter((r) => {
    const k = str(r.key);
    if (!keys.has(k)) { note(`ruolo per la parte «${k}» inesistente nel modello, tolto`); return false; }
    if (seenRole.has(k)) { note(`ruolo della parte «${k}» ripetuto, tenuto il primo`); return false; }
    seenRole.add(k);
    return true;
  }).map((r) => {
    const key = str(r.key);
    let ref = r.ref == null ? null : str(r.ref) || null;
    if (r.role === 'ignore') ref = null;
    else if (ref && validRefs.size) {
      const fixed = validRefs.get(normRef(ref));
      if (!fixed) { note(`parte ${key}: sigla «${ref}» inesistente nel manuale, tolta`); ref = null; }
      else if (fixed !== ref) { note(`parte ${key}: sigla «${ref}» corretta in «${fixed}»`); ref = fixed; }
    }
    return { key, role: r.role, ref };
  });
  const missingRole = [...keys].filter((k) => !seenRole.has(k));
  if (missingRole.length) warnings.push(`${missingRole.length} parti senza ruolo (trattate come componenti): ${missingRole.slice(0, 20).join(', ')}${missingRole.length > 20 ? '…' : ''}`);

  // --- passi e azioni
  const filterKeys = (list, where) => {
    const out = [];
    for (const k of list || []) {
      const t = str(k);
      if (!keys.has(t)) { note(`${where}: parte «${t}» inesistente, tolta`); continue; }
      if (!out.includes(t)) out.push(t);
    }
    return out;
  };
  const inserted = new Set();
  let steps = (p.steps || []).map((s) => {
    const where = `passo ${s.number}`;
    const actions = [];
    for (const a of s.actions || []) {
      const ak = filterKeys(a.keys, `${where}, ${a.type}`);
      const act = { type: a.type, keys: ak, direction: null, distance_factor: null, loose: null, axis: null, angle_deg: null };
      if (a.type === 'insert') {
        act.keys = ak.filter((k) => {
          if (inserted.has(k)) { note(`${where}: la parte ${k} era già stata inserita, tolta dal nuovo inserimento`); return false; }
          inserted.add(k);
          return true;
        });
        act.direction = unitVector(a.direction);
        if (a.direction != null && !act.direction) note(`${where}: direzione di inserimento non valida, uso quella automatica`);
        const df = a.distance_factor;
        if (df != null) {
          if (Number.isFinite(df) && df > 0) act.distance_factor = Math.min(30, Math.max(0.2, df));
          else note(`${where}: distanza di partenza ${df} non valida, uso quella predefinita`);
        }
      } else if (a.type === 'fasten') {
        act.loose = typeof a.loose === 'boolean' ? a.loose : null;
      } else if (a.type === 'flip') {
        act.axis = a.axis === 'x' || a.axis === 'y' || a.axis === 'z' ? a.axis : 'x';
        if (a.axis !== act.axis) note(`${where}: asse del ribaltamento mancante, uso «x»`);
        act.angle_deg = Number.isFinite(a.angle_deg) && a.angle_deg !== 0 ? a.angle_deg : 180;
        if (a.angle_deg !== act.angle_deg) note(`${where}: angolo del ribaltamento mancante, uso 180°`);
      }
      if (act.type !== 'flip' && !act.keys.length) { note(`${where}: azione «${a.type}» senza parti valide, tolta`); continue; }
      actions.push(act);
    }
    return {
      number: Number.isInteger(s.number) ? s.number : 0,
      caption_title: str(s.caption_title),
      caption_body: str(s.caption_body),
      actions,
      closeup_keys: filterKeys(s.closeup_keys, `${where}, primo piano`),
    };
  });
  // l'eventuale passo 0 (introduzione) va per primo
  const intro = steps.filter((s) => s.number === 0);
  if (intro.length > 1) note('più passi 0: tenuto il primo');
  if (intro.length && steps[0] !== intro[0]) note('passo 0 spostato all’inizio');
  steps = [...intro.slice(0, 1), ...steps.filter((s) => s.number !== 0)];
  p.steps = steps;

  // --- avvisi (non riparabili qui)
  const animated = new Set(steps.filter((s) => s.number !== 0).flatMap((s) => s.actions.flatMap((a) => a.keys)));
  const roleOf = new Map(p.parts.map((r) => [r.key, r.role]));
  const still = [...keys].filter((k) => roleOf.get(k) !== 'ignore' && !animated.has(k));
  if (still.length) warnings.push(`${still.length} parti non animate in nessun passo (saranno già montate dall’inizio): ${still.slice(0, 20).join(', ')}${still.length > 20 ? '…' : ''}`);
  if (manual?.steps?.length) {
    const planNums = new Set(steps.map((s) => s.number));
    const missing = manual.steps.map((s) => s.number).filter((n) => !planNums.has(n));
    if (missing.length) warnings.push(`passi del manuale senza animazione: ${missing.join(', ')}`);
  }
  for (const s of steps) if (s.caption_title.length > 70) warnings.push(`passo ${s.number}: didascalia lunga (${s.caption_title.length} caratteri)`);

  return { plan: AnimationPlan.parse(p), repairs, warnings };
}
