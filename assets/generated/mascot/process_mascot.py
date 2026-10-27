"""Turn the chosen mascot art (BRD-03) into the renderer's WebP assets.

The originals are Codex image_gen output on a #00ff00 backdrop
(assets/incoming/v0.3, untracked). Each one is keyed by how much greener
than red/blue a pixel is (soft edge, green unmixed from edge pixels),
trimmed to its own pixels, scaled to the height its places need, and saved
as WebP with alpha. The Emperor contact's head is a square crop of the
robe outfit. Which original goes where is decided in the 0.3 plan (D22,
D27, D35) and recorded in assets/generated/PROMPTS.md.

Usage: python3 -I process_mascot.py <incoming-v0.3-dir> <out-dir>
"""
import os
import sys

import numpy as np
from PIL import Image

# name: (original, height in px; 0 keeps the trimmed size)
FIGURES = {
    'robe': ('X-G2/X-G2-c2.png', 480),  # brand image: about page, 御书房 skin
    'throne': ('X-H2/X-H2-c2.png', 480),  # scene: Build's first home, 御书房 skin
    'daily': ('X-A/X-A-c1.png', 480),  # 日常 skin
    'hoodie': ('X-C/X-C-c1.png', 480),  # 日常 skin; the 加班中 sticker
    'sticker-zhunzou': ('X-F/X-F-c1.png', 256),  # 准奏
    'sticker-zhidaole': ('X-E/X-E-c1.png', 256),  # 朕知道了
    'sticker-en': ('X-D/X-D-c2.png', 256),  # 嗯？
    'sticker-jiaogei': ('X-B/X-B-c1.png', 256),  # 交给朕
    'seal-dan': ('L-L/L-L-c1.png', 192),  # 落款章「单」
    'seal-portrait': ('L-J/L-J-c1.png', 256),  # 肖像印
}
# The head of the robe outfit, crown included: a square in the original.
HEAD = ('X-G2/X-G2-c2.png', (372, 74, 908, 610), 192)


def keyed(path):
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    excess = g - np.maximum(r, b)
    alpha = np.clip(1 - (excess - 40) / 120, 0, 1)
    # Unmix the green from partly keyed pixels.
    g = np.where(excess > 0, np.maximum(r, b), g)
    out = np.dstack([r, g, b, alpha * 255]).round().astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def trimmed(image):
    box = image.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    return image.crop(box)


def scaled(image, height):
    if not height or image.height <= height:
        return image
    width = round(image.width * height / image.height)
    return image.resize((width, height), Image.LANCZOS)


def save(image, out_dir, name):
    path = os.path.join(out_dir, f'{name}.webp')
    image.save(path, 'WEBP', quality=88, method=6, exact=False)
    print(f'{name}: {image.width}x{image.height}, {os.path.getsize(path)} bytes')


def main(incoming, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for name, (original, height) in FIGURES.items():
        save(scaled(trimmed(keyed(os.path.join(incoming, original))), height), out_dir, name)
    original, box, size = HEAD
    head = keyed(os.path.join(incoming, original)).crop(box)
    save(head.resize((size, size), Image.LANCZOS), out_dir, 'emperor-head')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
