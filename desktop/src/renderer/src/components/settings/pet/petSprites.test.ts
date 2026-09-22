import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PET_IDLE_SPRITE_ID, PET_SPRITES } from './petSprites'

const spriteDir = resolve(
  __dirname,
  '../../../../../../../assets/desktop-pet/clawd-tank',
)

describe('settings pet sprites', () => {
  it('resolves every runtime state to a bundled sprite URL', () => {
    expect(PET_SPRITES).toHaveLength(14)
    for (const sprite of PET_SPRITES) {
      expect(existsSync(resolve(spriteDir, `${sprite.id}.svg`))).toBe(true)
      expect(sprite.url).toMatch(/clawd-|^data:image\/svg\+xml/)
      expect(sprite.url).not.toContain('../../')
    }
    expect(PET_SPRITES.map((sprite) => sprite.id)).toContain(PET_IDLE_SPRITE_ID)
  })
})
