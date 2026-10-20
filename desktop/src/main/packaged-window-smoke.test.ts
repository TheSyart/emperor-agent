import { describe, expect, it, vi } from 'vitest'
import {
  verifyWindowReopen,
  WINDOW_PROBE_SOURCE,
  type SmokeWindow,
} from './packaged-window-smoke'

let nextId = 1

function fakeWindow(answer: unknown = { mounted: true, coreBootstrap: true }) {
  let destroyed = false
  const win: SmokeWindow & { destroyNow(): void } = {
    id: nextId++,
    isDestroyed: () => destroyed,
    destroyNow: () => {
      destroyed = true
    },
    webContents: { executeJavaScript: vi.fn(async () => answer) },
  }
  return win
}

/** The real main-window bookkeeping, as index.ts does it. */
function harness(
  options: {
    reopenSame?: boolean
    keepOnClose?: boolean
    secondAnswer?: unknown
  } = {},
) {
  let current: ReturnType<typeof fakeWindow> | null = null
  const opened: Array<ReturnType<typeof fakeWindow>> = []
  const make = (answer?: unknown) => {
    const win = fakeWindow(answer)
    opened.push(win)
    current = win
    return win
  }
  return {
    opened,
    open: vi.fn(async () => make()),
    close: vi.fn(async (win: SmokeWindow) => {
      ;(win as ReturnType<typeof fakeWindow>).destroyNow()
      if (!options.keepOnClose) current = null
    }),
    reopen: vi.fn(async () =>
      options.reopenSame && opened[0] ? opened[0] : make(options.secondAnswer),
    ),
    current: () => current,
  }
}

describe('packaged smoke: close the main window and open it again (REL-04)', () => {
  it('closes the main window, reopens a new one through activate, and its UI talks to Core', async () => {
    const h = harness()
    const receipt = await verifyWindowReopen(h)
    expect(receipt).toEqual({
      ok: true,
      opened: true,
      closed: true,
      reopened: true,
      distinctWindow: true,
      coreAfterReopen: true,
    })
    expect(h.open).toHaveBeenCalledOnce()
    expect(h.reopen).toHaveBeenCalledOnce()
    // Both windows closed again at the end.
    expect(h.close).toHaveBeenCalledTimes(2)
    expect(h.opened.every((win) => win.isDestroyed())).toBe(true)
    for (const win of h.opened)
      expect(win.webContents.executeJavaScript).toHaveBeenCalledWith(
        WINDOW_PROBE_SOURCE,
      )
  })

  it('fails when closing leaves the main window behind', async () => {
    await expect(
      verifyWindowReopen(harness({ keepOnClose: true })),
    ).rejects.toThrow(/closing the main window left it behind/)
  })

  it('fails when activate brings back the closed window instead of a new one', async () => {
    await expect(
      verifyWindowReopen(harness({ reopenSame: true })),
    ).rejects.toThrow(/did not open a new main window/)
  })

  it('fails when the reopened window does not reach Core', async () => {
    await expect(
      verifyWindowReopen(
        harness({ secondAnswer: { mounted: true, coreBootstrap: false } }),
      ),
    ).rejects.toThrow(/reopened main window did not load/)
  })

  it('times out instead of hanging on a window that never loads', async () => {
    const h = harness()
    h.open.mockImplementation(() => new Promise<never>(() => {}))
    await expect(verifyWindowReopen({ ...h, timeoutMs: 20 })).rejects.toThrow(
      /timed out/,
    )
  })

  it('probes the mounted UI and a Core bootstrap through the preload bridge', () => {
    expect(WINDOW_PROBE_SOURCE).toContain("invokeCore('bootstrap')")
    expect(WINDOW_PROBE_SOURCE).toContain("querySelector('#app')")
  })
})
