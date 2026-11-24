// Contratti dati condivisi da tutto lo strumento (unica fonte di verità).
//
//  ImageCatalog  : prodotto dall'ingest (src/ingest) — immagini estratte dal documento.
//  ManualData    : prodotto da Claude (src/ai/extract.js), rivisto dall'utente nell'interfaccia,
//                  consumato dal generatore PDF (src/pdf) e dal video (src/video).
//  AnimationPlan : prodotto da Claude (src/ai/animate.js) per il video 3D, consumato dal motore video.
//
// Gli schemi sono scritti con zod v4 e rispettano i limiti degli "structured outputs" dell'API Claude:
// niente ricorsione, niente vincoli numerici/di lunghezza, ogni oggetto chiuso (additionalProperties:false,
// che zod genera per z.object), campi opzionali espressi come `nullable` (sempre presenti, valore null).

import * as z from 'zod';

// ---------------------------------------------------------------------------------------------
// ImageCatalog (nessuno schema zod: è prodotto dal nostro codice, non dal modello)
//
// [{ id: "img_00", page: 1, index: 0, width: 1000, height: 672,
//    file: "estratte/img_00.png",          // relativo alla cartella del lavoro
//    bbox: [x0, y0, x1, y1] | null,         // posizione sulla pagina in punti PDF (origine in alto a sinistra), se nota
//    duplicate_of: "img_04" | null }]       // stessa immagine già vista (stessi pixel)
// Gli id sono assegnati in ordine di apparizione (pagina, poi ordine di disegno): img_00, img_01, ...
// ---------------------------------------------------------------------------------------------

const imageId = z.string().describe('Id di una immagine del catalogo, es. "img_04"');
const nullableImageId = imageId.nullable();

export const ProductGroup = z.object({
  category: z.string().describe('Categoria al plurale, es. "Tavoli", "Panche". Stringa vuota se il documento non raggruppa.'),
  names: z.array(z.string()).describe('Nomi dei modelli, es. ["Levante","Libeccio"]'),
});

export const Hardware = z.object({
  id: z.string().describe('Id breve stabile: "H1", "H2", ...'),
  name: z.string().describe('Nome, es. "Vite inox M8×20"'),
  spec: z.string().describe('Specifica secondaria, es. "con flangia" o "17×2×8,1". Stringa vuota se assente.'),
  qty: z.number().int().nullable().describe('Quantità totale in confezione; null se il documento non la dice'),
  image_id: nullableImageId,
});

export const Component = z.object({
  code: z.string().describe('Sigla del componente come nel documento, es. "F1", "T1", "P1"'),
  name: z.string(),
  qty: z.number().int().nullable(),
  image_id: nullableImageId,
});

export const Use = z.object({
  ref: z.string().describe('Sigla di un componente (es. "T1") o id di ferramenta (es. "H1")'),
  qty: z.number().int().nullable().describe('Quantità usata in questo passo; null se non ricavabile con certezza'),
});

export const Step = z.object({
  number: z.number().int(),
  title: z.string().describe('Titolo breve imperativo (max ~6 parole) ricavato dal testo'),
  paragraphs: z.array(z.string()).describe('Testo del passo, fedele all\'originale. **parola** = enfasi (grassetto+sottolineato nell\'originale)'),
  image_ids: z.array(imageId).describe('Immagini che illustrano questo passo, in ordine'),
  uses: z.array(Use),
  warning: z.string().nullable().describe('Avvertenza da mettere in un riquadro, solo se il documento la giustifica'),
});

export const Phase = z.object({
  title: z.string().describe('Es. "Struttura in alluminio"'),
  step_numbers: z.array(z.number().int()),
});

export const Note = z.object({
  label: z.string().describe('Es. "N.B.", "Attenzione", "Manutenzione"'),
  title: z.string(),
  text: z.string(),
  image_id: nullableImageId,
});

export const Change = z.object({
  kind: z.enum(['correzione', 'uniformazione', 'aggiunta', 'incongruenza']),
  description: z.string().describe('Cosa è stato cambiato/aggiunto/rilevato, in italiano, con il testo prima → dopo se utile'),
  needs_confirmation: z.boolean().describe('true se serve una conferma umana (es. sigle in conflitto)'),
});

export const ManualData = z.object({
  version: z.literal(1),
  language: z.string().describe('Codice lingua del documento, es. "it"'),
  document_title: z.string().describe('Es. "Istruzioni di montaggio"'),
  short_name: z.string().describe('Nome breve per file e intestazioni, es. "Tavolo Levante"'),
  products: z.array(ProductGroup),
  footer_text: z.string().describe('Testo piccolo a piè di pagina, es. "Levante · Libeccio · Maestrale"'),
  cover_image_id: nullableImageId,
  brand_logo_image_id: nullableImageId.describe('Logo/marchi del produttore se presenti come immagine'),
  hardware: z.array(Hardware),
  components: z.array(Component),
  phases: z.array(Phase).describe('Raggruppamento dei passi in fasi; [] se non sensato'),
  steps: z.array(Step),
  notes: z.array(Note),
  unused_image_ids: z.array(imageId).describe('Immagini del catalogo non usate (decorative, duplicati, loghi già usati, ecc.)'),
  changes: z.array(Change),
});

// ---------------------------------------------------------------------------------------------
// AnimationPlan — sequenza del video 3D. I nodi sono indicati per "key" del riepilogo parti
// prodotto da src/video/model3d.js (PartsSummary: [{ key, name, bbox_min, bbox_max, size, center,
// triangles, similar_group }]). Coordinate nel sistema del modello normalizzato: Y in alto, unità mm,
// tavolo/oggetto appoggiato a terra (y=0) e centrato in X/Z.
// ---------------------------------------------------------------------------------------------

export const Vec3 = z.array(z.number()).describe('[x, y, z]');

export const PartRole = z.object({
  key: z.string().describe('key del PartsSummary'),
  role: z.enum(['component', 'hardware', 'ignore']),
  ref: z.string().nullable().describe('Sigla componente (F1...) o id ferramenta (H1...) corrispondente'),
});

export const Action = z.object({
  type: z.enum(['insert', 'fasten', 'tighten', 'flip', 'highlight']).describe(
    'insert: le parti arrivano da `direction` e si portano in posizione di montaggio; ' +
    'fasten: viti che entrano lungo il proprio asse ruotando e restano lente se `loose`; ' +
    'tighten: viti già messe che si serrano; ' +
    'flip: ruota di `angle_deg` attorno all\'asse `axis` tutto ciò che è già montato (o `keys`); ' +
    'highlight: evidenzia in arancio senza muovere'),
  keys: z.array(z.string()).describe('Parti coinvolte (key del PartsSummary). Per flip: [] = tutto il montato'),
  direction: Vec3.nullable().describe('Solo insert: versore di provenienza, es. [0,1,0] = dall\'alto'),
  distance_factor: z.number().nullable().describe('Solo insert: distanza di partenza in multipli della dimensione della parte (default 1.5)'),
  loose: z.boolean().nullable().describe('Solo fasten: true = restano lente (non serrate)'),
  axis: z.enum(['x', 'y', 'z']).nullable().describe('Solo flip'),
  angle_deg: z.number().nullable().describe('Solo flip, es. 180'),
});

export const AnimStep = z.object({
  number: z.number().int().describe('Numero del passo del manuale (0 = introduzione componenti)'),
  caption_title: z.string().describe('Didascalia breve (max ~60 caratteri)'),
  caption_body: z.string().describe('Seconda riga breve (max ~70 caratteri), può essere vuota'),
  actions: z.array(Action),
  closeup_keys: z.array(z.string()).describe('Se non vuoto, la camera fa un primo piano su queste parti durante le azioni'),
});

export const AnimationPlan = z.object({
  version: z.literal(1),
  title: z.string(),
  subtitle: z.string(),
  up_axis_in_source: z.enum(['y', 'z']).describe('Asse verticale del modello originale (il caricatore normalizza a Y)'),
  parts: z.array(PartRole),
  steps: z.array(AnimStep),
  final_caption_title: z.string(),
  final_caption_body: z.string(),
});

export const SCHEMA_VERSION = 1;
