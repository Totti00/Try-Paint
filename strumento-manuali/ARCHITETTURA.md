# Strumento manuali – architettura e contratti

Applicazione web locale (Node ≥ 20, ESM, JavaScript senza build) che:
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

## Interfacce dei moduli (tutte `async`, ESM)

`onProgress(pct: 0-100, message: string)` è sempre facoltativo. Messaggi per l'utente in **italiano**.

| Modulo | Funzione | Note |
|---|---|---|
| `src/ingest/index.js` | `ingestDocument(jobDir, inputPath, onProgress) → { kind:'pdf'\|'docx', catalog, pages:[{page, text}], html:string\|null, pdfPath:string\|null }` | scrive `estratte/` e `catalog.json`; per DOCX `pdfPath` è null e `html` contiene il testo con segnaposto `[[img_XX]]` nell'ordine del documento |
| `src/ingest/images.js` | `prepareImages(jobDir, catalog, onProgress) → void` | scrive `immagini/final` e `immagini/thumb` |
| `src/ai/client.js` | `callStructured({ system, content, schema, maxTokens, effort, onProgress }) → parsed` | streaming, fallback lato server, gestione refusal/max_tokens/errori con messaggi italiani |
| `src/ai/extract.js` | `extractManual(jobDir, ingestResult, onProgress) → ManualData` | scrive `manual.ai.json` e `manual.json`; valida con zod e ripara riferimenti a immagini inesistenti |
| `src/ai/animate.js` | `planAnimation(jobDir, manual, parts, onProgress) → AnimationPlan` | scrive `plan.json` |
| `src/pdf/generate.js` | `generatePdf(jobDir, manual, { outPath, theme }) → outPath` | usa `immagini/final/*`; impaginazione automatica nel browser |
| `src/video/model3d.js` | `importModel(jobDir, modelPath, onProgress) → { glbPath, parts }` | scrive `model.glb`, `parts.json` |
| `src/video/model3d.js` | `renderPartViews(jobDir, parts, { max: 24 }) → [{ key, label, file }]` | immagini PNG (vista d'insieme + ogni gruppo di parti evidenziato) da dare a Claude per riconoscere i pezzi |
| `src/video/render.js` | `renderVideo(jobDir, { mode:'3d'\|'immagini', manual, plan, glbPath, quality:'1080p'\|'720p'\|'anteprima', theme, onProgress }) → { videoPath, posterPath }` | Playwright + three.js + ffmpeg-static |
| `src/jobs.js` | `createJob`, `listJobs`, `getJob`, `updateJob`, `jobDir`, `events` (EventEmitter: `'update'` con job) | |
| `src/settings.js` | `getSettings()`, `saveSettings(partial)`, `getApiKey()` | chiave da `config/settings.json` o `ANTHROPIC_API_KEY` |

`theme` (default in `src/settings.js`): `{ accent:'#FF7E00', accentInk:'#B45700', beige:'#DBD3CB', beigeSoft:'#F2EEE9', ink:'#1F1C1A', text:'#3B3632', muted:'#766D66', line:'#E4DED7' }`.

## API HTTP (server.js)

```
GET  /                                  interfaccia
GET  /api/settings                      { hasApiKey, apiKeyHint:"sk-ant-…abcd", model, theme }
POST /api/settings                      { apiKey?, model?, theme? }
GET  /api/jobs                          elenco
POST /api/jobs                          multipart: documento (obbligatorio), modello3d (facoltativo) → { id }; avvia estrazione+analisi
GET  /api/jobs/:id                      job.json
GET  /api/jobs/:id/events               Server-Sent Events con job.json a ogni aggiornamento
GET  /api/jobs/:id/catalog              ImageCatalog
GET  /api/jobs/:id/image/:imgId         immagini/final (?thumb=1 per la miniatura)
GET  /api/jobs/:id/manual               manual.json
PUT  /api/jobs/:id/manual               salva (validato con zod)
POST /api/jobs/:id/reanalyze            ripete l'analisi con Claude
POST /api/jobs/:id/pdf                  genera il PDF
POST /api/jobs/:id/model                multipart modello3d (anche dopo)
POST /api/jobs/:id/video                { mode:'3d'|'immagini', quality } → piano (se 3d) + render
GET  /api/jobs/:id/files/:name          out/manuale.pdf, out/video.mp4, out/poster.jpg (download)
DELETE /api/jobs/:id
```

## Regole comuni
- Testi per l'utente in italiano; apostrofi tipografici (’), "×" nelle misure, virgola decimale.
- Mai inventare contenuti tecnici: ciò che Claude aggiunge o corregge finisce in `changes`.
- Nessun segreto nei log; la chiave API non lascia mai il server (non va al browser).
- Playwright è fissato a 1.63.0 (i browser si installano con `npx playwright install chromium`).

## Modalità di test (senza chiamare Claude)
- `MANUALI_AI_FIXTURE=/percorso/manual.json` → `extractManual` non chiama l'API e usa quel file (scritto nel log come MODALITÀ TEST).
- `MANUALI_PLAN_FIXTURE=/percorso/plan.json` → `planAnimation` idem.
- `quality:'anteprima'` = 960×540 a 15 fps, per test veloci.
- `ANTHROPIC_BASE_URL` (letta dall'SDK) permette di puntare a un server finto nei test di `src/ai`.
