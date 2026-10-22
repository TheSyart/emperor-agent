"""Cut the flat studio background (and the soft drop shadow) out of an
avatar sheet: background = pixels close to the backdrop colour, or light
low-chroma shadow, that connect to the sheet's border; edges get a soft
alpha and the backdrop is un-mixed from their colour."""
import sys
import numpy as np
from PIL import Image, ImageFilter

def dilate(m):
    o = m.copy()
    o[1:, :] |= m[:-1, :]; o[:-1, :] |= m[1:, :]
    o[:, 1:] |= m[:, :-1]; o[:, :-1] |= m[:, 1:]
    return o

def reconstruct(seed, mask):
    cur = seed & mask
    while True:
        nxt = dilate(cur) & mask
        if (nxt == cur).all():
            return cur
        cur = nxt

def local_std(lum, r=3):
    pad = np.pad(lum, r, mode='edge')
    c = np.cumsum(np.cumsum(pad, 0), 1)
    c2 = np.cumsum(np.cumsum(pad * pad, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0))); c2 = np.pad(c2, ((1, 0), (1, 0)))
    k = 2 * r + 1; h, w = lum.shape
    def box(a):
        return a[k:k + h, k:k + w] - a[:h, k:k + w] - a[k:k + h, :w] + a[:h, :w]
    n = k * k
    mean = box(c) / n
    return np.sqrt(np.maximum(box(c2) / n - mean * mean, 0))

def matte(src, dst, near=11.0, ramp=34.0, shadow_drop=48.0, shadow_chroma=9.0, smooth=4.0, neck=3):
    rgb = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(-1))
    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    bg_lum = float(bg @ np.array([0.299, 0.587, 0.114], np.float32))
    chroma = rgb.max(-1) - rgb.min(-1)
    bg_chroma = float(bg.max() - bg.min())
    shadow = (chroma < bg_chroma + shadow_chroma) & (lum <= bg_lum + 4) & (lum >= bg_lum - shadow_drop)
    # Backdrop and shadow are smooth; fur is textured. Only smooth pixels can
    # be background, so a white panda's face never leaks into it.
    flat = local_std(lum) < smooth
    candidate = ((dist < near) & (lum <= bg_lum + 2)) | (shadow & flat)
    seed = np.zeros((h, w), bool); seed[0] = seed[-1] = True; seed[:, 0] = seed[:, -1] = True
    # Opening by reconstruction: grow from the border through the candidate
    # shrunk by `neck` px, then give back the rim. A crack narrower than
    # 2 * neck into a white robot or ghost cannot carry the backdrop in.
    shrunk = candidate.copy()
    for _ in range(neck):
        shrunk = ~dilate(~shrunk)
    core = reconstruct(seed, shrunk)
    back = core
    for _ in range(neck + 1):
        back = dilate(back) & candidate
    # Soft edge: pixels of the foreground next to the background ramp in.
    edge = dilate(dilate(back)) & ~back
    alpha = np.where(back, 0.0, 1.0).astype(np.float32)
    # Shadow-tinted edge pixels count from the shadow, not the backdrop.
    e = np.clip((dist - near) / ramp, 0.0, 1.0)
    alpha[edge] = np.maximum(e[edge], 0.0)
    a = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    alpha = np.asarray(a).astype(np.float32) / 255.0
    alpha[back & ~dilate(dilate(dilate(~back)))] = 0.0
    # Un-mix the backdrop from half-covered pixels.
    safe = np.clip(alpha, 0.05, 1.0)[..., None]
    fg = np.where(alpha[..., None] < 0.999, (rgb - (1 - safe) * bg) / safe, rgb)
    fg = np.clip(fg, 0, 255)
    out = np.dstack([fg, alpha * 255]).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(dst)
    print(dst, 'bg', bg.round(1), 'removed %.1f%%' % (100 * back.mean()))

if __name__ == '__main__':
    matte(sys.argv[1], sys.argv[2])
