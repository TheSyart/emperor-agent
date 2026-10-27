/**
 * BRD-05: a skin image's type comes from its first bytes, never from its
 * name; its size from the header, so a tiny file cannot unpack into a huge
 * picture.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pngBytes, webpBytes } from '../test-fixtures/skins'
import { sniffImage } from './skin-image'

const MASCOT = join(__dirname, '../../renderer/src/assets/mascot')

describe('sniffImage', () => {
  it('reads a PNG by its signature and IHDR', () => {
    expect(sniffImage(pngBytes(320, 200))).toEqual({
      type: 'png',
      width: 320,
      height: 200,
    })
  })

  it('reads the three WebP kinds', () => {
    for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const)
      expect(sniffImage(webpBytes(270, 480, kind)), kind).toEqual({
        type: 'webp',
        width: 270,
        height: 480,
      })
  })

  it('reads the mascot pictures the official skins ship', () => {
    expect(sniffImage(readFileSync(join(MASCOT, 'robe.webp')))).toEqual({
      type: 'webp',
      width: 270,
      height: 480,
    })
    expect(sniffImage(readFileSync(join(MASCOT, 'seal-dan.webp')))).toEqual({
      type: 'webp',
      width: 193,
      height: 192,
    })
  })

  it('refuses HTML, SVG, GIF, JPEG and truncated files', () => {
    for (const bytes of [
      Buffer.from('<!doctype html><script>alert(1)</script>'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from('GIF89a\x01\x00\x01\x00'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
      pngBytes(10, 10).subarray(0, 12),
      Buffer.alloc(0),
    ])
      expect(sniffImage(bytes)).toBeNull()
  })
})
