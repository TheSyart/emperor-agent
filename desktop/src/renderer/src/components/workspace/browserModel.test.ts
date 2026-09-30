import { describe, expect, it } from 'vitest'
import type { BrowserViewState, UserDownloadView } from '../../api/backend'
import {
  applyBrowserState,
  browserViewBounds,
  clearBrowserError,
  downloadLine,
  downloadProgress,
  emptyBrowserPage,
  addressText,
  externalOpenAllowed,
  followDownload,
  formatDownloadSize,
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

  it('shows the whole address, or only the site when the setting says so', () => {
    const url = 'https://docs.example.com/guide/intro?tab=2#setup'
    expect(addressText(url, true)).toBe(url)
    expect(addressText(url, false)).toBe('docs.example.com')
    expect(addressText('http://localhost:5173/app', false)).toBe(
      'localhost:5173',
    )
    expect(addressText('', false)).toBe('')
    expect(addressText('not a url', false)).toBe('not a url')
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

describe('download line', () => {
  const view = (patch: Partial<UserDownloadView> = {}): UserDownloadView => ({
    id: 'ud_000000000001',
    name: 'report.csv',
    site: 'https://news.example',
    time: 1,
    state: 'progressing',
    bytes: 0,
    ...patch,
  })

  it('sizes files the way browsers do', () => {
    expect(formatDownloadSize(0)).toBe('0 B')
    expect(formatDownloadSize(1023)).toBe('1023 B')
    expect(formatDownloadSize(2048)).toBe('2.0 KB')
    expect(formatDownloadSize(15 * 1024 * 1024)).toBe('15 MB')
    expect(formatDownloadSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })

  it('shows progress against the announced size, else the bytes so far', () => {
    expect(downloadProgress(view({ bytes: 50, totalBytes: 200 }))).toBe('25%')
    expect(downloadProgress(view({ bytes: 4096, totalBytes: 0 }))).toBe(
      '4.0 KB',
    )
  })

  it('follows the newest download and drops one the user cancelled', () => {
    const first = view()
    const second = view({ id: 'ud_000000000002', time: 2 })
    expect(followDownload(null, first)).toBe(first)
    expect(followDownload(second, first)).toBe(second)
    expect(followDownload(first, second)).toBe(second)
    const done = view({ state: 'completed', bytes: 3, exists: true })
    expect(followDownload(second, done)).toBe(second)
    expect(followDownload(first, done)).toBe(done)
    expect(followDownload(first, view({ state: 'cancelled' }))).toBeNull()
    expect(
      followDownload(
        first,
        view({ id: 'ud_000000000003', time: 3, state: 'cancelled' }),
      ),
    ).toBe(first)
  })

  it('says what happened in one line', () => {
    expect(downloadLine(view({ bytes: 1, totalBytes: 4 }))).toEqual({
      tone: 'progress',
      text: '正在下载 report.csv',
      detail: '25%',
      reveal: false,
    })
    expect(
      downloadLine(view({ state: 'completed', exists: true })),
    ).toMatchObject({
      tone: 'done',
      reveal: true,
    })
    expect(
      downloadLine(view({ state: 'completed', exists: false })),
    ).toMatchObject({
      detail: '文件已移走或删除',
      reveal: false,
    })
    expect(
      downloadLine(view({ state: 'blocked', reason: 'too-large' })),
    ).toMatchObject({
      text: '已拦截 report.csv',
      detail: '超过 2 GB 的文件不会下载',
    })
    expect(downloadLine(view({ state: 'interrupted' }))?.tone).toBe('failed')
    expect(downloadLine(view({ state: 'cancelled' }))).toBeNull()
    expect(downloadLine(null)).toBeNull()
  })
})
