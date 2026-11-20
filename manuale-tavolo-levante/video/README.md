# Video di montaggio — Tavolo Levante

Animazione 3D (MP4, 1920×1080, 30 fps, didascalie in italiano) che mostra il montaggio del
Tavolo Levante **nello stesso ordine del manuale cartaceo**. Il modello 3D attuale è
**parametrico e approssimato**, ricostruito dai render del manuale: quando arriverà il CAD
reale basterà sostituirlo (vedi [Sostituire il modello](#sostituire-il-modello-con-il-cad-reale)),
senza toccare la timeline.

Output finale: `montaggio-tavolo-levante.mp4` (in questa cartella, ~96,5 s) e `poster.jpg`
(fotogramma del titolo con il tavolo finito).

## Come funziona

- `src/index.html` carica una scena three.js (WebGL) con sopra un overlay HTML (didascalie,
  etichette, cartello finale) nello stile del manuale: palette `#1F1C1A` / `#DBD3CB` /
  `#F6F3EF` / arancio `#FF7E00`, font Barlow (da `../assets/fonts`).
- La pagina espone `window.renderAt(t)`: posiziona parti, camera e overlay per l'istante `t`
  (secondi) e disegna in modo **sincrono e deterministico** (niente orologio, niente random).
- `render.mjs` avvia un piccolo server locale, apre la pagina in Chromium (Playwright),
  chiama `renderAt(i / fps)` per ogni fotogramma, cattura il viewport e invia i JPEG a ffmpeg
  (`libx264`, `yuv420p`, `crf 18`, `+faststart`).

## Requisiti

- Node.js ≥ 18, Playwright con Chromium (`require('playwright')` deve funzionare;
  in alternativa `npm i -D playwright && npx playwright install chromium`)
- ffmpeg (di default `/usr/bin/ffmpeg`, altrimenti `--ffmpeg <percorso>`)
- three.js è già copiato in `src/vendor/three/` (v0.170.0): **non serve `npm install`**.
  Per aggiornarlo: `npm install && npm run vendor`.

Nessuna GPU necessaria: funziona anche con WebGL software (SwiftShader).

## Comandi

```bash
node render.mjs                              # video finale 1920x1080 @ 30 fps
node render.mjs --workers 2                  # idem, 2 pagine in parallelo (~20% piu' veloce su 4 CPU)
node render.mjs --preview --out /tmp/p.mp4   # anteprima 960x540 @ 15 fps (stessa timeline)
node render.mjs --from 39.5 --to 51          # solo un intervallo (es. passo 4)
node render.mjs --stills 12,33.6 --stills-dir /tmp/st   # singoli fotogrammi PNG
node render.mjs --poster                     # poster.jpg 1920x1080 (t = 2,4 s; oppure --poster 86)
node render.mjs --crf 20                     # qualita' x264 diversa (default 18)
node render.mjs --serve                      # anteprima interattiva: http://127.0.0.1:8123/video/src/index.html
tools/keyframes.sh video.mp4 /tmp/keyframes 2 6         # un fotogramma ogni 2 s + provino a griglia
```

Tempi indicativi (4 CPU, nessuna GPU): anteprima ~75 ms/fotogramma (≈2 min in tutto);
1080p ~245 ms/fotogramma con 1 worker, ~210 ms con 2 worker (≈10–12 min per 96,5 s di video).
I fotogrammi di dissolvenza tra due inquadrature costano il doppio (la scena viene disegnata due volte).

Nell'anteprima interattiva: spazio = pausa, frecce = ±2 s, `?t=42` per partire da un istante.
Per verifiche automatiche la pagina espone anche `window.__debug = { scene, rig, camera }`
(es. controllare che nessuna parte scenda sotto il pavimento durante i ribaltamenti).

## Struttura

| File | Ruolo |
|---|---|
| `src/timeline.js` | **unica tabella dei tempi**: passi, didascalie, tracce delle parti, camera, etichette |
| `src/parts.js` | modello parametrico (punto di sostituzione): parti con nome in posizione di montaggio |
| `src/cad-loader.js` | adattatore per il GLB del CAD reale (stessi nomi) |
| `src/rig.js` | perni, gruppi (capovolgimenti), opacità, evidenziazione arancio, contorni |
| `src/anim.js` | easing e interpolazione dei keyframe |
| `src/overlay.js`, `src/style.css`, `src/fonts.css` | didascalie e grafica 2D |
| `src/main.js` | scena, luci, ombre, camera, `window.renderAt(t)` |
| `render.mjs` | render fotogramma per fotogramma → ffmpeg |
| `tools/vendor-three.mjs` | copia i file di three.js necessari in `src/vendor/` |

## Timeline

Le durate sono in `STEP_TABLE` (`src/timeline.js`); gli inizi si calcolano sommando le durate,
quindi allungare un passo sposta automaticamente i successivi. Dentro ogni passo gli eventi
sono scritti come `at('s4', 2.4)` = 2,4 s dopo l'inizio del passo 4.

| Capitolo | Inizio – fine (s) | Didascalia / inquadrature |
|---|---|---|
| Titolo | 0,0 – 4,5 | Tavolo Levante — Istruzioni di montaggio |
| Componenti | 4,5 – 13,0 | Esploso con etichette F1, T1, T2, P1 + ferramenta (×10, ×10, ×6) |
| Passo 1 | 13,0 – 18,5 | Posizionare i due fianchi (F1) in maniera speculare |
| Passo 2 | 18,5 – 29,5 | Inserire i traversi superiori (T1) nelle asole — campo largo, primo piano asola (21,5), campo largo (25,3) |
| Passo 3 | 29,5 – 39,5 | Viti M8 con rondella, senza serrarle (restano fuori 11 mm) — primo piano viti, campo largo (34,5) |
| Passo 4 | 39,5 – 52,0 | T2 spinto fino in fondo, foro più interno, 1 vite per lato — campo largo, primo piano foro (45,2), campo largo (49,9) |
| Passo 5 | 52,0 – 59,5 | Serrare tutte le 10 viti — primo piano sul giunto del passo 3, campo largo (54,4) |
| Passo 6 | 59,5 – 69,5 | Struttura capovolta sul piano a doghe (P1) |
| Passo 7 | 69,5 – 79,5 | 6 viti da legno negli angolari — primo piano (img-013), campo largo (74,1) |
| Passo 8 | 79,5 – 83,5 | Capovolgere il tavolo |
| Fine | 83,5 – 91,5 | Montaggio completato (badge con spunta) + giro del tavolo |
| Cartello | 91,5 – 96,5 | Loghi Ramberti group su `#DBD3CB` |

Tracce: ogni parte ha keyframe `{ t, p, r, o, s, h, hb, ease }` (spostamento in mm rispetto
alla posizione di montaggio, rotazione attorno al centro della parte, opacità, rotazione di
avvitamento attorno a `userData.axis`, evidenziazione arancio, evidenziazione dei soli
angolari). I gruppi `STRUCT`, `TOP`, `ASSEMBLY` servono per i capovolgimenti (passi 6 e 8).
Camera: keyframe `{ t, target, dist, az, el, fov, sx, sy, cut }` (orbita attorno al target;
`sx/sy` = decentramento ottico per lasciare spazio alle didascalie). Un keyframe con
`cut: true` apre una nuova **inquadratura**: stacco con dissolvenza incrociata di 0,4 s
(`cut: 0.6` = durata a scelta, `cut: 0` = stacco netto). Regola usata: tra campo largo e
primo piano sempre uno stacco; i movimenti continui restano lenti, così la camera non
"frusta" e non attraversa i tubi. La dissolvenza è vera (non un passaggio dal bianco):
`main.js` disegna l'inquadratura uscente, la copia nel canvas `#ghost` (che ha lo stesso
fondale CSS) e lo sfuma sopra quella entrante.

Nei primi piani (distanza camera < ~2 m) i contorni diventano più marcati (0,4 → 0,66), il
fondale si scurisce leggermente (`#dim`) e l'intestazione in alto si attenua, così
l'alluminio bianco resta leggibile sul fondo chiaro. L'evidenziazione arancio tinge il colore
di base dei materiali verso `#FFC25A` (tinta resa ~30°, come `#FF7E00`); i contorni della
parte evidenziata diventano `#FF7E00`.

## Sostituire il modello con il CAD reale

1. **STEP → GLB**, ad esempio con [cascadio](https://pypi.org/project/cascadio/) (OpenCASCADE):
   ```bash
   pip install cascadio
   python -c "import cascadio; cascadio.step_to_glb('tavolo_levante.step', 'tavolo.glb', 0.1, 0.5)"
   ```
   (tolleranza lineare 0,1 mm e angolare 0,5 rad; con `trimesh` installato si può anche usare
   `trimesh.load('tavolo_levante.step')` + `scene.export('tavolo.glb')`).
2. **Nomi dei nodi** (rinominare per esempio in Blender → Outliner, poi *Esporta glTF binario*,
   +Y in alto). Il tavolo deve essere **assemblato**, con la lunghezza lungo X
   (altrimenti `--cad-rot-y 90`). Metri o millimetri vengono riconosciuti da soli; l'origine
   viene normalizzata (centro in X/Z, appoggio a terra).

   | Nome | Parte |
   |---|---|
   | `F1_L`, `F1_R` | fianco sinistro (x<0) e destro (x>0) |
   | `T1_A`, `T1_B` | traverso superiore anteriore (z>0, verso la camera) e posteriore |
   | `T2` | traverso inferiore |
   | `P1` | piano a doghe con listelli |
   | `M8_01…M8_10`, `W_01…W_10` | viti M8 e rondelle: 01–02 F1_L/T1_A, 03–04 F1_L/T1_B, 05–06 F1_R/T1_A, 07–08 F1_R/T1_B, 09 T2 lato L, 10 T2 lato R |
   | `WS_1…WS_6` | viti da legno: 1–3 su T1_B (x = −, 0, +), 4–6 su T1_A |

   Per la minuteria l'asse **+Y locale** del nodo deve puntare dentro il materiale
   (direzione di avvitamento). I nodi mancanti (tipicamente la minuteria) vengono presi dal
   modello parametrico, quindi basta anche il GLB con le sole 6 parti principali.
3. Copiare il file dentro `manuale-tavolo-levante/` (es. `video/models/tavolo.glb`) e lanciare
   `node render.mjs --cad models/tavolo.glb` (anteprima: `...index.html?cad=/video/models/tavolo.glb`).
   Con `?cadMaterials=keep` si mantengono i materiali del CAD invece della palette del video.
4. Da ricontrollare dopo la sostituzione (sono quote, non tempi): i punti `JOINTS` in
   `parts.js` — la timeline li riceve (`buildTimeline({ axes, joints })`) e li usa come target
   dei primi piani (asola T1, viti M8 01–02, foro interno di T2, angolare + vite WS_1) e come
   ancore delle etichette; le costanti del passo 4 in `timeline.js` (lunghezza di T2 e quote
   dell'inserimento inclinato), la corsa "senza serrarle" `LOOSE` (11 mm), gli scostamenti
   dell'esploso. Conviene poi rigenerare qualche fotogramma dei primi piani
   (`--stills 23,33.5,47.8,72.5`) per verificare che nessun tubo copra le viti.

Il percorso è stato provato esportando il modello parametrico come GLB (in metri, con origine
spostata) e rieseguendo la stessa timeline.

## Limiti noti

- Geometria approssimata dai render: tubi senza raggiature, asole e fori sono decalcomanie
  scure (non forature reali), rivetti e filettature M8 non modellati.
- Quote interpretate: T1 (80 mm) arriva 3 mm sotto le doghe (nessuna fessura sotto il piano,
  come img-000/012/013); la gamba orizzontale degli angolari è al livello del fondo dei
  listelli (698 mm), ~24 mm sotto il bordo di T1 (come img-009/010); i 2 fori M8 di ogni
  estremità di T1 sono a 668 mm, nella fascia sotto lo spigolo del fianco (come img-010).
- Per infilare i T1 il fianco destro viene posato 240 mm più esterno e poi accostato (passo 2);
  T2 entra inclinato prima nel fianco destro e poi scorre fino in fondo nel sinistro (passo 4):
  è un'interpretazione plausibile del manuale, da verificare con il produttore.
- Niente occlusione ambientale in screen-space (troppo lenta in WebGL software): solo ombre
  morbide su pavimento invisibile, luce d'ambiente e contorni sottili.
- Le linee dei contorni WebGL sono larghe 1 px: a 960×540 risultano relativamente più marcate.
