import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ASSETS,
  SPRITE_FRAME,
  SPRITES,
  spriteFor,
} from '../../../../../pet/event-mapper.js'
import { PET_FRAME, PET_IDLE_SPRITE_ID, PET_SPRITES } from './petSprites'

const spriteDir = resolve(
  __dirname,
  '../../../../../../../assets/desktop-pet/xiaodan',
)

/** Canvas size from a WebP header (VP8X, lossy VP8 or lossless VP8L). */
function webpSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP')
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X')
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    }
  if (chunk === 'VP8 ')
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  throw new Error(`unknown WebP chunk ${chunk} in ${path}`)
}

describe('settings pet sprites', () => {
  it('resolves every runtime state to a bundled strip URL', () => {
    expect(PET_SPRITES).toHaveLength(14)
    for (const sprite of PET_SPRITES) {
      expect(existsSync(resolve(spriteDir, sprite.strip.file))).toBe(true)
      expect(sprite.url).toMatch(/xiaodan-/)
      expect(sprite.url).not.toContain('../../')
    }
    expect(PET_SPRITES.map((sprite) => sprite.id)).toContain(PET_IDLE_SPRITE_ID)
  })

  it('mirrors the pet window state table exactly', () => {
    expect(PET_FRAME).toEqual(SPRITE_FRAME)
    expect(PET_SPRITES.map((sprite) => sprite.id).sort()).toEqual(
      Object.keys(ASSETS).sort(),
    )
    for (const sprite of PET_SPRITES)
      expect(sprite.strip).toEqual(spriteFor(sprite.id))
  })

  it('declares the frame count each strip actually has', () => {
    for (const strip of Object.values(SPRITES)) {
      const size = webpSize(resolve(spriteDir, strip.file))
      expect(size, strip.file).toEqual({
        width: strip.frames * SPRITE_FRAME.width,
        height: SPRITE_FRAME.height,
      })
      expect(strip.frames, strip.file).toBeGreaterThan(1)
      expect(strip.fps, strip.file).toBeGreaterThan(0)
    }
  })

  it('ships no strip the pet never plays', () => {
    const used = new Set(Object.values(SPRITES).map((strip) => strip.file))
    const shipped = readdirSync(spriteDir).filter((file) =>
      file.endsWith('.webp'),
    )
    expect(shipped.sort()).toEqual([...used].sort())
    for (const key of Object.values(ASSETS)) expect(SPRITES).toHaveProperty(key)
  })
})
