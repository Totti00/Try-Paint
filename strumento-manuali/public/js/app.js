// Avvio dell'interfaccia: instradamento per hash (#/, #/impostazioni, #/lavoro/<id>/<passo>).
import { h, replace, toast } from './ui.js';
import { get } from './api.js';
import { renderHome } from './home.js';
import { renderSettings } from './settings.js';
import { renderJob } from './job.js';

export const state = { settings: null };

let page = null;          // { cleanup(), update?(params), key }
let currentHash = null;
let leaveGuard = null;    // (hashDestinazione) => Promise<boolean>
let routeSeq = 0;         // ogni navigazione ha un numero: una pagina lenta superata da una più recente viene scartata

/**
 * La pagina corrente può chiedere conferma prima di essere lasciata (modifiche non salvate).
 * owner = elemento in cui la pagina si disegna: se non è più nel documento (pagina già lasciata) la richiesta è ignorata.
 */
export function setLeaveGuard(fn, owner = null) {
  if (owner && !owner.isConnected) return;
  leaveGuard = fn;
}

export function navigate(hash, { replace: rep = false } = {}) {
  if (location.hash === hash) return route();
  if (rep) { history.replaceState(null, '', hash); route(); } else location.hash = hash;
}

export async function refreshSettings() {
  try {
    state.settings = await get('/api/settings');
  } catch {
    state.settings = state.settings || null;
  }
  const dot = document.querySelector('.nav-dot');
  if (dot) dot.hidden = !(state.settings && !state.settings.hasApiKey && !state.settings.testMode?.ai);
  return state.settings;
}

function match(hash) {
  let m;
  if ((m = /^#\/impostazioni\/?$/.exec(hash))) return { key: 'impostazioni', render: renderSettings, params: {} };
  if ((m = /^#\/lavoro\/([a-z0-9-]{1,80})(?:\/(analisi|revisione|pdf|video))?\/?$/.exec(hash))) {
    return { key: `lavoro:${m[1]}`, render: renderJob, params: { id: m[1], step: m[2] || null } };
  }
  return { key: 'home', render: renderHome, params: {} };
}

async function route() {
  const hash = location.hash || '#/';
  if (hash === currentHash) return;
  if (leaveGuard && currentHash !== null) {
    const ok = await leaveGuard(hash);
    if (!ok) { history.replaceState(null, '', currentHash); return; }
  }
  currentHash = hash;
  const target = match(hash);
  document.querySelectorAll('.topnav a').forEach((a) => a.classList.toggle('active',
    (a.dataset.nav === 'impostazioni' && target.key === 'impostazioni') || (a.dataset.nav === 'home' && target.key !== 'impostazioni')));

  if (page && page.key === target.key && page.update) {
    page.update(target.params);
    return;
  }
  if (page && page.cleanup) { try { page.cleanup(); } catch { /* ignora */ } }
  page = null;
  leaveGuard = null;
  const seq = ++routeSeq;
  // Ogni pagina si disegna in un proprio contenitore: se nel frattempo l'utente è già andato altrove,
  // la pagina lenta scrive in un elemento staccato (invisibile) e viene chiusa subito.
  const root = document.getElementById('app');
  const view = h('div', { class: 'route-view', style: 'display:contents' });
  replace(root, view);
  window.scrollTo(0, 0);
  try {
    const p = (await target.render(view, target.params)) || {};
    if (seq !== routeSeq) { try { p.cleanup?.(); } catch { /* ignora */ } return; }
    page = { ...p, key: target.key };
  } catch (err) {
    if (seq !== routeSeq) return;
    console.error(err);
    replace(view, h('div', { class: 'page' }, h('div', { class: 'card' }, h('h2', 'Qualcosa non ha funzionato'), h('p', String(err?.message || err)),
      h('a', { class: 'btn', href: '#/' }, 'Torna ai lavori'))));
    page = { key: target.key };
  }
}

window.addEventListener('hashchange', () => route());
// «Vai al contenuto»: sposta il focus senza cambiare l'indirizzo (l'hash serve all'instradamento).
document.querySelector('.skip-link')?.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('app')?.focus(); });
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message;
  if (msg) toast(msg, 'err', 6000);
});

await refreshSettings();
route();
