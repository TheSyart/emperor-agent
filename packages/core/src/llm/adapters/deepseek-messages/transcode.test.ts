// KRN-07: the pixel budget and the macOS `sips` JPEG encoder used for
// Files API uploads.
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { imageDimensions } from '../../../attachments/image-dimensions'
import { fitPixels, sipsTranscoder } from './transcode'

/** An opaque RGB PNG of the given size (CRCs are not checked by sips' reader, but are written correctly). */
function png(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = (x * 7) & 0xff
      row[2 + x * 3] = (y * 5) & 0xff
      row[3 + x * 3] = 128
    }
    rows.push(row)
  }
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

describe('fitPixels', () => {
  it('scales down past the budget, keeping the aspect ratio', () => {
    const { width, height } = fitPixels(4000, 3000, 1300 * 1300)
    expect(width * height).toBeLessThanOrEqual(1300 * 1300)
    expect(width * height).toBeGreaterThan(1300 * 1300 * 0.99)
    expect(width / height).toBeCloseTo(4 / 3, 2)
    expect(fitPixels(30_000, 10, 1300 * 1300).height).toBeGreaterThanOrEqual(1)
  })

  it('never enlarges', () => {
    expect(fitPixels(800, 600, 1300 * 1300)).toEqual({
      width: 800,
      height: 600,
    })
  })
})

describe.skipIf(process.platform !== 'darwin')('sipsTranscoder (macOS)', () => {
  it('writes a JPEG at the size it was asked for', async () => {
    const source = png(40, 20)
    const out = await sipsTranscoder!.toJpeg(
      { data: source, mediaType: 'image/png' },
      { quality: 75, width: 20, height: 10 },
    )
    expect([out[0], out[1], out[2]]).toEqual([0xff, 0xd8, 0xff])
    expect(imageDimensions(out)).toEqual({ width: 20, height: 10 })
  })

  it('fails instead of returning garbage for bytes that are not an image', async () => {
    await expect(
      sipsTranscoder!.toJpeg(
        {
          data: new TextEncoder().encode('not an image'),
          mediaType: 'image/png',
        },
        { quality: 85, width: 10, height: 10 },
      ),
    ).rejects.toThrow()
  })
})
