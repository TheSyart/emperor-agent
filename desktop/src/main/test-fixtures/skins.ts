/**
 * Test helpers for BRD-05 skins: image headers that pass (or fail) the
 * sniffer, and skin packages written into a temporary folder.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A PNG with a real signature and IHDR (its pixels are not decodable). */
export function pngBytes(width: number, height: number, pad = 0): Buffer {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  head[24] = 8
  head[25] = 6
  const end = Buffer.from([
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
  return Buffer.concat([head, Buffer.alloc(pad), end])
}

/** A WebP header of the given kind (lossy, lossless or extended). */
export function webpBytes(
  width: number,
  height: number,
  kind: 'VP8 ' | 'VP8L' | 'VP8X' = 'VP8X',
  pad = 0,
): Buffer {
  const head = Buffer.alloc(32)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(24 + pad, 4)
  head.write('WEBP', 8, 'latin1')
  head.write(kind, 12, 'latin1')
  head.writeUInt32LE(10, 16)
  if (kind === 'VP8X') {
    head.writeUIntLE(width - 1, 24, 3)
    head.writeUIntLE(height - 1, 27, 3)
  } else if (kind === 'VP8L') {
    head[20] = 0x2f
    head.writeUInt32LE(
      ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14),
      21,
    )
  } else {
    head[23] = 0x9d
    head[24] = 0x01
    head[25] = 0x2a
    head.writeUInt16LE(width & 0x3fff, 26)
    head.writeUInt16LE(height & 0x3fff, 28)
  }
  return Buffer.concat([head, Buffer.alloc(pad)])
}

export function tempDir(prefix = 'emperor-skin-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A valid light skin manifest (朱批-like), to be changed per test. */
export function manifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 1,
    id: 'paper',
    name: '宣纸',
    author: '测试',
    license: 'CC BY-NC 4.0',
    base: 'light',
    tokens: {
      '--surface-canvas': '246 239 225',
      '--text-1': '58 34 24',
      '--brand': '184 50 31',
      '--stroke-2': 'rgb(90 50 20 / 0.14)',
    },
    fonts: { heading: 'songti' },
    slots: { hero: 'hero.webp', sidebarFooter: 'pet.png' },
    ...overrides,
  }
}

/** Writes a package folder: skin.json plus the given files. */
export function writeSkin(
  parent: string,
  folder: string,
  json: Record<string, unknown> | string | null,
  files: Record<string, Buffer | string> = {
    'hero.webp': webpBytes(240, 240),
    'pet.png': pngBytes(120, 200),
  },
): string {
  const dir = join(parent, folder)
  mkdirSync(dir, { recursive: true })
  if (json !== null)
    writeFileSync(
      join(dir, 'skin.json'),
      typeof json === 'string' ? json : JSON.stringify(json, null, 2),
    )
  for (const [name, bytes] of Object.entries(files))
    writeFileSync(join(dir, name), bytes)
  return dir
}
