import { describe, expect, it } from 'vitest'
import type { BrowserViewState } from '../../api/backend'
import {
  applyBrowserState,
  browserViewBounds,
  clearBrowserError,
  emptyBrowserPage,
  externalOpenAllowed,
  isLoopbackUrl,
  rectsIntersect,
  type BrowserPlacement,
} from './browserModel'

function state(patch: Partial<BrowserViewState> = {}): BrowserViewState {
  return {
    url: 'http://localhost:5173/',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...patch,
  }
}

const RECT = { x: 900, y: 120, width: 540, height: 700 }
const CLEAR: BrowserPlacement = {
  shown: true,
  dragging: false,
  transitioning: false,
  modalOpen: false,
  overlays: [],
}

describe('browser model', () => {
  it('recognizes addresses of this machine', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://app.localhost/',
      'http://127.0.0.1:8080/',
      'http://127.1/',
      'http://0.0.0.0:3000/',
      'http://[::1]:5173/',
      'http://[::ffff:127.0.0.1]/',
      'not a url',
    ])
      expect(isLoopbackUrl(url), url).toBe(true)
    for (const url of [
      'https://example.com/',
      'http://192.168.1.2/',
      'http://localhost.example.com/',
    ])
      expect(isLoopbackUrl(url), url).toBe(false)
  })

  it('offers 在外部打开 for credential-free remote http(s) pages only', () => {
    expect(externalOpenAllowed('https://example.com/a')).toBe(true)
    expect(externalOpenAllowed('http://example.com/')).toBe(true)
    expect(externalOpenAllowed('http://localhost:5173/')).toBe(false)
    expect(externalOpenAllowed('https://user:pw@example.com/')).toBe(false)
    expect(externalOpenAllowed('file:///etc/hosts')).toBe(false)
    expect(externalOpenAllowed('')).toBe(false)
  })

  it('keeps a load error until the page leaves that URL or the user acts', () => {
    let page = applyBrowserState(emptyBrowserPage(), state({ loading: true }))
    expect(page.error).toBe('')
    page = applyBrowserState(
      page,
      state({ loading: true, error: 'ERR_CONNECTION_REFUSED (-102)' }),
    )
    expect(page.error).toBe('ERR_CONNECTION_REFUSED (-102)')
    // The stop-loading update after a failure carries no error.
    page = applyBrowserState(page, state())
    expect(page.error).toBe('ERR_CONNECTION_REFUSED (-102)')
    page = applyBrowserState(
      page,
      state({ url: 'chrome-error://chromewebdata/' }),
    )
    expect(page.error).not.toBe('')
    expect(page.state?.url).toBe('http://localhost:5173/')
    // Another URL (a redirect or history move) is a fresh page.
    expect(
      applyBrowserState(page, state({ url: 'https://example.com/' })).error,
    ).toBe('')
    const cleared = clearBrowserError(page)
    expect(cleared.error).toBe('')
    expect(applyBrowserState(cleared, state({ loading: true })).error).toBe('')
    const fresh = emptyBrowserPage()
    expect(clearBrowserError(fresh)).toBe(fresh)
  })

  it('intersects rectangles on open edges', () => {
    expect(rectsIntersect(RECT, { x: 0, y: 0, width: 901, height: 121 })).toBe(
      true,
    )
    expect(rectsIntersect(RECT, { x: 0, y: 0, width: 900, height: 900 })).toBe(
      false,
    )
  })

  it('places the view over the slot while nothing covers it', () => {
    expect(
      browserViewBounds({ x: 900.4, y: 120.6, width: 540, height: 700 }, CLEAR),
    ).toEqual({ x: 900, y: 121, width: 540, height: 700 })
  })

  it('hides the view when the pane, a drag, an animation or a modal says so', () => {
    expect(browserViewBounds(null, CLEAR)).toBeNull()
    for (const patch of [
      { shown: false },
      { dragging: true },
      { transitioning: true },
      { modalOpen: true },
    ])
      expect(browserViewBounds(RECT, { ...CLEAR, ...patch })).toBeNull()
    expect(
      browserViewBounds({ ...RECT, width: 119 }, CLEAR),
      'narrower than main accepts',
    ).toBeNull()
    expect(browserViewBounds({ ...RECT, height: 79 }, CLEAR)).toBeNull()
  })

  it('hides under menus and modals anywhere, popovers only when they overlap', () => {
    const far = { x: 10, y: 10, width: 200, height: 200 }
    const over = { x: 1000, y: 300, width: 200, height: 120 }
    const overlay = { menu: false, modal: false, floating: true, rect: far }
    const hidden = (overlays: BrowserPlacement['overlays']) =>
      browserViewBounds(RECT, { ...CLEAR, overlays }) === null
    expect(hidden([{ ...overlay, menu: true }])).toBe(true)
    expect(hidden([{ ...overlay, modal: true, floating: false }])).toBe(true)
    expect(hidden([overlay])).toBe(false)
    expect(hidden([{ ...overlay, rect: over }])).toBe(true)
    // In-flow listboxes / menus (a sidebar list) never hide the page.
    expect(
      hidden([{ ...overlay, menu: true, floating: false, rect: over }]),
    ).toBe(false)
    expect(
      hidden([{ ...overlay, rect: { ...over, width: 0 } }]),
      'collapsed popover',
    ).toBe(false)
  })
})
