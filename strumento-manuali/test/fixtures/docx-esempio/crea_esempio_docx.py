"""Crea esempio.docx (fixture per test/test-pdf.js). Solo per sviluppo: richiede python-docx e Pillow.

Uso:  python3 test/fixtures/docx-esempio/crea_esempio_docx.py
Contiene: titolo e intestazioni, tabella della ferramenta con immagini (PNG e JPEG), elenco componenti,
passi numerati con immagini (una ripetuta = duplicato), un'avvertenza in grassetto, testo sottolineato
e un'immagine EMF (formato non supportato: l'ingest deve saltarla con un avviso).
"""
import io, re, zipfile
from pathlib import Path
from PIL import Image
from docx import Document
from docx.shared import Cm

HERE = Path(__file__).resolve().parent
SRC = HERE.parents[3] / "manuale-tavolo-levante" / "assets" / "estratte"
OUT = HERE / "esempio.docx"


def img_bytes(name, fmt="PNG", max_side=420):
    im = Image.open(SRC / name).convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, fmt, quality=88) if fmt == "JPEG" else im.save(buf, fmt)
    buf.seek(0)
    return buf


doc = Document()
doc.add_heading("Istruzioni di montaggio – Panca Volpina", level=0)
p = doc.add_paragraph("Leggere tutte le istruzioni ")
r = p.add_run("prima di iniziare")
r.bold = True
p.add_run(" e conservare il foglio. Montaggio in ")
r = p.add_run("due persone")
r.underline = True
p.add_run(".")

doc.add_heading("Ferramenta in dotazione", level=1)
table = doc.add_table(rows=3, cols=3)
table.style = "Table Grid"
rows = [("img-001.png", "PNG", "Vite inox M8x20 con flangia", "x10"),
        ("img-003.png", "JPEG", "Rondella in nylon 17x2x8.1", "x10"),
        ("img-002.png", "PNG", "Vite da legno inox 4x20", "x6")]
for i, (name, fmt, desc, qty) in enumerate(rows):
    cells = table.rows[i].cells
    cells[0].paragraphs[0].add_run().add_picture(img_bytes(name, fmt, 200), width=Cm(2.5))
    cells[1].text = desc
    cells[2].text = qty

doc.add_heading("Componenti", level=1)
for t in ["F1 – Fianchi panca in alluminio (2)", "T1 – Traversi di giunzione (2)", "P1 – Piano a doghe (1)"]:
    doc.add_paragraph(t, style="List Bullet")

doc.add_heading("Montaggio", level=1)
doc.add_paragraph("Posizionare i due fianchi (F1) in maniera speculare.", style="List Number")
doc.add_paragraph().add_run().add_picture(img_bytes("img-004.png", "PNG"), width=Cm(6))
p = doc.add_paragraph("Inserire i traversi (T1) e avvitare le viti con la rondella, ", style="List Number")
r = p.add_run("SENZA SERRARLE")
r.bold = True
r.underline = True
p.add_run(".")
doc.add_paragraph().add_run().add_picture(img_bytes("img-010.png", "JPEG", 600), width=Cm(9))
doc.add_paragraph("Verificare che i fianchi siano ancora speculari.", style="List Number")
doc.add_paragraph().add_run().add_picture(img_bytes("img-004.png", "PNG"), width=Cm(6))  # stessa immagine: duplicato
doc.add_paragraph("Serrare tutte le viti.", style="List Number")
doc.add_paragraph().add_run().add_picture(img_bytes("img-003.png", "PNG", 64), width=Cm(1.5))  # diventerà EMF
p = doc.add_paragraph()
r = p.add_run("ATTENZIONE: non serrare le viti prima del passo 4.")
r.bold = True
doc.add_heading("Manutenzione", level=2)
doc.add_paragraph("Pulire con un panno umido. Non usare solventi.")
doc.save(OUT)

# --- l'ultima immagine (64 px) diventa un finto EMF: Word la conserverebbe così
z = zipfile.ZipFile(OUT)
files = {n: z.read(n) for n in z.namelist()}
z.close()
media = sorted([n for n in files if n.startswith("word/media/")], key=lambda n: len(files[n]))
small = media[0]
emf_name = small.rsplit(".", 1)[0] + ".emf"
EMF_HEADER = bytes.fromhex("01000000") + (108).to_bytes(4, "little") + bytes(100)
files[emf_name] = EMF_HEADER
del files[small]
rels = files["word/_rels/document.xml.rels"].decode()
files["word/_rels/document.xml.rels"] = rels.replace(small.split("word/")[1], emf_name.split("word/")[1]).encode()
ct = files["[Content_Types].xml"].decode()
if 'Extension="emf"' not in ct:
    ct = ct.replace("<Default ", '<Default Extension="emf" ContentType="image/x-emf"/><Default ', 1)
files["[Content_Types].xml"] = ct.encode()
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zo:
    for n, data in files.items():
        zo.writestr(n, data)
print("creato", OUT, "media:", sorted(n for n in files if n.startswith("word/media/")))
