# Strumento manuali – architettura e contratti

Applicazione web locale (Node ≥ 22.13 — richiesto da pdfjs-dist 6.5 —, ESM, JavaScript senza build) che:
1. riceve un manuale di montaggio **PDF o Word (.docx)** e, facoltativo, un **modello 3D**;
2. estrae testo e immagini, poi con **Claude** (API Anthropic) ricava una scheda strutturata (`ManualData`);
3. mostra la scheda in una pagina di **revisione** modificabile;
4. genera un **PDF impaginato** professionale (stile del manuale "Tavolo Levante" in `../manuale-tavolo-levante/`);
5. genera un **video di montaggio**: 3D se c'è il modello (piano dell'animazione scritto da Claude), altrimenti
   "video con immagini" (le figure del manuale animate con didascalie).

Contratti dati: **`src/schema.js`** (zod) — `ManualData`, `AnimationPlan`; `ImageCatalog` e `PartsSummary` descritti lì.
Fixture di riferimento (scritta a mano, NON output di Claude): `test/fixtures/tavolo-levante/manual.json` + PDF originale.

## Cartelle

```
server.js                 server Express: interfaccia + API + esecuzione dei lavori
avvia-windows.bat, avvia-mac.command, avvia-linux.sh   avvio per l'utente: controllo di Node ≥ 22.13, npm install e
                          Chromium di Playwright la prima volta, poi node server.js (apre il browser)
Dockerfile                immagine facoltativa (node:22-bookworm-slim + Chromium; HOST=0.0.0.0, porta 3210)
src/schema.js             contratti dati (zod)
src/jobs.js               archivio lavori su disco + eventi di avanzamento
src/settings.js           impostazioni locali (config/settings.json: chiave API, modello, tema)
src/ingest/               lettura documenti: pdf.js (PDF), mammoth (DOCX), sharp (immagini)
src/ai/                   chiamate a Claude: client, estrazione ManualData, piano animazione
src/pdf/                  modello HTML/CSS del manuale + impaginazione automatica + stampa PDF (Playwright)
src/video/                import modelli 3D (occt-import-js per STEP/IGES), motore three.js, render (Playwright + ffmpeg-static)
public/                   interfaccia web (HTML/CSS/JS senza framework)
assets/fonts/             Barlow (OFL) — usato da PDF, video e interfaccia
test/                     test automatici e fixture
lavori/                   (git-ignored) un lavoro per cartella
config/settings.json      (git-ignored) chiave API e preferenze
```

## Cartella di un lavoro: `lavori/<id>/`

```
job.json                  stato (vedi sotto)
input/<documento>         file caricato (pdf o docx)
modello/<file 3D>         facoltativo (step, stp, iges, igs, glb, gltf, obj, stl)
estratte/img_XX.png       immagini estratte così come sono + catalog.json (ImageCatalog)
estratte/text.json        testo per pagina (PDF) o HTML (DOCX)
immagini/final/<id>.png   immagini pronte per stampa (rifilate, sfondo bianco, ingrandite se piccole)
immagini/thumb/<id>.jpg   miniature (lato lungo ≤ 360 px) per l'interfaccia
manual.ai.json            ManualData come restituito da Claude (non modificato)
manual.json               ManualData corrente (modificato dall'utente nella revisione)
model.glb + parts.json    modello normalizzato (Y in alto, mm, a terra, centrato) + PartsSummary
plan.json                 AnimationPlan (video 3D)
out/manuale.pdf           PDF generato
out/video.mp4, out/poster.jpg
log.txt                   registro testuale
```

`job.json`:
```json
{ "id": "20261124-153012-tavolo-levante", "name": "Tavolo Levante", "created_at": "ISO",
  "input_file": "input/TAVOLO_LEVANTE.pdf", "model_file": null,
  "status": "nuovo|estrazione|analisi|revisione|pdf|pdf_pronto|video|completato|errore",
  "progress": { "stage": "analisi", "pct": 40, "message": "Claude sta leggendo il documento…" },
  "error": null,
  "outputs": { "pdf": null, "video": null, "poster": null },
  "video_mode": null }
```

Significato di `status` (scritto solo da `server.js`; l’interfaccia lo legge insieme a `task`, `progress` ed `error`):

| status | quando |
|---|---|
| `nuovo` | lavoro appena creato, per un istante (poi l’analisi va subito in coda) |
| `estrazione` | analisi in coda (`progress.queued: true`) o in lettura del documento/immagini |
| `analisi` | Claude (o la scheda di prova) sta preparando `manual.json` |
| `revisione` | scheda pronta, nessun PDF né video ancora |
| `pdf` / `video` | creazione del PDF / del video in coda (`progress.queued: true`) o in corso |
| `pdf_pronto` | c’è il PDF, non ancora il video |
| `completato` | c’è il video (il PDF può mancare: l’interfaccia mostra allora «Video pronto») |
| `errore` | l’ultima operazione principale non è riuscita, è stata annullata senza uno stato precedente a cui tornare, o il programma è stato chiuso a metà (`error.code: 'interrupted'`). I risultati precedenti (`outputs`) restano validi e visibili; «Riprova» ripete `error.task` con `error.params` |

La lettura del modello 3D in sottofondo non cambia `status`: ha il suo stato in `model3d.status`.
Annullando un’operazione in corso, `status` torna a `completato`/`pdf_pronto`/`revisione` secondo i file esistenti.

Campi aggiuntivi scritti da `server.js`/`src/jobs.js` (tutti facoltativi per chi legge):
- `input_name` (nome originale del file caricato, solo da mostrare), `input_kind` (`pdf`|`docx`), `model_name`;
- `task` (operazione principale in corso o in coda: `analisi`|`pdf`|`video`) e `task_params`;
- `progress` = `{ stage, pct, message, queued, started_at, eta_s, cancelling? }` oppure `null` a riposo
  (`stage`: `estrazione`|`immagini`|`analisi`|`pdf`|`modello`|`piano`|`render`; `eta_s` solo durante il rendering del video);
- `error` = `{ task, message, code, params, at }` oppure `null` (`code: 'interrupted'` se il programma è stato chiuso a metà);
- `outputs.pdf_at`, `outputs.pdf_pages`, `outputs.video_at`, `video_quality`, `video_duration`;
- `warnings` = `{ ingest:[], images:[], pdf:[], video:[], model:[] }` (avvisi da mostrare all’utente);
- `cost` = `{ usd, text, calls, approx, items:[{label, usd, text}] }` dalla somma di `ai-usage.json` (null in modalità test);
- `test_mode`, `analysed_at`, `manual_saved_at`, `thumb` (id immagine per la miniatura), `review.verified` (indici delle
  `changes` con «ho verificato»), `scanned` (PDF senza testo, letto come immagini: da `ingestDocument`);
- `model3d` = `{ status:'nessuno'|'in_coda'|'importazione'|'pronto'|'errore', pct, message, error, file, up_axis_requested,
  up_axis, up_axis_reason, part_count, group_count, size_text, views:[{key,label,name}], imported_at, plan_sig }`
  (`plan_sig` = firma di scheda+modello dell’ultimo `plan.json`: se non cambia, il piano si riusa senza chiamare Claude).

Le operazioni pesanti passano da **una sola coda sequenziale** in `server.js`: `analisi` (ingestDocument + prepareImages +
extractManual), `pdf` (generatePdf), `video` (3D: importModel se serve + renderPartViews + planAnimation se serve, poi
renderVideo) e `modello` (importModel + renderPartViews in sottofondo, a priorità più bassa delle azioni dell’utente).
All’avvio i lavori rimasti "in corso" passano a `errore` con «Riprova».

## Interfacce dei moduli (tutte `async`, ESM)

`onProgress(pct: 0-100, message: string)` è sempre facoltativo. Messaggi per l'utente in **italiano**.

| Modulo | Funzione | Note |
|---|---|---|
| `src/ingest/index.js` | `ingestDocument(jobDir, inputPath, onProgress) → { kind:'pdf'\|'docx', catalog, pages:[{page, text}], html:string\|null, pdfPath:string\|null, warnings:string[], scanned:boolean }` | scrive `estratte/` e `catalog.json`; per DOCX `pdfPath` è null e `html` contiene il testo con segnaposto `[[img_XX]]` nell'ordine del documento |
| `src/ingest/images.js` | `prepareImages(jobDir, catalog, onProgress) → { prepared, warnings }` | scrive `immagini/final` e `immagini/thumb` |
| `src/ai/client.js` | `callStructured({ system, content, schema, maxTokens, effort, onProgress }) → parsed` | streaming, fallback lato server, gestione refusal/max_tokens/errori con messaggi italiani |
| `src/ai/extract.js` | `extractManual(jobDir, ingestResult, onProgress) → ManualData` | scrive `manual.ai.json` e `manual.json`; valida con zod e ripara riferimenti a immagini inesistenti |
| `src/ai/animate.js` | `planAnimation(jobDir, manual, parts, onProgress, { views, signal }?) → AnimationPlan` | scrive `plan.json`; `views` = viste delle parti da allegare |
| `src/pdf/generate.js` | `generatePdf(jobDir, manual, { outPath, theme, onProgress }) → outPath` | usa `immagini/final/*`; impaginazione automatica nel browser; scrive `pdf-build/layout.json` (pagine + `warnings`) |
| `src/video/model3d.js` | `importModel(jobDir, modelPath, onProgress, { upAxis:'auto'\|'y'\|'z' }?) → { glbPath, parts, meta }` | scrive `model.glb`, `parts.json`, `model.meta.json` |
| `src/video/model3d.js` | `renderPartViews(jobDir, parts, { max: 24, theme }) → [{ key, label, file, path, keys }]` | immagini PNG (vista d'insieme + ogni gruppo di parti evidenziato) da dare a Claude per riconoscere i pezzi |
| `src/video/render.js` | `renderVideo(jobDir, { mode:'3d'\|'immagini', manual, plan, glbPath, quality:'1080p'\|'720p'\|'anteprima', theme, onProgress, signal }) → { videoPath, posterPath, duration, warnings, … }` | Playwright + three.js + ffmpeg-static (`src/video/index.js` riesporta tutto) |
| `src/jobs.js` | `createJob({name,inputName})`, `listJobs()`, `getJob(id)`, `updateJob(id, patch\|fn, {lazy})`, `deleteJob(id)`, `appendLog(id,msg)`, `jobDir(id)`, `jobPath(id,...seg)`, `markInterrupted()`, `events` (EventEmitter: `'update'` con job, `'deleted'` con id) | id = `AAAAMMGG-hhmmss-slug`; `jobPath` rifiuta segmenti che escono dalla cartella |
| `src/settings.js` | `getSettings()`, `saveSettings(partial)`, `getApiKey()` | chiave da `config/settings.json` o `ANTHROPIC_API_KEY` |

`theme` (default in `src/settings.js`): `{ accent:'#FF7E00', accentInk:'#B45700', beige:'#DBD3CB', beigeSoft:'#F2EEE9', ink:'#1F1C1A', text:'#3B3632', muted:'#766D66', line:'#E4DED7' }`.

## API HTTP (server.js)

```
GET  /                                  interfaccia (public/, hash router: #/, #/impostazioni, #/lavoro/<id>/<passo>)
GET  /fonts/*                           assets/fonts (Barlow)
GET  /api/health                        { ok, app:'strumento-manuali', version, testMode:{ai,plan} }
GET  /api/settings                      { hasApiKey, apiKeyHint:"sk-ant-…abcd", apiKeySource, model, theme, defaultModel, defaultTheme, testMode }
POST /api/settings  (anche PUT)         { apiKey?, model?, theme? } (null = cancella/predefinito); 400 con messaggio italiano
GET  /api/events                        SSE con il riepilogo di ogni lavoro aggiornato (+ event: deleted)
GET  /api/jobs                          elenco (riepiloghi)
POST /api/jobs                          multipart: documento (obbligatorio, .pdf/.docx ≤ 100 MB), modello3d (facoltativo, ≤ 300 MB),
                                        upAxis? → 201 { id, job }; mette in coda l'analisi (+ lettura del modello in sottofondo)
GET  /api/jobs/:id                      job.json (+ queue: { main, model } con stato in_corso/in_coda)
PATCH /api/jobs/:id                     { review:{ verified:[indici] }?, name? }
DELETE /api/jobs/:id                    annulla le operazioni del lavoro e cancella la cartella
GET  /api/jobs/:id/events               Server-Sent Events con job.json a ogni aggiornamento (+ event: deleted)
GET  /api/jobs/:id/catalog              ImageCatalog
GET  /api/jobs/:id/image/:imgId         immagini/final (?thumb=1 per la miniatura); imgId = img_NN
GET  /api/jobs/:id/document             documento originale (PDF in linea per l'<iframe>; DOCX come download; ?download=1)
GET  /api/jobs/:id/document/preview     HTML del testo estratto con le immagini al loro posto (DOCX), CSP restrittiva
GET  /api/jobs/:id/manual               manual.json
PUT  /api/jobs/:id/manual               salva (validato con zod) → { ok, manual, warnings:[…] };
                                        400 → { error, issues:[{ path:'steps.0.title', label:'Passo 1 › Titolo', message }] }
POST /api/jobs/:id/reanalyze            ripete l'analisi con Claude
POST /api/jobs/:id/pdf                  genera il PDF (202; 409 se c'è già un'operazione per il lavoro)
POST /api/jobs/:id/model                multipart modello3d (+ upAxis 'auto'|'y'|'z'): sostituisce il modello e lo rilegge
POST /api/jobs/:id/model/reimport       { upAxis:'auto'|'y'|'z' } rilegge il modello già caricato ("il modello è capovolto?")
DELETE /api/jobs/:id/model              toglie il modello 3D
GET  /api/jobs/:id/views/:name          viste delle parti (viste_parti/*.png)
POST /api/jobs/:id/video                { mode:'3d'|'immagini', quality:'1080p'|'720p'|'anteprima', replan? } → piano (se 3d) + render
POST /api/jobs/:id/retry                ripete l'operazione fallita (job.error) con gli stessi parametri; { what:'modello' } per il modello
POST /api/jobs/:id/cancel               annulla l'operazione in corso o in coda ({ what:'modello' } per la lettura del modello)
GET  /api/jobs/:id/files/:name          manuale.pdf | video.mp4 | poster.jpg — in linea, o download con ?download=1
                                        (Istruzioni_Montaggio_<short_name>.pdf, Montaggio_<short_name>.mp4)
GET  /api/jobs/:id/log                  log.txt (?download=1)
```

Sicurezza: il server ascolta su 127.0.0.1 (variabile `HOST` per cambiarlo, es. Docker); id dei lavori, nomi dei file e id
delle immagini passano da whitelist (niente path traversal); le richieste che modificano qualcosa con `Origin`/`Sec-Fetch-Site`
di un altro sito sono rifiutate (403); la chiave API non lascia mai il server.

## Regole comuni
- Testi per l'utente in italiano; apostrofi tipografici (’), "×" nelle misure, virgola decimale.
- Mai inventare contenuti tecnici: ciò che Claude aggiunge o corregge finisce in `changes`.
- Nessun segreto nei log; la chiave API non lascia mai il server (non va al browser).
- Playwright è fissato a 1.63.0 (i browser si installano con `npx playwright install chromium`).

## Modalità di test (senza chiamare Claude)
- `MANUALI_AI_FIXTURE=/percorso/manual.json` → `extractManual` non chiama l'API e usa quel file (scritto nel log come MODALITÀ TEST).
- `MANUALI_PLAN_FIXTURE=/percorso/plan.json` → `planAnimation` idem.
- `quality:'anteprima'` = 960×540 a 15 fps, per test veloci (scelta anche dall'interfaccia: «Anteprima veloce»).
- `MANUALI_JOBS_DIR` / `MANUALI_CONFIG_DIR` spostano le cartelle dei lavori e delle impostazioni (test); `NO_BROWSER=1` non apre
  il browser all'avvio; `PORT` (3210) e `HOST` (127.0.0.1).
- `MANUALI_TEST_DIR=/cartella` raccoglie le cartelle di lavoro di tutti i test (`server/`, `video/`, …; predefinita: la cartella
  temporanea di sistema).
- `node test/run-all.js` (= `npm test`) esegue in fila tutti i `test/test-*.js` con un riepilogo; `test/test-server.js` prova
  l'intera catena via HTTP in modalità test (caricamento, SSE, revisione, PDF, video con immagini e 3D, annullamento,
  ripresa dopo la chiusura, path traversal).
- `ANTHROPIC_BASE_URL` (letta dall'SDK) permette di puntare a un server finto nei test di `src/ai`.
