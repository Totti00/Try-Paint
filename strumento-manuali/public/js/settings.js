// Impostazioni: chiave API di Claude (mai mostrata per intero), modello, colori del manuale e del video.
import { h, replace, icon, toast, notice, confirmDialog } from './ui.js';
import { post } from './api.js';
import { state, refreshSettings } from './app.js';

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
/** colore per i testi in evidenza (più scuro dell'accento, leggibile su bianco) */
const darken = (hex, f = 0.7) => rgbToHex(hexToRgb(hex).map((v) => v * f));
/** fondo chiaro derivato dal beige */
const lighten = (hex, t = 0.62) => rgbToHex(hexToRgb(hex).map((v) => v + (255 - v) * t));

export async function renderSettings(root) {
  const s = (await refreshSettings()) || {};
  const defaults = s.defaultTheme || { accent: '#FF7E00', beige: '#DBD3CB' };

  // ---------------------------------------------------------------- chiave API
  const keyStatus = h('div');
  const keyInput = h('input', { class: 'input', type: 'password', id: 'api-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-ant-…', 'aria-describedby': 'api-key-hint' });
  const toggleBtn = h('button', { class: 'btn btn-icon', type: 'button', title: 'Mostra/nascondi', 'aria-label': 'Mostra o nascondi la chiave' }, icon('eye', 18));
  toggleBtn.addEventListener('click', () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    replace(toggleBtn, icon(show ? 'eyeOff' : 'eye', 18));
  });
  const saveKeyBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salva la chiave');
  const removeKeyBtn = h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash', 18), 'Rimuovi la chiave');

  const renderKeyStatus = (st) => {
    replace(keyStatus);
    if (st.hasApiKey) {
      keyStatus.append(h('div', { class: 'key-status' }, h('span', { class: 'pill pill-ok' }, icon('check', 15), 'Chiave configurata'),
        h('code', st.apiKeyHint),
        st.apiKeySource === 'ambiente' ? h('span', { class: 'small muted' }, 'dalla variabile d’ambiente ANTHROPIC_API_KEY') : null));
    } else {
      keyStatus.append(h('div', { class: 'key-status' }, h('span', { class: 'pill pill-warn' }, icon('alert', 15), 'Nessuna chiave'),
        h('span', { class: 'small muted' }, st.testMode?.ai ? 'In modalità test non serve.' : 'Serve per analizzare i manuali con Claude.')));
    }
    removeKeyBtn.hidden = !(st.hasApiKey && st.apiKeySource === 'impostazioni');
  };
  renderKeyStatus(s);

  const keyForm = h('form', { class: 'mt-8', onsubmit: async (e) => {
    e.preventDefault();
    const v = keyInput.value.trim();
    if (!v) { toast('Incolla prima la chiave nel campo.', 'err'); keyInput.focus(); return; }
    saveKeyBtn.disabled = true;
    try {
      const ns = await post('/api/settings', { apiKey: v });
      state.settings = ns;
      keyInput.value = '';
      keyInput.type = 'password';
      renderKeyStatus(ns);
      await refreshSettings();
      toast('Chiave salvata.', 'ok');
    } catch (err) {
      toast(err.message, 'err', 8000);
    } finally {
      saveKeyBtn.disabled = false;
    }
  } },
  h('label', { class: 'field-label', for: 'api-key' }, s.hasApiKey ? 'Sostituisci la chiave' : 'Incolla qui la chiave'),
  h('div', { class: 'input-group' }, keyInput, toggleBtn, saveKeyBtn),
  h('span', { class: 'field-hint', id: 'api-key-hint' }, 'La chiave resta su questo computer (cartella config) e non viene mai mostrata per intero nel browser.'));

  removeKeyBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Rimuovere la chiave?', message: 'Senza chiave non si possono analizzare nuovi manuali con Claude. I lavori già fatti restano.', confirmLabel: 'Rimuovi', danger: true });
    if (!ok) return;
    try {
      const ns = await post('/api/settings', { apiKey: null });
      renderKeyStatus(ns);
      await refreshSettings();
      toast('Chiave rimossa.', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------------------------------------------------------------- modello
  const modelInput = h('input', { class: 'input', id: 'model', value: s.model || s.defaultModel || '', spellcheck: 'false', autocomplete: 'off' });
  const saveModel = async (value) => {
    try {
      const ns = await post('/api/settings', { model: value });
      modelInput.value = ns.model;
      toast(value ? 'Modello salvato.' : 'Ripristinato il modello consigliato.', 'ok');
    } catch (err) { toast(err.message, 'err', 7000); }
  };

  // ---------------------------------------------------------------- colori
  let theme = { ...(s.theme || defaults) };
  const preview = h('div', { class: 'theme-preview', 'aria-hidden': 'true' },
    h('div', { class: 'tp-side' }, '3'),
    h('div', { class: 'tp-main' },
      h('div', null, h('span', { class: 'tp-num' }, '3'), h('span', { class: 'tp-title' }, 'Avvitare le viti')),
      h('div', { class: 'tp-text' }, 'Procedere all’avvitatura delle viti con la rondella sottotesta, ', h('u', 'senza serrarle'), '.')));
  const applyPreview = () => {
    preview.style.setProperty('--tp-accent', theme.accent);
    preview.style.setProperty('--tp-beige', theme.beige);
  };
  applyPreview();
  const swatch = (key, label, hint) => {
    const code = h('code', theme[key]);
    const input = h('input', { type: 'color', value: theme[key], 'aria-label': label, oninput: () => {
      theme[key] = input.value.toUpperCase();
      code.textContent = theme[key];
      applyPreview();
    } });
    return { el: h('label', { class: 'swatch-field' }, input, h('div', null, h('div', { style: 'font-weight:700;color:var(--ink)' }, label), h('div', { class: 'tiny muted' }, hint), code)), input, code };
  };
  const swAccent = swatch('accent', 'Colore principale', 'numeri dei passi, evidenze');
  const swBeige = swatch('beige', 'Colore di fondo', 'fasce e riquadri');
  const saveTheme = async () => {
    try {
      const ns = await post('/api/settings', { theme: { accent: theme.accent, accentInk: darken(theme.accent), beige: theme.beige, beigeSoft: lighten(theme.beige) } });
      theme = { ...ns.theme };
      toast('Colori salvati: verranno usati per i prossimi PDF e video.', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  const resetTheme = async () => {
    try {
      const ns = await post('/api/settings', { theme: null });
      theme = { ...ns.theme };
      swAccent.input.value = theme.accent; swAccent.code.textContent = theme.accent;
      swBeige.input.value = theme.beige; swBeige.code.textContent = theme.beige;
      applyPreview();
      toast('Colori predefiniti ripristinati.', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  const page = h('div', { class: 'page page-narrow' },
    h('a', { class: 'back-link', href: '#/' }, icon('left', 18), 'Tutti i lavori'),
    h('h1', null, 'Impostazioni'),
    h('p', { class: 'muted mt-8' }, 'Queste impostazioni valgono per tutti i lavori.'),
    s.testMode?.ai ? notice('dark', 'Modalità test attiva', h('p', 'Lo strumento è stato avviato in modalità test: Claude non viene chiamato.')) : null,

    h('section', { class: 'card mt-24' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', 'Chiave API di Claude'), h('p', 'Serve per far leggere i manuali a Claude.'))),
      keyStatus,
      keyForm,
      h('div', { class: 'row mt-16' }, removeKeyBtn),
      h('div', { class: 'notice notice-accent mt-24' }, icon('info', 22), h('div', null,
        h('h3', 'Dove trovo la chiave?'),
        h('ol', { class: 'steps-list' },
          h('li', null, 'Apri ', h('a', { href: 'https://console.anthropic.com/', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), ' ed entra con il tuo account (o creane uno).'),
          h('li', null, 'Nel menu scegli ', h('b', 'API Keys'), ' e premi ', h('b', 'Create Key'), '.'),
          h('li', null, 'Copia la chiave (inizia con ', h('code', 'sk-ant-'), ') e incollala qui sopra.')),
        h('p', { class: 'mt-8' }, h('b', 'Costi: '), 'ogni analisi viene addebitata sull’account Anthropic della chiave (serve un credito prepagato, in ', h('b', 'Plans & Billing'), '). Indicativamente costa qualche euro per manuale; il costo stimato di ogni lavoro è indicato nella sua pagina.')))),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', 'Modello di Claude'), h('p', 'Di solito non serve cambiarlo.'))),
      h('label', { class: 'field-label', for: 'model' }, 'Nome del modello'),
      h('div', { class: 'input-group' }, modelInput,
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => saveModel(modelInput.value.trim()) }, 'Salva')),
      h('span', { class: 'field-hint' }, `Consigliato: ${s.defaultModel || 'claude-opus-5-5'}.`),
      h('button', { class: 'btn btn-sm mt-16', type: 'button', onclick: () => saveModel(null) }, icon('rotate', 16), 'Ripristina il consigliato')),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', 'Colori del manuale e del video'), h('p', 'Usati nel PDF impaginato e nelle didascalie del video.'))),
      h('div', { class: 'swatches' }, swAccent.el, swBeige.el),
      preview,
      h('div', { class: 'row mt-16' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: saveTheme }, 'Salva i colori'),
        h('button', { class: 'btn', type: 'button', onclick: resetTheme }, icon('rotate', 16), 'Ripristina i colori predefiniti'))));
  replace(root, page);
  return {};
}
