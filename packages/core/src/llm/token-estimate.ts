/**
 * Heuristic token pricing shared by the token meter, compaction and the
 * request-size checks (KRN-05). No tokenizer is loaded: text is priced by
 * character class (DSH-25) and an image by the route that will see it
 * (DSH-13). The token meter calibrates these figures per session against
 * the usage the provider reports.
 *
 * Browser-safe: no `node:` imports.
 */

import { textOnlyImageText } from './content'
import type { RouteSpec } from './route'
import type { ImageAttachmentRef } from './types'

/** ASCII characters per token (English prose, code, JSON). */
const ASCII_CHARS_PER_TOKEN = 4
/** Characters per token for scripts other than ASCII, CJK and kana. */
const OTHER_CHARS_PER_TOKEN = 2

/** CJK unified (and compatibility) ideographs and kana: one token each. */
function isCjkOrKana(point: number): boolean {
  return (
    (point >= 0x4e00 && point <= 0x9fff) || // CJK Unified Ideographs
    (point >= 0x3400 && point <= 0x4dbf) || // Extension A
    (point >= 0x20000 && point <= 0x323af) || // Extensions B–H
    (point >= 0xf900 && point <= 0xfaff) || // Compatibility Ideographs
    (point >= 0x2f800 && point <= 0x2fa1f) || // Compatibility Supplement
    (point >= 0x3040 && point <= 0x30ff) || // Hiragana, Katakana
    (point >= 0x31f0 && point <= 0x31ff) || // Katakana Phonetic Extensions
    (point >= 0xff66 && point <= 0xff9f) // Halfwidth Katakana
  )
}

/**
 * Estimated tokens of one text: a CJK ideograph or kana ≈ 1 token, ASCII
 * ≈ 4 characters per token, every other character ≈ 2 per token.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) {
      ascii += 1
      continue
    }
    let point = unit
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        point = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        index += 1
      }
    }
    if (isCjkOrKana(point)) cjk += 1
    else other += 1
  }
  return (
    cjk +
    Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) +
    Math.ceil(other / OTHER_CHARS_PER_TOKEN)
  )
}

/** How a route charges for one image; `text` routes see a placeholder. */
export type ImagePricing = 'deepseek' | 'anthropic' | 'openai' | 'text'

/** The image pricing of the route a request is sent to. */
export function imagePricingForRoute(
  route: Pick<RouteSpec, 'adapter' | 'protocol' | 'vision'>,
): ImagePricing {
  if (!route.vision) return 'text'
  if (route.adapter === 'deepseek') return 'deepseek'
  return route.protocol === 'anthropic' ? 'anthropic' : 'openai'
}

// DeepSeek: a 14px patch grid, at most 1024 tokens per image.
const DEEPSEEK_PATCH_PX = 14
const DEEPSEEK_MAX_IMAGE_TOKENS = 1024
// Anthropic: (w × h) / 750 after fitting the long edge into 1568px (~1600 max).
const ANTHROPIC_PIXELS_PER_TOKEN = 750
const ANTHROPIC_MAX_EDGE_PX = 1568
const ANTHROPIC_MAX_IMAGE_TOKENS = 1600
// OpenAI high detail: fit 2048², shortest side to 768, 85 + 170 per 512px tile.
const OPENAI_BASE_TOKENS = 85
const OPENAI_TILE_TOKENS = 170
const OPENAI_TILE_PX = 512
const OPENAI_MAX_EDGE_PX = 2048
const OPENAI_SHORT_EDGE_PX = 768
const OPENAI_MAX_TILES = 8

function knownSize(
  ref: ImageAttachmentRef,
): { width: number; height: number } | undefined {
  const { width, height } = ref
  if (
    width === undefined ||
    height === undefined ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return undefined
  return { width, height }
}

/**
 * Estimated tokens of one image on a route. An image of unknown size is
 * priced at the route's largest image.
 */
export function estimateImageTokens(
  ref: ImageAttachmentRef,
  pricing: ImagePricing,
): number {
  if (pricing === 'text') return estimateTextTokens(textOnlyImageText(ref))
  const size = knownSize(ref)
  switch (pricing) {
    case 'deepseek':
      if (size === undefined) return DEEPSEEK_MAX_IMAGE_TOKENS
      return Math.min(
        DEEPSEEK_MAX_IMAGE_TOKENS,
        Math.ceil(size.width / DEEPSEEK_PATCH_PX) *
          Math.ceil(size.height / DEEPSEEK_PATCH_PX),
      )
    case 'anthropic': {
      if (size === undefined) return ANTHROPIC_MAX_IMAGE_TOKENS
      const scale = Math.min(
        1,
        ANTHROPIC_MAX_EDGE_PX / Math.max(size.width, size.height),
      )
      const width = Math.round(size.width * scale)
      const height = Math.round(size.height * scale)
      return Math.min(
        ANTHROPIC_MAX_IMAGE_TOKENS,
        Math.ceil((width * height) / ANTHROPIC_PIXELS_PER_TOKEN),
      )
    }
    case 'openai': {
      if (size === undefined)
        return OPENAI_BASE_TOKENS + OPENAI_TILE_TOKENS * OPENAI_MAX_TILES
      const fit = Math.min(
        1,
        OPENAI_MAX_EDGE_PX / Math.max(size.width, size.height),
      )
      let width = size.width * fit
      let height = size.height * fit
      const short = Math.min(1, OPENAI_SHORT_EDGE_PX / Math.min(width, height))
      width = Math.round(width * short)
      height = Math.round(height * short)
      const tiles =
        Math.ceil(width / OPENAI_TILE_PX) * Math.ceil(height / OPENAI_TILE_PX)
      return OPENAI_BASE_TOKENS + OPENAI_TILE_TOKENS * tiles
    }
  }
}
