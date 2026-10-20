import { describe, expect, it, vi } from 'vitest'
import { SCREENSHOT_CAPTURE_CHANNEL } from '../shared/ipc-contract'
import {
  createScreenshotCapture,
  registerScreenshotIpc,
  type ScreenshotCaptureDeps,
} from './screenshot-ipc'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function deps(overrides: Partial<ScreenshotCaptureDeps> = {}) {
  const written = new Map<string, Uint8Array>()
  const removed: string[] = []
  const base: ScreenshotCaptureDeps = {
    platform: 'darwin',
    screenAccess: () => 'granted',
    makeTempDir: async () => '/tmp/emperor-shot-1',
    // The user drags a region: the tool writes the file it was given.
    run: vi.fn(async (args: string[]) => {
      written.set(args.at(-1)!, PNG)
    }),
    readFile: async (path: string) => {
      const data = written.get(path)
      if (!data) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return data
    },
    removeDir: async (path: string) => {
      removed.push(path)
    },
    now: () => new Date(2026, 9, 20, 11, 5, 32),
    ...overrides,
  }
  return { deps: base, written, removed }
}

function windowSpy() {
  const calls: string[] = []
  return {
    calls,
    window: {
      hide: () => calls.push('hide'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
      isDestroyed: () => false,
    },
  }
}

describe('the composer screenshot (UI-S04)', () => {
  it("runs macOS's interactive capture and hands back the PNG", async () => {
    const { deps: d, removed } = deps()
    const { window, calls } = windowSpy()
    const result = await createScreenshotCapture(d)(window)
    expect(d.run).toHaveBeenCalledOnce()
    const args = vi.mocked(d.run).mock.calls[0]![0]
    expect(args.slice(0, -1)).toEqual(['-i', '-x', '-o'])
    expect(args.at(-1)).toMatch(/^\/tmp\/emperor-shot-1\/.+\.png$/)
    expect(result).toEqual({
      ok: true,
      name: '截图 2026-10-20 11.05.32.png',
      mime: 'image/png',
      data: PNG,
    })
    // The temporary folder never outlives the call.
    expect(removed).toEqual(['/tmp/emperor-shot-1'])
    // Emperor steps aside while the user picks, then comes back.
    expect(calls).toEqual(['hide', 'show', 'focus'])
  })

  it('treats Esc (no file, or an empty one) as cancelled', async () => {
    const { deps: none, removed } = deps({ run: vi.fn(async () => undefined) })
    const { window, calls } = windowSpy()
    expect(await createScreenshotCapture(none)(window)).toMatchObject({
      ok: false,
      reason: 'cancelled',
    })
    expect(removed).toEqual(['/tmp/emperor-shot-1'])
    expect(calls).toEqual(['hide', 'show', 'focus'])

    const empty = deps()
    empty.deps.run = vi.fn(async (args: string[]) => {
      empty.written.set(args.at(-1)!, new Uint8Array())
    })
    expect(await createScreenshotCapture(empty.deps)()).toMatchObject({
      ok: false,
      reason: 'cancelled',
    })
  })

  it('says where to allow screen recording, without starting the tool', async () => {
    for (const access of ['denied', 'restricted']) {
      const { deps: d } = deps({ screenAccess: () => access })
      const result = await createScreenshotCapture(d)()
      expect(result).toMatchObject({ ok: false, reason: 'permission' })
      expect(result.ok ? '' : result.message).toContain('录屏与系统录音')
      expect(d.run).not.toHaveBeenCalled()
    }
  })

  it('is macOS only', async () => {
    const { deps: d } = deps({ platform: 'linux' })
    expect(await createScreenshotCapture(d)()).toMatchObject({
      ok: false,
      reason: 'unsupported',
    })
    expect(d.run).not.toHaveBeenCalled()
  })

  it('takes one screenshot at a time', async () => {
    let finish: () => void = () => undefined
    const { deps: d, written } = deps({
      run: vi.fn(
        (args: string[]) =>
          new Promise<void>((resolve) => {
            finish = () => {
              written.set(args.at(-1)!, PNG)
              resolve()
            }
          }),
      ),
    })
    const capture = createScreenshotCapture(d)
    const first = capture()
    await Promise.resolve()
    expect(await capture()).toMatchObject({ ok: false, reason: 'busy' })
    await vi.waitFor(() => expect(d.run).toHaveBeenCalledOnce())
    finish()
    expect((await first).ok).toBe(true)
    // Free again afterwards.
    const again = capture()
    await vi.waitFor(() => expect(d.run).toHaveBeenCalledTimes(2))
    finish()
    expect((await again).ok).toBe(true)
  })

  it('reports a tool that cannot start, and still cleans up', async () => {
    const { deps: d, removed } = deps({
      run: vi.fn(async () => {
        throw Object.assign(new Error('spawn screencapture ENOENT'), {
          code: 'ENOENT',
        })
      }),
    })
    const { window, calls } = windowSpy()
    const result = await createScreenshotCapture(d)(window)
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(removed).toEqual(['/tmp/emperor-shot-1'])
    expect(calls).toEqual(['hide', 'show', 'focus'])
  })

  it('authorizes the sender before capturing', async () => {
    const handlers = new Map<string, (event: unknown) => unknown>()
    const ipcMain = {
      handle: (channel: string, listener: (event: unknown) => unknown) => {
        handlers.set(channel, listener)
      },
    }
    const capture = vi.fn(async () => ({
      ok: false as const,
      reason: 'cancelled' as const,
      message: '',
    }))
    const target = windowSpy().window
    const authorize = vi.fn((event: unknown) => {
      if ((event as { trusted?: boolean }).trusted !== true)
        throw new Error('untrusted sender')
    })
    registerScreenshotIpc({
      ipcMain,
      authorize,
      capture,
      windowOf: () => target,
    })
    const handler = handlers.get(SCREENSHOT_CAPTURE_CHANNEL)!
    expect(() => handler({ trusted: false })).toThrow('untrusted sender')
    expect(capture).not.toHaveBeenCalled()
    await handler({ trusted: true })
    expect(capture).toHaveBeenCalledWith(target)
  })
})
