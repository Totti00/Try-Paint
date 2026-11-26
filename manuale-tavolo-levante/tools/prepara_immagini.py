"""Prepara le immagini finali del manuale in assets/final/.

- Parte dalle immagini estratte e rifilate (assets/img) o, se esiste, dalla
  versione ingrandita 2x (assets/img2x, super-resolution EDSR).
- Porta lo sfondo dei render CAD (#FAFBFB) a bianco puro, così in stampa
  non compaiono riquadri grigini attorno alle figure.
- Ricava il logo "Ramberti group" bianco con trasparenza per la copertina.

Uso:  python3 tools/prepara_immagini.py   (dalla cartella manuale-tavolo-levante)
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC1, SRC2, OUT = ROOT / "assets/img", ROOT / "assets/img2x", ROOT / "assets/final"
OUT.mkdir(parents=True, exist_ok=True)

LOGO = "logo_ramberti_group.png"
BEIGE = (219, 211, 203)  # #DBD3CB, sfondo del logo originale


def best_source(name: str) -> Path:
    p2 = SRC2 / name
    return p2 if p2.exists() else SRC1 / name


def whiten(im: Image.Image) -> Image.Image:
    """Scala i canali di 255/250: lo sfondo 250-251 diventa 255, il resto cambia di ~2%."""
    lut = [min(255, round(v * 255 / 250)) for v in range(256)]
    return im.point(lut * 3)


for src in sorted(SRC1.glob("*.png")):
    name = src.name
    im = Image.open(best_source(name)).convert("RGB")
    if name == LOGO:
        # il logo resta sul suo beige: i pixel quasi-beige diventano esattamente
        # #DBD3CB, così il riquadro si fonde con il retro senza bordi visibili
        px = im.load()
        for y in range(im.height):
            for x in range(im.width):
                r, g, b = px[x, y]
                if abs(r - BEIGE[0]) <= 6 and abs(g - BEIGE[1]) <= 6 and abs(b - BEIGE[2]) <= 6:
                    px[x, y] = BEIGE
        im.save(OUT / name, optimize=True)
        continue
    whiten(im).save(OUT / name, optimize=True)
    print("ok", name, im.size)

# --- logo di gruppo bianco su trasparente (per la fascia beige in copertina)
logo = Image.open(best_source(LOGO)).convert("RGB")
w, h = logo.size
top = logo.crop((0, 0, w, int(h * 0.26)))  # la scritta "RAMBERTI group" sta nel primo quarto
lb = 0.299 * BEIGE[0] + 0.587 * BEIGE[1] + 0.114 * BEIGE[2]
alpha = Image.new("L", top.size)
pa, pt = alpha.load(), top.load()
for y in range(top.height):
    for x in range(top.width):
        r, g, b = pt[x, y]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        t = (lum - lb) / (255 - lb)
        t = 0 if t < 0.15 else min(1.0, (t - 0.15) / 0.75)
        pa[x, y] = int(round(t * 255))
white = Image.new("RGBA", top.size, (255, 255, 255, 0))
white.putalpha(alpha)
bbox = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
white.crop(bbox).save(OUT / "logo_group_white.png", optimize=True)
print("ok logo_group_white.png", white.crop(bbox).size)
