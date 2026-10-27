import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SPRITE_FRAME, SPRITES } from '../event-mapper.js'

/**
 * The outfit strips sliced by desktop/scripts/slice-pet-keyframes.mjs must
 * drop into the 小单 SPRITES table unchanged: one strip per action, the same
 * frame count and the same 192×208 cell, so swapping outfits only swaps files.
 */
const petRoot = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'assets',
  'desktop-pet',
)
const OUTFITS = [
  { folder: 'xiaodan-daily', prefix: 'daily' },
  { folder: 'xiaodan-robe', prefix: 'robe' },
]
const MAX_STRIP_BYTES = 300 * 1024

interface WebpHeader {
  width: number
  height: number
  alpha: boolean
}

/** Canvas size and alpha from an extended (VP8X) WebP's RIFF header. */
function readWebpHeader(bytes: Buffer): WebpHeader {
  const fourCC = (offset: number) => bytes.toString('ascii', offset, offset + 4)
  if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WEBP')
    throw new Error('not a RIFF/WEBP file')
  if (bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw new Error('RIFF size does not match the file size')
  if (fourCC(12) !== 'VP8X')
    throw new Error(`expected an extended VP8X WebP, got ${fourCC(12)}`)
  const flags = bytes[20]
  const width = bytes.readUIntLE(24, 3) + 1
  const height = bytes.readUIntLE(27, 3) + 1
  // The alpha flag must be backed by real alpha data: an ALPH chunk next to
  // lossy VP8 data, or a lossless VP8L bitstream.
  const chunks: string[] = []
  for (let offset = 12; offset + 8 <= bytes.length;) {
    chunks.push(fourCC(offset))
    const size = bytes.readUInt32LE(offset + 4)
    offset += 8 + size + (size % 2)
  }
  const alpha =
    (flags & 0x10) !== 0 && (chunks.includes('ALPH') || chunks.includes('VP8L'))
  return { width, height, alpha }
}

describe('desktop-pet outfit strips', () => {
  for (const { folder, prefix } of OUTFITS) {
    const dir = path.join(petRoot, folder)

    it(`${folder} has exactly one strip per 小单 action`, () => {
      const expected = Object.keys(SPRITES)
        .map((action) => `${prefix}-${action}.webp`)
        .sort()
      expect(expected).toHaveLength(12)
      const strips = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((file) => file.endsWith('.webp'))
        : []
      expect(strips.sort()).toEqual(expected)
    })

    for (const [action, sprite] of Object.entries(SPRITES)) {
      it(`${folder}/${prefix}-${action}.webp fits the ${sprite.frames}-frame cell grid`, () => {
        const file = path.join(dir, `${prefix}-${action}.webp`)
        expect(fs.existsSync(file), `${file} is missing`).toBe(true)
        const bytes = fs.readFileSync(file)
        expect(bytes.length).toBeLessThanOrEqual(MAX_STRIP_BYTES)
        const header = readWebpHeader(bytes)
        expect(header.height).toBe(SPRITE_FRAME.height)
        expect(header.width).toBe(sprite.frames * SPRITE_FRAME.width)
        expect(header.alpha).toBe(true)
      })
    }
  }

  it('reads the existing 小单 strips the same way', () => {
    const header = readWebpHeader(
      fs.readFileSync(path.join(petRoot, 'xiaodan', SPRITES.idle.file)),
    )
    expect(header).toEqual({
      width: SPRITES.idle.frames * SPRITE_FRAME.width,
      height: SPRITE_FRAME.height,
      alpha: true,
    })
  })
})
