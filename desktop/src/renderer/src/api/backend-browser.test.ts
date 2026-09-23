import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORE_BRIDGE_UNAVAILABLE_MESSAGE,
  browserAction,
  closeBrowserView,
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
