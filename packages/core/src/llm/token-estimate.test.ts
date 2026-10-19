// Heuristic token pricing (KRN-05): text by character class (DSH-25) and
// images by route (DSH-13), plus the image-header size reader that gives
// stored attachments their pixel size.
import { describe, expect, it } from 'vitest'
import { imageDimensions } from '../attachments/image-dimensions'
import { textOnlyImageText } from './content'
import {
  estimateImageTokens,
  estimateTextTokens,
  imagePricingForRoute,
} from './token-estimate'
import type { ImageAttachmentRef } from './types'

const PASSAGE =
  '上下文接近上限时，代理会先截短较早的工具结果，再把较早的对话压缩成一份摘要，保留最近的内容。'

function chinese(length: number): string {
  let text = ''
  while (text.length < length) text += PASSAGE
  return text.slice(0, length)
}

function image(width?: number, height?: number): ImageAttachmentRef {
  return {
    attachmentId: 'att_2026-10_00000001',
    mediaType: 'image/png',
    bytes: 300_000,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  }
}

describe('estimateTextTokens', () => {
  it('prices 10,000 Chinese characters at 9,000–11,000 tokens (KRN-05 #5)', () => {
    const tokens = estimateTextTokens(chinese(10_000))
    expect(tokens).toBeGreaterThanOrEqual(9_000)
    expect(tokens).toBeLessThanOrEqual(11_000)
  })

  it('weights ASCII at 4 characters, CJK and kana at 1, other scripts at 2 per token', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('a'.repeat(400))).toBe(100)
    expect(estimateTextTokens('漢字かなカナ')).toBe(6)
    // CJK Extension B is outside the BMP: one code point, one token.
    expect(estimateTextTokens('𠀀𠀁')).toBe(2)
    expect(estimateTextTokens('Привет')).toBe(3)
    expect(estimateTextTokens('你好, world')).toBe(2 + 2)
  })
})

describe('estimateImageTokens', () => {
  it('prices a 1024×1024 image at no more than 1024 tokens on DeepSeek (KRN-05 #8)', () => {
    const tokens = estimateImageTokens(image(1024, 1024), 'deepseek')
    expect(tokens).toBeLessThanOrEqual(1024)
    expect(tokens).toBeGreaterThan(512)
    // 14px patch grid below the cap: 16 × 16 patches.
    expect(estimateImageTokens(image(224, 224), 'deepseek')).toBe(256)
  })

  it('prices Anthropic routes at (w×h)/750 and OpenAI routes by 512px tiles', () => {
    expect(estimateImageTokens(image(1000, 1000), 'anthropic')).toBe(1334)
    // Long edge above 1568 is scaled down first; the result stays near 1600.
    expect(estimateImageTokens(image(4000, 3000), 'anthropic')).toBe(1600)
    // 1024² → shortest side 768 → 2 × 2 tiles.
    expect(estimateImageTokens(image(1024, 1024), 'openai')).toBe(85 + 170 * 4)
    expect(estimateImageTokens(image(512, 512), 'openai')).toBe(85 + 170)
  })

  it('assumes the largest price when the size is unknown, and text on text-only routes', () => {
    expect(estimateImageTokens(image(), 'deepseek')).toBe(1024)
    expect(estimateImageTokens(image(), 'anthropic')).toBe(1600)
    expect(estimateImageTokens(image(), 'openai')).toBe(85 + 170 * 8)
    expect(estimateImageTokens(image(1024, 1024), 'text')).toBe(
      estimateTextTokens(textOnlyImageText(image())),
    )
  })

  it('chooses the pricing from the route', () => {
    expect(
      imagePricingForRoute({
        adapter: 'deepseek',
        protocol: 'openai',
        vision: true,
      }),
    ).toBe('deepseek')
    expect(
      imagePricingForRoute({
        adapter: 'pi-ai',
        protocol: 'anthropic',
        vision: true,
      }),
    ).toBe('anthropic')
    expect(
      imagePricingForRoute({
        adapter: 'pi-ai',
        protocol: 'openai',
        vision: true,
      }),
    ).toBe('openai')
    expect(
      imagePricingForRoute({
        adapter: 'deepseek',
        protocol: 'openai',
        vision: false,
      }),
    ).toBe('text')
  })
})

describe('imageDimensions', () => {
  it('reads PNG, GIF, JPEG and WebP headers', () => {
    const png = new Uint8Array(32)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
    png.set([0, 0, 0x04, 0x00, 0, 0, 0x03, 0x00], 16)
    expect(imageDimensions(png)).toEqual({ width: 1024, height: 768 })

    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00,
    ])
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 240 })

    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
    ])
    expect(imageDimensions(jpeg)).toEqual({ width: 800, height: 600 })

    const vp8x = new Uint8Array(30)
    vp8x.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    vp8x.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0], 12)
    // canvas 1920×1080, stored minus one, 24-bit little endian
    vp8x.set([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00], 24)
    expect(imageDimensions(vp8x)).toEqual({ width: 1920, height: 1080 })

    const vp8l = new Uint8Array(25)
    vp8l.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    vp8l.set([0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f], 12)
    // (w−1) | (h−1) << 14 for 100×50
    const bits = 99 | (49 << 14)
    vp8l.set(
      [bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24],
      21,
    )
    expect(imageDimensions(vp8l)).toEqual({ width: 100, height: 50 })
  })

  it('returns null for unknown or truncated data', () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
  })
})
