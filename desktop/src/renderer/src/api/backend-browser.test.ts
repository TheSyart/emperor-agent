import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORE_BRIDGE_UNAVAILABLE_MESSAGE,
  browserAction,
  clearBrowserData,
  closeBrowserView,
  fetchBrowserHistory,
  openBrowserHistoryEntry,
  onBrowserState,
  openBrowserUrl,
  setBrowserBounds,
} from './backend'

const g = globalThis as unknown as { window?: unknown }

afterEach(() => {
  delete g.window
})

describe('embedded browser bridge', () => {
  it('passes the typed text to main and returns the normalized URL', async () => {
    const open = vi.fn(async () => ({
      ok: true,
      url: 'http://localhost:5173/',
    }))
    g.window = { emperor: { openBrowserUrl: open } }

    await expect(openBrowserUrl('localhost:5173')).resolves.toEqual({
      ok: true,
      url: 'http://localhost:5173/',
    })
    expect(open).toHaveBeenCalledWith('localhost:5173')
  })

  it('reports refusals, IPC failures and a missing bridge as ok:false', async () => {
    g.window = {
      emperor: {
        openBrowserUrl: async () => ({
          ok: false,
          error: '只支持 http 和 https 网址',
        }),
      },
    }
    await expect(openBrowserUrl('file:///etc/passwd')).resolves.toEqual({
      ok: false,
      error: '只支持 http 和 https 网址',
    })

    g.window = {
      emperor: {
        openBrowserUrl: async () => {
          throw new Error('IPC caller is not trusted')
        },
      },
    }
    await expect(openBrowserUrl('example.com')).resolves.toEqual({
      ok: false,
      error: 'IPC caller is not trusted',
    })

    g.window = { emperor: { openBrowserUrl: async () => 'weird' } }
    await expect(openBrowserUrl('example.com')).resolves.toEqual({
      ok: false,
      error: '无法打开网址',
    })

    g.window = { emperor: {} }
    await expect(openBrowserUrl('example.com')).resolves.toEqual({
      ok: false,
      error: CORE_BRIDGE_UNAVAILABLE_MESSAGE,
    })
  })

  it('maps bounds, actions, close and state to the browser bridge', () => {
    const bridge = {
      browserBounds: vi.fn(),
      browserAction: vi.fn(),
      browserClose: vi.fn(),
      onBrowserState: vi.fn(() => () => undefined),
    }
    g.window = { emperor: bridge }
    const listener = vi.fn()

    setBrowserBounds({ x: 1, y: 2, width: 640, height: 480 })
    setBrowserBounds(null)
    browserAction('stop')
    closeBrowserView()
    onBrowserState(listener)

    expect(bridge.browserBounds.mock.calls).toEqual([
      [{ x: 1, y: 2, width: 640, height: 480 }],
      [null],
    ])
    expect(bridge.browserAction).toHaveBeenCalledWith('stop')
    expect(bridge.browserClose).toHaveBeenCalledTimes(1)
    expect(bridge.onBrowserState).toHaveBeenCalledWith(listener)

    g.window = { emperor: {} }
    expect(() => setBrowserBounds(null)).not.toThrow()
    expect(onBrowserState(listener)).toBeTypeOf('function')
  })
})

describe('built-in browser history and clearing', () => {
  it('reads well-formed entries only, and nothing without a bridge', async () => {
    await expect(fetchBrowserHistory()).resolves.toEqual([])
    g.window = {
      emperor: {
        browserHistory: async () => [
          { id: 'h2', url: 'https://example.com/b', title: 'B', time: 2 },
          { id: 'h1', url: 'https://example.com/a' },
          'junk',
        ],
      },
    }
    await expect(fetchBrowserHistory()).resolves.toEqual([
      { id: 'h2', url: 'https://example.com/b', title: 'B', time: 2 },
    ])
  })

  it('reopens by id and clears, reporting refusals', async () => {
    const open = vi.fn(async (id: string) =>
      id === 'h1'
        ? { ok: true, url: 'https://example.com/a' }
        : { ok: false, error: '这条记录已不存在' },
    )
    const clear = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'disk busy' })
    g.window = {
      emperor: { openBrowserHistory: open, clearBrowserData: clear },
    }
    await expect(openBrowserHistoryEntry('h1')).resolves.toEqual({
      ok: true,
      url: 'https://example.com/a',
    })
    await expect(openBrowserHistoryEntry('h9')).resolves.toEqual({
      ok: false,
      error: '这条记录已不存在',
    })
    expect(open).toHaveBeenCalledWith('h1')
    await expect(clearBrowserData()).resolves.toEqual({ ok: true })
    await expect(clearBrowserData()).resolves.toEqual({
      ok: false,
      error: 'disk busy',
    })
    delete g.window
    await expect(clearBrowserData()).resolves.toEqual({
      ok: false,
      error: CORE_BRIDGE_UNAVAILABLE_MESSAGE,
    })
  })
})
