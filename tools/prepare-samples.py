#!/usr/bin/env python3
"""Convert sample photos (HEIC/JPG/PNG) into raw RGBA files that the Node tests can read.

usage: python3 tools/prepare-samples.py [--scale 0.5] [Sample]
writes Sample/.cache/<name>.rgba and Sample/.cache/index.json
(HEIC needs macOS `sips`; EXIF orientation is applied.)
"""
import json, os, subprocess, sys, tempfile
from PIL import Image, ImageOps

args = sys.argv[1:]
scale = 1.0
if '--scale' in args:
    i = args.index('--scale'); scale = float(args[i + 1]); del args[i:i + 2]
src = args[0] if args else os.path.join(os.path.dirname(__file__), '..', 'Sample')
cache = os.path.join(src, '.cache')
os.makedirs(cache, exist_ok=True)
index = {}
for name in sorted(os.listdir(src)):
    base, ext = os.path.splitext(name)
    if ext.lower() not in ('.heic', '.jpg', '.jpeg', '.png') or base.startswith('blank'):
        continue
    path = os.path.join(src, name)
    if ext.lower() == '.heic':
        tmp = os.path.join(tempfile.mkdtemp(), base + '.jpg')
        subprocess.run(['sips', '-s', 'format', 'jpeg', path, '--out', tmp], check=True, capture_output=True)
        path = tmp
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGBA')
    if scale != 1.0:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    with open(os.path.join(cache, base + '.rgba'), 'wb') as f:
        f.write(im.tobytes())
    index[base] = {'width': im.width, 'height': im.height, 'source': name}
    print(f'{name} -> {im.width}x{im.height}')
with open(os.path.join(cache, 'index.json'), 'w') as f:
    json.dump(index, f, indent=2)
