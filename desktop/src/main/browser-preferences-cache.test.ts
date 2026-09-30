import { describe, expect, it } from 'vitest'
import { BrowserPreferencesCache } from './browser-preferences-cache'

const saved = {
  linkTarget: 'builtin',
  localTarget: 'system',
  showFullUrl: false,
  history: false,
  downloadDirectory: '/Users/me/Downloads/web',
  askWhereToSave: true,
}

describe('BrowserPreferencesCache', () => {
  it('holds the defaults until Core answers, then what Core stored', async () => {
    const cache = new BrowserPreferencesCache()
    expect(cache.current).toEqual({
      linkTarget: 'system',
      localTarget: 'builtin',
      showFullUrl: true,
      history: true,
      downloadDirectory: null,
      askWhereToSave: false,
    })
    await cache.load(async () => saved)
    expect(cache.current).toEqual(saved)
  })

  it('keeps the defaults when Core cannot be read', async () => {
    const cache = new BrowserPreferencesCache()
    await cache.load(async () => {
      throw new Error('core not ready')
    })
    expect(cache.current.history).toBe(true)
    await cache.load(async () => null)
    expect(cache.current.downloadDirectory).toBeNull()
  })

  it('follows the change events and ignores everything else', () => {
    const cache = new BrowserPreferencesCache()
    cache.observe({ event: 'computer_use_changed', preferences: saved })
    cache.observe({ event: 'browser_preferences_changed' })
    cache.observe({ event: 'browser_preferences_changed', preferences: 'x' })
    expect(cache.current.askWhereToSave).toBe(false)
    cache.observe({ event: 'browser_preferences_changed', preferences: saved })
    expect(cache.current).toEqual(saved)
    // Repaired like Core does: a relative folder means the system one.
    cache.observe({
      event: 'browser_preferences_changed',
      preferences: { ...saved, downloadDirectory: 'relative/dir' },
    })
    expect(cache.current.downloadDirectory).toBeNull()
  })

  it('lets a change that arrives during the first read win', async () => {
    const cache = new BrowserPreferencesCache()
    let answer: (value: unknown) => void = () => undefined
    const loading = cache.load(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    cache.observe({
      event: 'browser_preferences_changed',
      preferences: { ...saved, askWhereToSave: false },
    })
    answer(saved)
    await loading
    expect(cache.current.askWhereToSave).toBe(false)
  })
})
