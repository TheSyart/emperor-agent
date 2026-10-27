/**
 * BRD-05: the token tables main checks skins against, read from the
 * renderer's own theme files, so the allowlist never drifts from them.
 */
import { describe, expect, it } from 'vitest'
import { themeTokens } from './theme-sources'

describe('the skin token allowlist', () => {
  it('lets a skin change surfaces, text, strokes, the brand and the accent', () => {
    for (const key of [
      '--surface-canvas',
      '--surface-base',
      '--surface-raised',
      '--surface-hover',
      '--text-1',
      '--text-2',
      '--text-link',
      '--stroke-2',
      '--hairline',
      '--accent',
      '--accent-soft',
      '--brand',
      '--focus-ring',
      '--bubble-user',
    ])
      expect(themeTokens.allowlist.has(key), key).toBe(true)
  })

  it('never sizes, spacing, radii, fonts, status colours or a11y-owned lines', () => {
    for (const key of [
      '--radius-card',
      '--r-md',
      '--fs-s',
      '--lh-s',
      '--space-4',
      '--font-sans',
      '--ok',
      '--error',
      '--warn',
      '--attention',
      '--info',
      '--elev-1',
      '--scrim',
      '--surface-hover-danger',
      '--stroke-solid',
      '--stroke-solid-strong',
      '--input-major',
      '--gold-500',
    ])
      expect(themeTokens.allowlist.has(key), key).toBe(false)
  })

  it('knows which tokens take a triplet and which a full colour', () => {
    expect(themeTokens.allowlist.get('--surface-canvas')).toBe('triplet')
    expect(themeTokens.allowlist.get('--text-1')).toBe('triplet')
    expect(themeTokens.allowlist.get('--surface-hover')).toBe('colour')
    expect(themeTokens.allowlist.get('--stroke-2')).toBe('colour')
    expect(themeTokens.allowlist.get('--hairline')).toBe('colour')
  })
})

describe('resolving the base themes', () => {
  it('follows var() through the layers', () => {
    expect(themeTokens.resolve('light', '--surface-canvas')).toBe('246 245 242')
    expect(themeTokens.resolve('dark', '--surface-canvas')).toBe('20 20 19')
    expect(themeTokens.resolve('light', '--input-major')).toBe('255 255 255')
    expect(themeTokens.resolve('dark', '--input-major')).toBe('33 33 32')
    expect(themeTokens.resolve('light', '--hairline')).toBe('rgb(0 0 0 / 0.12)')
    expect(themeTokens.resolve('light', '--nope')).toBeNull()
  })

  it('lists every token built on a changed one, per theme', () => {
    const light = themeTokens.dependents('light', ['--surface-base'])
    expect(light.has('--surface-base')).toBe(true)
    expect(light.has('--input-major')).toBe(true)
    expect(light.has('--settings-card-control-fill')).toBe(true)
    expect(light.has('--env-card-fill')).toBe(true)
    expect(light.has('--text-1')).toBe(false)
    // On dark the composer fill rests on --surface-raised, not --surface-base.
    expect(
      themeTokens.dependents('dark', ['--surface-base']).has('--input-major'),
    ).toBe(false)
    const strokes = themeTokens.dependents('light', ['--stroke-2'])
    expect(strokes.has('--hairline')).toBe(true)
    expect(strokes.has('--composer-edge')).toBe(true)
  })
})
