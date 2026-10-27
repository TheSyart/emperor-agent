#!/usr/bin/env node
// Desktop-pet outfits (BRD-03): turn the generated sprite rows — one row of
// poses per action on a flat green background — into 小单-format strips.
//
//   node scripts/slice-pet-keyframes.mjs --in <dir> [--out <dir>] [--review <dir>]
//
//   --in      folder with PA-<action>.png (everyday outfit) and PG-<action>.png
//             (dragon robe); default <repo>/assets/incoming/v0.3/pet
//   --out     default <repo>/assets/desktop-pet; writes
//             xiaodan-daily/daily-<action>.webp and xiaodan-robe/robe-<action>.webp
//   --review  also write pet-review-light.png and pet-review-dark.png there:
//             every strip on #f3f1ec and #141312 next to 小单's idle strip
//   --report  write the per-strip measurements as JSON to this file
//
// Needs only the Chromium that @playwright/test already installed: the pixel
// work runs in a headless page (canvas decode, WebP encode), nothing visible.
//
// Pipeline, per source image:
//   1. Key: alpha from how far G exceeds max(R, B), soft between two
//      thresholds; edge pixels are un-mixed from the measured key colour and
//      G is clamped to max(R, B), so no green fringe survives.
//   2. Segment: frames are the runs of non-empty columns; the count must equal
//      SPRITES[action].frames (src/pet/event-mapper.js) or the run fails.
//      Specks (small components) are dropped.
//   3. Measure the body: the generated rows are NOT drawn at one scale (the
//      same standing pose is 351 px tall in PA-idle and 541 px in PA-wave), so
//      each image gets its own factor that brings the body to ONE size:
//        - upright actions: ground line to the top of the hair (the crown is
//          gold, so it is not counted);
//        - run, walk, cheer, doze: the hair's width times the outfit's
//          height/hair-width ratio from its upright strips.
//      One body size for all 24 strips: everyday idle as tall as 小单's idle,
//      unless a frame (the robe's crown, raised arms mid-jump) would leave the
//      cell with its outline — then the largest size where every frame fits.
//   4. Compose: area-average resampling with premultiplied alpha into
//      192×208 cells. The ground of a strip is its lowest foot, so jumps keep
//      their height. Frames are centred on the alpha-weighted median column
//      (arms barely move it) — upright strips on the feet instead, so
//      standing feet do not slide.
//   5. Outline: 小单's white sticker outline (OUTLINE), a round dilation of
//      the silhouette under the character; its bottom sits on 小单's ground
//      row, like 小单's feet and outline.
//   6. Encode with canvas.toBlob('image/webp', 0.9); check the decoded strip
//      for green fringe and for pixels touching the cell edges.
/* global process, Buffer */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { chromium } from '@playwright/test'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(desktop, '..')

const OUTFITS = [
  { source: 'PA', folder: 'xiaodan-daily', prefix: 'daily' },
  { source: 'PG', folder: 'xiaodan-robe', prefix: 'robe' },
]
/**
 * Actions where the character stands straight: ground-to-hair is its height,
 * and the frames are centred on the feet (the rest on the body's mass).
 */
const UPRIGHT = new Set([
  'idle',
  'wave',
  'facepalm',
  'present',
  'laptop',
  'think',
  'lookup',
  'lookaround',
])
const TOP_MARGIN = 1
const SIDE_MARGIN = 1
const WEBP_QUALITY = 0.9
/**
 * 小单's white sticker outline, measured on assets/desktop-pet/xiaodan at the
 * 192×208 cell scale: about 3.5 px from the art's edge to the outer
 * half-alpha edge (one anti-aliased pixel, then three solid ones), colour
 * (253, 253, 253), and it fills gaps narrower than twice that (between an
 * arm and the body) the way a dilation does.
 */
const OUTLINE = { width: 3.6, colour: [253, 253, 253] }

// ---------------------------------------------------------------------------
// Page side: these functions are serialised into the headless page. They may
// only use browser globals and each other.

async function petDecode(b64, type) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  return { width: bitmap.width, height: bitmap.height, data }
}

function petToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Green-screen key: soft alpha, colour un-mixed from the key, G despilled. */
function petKey(img) {
  const { width, height, data } = img
  const n = width * height
  const hist = [
    new Uint32Array(256),
    new Uint32Array(256),
    new Uint32Array(256),
  ]
  let count = 0
  for (let i = 0; i < n; i++) {
    const r = data[4 * i]
    const g = data[4 * i + 1]
    const b = data[4 * i + 2]
    if (g - Math.max(r, b) > 160) {
      hist[0][r]++
      hist[1][g]++
      hist[2][b]++
      count++
    }
  }
  const median = (h) => {
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += h[v]
      if (acc * 2 >= count) return v
    }
    return 255
  }
  const key = [median(hist[0]), median(hist[1]), median(hist[2])]
  const keyExcess = key[1] - Math.max(key[0], key[2])
  // Excess at or above `clearAt` is background; at or below `solidAt` it is
  // the character (its own colours never lean green: max interior excess 22).
  const clearAt = keyExcess - 16
  const solidAt = 24
  const alpha = new Float32Array(n)
  const rgb = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    const r = data[4 * i]
    const g = data[4 * i + 1]
    const b = data[4 * i + 2]
    const excess = g - Math.max(r, b)
    const a = Math.min(1, Math.max(0, (clearAt - excess) / (clearAt - solidAt)))
    alpha[i] = a
    if (a === 0) continue
    // How much of the pixel is character, if it is a linear blend with the key.
    const cover = Math.min(
      1,
      Math.max(0.05, 1 - Math.max(0, excess) / keyExcess),
    )
    let R = (r - (1 - cover) * key[0]) / cover
    let G = (g - (1 - cover) * key[1]) / cover
    let B = (b - (1 - cover) * key[2]) / cover
    R = Math.min(255, Math.max(0, R))
    B = Math.min(255, Math.max(0, B))
    G = Math.min(Math.max(R, B), Math.max(0, G))
    rgb[3 * i] = R
    rgb[3 * i + 1] = G
    rgb[3 * i + 2] = B
  }
  return { width, height, data, alpha, rgb, key }
}

/** Frames = runs of non-empty columns; drops specks; exact count or throw. */
function petSegment(keyed, expected, name) {
  const { width, height, alpha } = keyed
  const counts = new Uint32Array(width)
  const mass = new Float64Array(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = alpha[y * width + x]
      mass[x] += a
      if (a >= 0.5) counts[x]++
    }
  }
  const runs = []
  let start = -1
  for (let x = 0; x <= width; x++) {
    const filled = x < width && counts[x] >= 2
    if (filled && start < 0) start = x
    if (!filled && start >= 0) {
      let m = 0
      for (let i = start; i < x; i++) m += mass[i]
      runs.push({ x0: start, x1: x - 1, mass: m })
      start = -1
    }
  }
  const biggest = Math.max(0, ...runs.map((run) => run.mass))
  const frames = runs.filter((run) => run.mass >= 0.02 * biggest)
  if (frames.length !== expected) {
    const spans = frames.map((run) => `${run.x0}-${run.x1}`).join(', ')
    throw new Error(
      `${name}: found ${frames.length} frames, expected ${expected} (column runs ${spans})`,
    )
  }
  // A frame owns the columns up to halfway to its neighbours.
  return frames.map((run, i) => {
    const left = i === 0 ? 0 : Math.ceil((frames[i - 1].x1 + run.x0) / 2)
    const right =
      i === frames.length - 1
        ? width - 1
        : Math.floor((run.x1 + frames[i + 1].x0) / 2)
    return { x0: left, x1: right }
  })
}

/** Zero every component of a frame that is a speck, then measure the frame. */
function petCleanAndMeasure(keyed, region, name, index) {
  const { width, height, alpha, data } = keyed
  const rw = region.x1 - region.x0 + 1
  const label = new Int32Array(rw * height)
  const stack = new Int32Array(rw * height)
  const components = []
  let total = 0
  for (let y = 0; y < height; y++) {
    for (let lx = 0; lx < rw; lx++) {
      if (alpha[y * width + region.x0 + lx] <= 0 || label[y * rw + lx]) continue
      const id = components.length + 1
      let sp = 0
      let sum = 0
      stack[sp++] = y * rw + lx
      label[y * rw + lx] = id
      while (sp > 0) {
        const p = stack[--sp]
        const py = Math.floor(p / rw)
        const px = p - py * rw
        sum += alpha[py * width + region.x0 + px]
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qy = py + dy
            const qx = px + dx
            if (qy < 0 || qy >= height || qx < 0 || qx >= rw) continue
            const q = qy * rw + qx
            if (label[q] || alpha[qy * width + region.x0 + qx] <= 0) continue
            label[q] = id
            stack[sp++] = q
          }
        }
      }
      components.push(sum)
      total += sum
    }
  }
  const keep = components.map((sum) => sum >= Math.max(25, 0.001 * total))
  let dropped = 0
  for (let y = 0; y < height; y++) {
    for (let lx = 0; lx < rw; lx++) {
      const id = label[y * rw + lx]
      if (id && !keep[id - 1]) {
        alpha[y * width + region.x0 + lx] = 0
        dropped++
      }
    }
  }

  // Bounding box of the solid pixels (alpha >= 0.5).
  let x0 = width
  let x1 = -1
  let y0 = height
  let y1 = -1
  const columnMass = new Float64Array(rw)
  for (let y = 0; y < height; y++) {
    for (let lx = 0; lx < rw; lx++) {
      const a = alpha[y * width + region.x0 + lx]
      if (a <= 0) continue
      const x = region.x0 + lx
      columnMass[lx] += a
      if (a < 0.5) continue
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  }
  if (x1 < 0) throw new Error(`${name} frame ${index}: empty after keying`)

  // Body centre: the column that splits the frame's alpha mass in half.
  let massTotal = 0
  for (const m of columnMass) massTotal += m
  let acc = 0
  let massCx = region.x0
  for (let lx = 0; lx < rw; lx++) {
    if (acc + columnMass[lx] >= massTotal / 2) {
      massCx = region.x0 + lx + (massTotal / 2 - acc) / columnMass[lx]
      break
    }
    acc += columnMass[lx]
  }
  // Feet: the solid pixels in the lowest 6% of the figure.
  const footTop = y1 - Math.floor(0.06 * (y1 - y0))
  let fx0 = width
  let fx1 = -1
  for (let y = footTop; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (alpha[y * width + x] < 0.5) continue
      fx0 = Math.min(fx0, x)
      fx1 = Math.max(fx1, x)
    }
  }
  const footCx = (fx0 + fx1 + 1) / 2

  // Hair: after an erosion that cuts the thin outlines joining the dark parts,
  // the big near-black blob highest up (the shirt and trousers sit lower).
  // The crown is gold, so it is never part of it.
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  let dark = new Uint8Array(bw * bh)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = (y0 + y) * width + x0 + x
      const max = Math.max(data[4 * i], data[4 * i + 1], data[4 * i + 2])
      dark[y * bw + x] = alpha[i] >= 0.9 && max < 60 ? 1 : 0
    }
  }
  for (let pass = 0; pass < 5; pass++) {
    const next = new Uint8Array(bw * bh)
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const p = y * bw + x
        next[p] =
          dark[p] & dark[p - 1] & dark[p + 1] & dark[p - bw] & dark[p + bw]
      }
    }
    dark = next
  }
  const blobs = new Int32Array(bw * bh)
  const blobStack = new Int32Array(bw * bh)
  const found = []
  let blobCount = 0
  for (let p0 = 0; p0 < bw * bh; p0++) {
    if (!dark[p0] || blobs[p0]) continue
    blobCount++
    let sp = 0
    blobStack[sp++] = p0
    blobs[p0] = blobCount
    let area = 0
    let sumY = 0
    let top = bh
    let left = bw
    let right = -1
    while (sp > 0) {
      const p = blobStack[--sp]
      const py = Math.floor(p / bw)
      const px = p - py * bw
      area++
      sumY += py
      top = Math.min(top, py)
      left = Math.min(left, px)
      right = Math.max(right, px)
      for (const q of [p - 1, p + 1, p - bw, p + bw]) {
        if (q < 0 || q >= bw * bh || blobs[q] || !dark[q]) continue
        if (Math.abs((q % bw) - px) > 1) continue
        blobs[q] = blobCount
        blobStack[sp++] = q
      }
    }
    found.push({
      area,
      cy: sumY / area,
      top: y0 + top,
      width: right - left + 1,
    })
  }
  const largest = Math.max(0, ...found.map((blob) => blob.area))
  const hair = found
    .filter((blob) => blob.area >= Math.max(800, 0.15 * largest))
    .sort((a, b) => a.cy - b.cy)[0]
  if (!hair) throw new Error(`${name} frame ${index}: no hair found to size by`)

  return {
    region,
    dropped,
    x0,
    x1,
    y0,
    y1,
    massCx,
    footCx,
    hairTop: hair.top,
    hairWidth: hair.width,
  }
}

async function petAnalyze(b64, expected, name) {
  const keyed = petKey(await petDecode(b64, 'image/png'))
  const regions = petSegment(keyed, expected, name)
  const frames = regions.map((region, i) =>
    petCleanAndMeasure(keyed, region, name, i),
  )
  return { width: keyed.width, height: keyed.height, key: keyed.key, frames }
}

/** Box-filter footprints of `n` destination pixels over source [lo, hi). */
function petWeights(n, sourceAt, scale, lo, hi) {
  const out = []
  for (let d = 0; d < n; d++) {
    const a = sourceAt(d)
    const b = a + 1 / scale
    const first = Math.max(lo, Math.floor(a))
    const last = Math.min(hi - 1, Math.ceil(b) - 1)
    const weights = []
    for (let j = first; j <= last; j++) {
      const overlap = Math.min(b, j + 1) - Math.max(a, j)
      weights.push(overlap > 0 ? overlap * scale : 0)
    }
    out.push({ first, weights })
  }
  return out
}

/**
 * Resample one keyed frame into a float cell (premultiplied box filter):
 * alpha in `A`, straight colour in `C`.
 */
function petResample(keyed, region, place, cell) {
  const { width, alpha, rgb } = keyed
  const { scale, cx, ground } = place
  const xs = petWeights(
    cell.width,
    (d) => cx + (d - cell.width / 2) / scale,
    scale,
    region.x0,
    region.x1 + 1,
  )
  const ys = petWeights(
    cell.height,
    (d) => ground + (d - cell.artGround) / scale,
    scale,
    0,
    keyed.height,
  )
  let rowLo = keyed.height
  let rowHi = -1
  for (const { first, weights } of ys) {
    if (!weights.length) continue
    rowLo = Math.min(rowLo, first)
    rowHi = Math.max(rowHi, first + weights.length - 1)
  }
  const frame = {
    A: new Float32Array(cell.width * cell.height),
    C: new Float32Array(cell.width * cell.height * 3),
  }
  if (rowHi < rowLo) return frame
  const rows = rowHi - rowLo + 1
  const tmp = new Float64Array(rows * cell.width * 4)
  for (let r = 0; r < rows; r++) {
    const y = rowLo + r
    for (let dx = 0; dx < cell.width; dx++) {
      const { first, weights } = xs[dx]
      let A = 0
      let R = 0
      let G = 0
      let B = 0
      for (let k = 0; k < weights.length; k++) {
        const i = y * width + first + k
        const wa = weights[k] * alpha[i]
        if (wa === 0) continue
        A += wa
        R += wa * rgb[3 * i]
        G += wa * rgb[3 * i + 1]
        B += wa * rgb[3 * i + 2]
      }
      const t = (r * cell.width + dx) * 4
      tmp[t] = A
      tmp[t + 1] = R
      tmp[t + 2] = G
      tmp[t + 3] = B
    }
  }
  for (let dy = 0; dy < cell.height; dy++) {
    const { first, weights } = ys[dy]
    for (let dx = 0; dx < cell.width; dx++) {
      let A = 0
      let R = 0
      let G = 0
      let B = 0
      for (let k = 0; k < weights.length; k++) {
        const t = ((first - rowLo + k) * cell.width + dx) * 4
        const w = weights[k]
        A += w * tmp[t]
        R += w * tmp[t + 1]
        G += w * tmp[t + 2]
        B += w * tmp[t + 3]
      }
      if (A <= 0) continue
      // Averaging a reddish and a bluish pixel can still lean green: clamp again.
      const p = dy * cell.width + dx
      const red = R / A
      const blue = B / A
      frame.A[p] = Math.min(1, A)
      frame.C[3 * p] = red
      frame.C[3 * p + 1] = Math.min(G / A, Math.max(red, blue))
      frame.C[3 * p + 2] = blue
    }
  }
  return frame
}

/**
 * The sticker outline: the silhouette dilated by `cell.outline.width` px
 * with round joins, filled under the character. Each pixel's own edge sits
 * `alpha - 0.5` px past its centre, which keeps the outline's rim
 * anti-aliased; faint pixels (alpha < 0.25) do not grow it.
 */
function petOutline(frame, cell) {
  const { width: w, height: h } = cell
  const radius = cell.outline.width
  const [wr, wg, wb] = cell.outline.colour
  const reach = Math.ceil(radius + 1)
  const offsets = []
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const d = Math.hypot(dx, dy)
      if (d < radius + 1) offsets.push(dx, dy, d)
    }
  }
  const edge = new Float32Array(w * h).fill(Infinity)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = frame.A[y * w + x]
      if (a < 0.25) continue
      const past = a - 0.5
      for (let k = 0; k < offsets.length; k += 3) {
        const px = x + offsets[k]
        const py = y + offsets[k + 1]
        if (px < 0 || py < 0 || px >= w || py >= h) continue
        const p = py * w + px
        const s = offsets[k + 2] - past
        if (s < edge[p]) edge[p] = s
      }
    }
  }
  for (let p = 0; p < w * h; p++) {
    const ring = Math.min(1, Math.max(0, radius + 0.5 - edge[p]))
    if (ring === 0) continue
    const a = frame.A[p]
    const out = a + (1 - a) * ring
    const under = (1 - a) * ring
    frame.C[3 * p] = (a * frame.C[3 * p] + under * wr) / out
    frame.C[3 * p + 1] = (a * frame.C[3 * p + 1] + under * wg) / out
    frame.C[3 * p + 2] = (a * frame.C[3 * p + 2] + under * wb) / out
    frame.A[p] = out
  }
}

/** Quantise a float cell into the strip; near-invisible pixels become 0. */
function petWriteCell(frame, strip, cell, left) {
  for (let y = 0; y < cell.height; y++) {
    for (let x = 0; x < cell.width; x++) {
      const p = y * cell.width + x
      const a8 = Math.round(frame.A[p] * 255)
      if (a8 < cell.minAlpha) continue
      const o = (y * strip.width + left + x) * 4
      strip.data[o] = Math.round(frame.C[3 * p])
      strip.data[o + 1] = Math.round(frame.C[3 * p + 1])
      strip.data[o + 2] = Math.round(frame.C[3 * p + 2])
      strip.data[o + 3] = a8
    }
  }
}

/**
 * Green fringe and cell-edge contact in a strip. Lossy WebP's 4:2:0 chroma
 * leaves a few isolated pixels a little green (G up to ~24 over max(R, B));
 * a keying fringe is a whole outline at 60+, so only that counts.
 */
function petInspect(data, frames, cell) {
  const width = frames * cell.width
  let fringe = 0
  let maxExcess = 0
  const touching = []
  const rows = []
  for (let f = 0; f < frames; f++) {
    let touch = false
    let top = cell.height
    let bottom = -1
    for (let y = 0; y < cell.height; y++) {
      for (let x = 0; x < cell.width; x++) {
        const o = (y * width + f * cell.width + x) * 4
        const a = data[o + 3]
        if (a < 16) continue
        const excess = data[o + 1] - Math.max(data[o], data[o + 2])
        maxExcess = Math.max(maxExcess, excess)
        if (excess > 32) fringe++
        if (y === 0 || x === 0 || x === cell.width - 1) touch = true
        if (a < 128) continue
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
    if (touch) touching.push(f)
    rows.push({ top, bottom })
  }
  return { fringe, maxExcess, touching, rows }
}

async function petCompose(b64, expected, name, places, cellSpec) {
  const keyed = petKey(await petDecode(b64, 'image/png'))
  const regions = petSegment(keyed, expected, name)
  regions.forEach((region, i) => petCleanAndMeasure(keyed, region, name, i))
  const strip = {
    width: expected * cellSpec.width,
    height: cellSpec.height,
    data: new Uint8ClampedArray(
      expected * cellSpec.width * cellSpec.height * 4,
    ),
  }
  regions.forEach((region, i) => {
    const frame = petResample(keyed, region, places[i], cellSpec)
    if (cellSpec.outline) petOutline(frame, cellSpec)
    petWriteCell(frame, strip, cellSpec, i * cellSpec.width)
  })
  const canvas = document.createElement('canvas')
  canvas.width = strip.width
  canvas.height = strip.height
  canvas
    .getContext('2d')
    .putImageData(new ImageData(strip.data, strip.width, strip.height), 0, 0)
  const blob = await new Promise((done) =>
    canvas.toBlob(done, 'image/webp', cellSpec.quality),
  )
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const decoded = await petDecode(petToBase64(bytes), 'image/webp')
  return {
    webp: petToBase64(bytes),
    before: petInspect(strip.data, expected, { ...cellSpec }),
    after: petInspect(decoded.data, expected, { ...cellSpec }),
  }
}

/** Bounding rows of 小单's idle strip: its standing height and ground row. */
async function petMeasureReference(b64, frames, cellWidth) {
  const img = await petDecode(b64, 'image/webp')
  const heights = []
  let ground = 0
  for (let f = 0; f < frames; f++) {
    let top = img.height
    let bottom = -1
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < cellWidth; x++) {
        if (img.data[(y * img.width + f * cellWidth + x) * 4 + 3] < 128)
          continue
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
    heights.push(bottom - top + 1)
    ground = Math.max(ground, bottom + 1)
  }
  heights.sort((a, b) => a - b)
  return { standing: heights[Math.floor(heights.length / 2)], ground }
}

/** Contact sheet: each action's two strips side by side over `background`. */
async function petRenderReview(rows, options) {
  const { background, ink, line, cell, groundY } = options
  const pad = 24
  const labelWidth = 170
  const gap = 32
  const maxFrames = 8
  const rowHeight = cell.height + 34
  const width = pad * 2 + labelWidth + maxFrames * cell.width * 2 + gap
  const height = pad * 2 + 40 + rows.length * rowHeight
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = ink
  ctx.font = '600 22px -apple-system, "Helvetica Neue", sans-serif'
  ctx.fillText(options.title, pad, pad + 22)
  ctx.font = '15px -apple-system, "Helvetica Neue", sans-serif'
  for (let r = 0; r < rows.length; r++) {
    const top = pad + 40 + r * rowHeight
    ctx.fillStyle = ink
    ctx.fillText(rows[r].label, pad, top + 24 + cell.height / 2)
    for (let c = 0; c < rows[r].strips.length; c++) {
      const item = rows[r].strips[c]
      if (!item) continue
      const left = pad + labelWidth + c * (maxFrames * cell.width + gap)
      ctx.fillStyle = ink
      ctx.fillText(item.caption, left, top + 18)
      const y = top + 26
      ctx.strokeStyle = line
      ctx.lineWidth = 1
      for (let f = 0; f < item.frames; f++) {
        ctx.strokeRect(
          left + f * cell.width + 0.5,
          y + 0.5,
          cell.width - 1,
          cell.height - 1,
        )
      }
      ctx.beginPath()
      ctx.moveTo(left, y + groundY + 0.5)
      ctx.lineTo(left + item.frames * cell.width, y + groundY + 0.5)
      ctx.stroke()
      const bytes = Uint8Array.from(atob(item.b64), (ch) => ch.charCodeAt(0))
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: 'image/webp' }),
      )
      ctx.drawImage(bitmap, left, y)
    }
  }
  const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'))
  return petToBase64(new Uint8Array(await blob.arrayBuffer()))
}

const PAGE_FUNCTIONS = [
  petDecode,
  petToBase64,
  petKey,
  petSegment,
  petCleanAndMeasure,
  petAnalyze,
  petWeights,
  petResample,
  petOutline,
  petWriteCell,
  petInspect,
  petCompose,
  petMeasureReference,
  petRenderReview,
]
const PAGE_SCRIPT = `${PAGE_FUNCTIONS.map(String).join('\n\n')}
${PAGE_FUNCTIONS.map((fn) => `window.${fn.name} = ${fn.name}`).join('\n')}`

// ---------------------------------------------------------------------------
// Node side.

function parseArgs(argv) {
  const options = {
    input: join(repoRoot, 'assets/incoming/v0.3/pet'),
    output: join(repoRoot, 'assets/desktop-pet'),
    review: null,
    report: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!value) throw new Error(`${flag} needs a value`)
    if (flag === '--in') options.input = resolve(value)
    else if (flag === '--out') options.output = resolve(value)
    else if (flag === '--review') options.review = resolve(value)
    else if (flag === '--report') options.report = resolve(value)
    else throw new Error(`unknown option ${flag}`)
    i++
  }
  return options
}

/** SPRITES and SPRITE_FRAME from the pet's UMD script, the single source. */
function loadSpriteTable() {
  const module = { exports: {} }
  vm.runInNewContext(
    readFileSync(join(desktop, 'src/pet/event-mapper.js'), 'utf8'),
    { module },
  )
  return module.exports
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length / 2
  return Number.isInteger(mid)
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[Math.floor(mid)]
}

/**
 * One body size for every strip: `unit` output pixels per body measure.
 * Starts at 小单's standing height (outline included) for the everyday idle
 * strip and shrinks until every frame of every strip, with its outline, fits
 * its cell.
 */
function planScale(strips, reference, cell) {
  for (const strip of strips) {
    strip.ground = Math.max(...strip.frames.map((f) => f.y1)) + 1
    strip.hairWidth = median(strip.frames.map((f) => f.hairWidth))
    strip.standing = median(strip.frames.map((f) => strip.ground - f.hairTop))
    for (const frame of strip.frames)
      frame.cx = UPRIGHT.has(strip.action) ? frame.footCx : frame.massCx
  }
  const ratio = {}
  for (const { source } of OUTFITS) {
    ratio[source] = median(
      strips
        .filter((s) => s.outfit.source === source && UPRIGHT.has(s.action))
        .map((s) => s.standing / s.hairWidth),
    )
  }
  for (const strip of strips) {
    strip.measure = UPRIGHT.has(strip.action)
      ? strip.standing
      : ratio[strip.outfit.source] * strip.hairWidth
  }
  const anchor = strips.find(
    (s) => s.outfit.source === 'PA' && s.action === 'idle',
  )
  const anchorBox = median(anchor.frames.map((f) => anchor.ground - f.y0))
  const ring = cell.outline ? cell.outline.width : 0
  const wanted = ((reference.standing - 2 * ring) * anchor.measure) / anchorBox
  let unit = wanted
  let binding = null
  const half = cell.width / 2 - SIDE_MARGIN - ring
  for (const strip of strips) {
    strip.frames.forEach((f, i) => {
      const limits = [
        ['top', (cell.artGround - TOP_MARGIN - ring) / (strip.ground - f.y0)],
        ['left', half / (f.cx - f.x0)],
        ['right', half / (f.x1 + 1 - f.cx)],
      ]
      for (const [side, perMeasure] of limits) {
        const limit = perMeasure * strip.measure
        if (limit < unit) {
          unit = limit
          binding = `${strip.name} frame ${i} (${side})`
        }
      }
    })
  }
  for (const strip of strips) strip.scale = unit / strip.measure
  return {
    unit,
    wanted,
    binding,
    ratio,
    standing: (anchorBox * unit) / anchor.measure,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { SPRITES, SPRITE_FRAME } = loadSpriteTable()
  const actions = Object.keys(SPRITES)
  const xiaodan = join(repoRoot, 'assets/desktop-pet/xiaodan')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.addScriptTag({ content: PAGE_SCRIPT })
    const referenceB64 = readFileSync(
      join(xiaodan, SPRITES.idle.file),
    ).toString('base64')
    const reference = await page.evaluate(
      ([b64, frames, width]) => window.petMeasureReference(b64, frames, width),
      [referenceB64, SPRITES.idle.frames, SPRITE_FRAME.width],
    )
    // 小单's ground row is the bottom of its outline: the art's feet stand
    // one outline width above it.
    const cell = {
      width: SPRITE_FRAME.width,
      height: SPRITE_FRAME.height,
      groundY: reference.ground,
      artGround: reference.ground - OUTLINE.width,
      outline: OUTLINE,
      minAlpha: 3,
      quality: WEBP_QUALITY,
    }

    const strips = []
    for (const outfit of OUTFITS) {
      for (const action of actions) {
        const name = `${outfit.source}-${action}`
        const b64 = readFileSync(join(options.input, `${name}.png`)).toString(
          'base64',
        )
        const analysis = await page.evaluate(
          ([data, frames, label]) => window.petAnalyze(data, frames, label),
          [b64, SPRITES[action].frames, name],
        )
        strips.push({ outfit, action, name, b64, ...analysis })
      }
    }

    const plan = planScale(strips, reference, cell)
    console.log(
      `body unit ${plan.unit.toFixed(2)} px (wanted ${plan.wanted.toFixed(2)} for 小单's ${reference.standing} px idle); ` +
        `everyday idle stands ${plan.standing.toFixed(1)} px, ${(plan.standing + 2 * OUTLINE.width).toFixed(1)} px with its ` +
        `${OUTLINE.width} px outline, whose bottom is on ground row ${cell.groundY - 1}; ` +
        `limited by ${plan.binding ?? 'nothing'}; height/hair ratio ${JSON.stringify(plan.ratio)}`,
    )

    const written = []
    const failures = []
    for (const strip of strips) {
      const places = strip.frames.map((f) => ({
        scale: strip.scale,
        cx: f.cx,
        ground: strip.ground,
      }))
      const result = await page.evaluate(
        ([data, frames, label, place, spec]) =>
          window.petCompose(data, frames, label, place, spec),
        [strip.b64, SPRITES[strip.action].frames, strip.name, places, cell],
      )
      const dir = join(options.output, strip.outfit.folder)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${strip.outfit.prefix}-${strip.action}.webp`)
      const bytes = Buffer.from(result.webp, 'base64')
      writeFileSync(file, bytes)
      strip.webp = result.webp
      strip.bytes = bytes.length
      strip.inspect = result.after
      written.push(strip)
      const tops = result.after.rows.map((r) => r.top)
      const bottoms = result.after.rows.map((r) => r.bottom)
      console.log(
        `${strip.name.padEnd(14)} ${String(strip.frames.length)} frames  scale ${strip.scale.toFixed(4)}  ` +
          `${(bytes.length / 1024).toFixed(1)} KB  rows ${Math.min(...tops)}–${Math.max(...bottoms)}  ` +
          `green excess max ${result.before.maxExcess} before / ${result.after.maxExcess} after encoding` +
          (result.after.fringe
            ? `  GREEN FRINGE on ${result.after.fringe} px`
            : '') +
          (result.after.touching.length
            ? `  TOUCHES CELL EDGE in frames ${result.after.touching.join(',')}`
            : ''),
      )
      if (result.after.touching.length || result.after.fringe > 0)
        failures.push(strip.name)
    }

    if (options.report) {
      const report = {
        reference,
        cell,
        plan,
        strips: strips.map((s) => ({
          name: s.name,
          scale: s.scale,
          measure: s.measure,
          ground: s.ground,
          hairWidth: s.hairWidth,
          standing: s.standing,
          bytes: s.bytes,
          frames: s.frames.map(({ region: _region, ...f }) => f),
          rows: s.inspect.rows,
        })),
      }
      writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`)
    }

    if (options.review) {
      mkdirSync(options.review, { recursive: true })
      const referenceRow = {
        label: '小单 idle',
        strips: [
          {
            caption: 'xiaodan-idle (current pet, for scale)',
            b64: referenceB64,
            frames: SPRITES.idle.frames,
          },
          {
            caption: 'xiaodan-idle (current pet, for scale)',
            b64: referenceB64,
            frames: SPRITES.idle.frames,
          },
        ],
      }
      const rows = [
        referenceRow,
        ...actions.map((action) => ({
          label: action,
          strips: OUTFITS.map((outfit) => {
            const strip = written.find(
              (s) => s.outfit === outfit && s.action === action,
            )
            return {
              caption: `${outfit.prefix}-${action}.webp  ${(strip.bytes / 1024).toFixed(0)} KB`,
              b64: strip.webp,
              frames: SPRITES[action].frames,
            }
          }),
        })),
      ]
      for (const [mode, background, ink, line] of [
        ['light', '#f3f1ec', '#141312', 'rgba(20,19,18,0.14)'],
        ['dark', '#141312', '#f3f1ec', 'rgba(243,241,236,0.16)'],
      ]) {
        const png = await page.evaluate(
          ([items, opts]) => window.petRenderReview(items, opts),
          [
            rows,
            {
              background,
              ink,
              line,
              cell,
              groundY: cell.groundY,
              title: `Desktop pet outfits — daily (left) and robe (right), ${mode}; line = ground row`,
            },
          ],
        )
        const file = join(options.review, `pet-review-${mode}.png`)
        writeFileSync(file, Buffer.from(png, 'base64'))
        console.log(`review sheet ${file}`)
      }
    }

    if (failures.length) {
      throw new Error(
        `green fringe or clipped frames in ${failures.join(', ')}`,
      )
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
