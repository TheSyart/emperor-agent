import { describe, expect, it } from 'vitest'
import { mediaRawUrl } from './media'

describe('media raw URLs', () => {
  it('uses the app media protocol without probing an HTTP fallback', () => {
    expect(mediaRawUrl('media_2026-07_abcd1234')).toBe('app://media/media_2026-07_abcd1234/raw')
  })
})
