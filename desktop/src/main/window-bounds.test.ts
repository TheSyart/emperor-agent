import { describe, it, expect } from 'vitest'
import { normalizeBounds, readBounds, pickBounds, DEFAULT_BOUNDS, MIN_BOUNDS } from './window-bounds'

describe('normalizeBounds', () => {
  it('returns the default size with no position when given nothing', () => {
    expect(normalizeBounds({})).toEqual({ ...DEFAULT_BOUNDS })
  })

  it('raises sub-minimum sizes to the minimum', () => {
    const b = normalizeBounds({ width: 100, height: 100 })
    expect(b.width).toBe(MIN_BOUNDS.width)
    expect(b.height).toBe(MIN_BOUNDS.height)
  })

  it('preserves a valid position', () => {
    expect(normalizeBounds({ width: 1400, height: 900, x: 10, y: 20 })).toEqual({
      width: 1400,
      height: 900,
      x: 10,
      y: 20,
    })
  })

  it('drops a partial/invalid position', () => {
    const b = normalizeBounds({ width: 1400, height: 900, x: NaN, y: 20 })
    expect('x' in b).toBe(false)
    expect('y' in b).toBe(false)
  })
})

describe('readBounds', () => {
  it('falls back to defaults when the file cannot be read', () => {
    const readFile = () => {
      throw new Error('ENOENT')
    }
    expect(readBounds('/nope/window.json', { readFile })).toEqual({ ...DEFAULT_BOUNDS })
  })

  it('normalizes a stored payload', () => {
    const readFile = () => JSON.stringify({ width: 100, height: 100, x: 5, y: 6 })
    const b = readBounds('/x/window.json', { readFile })
    expect(b.width).toBe(MIN_BOUNDS.width)
    expect(b.x).toBe(5)
  })
})

describe('pickBounds', () => {
  it('keeps only geometry fields', () => {
    expect(pickBounds({ x: 1, y: 2, width: 3, height: 4, extra: 'drop' } as never)).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    })
  })
})
