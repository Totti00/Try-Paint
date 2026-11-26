#!/usr/bin/env bash
# Estrae un fotogramma ogni N secondi da un video (k_<secondi>.png) e crea un provino a griglia
# <cartella_out>_sheet.png (con etichette se e' disponibile Python + Pillow).
# Uso: tools/keyframes.sh video.mp4 cartella_out [passo_s=2] [colonne=6]
set -euo pipefail
in="$1"; out="${2%/}"; step="${3:-2}"; cols="${4:-6}"
sheet="$(dirname "$out")/$(basename "$out")_sheet.png"
mkdir -p "$out"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
last=$(python3 -c "import math;print(int(math.floor(float('$dur')-0.05)))" 2>/dev/null || echo "${dur%.*}")
for t in $(seq 0 "$step" "$last"); do
  ffmpeg -v error -y -ss "$t" -i "$in" -frames:v 1 "$out/k_$(printf %03d "$t").png"
done
n=$(ls "$out"/k_*.png | wc -l)
if python3 -c "import PIL" 2>/dev/null; then
  python3 - "$out" "$sheet" "$cols" <<'PY'
import sys, glob, os
from PIL import Image, ImageDraw
src, dst, cols = sys.argv[1], sys.argv[2], int(sys.argv[3])
files = sorted(glob.glob(os.path.join(src, 'k_*.png')))
w = 320; ims = [Image.open(f).convert('RGB') for f in files]
h = round(ims[0].height * w / ims[0].width)
rows = (len(ims) + cols - 1) // cols
S = Image.new('RGB', (cols * (w + 4) + 4, rows * (h + 4) + 4), (34, 32, 30))
d = ImageDraw.Draw(S)
for i, (f, im) in enumerate(zip(files, ims)):
    x, y = 4 + (i % cols) * (w + 4), 4 + (i // cols) * (h + 4)
    S.paste(im.resize((w, h), Image.LANCZOS), (x, y))
    lab = os.path.splitext(os.path.basename(f))[0].replace('k_', '') + ' s'
    d.rectangle((x, y, x + 52, y + 16), fill=(31, 28, 26)); d.text((x + 4, y + 2), lab, fill=(255, 126, 0))
S.save(dst)
PY
else
  rows=$(( (n + cols - 1) / cols ))
  ffmpeg -v error -y -pattern_type glob -i "$out/k_*.png" -vf "scale=320:-1,tile=${cols}x${rows}:padding=4:margin=4" -frames:v 1 "$sheet"
fi
echo "$n fotogrammi in $out, provino: $sheet"
