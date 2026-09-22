import { describe, expect, it } from 'vitest'
import { floatingMenuLayout } from './floatingMenu'

describe('floatingMenuLayout', () => {
  it('places a menu above the button when there is enough space', () => {
    const layout = floatingMenuLayout({
      buttonRect: { top: 500, bottom: 532, right: 700 },
      menuWidth: 320,
      menuHeight: 220,
      viewportWidth: 900,
      viewportHeight: 700,
    })

    expect(layout.placement).toBe('top')
    expect(layout.left).toBe(380)
    expect(layout.top).toBe(272)
    expect(layout.width).toBe(320)
  })

  it('places a menu below the button when above space is constrained', () => {
    const layout = floatingMenuLayout({
      buttonRect: { top: 48, bottom: 80, right: 260 },
      menuWidth: 390,
      menuHeight: 260,
      viewportWidth: 420,
      viewportHeight: 700,
    })

    expect(layout.placement).toBe('bottom')
    expect(layout.left).toBe(12)
    expect(layout.top).toBe(88)
    expect(layout.width).toBe(390)
    expect(layout.maxHeight).toBe(600)
  })

  it('drops below the button when bottom is preferred and fits', () => {
    const layout = floatingMenuLayout({
      buttonRect: { top: 500, bottom: 532, right: 700 },
      menuWidth: 240,
      menuHeight: 120,
      viewportWidth: 900,
      viewportHeight: 700,
      prefer: 'bottom',
    })

    expect(layout.placement).toBe('bottom')
    expect(layout.top).toBe(540)
  })

  it('flips a bottom-preferred menu above when below lacks room', () => {
    const layout = floatingMenuLayout({
      buttonRect: { top: 600, bottom: 632, right: 700 },
      menuWidth: 240,
      menuHeight: 200,
      viewportWidth: 900,
      viewportHeight: 700,
      prefer: 'bottom',
    })

    expect(layout.placement).toBe('top')
    expect(layout.top).toBe(392)
  })
})
