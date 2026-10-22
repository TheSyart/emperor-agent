// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  createSiteIconLoader,
  hydrateMarkdownSiteIcons,
  safeSiteIcon,
} from './siteIcons'
vi.mock('../../../api/http', () => ({ core: vi.fn() }))
const PNG = 'data:image/png;base64,aGVsbG8='
const resource = (i = 0) => ({
  href: `https://same.example/page-${i}`,
  label: 'Site',
  sourceMessageId: 'm1',
})
describe('site icon scheduling and validation', () => {
  it('deduplicates a hundred URL paths while preserving session isolation', async () => {
    const request = vi.fn(async () => PNG)
    const load = createSiteIconLoader(request)
    expect(
      (
        await Promise.all(
          Array.from({ length: 100 }, (_, i) => load('s1', resource(i))),
        )
      ).every((v) => v === PNG),
    ).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    await load('s2', resource())
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('limits concurrency and caches failures rather than retrying every render', async () => {
    let active = 0,
      peak = 0
    const request = vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
      return null
    })
    const load = createSiteIconLoader(request)
    const records = Array.from({ length: 10 }, (_, i) => ({
      ...resource(),
      href: `https://site-${i}.example`,
    }))
    await Promise.all(records.map((r) => load('s1', r)))
    expect(peak).toBeLessThanOrEqual(4)
    await load('s1', records[0]!)
    expect(request).toHaveBeenCalledTimes(10)
  })
  it('accepts only bounded raster data, never third-party URLs or SVG', () => {
    for (const value of [
      'https://tracker.example/icon.png',
      'data:image/svg+xml;base64,aGVsbG8=',
      'javascript:alert(1)',
      `data:image/png;base64,${'A'.repeat(350_000)}`,
    ])
      expect(safeSiteIcon(value)).toBeNull()
    expect(safeSiteIcon(PNG)).toBe(PNG)
  })
  it('does not request offscreen elements and disconnects the visibility observer on disposal', () => {
    const observe = vi.fn(),
      disconnect = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = observe
        disconnect = disconnect
      },
    )
    const root = document.createElement('div')
    root.innerHTML =
      '<a class="md-link-chip" data-resource-kind="web" href="https://offscreen.example">offscreen</a>'
    const dispose = hydrateMarkdownSiteIcons(root, 's1', 'm1')
    expect(observe).toHaveBeenCalledTimes(1)
    dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})

describe('site icon privacy switch', () => {
  it('makes no request while 显示网站图标 is off, and loads once it is on', async () => {
    const { core } = await import('../../../api/http')
    const { loadSiteIcon } = await import('./siteIcons')
    const { setUiPreference } =
      await import('../../../composables/useUiPreferences')
    const call = vi.mocked(core)
    call.mockReset()
    setUiPreference('siteIcons', false)
    expect(await loadSiteIcon('s1', resource(90))).toBeNull()
    expect(call).not.toHaveBeenCalled()

    call.mockImplementation((async (op: string) =>
      op === 'references.resolve'
        ? { id: 'ref_1' }
        : { state: 'ready', dataUrl: PNG }) as never)
    setUiPreference('siteIcons', true)
    expect(await loadSiteIcon('s1', resource(91))).toBe(PNG)
    expect(call).toHaveBeenCalledWith('references.siteIcon', {
      sessionId: 's1',
      referenceId: 'ref_1',
    })
    setUiPreference('siteIcons', false)
  })
})
