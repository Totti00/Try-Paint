// Chiamate al server locale (stessa origine).

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function parse(res) {
  let data = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try { data = await res.json(); } catch { data = null; }
  } else {
    try { data = { error: (await res.text()).slice(0, 400) }; } catch { data = null; }
  }
  if (!res.ok) {
    const msg = data?.error || (res.status === 404 ? 'Non trovato.' : `Errore del server (${res.status}).`);
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Non riesco a contattare lo strumento: controlla che la finestra del programma sia ancora aperta.', 0);
  }
  return parse(res);
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body) => api('PUT', url, body);
export const patch = (url, body) => api('PATCH', url, body);
export const del = (url) => api('DELETE', url);

/**
 * Caricamento multipart con avanzamento (XMLHttpRequest: fetch non riporta l'avanzamento dell'invio).
 * @param {(fraction:number)=>void} onProgress
 */
export function upload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      const data = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `Caricamento non riuscito (${xhr.status}).`, xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError('Caricamento interrotto: controlla che lo strumento sia ancora aperto e riprova.', 0));
    xhr.send(formData);
  });
}

/**
 * Aggiornamenti in tempo reale (Server-Sent Events). Restituisce una funzione per chiudere.
 *
 * Il browser concede solo 6 connessioni contemporanee allo stesso indirizzo: con un flusso sempre aperto per
 * scheda, alla sesta scheda dello strumento tutte le richieste resterebbero in attesa. Per questo il flusso si
 * chiude quando la scheda non è visibile (o viene lasciata) e si riapre quando torna in primo piano; alla
 * riapertura onReopen() permette di rileggere lo stato (i messaggi persi nel frattempo non arrivano più).
 * @param {{ onDeleted?: (data:object)=>void, onReopen?: ()=>void }} [opts]
 */
export function subscribe(url, onData, { onDeleted, onReopen } = {}) {
  let es = null;
  let closed = false;
  let opened = false;
  const open = () => {
    if (closed || es) return;
    es = new EventSource(url);
    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; /* messaggio non valido */ }
      try { onData(data); } catch (err) { console.error(err); }
    };
    es.addEventListener('deleted', (e) => {
      if (onDeleted) { try { onDeleted(JSON.parse(e.data || '{}')); } catch { onDeleted({}); } }
    });
    // aperto dopo una pausa (o dopo un avvio con la scheda nascosta): lo stato va riletto
    if (opened && onReopen) { try { onReopen(); } catch (err) { console.error(err); } }
  };
  const pause = () => { if (es) { es.close(); es = null; } };
  const onVisibility = () => { if (document.visibilityState === 'hidden') pause(); else open(); };
  const onPageHide = () => pause();
  const onPageShow = () => { if (document.visibilityState !== 'hidden') open(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  if (document.visibilityState !== 'hidden') open();
  opened = true;
  return () => {
    closed = true;
    pause();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  };
}
