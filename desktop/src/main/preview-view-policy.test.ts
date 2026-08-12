import { describe, expect, it } from 'vitest'
import {
  normalizedPreviewBounds,
  previewExternalNavigationEligible,
  previewNavigationAllowed,
} from './preview-view-policy'

describe('preview view policy', () => {
  it('accepts bounded renderer rectangles', () => {
    expect(
      normalizedPreviewBounds({ x: 2.4, y: 3.6, width: 640, height: 480 }),
    ).toEqual({
      x: 2,
      y: 4,
      width: 640,
      height: 480,
    })
    expect(
      normalizedPreviewBounds({ x: 0, y: 0, width: 1, height: 1 }),
    ).toBeNull()
  })

  it('allows only the registered loopback origin', () => {
    expect(
      previewNavigationAllowed(
        'http://127.0.0.1:4173/page',
        'http://127.0.0.1:4173/',
      ),
    ).toBe(true)
    expect(
      previewNavigationAllowed(
        'http://127.0.0.1:5173/',
        'http://127.0.0.1:4173/',
      ),
    ).toBe(false)
    expect(
      previewNavigationAllowed(
        'https://example.com/',
        'http://127.0.0.1:4173/',
      ),
    ).toBe(false)
    expect(
      previewNavigationAllowed('file:///etc/passwd', 'http://127.0.0.1:4173/'),
    ).toBe(false)
  })

  it('opens only remote credential-free links in the system browser', () => {
    expect(previewExternalNavigationEligible('https://example.com/docs')).toBe(
      true,
    )
    expect(previewExternalNavigationEligible('http://127.0.0.1:5173/')).toBe(
      false,
    )
    expect(
      previewExternalNavigationEligible('https://token@example.com/'),
    ).toBe(false)
  })
})
