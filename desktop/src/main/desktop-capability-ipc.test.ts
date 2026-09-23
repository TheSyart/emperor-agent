import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_ACTION_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
} from '../shared/ipc-contract'
import { registerDesktopCapabilityIpc } from './desktop-capability-ipc'
import { BROWSER_INPUT_REASONS } from './browser-view-policy'

function fakeBrowser() {
  return {
    openUrl: vi.fn(async (input: { url: string }) => ({
      ok: true as const,
      url: input.url,
    })),
    setBounds: vi.fn(),
    action: vi.fn(),
    close: vi.fn(),
  }
}

describe('desktop capability IPC', () => {
  it('authorizes every request and delegates only capability-shaped inputs', async () => {
    const ipc = new FakeIpcMain()
    const authorize = vi.fn()
    const browser = fakeBrowser()
    const revealPath = vi.fn(() => '/outside/authorized.txt')
    const showItemInFolder = vi.fn()
    const openExternal = vi.fn(async () => undefined)

    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser,
      references: { revealPath },
      showItemInFolder,
      openExternal,
    })

    await expect(
      ipc.invoke(BROWSER_OPEN_CHANNEL, { url: 'localhost:5173' }),
    ).resolves.toEqual({ ok: true, url: 'http://localhost:5173/' })
    await ipc.invoke(REFERENCE_REVEAL_CHANNEL, {
      sessionId: 'session-1',
      referenceId: 'reference-1',
    })
    await ipc.invoke(EXTERNAL_OPEN_CHANNEL, 'https://example.com/docs')
    ipc.emit(BROWSER_BOUNDS_CHANNEL, { x: 1, y: 2, width: 640, height: 480 })
    ipc.emit(BROWSER_ACTION_CHANNEL, 'reload')
    ipc.emit(BROWSER_ACTION_CHANNEL, { action: 'reload' })
    ipc.emit(BROWSER_CLOSE_CHANNEL)

    expect(browser.openUrl).toHaveBeenCalledWith({
      url: 'http://localhost:5173/',
    })
    expect(revealPath).toHaveBeenCalledWith({
      sessionId: 'session-1',
      referenceId: 'reference-1',
    })
    expect(showItemInFolder).toHaveBeenCalledWith('/outside/authorized.txt')
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(browser.setBounds).toHaveBeenCalledWith({
      x: 1,
      y: 2,
      width: 640,
      height: 480,
    })
    expect(browser.action.mock.calls).toEqual([['reload'], ['']])
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledTimes(7)
  })

  it('normalizes browser input in main and never opens rejected URLs', async () => {
    const ipc = new FakeIpcMain()
    const authorize = vi.fn()
    const browser = fakeBrowser()
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser,
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(),
    })

    for (const [payload, reason] of [
      [{ url: 'javascript:alert(1)' }, BROWSER_INPUT_REASONS.scheme],
      [{ url: 'file:///etc/passwd' }, BROWSER_INPUT_REASONS.scheme],
      [{ url: 'data:text/html,hi' }, BROWSER_INPUT_REASONS.scheme],
      [{ url: 'chrome://settings' }, BROWSER_INPUT_REASONS.scheme],
      [
        { url: 'https://token@example.com/' },
        BROWSER_INPUT_REASONS.credentials,
      ],
      [{ url: 'x'.repeat(2049) }, BROWSER_INPUT_REASONS.tooLong],
      [{ url: '   ' }, BROWSER_INPUT_REASONS.empty],
      [{ url: 42 }, BROWSER_INPUT_REASONS.invalid],
      ['https://example.com/', BROWSER_INPUT_REASONS.invalid],
      [null, BROWSER_INPUT_REASONS.invalid],
    ] as const)
      await expect(ipc.invoke(BROWSER_OPEN_CHANNEL, payload)).resolves.toEqual({
        ok: false,
        error: reason,
      })
    expect(browser.openUrl).not.toHaveBeenCalled()

    await expect(
      ipc.invoke(BROWSER_OPEN_CHANNEL, { url: ' example.com/docs ' }),
    ).resolves.toEqual({ ok: true, url: 'https://example.com/docs' })
    expect(browser.openUrl).toHaveBeenCalledWith({
      url: 'https://example.com/docs',
    })

    browser.openUrl.mockRejectedValueOnce(new Error('window is gone: /secret'))
    await expect(
      ipc.invoke(BROWSER_OPEN_CHANNEL, { url: 'https://example.com/' }),
    ).resolves.toEqual({ ok: false, error: '内置浏览器暂不可用' })
    expect(authorize).toHaveBeenCalledTimes(12)
  })

  it('refuses browser requests from untrusted callers before touching the view', async () => {
    const ipc = new FakeIpcMain()
    const browser = fakeBrowser()
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize: () => {
        throw new Error('IPC caller is not trusted')
      },
      browser,
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(),
    })

    await expect(
      ipc.invoke(BROWSER_OPEN_CHANNEL, { url: 'https://example.com/' }),
    ).rejects.toThrow(/not trusted/)
    expect(() =>
      ipc.emit(BROWSER_BOUNDS_CHANNEL, { x: 0, y: 0, width: 640, height: 480 }),
    ).toThrow(/not trusted/)
    expect(() => ipc.emit(BROWSER_ACTION_CHANNEL, 'reload')).toThrow(
      /not trusted/,
    )
    expect(() => ipc.emit(BROWSER_CLOSE_CHANNEL)).toThrow(/not trusted/)
    expect(browser.openUrl).not.toHaveBeenCalled()
    expect(browser.setBounds).not.toHaveBeenCalled()
    expect(browser.action).not.toHaveBeenCalled()
    expect(browser.close).not.toHaveBeenCalled()
  })

  it('rejects renderer-provided local, credential-bearing and custom-protocol external URLs', async () => {
    const ipc = new FakeIpcMain()
    const openExternal = vi.fn(async () => undefined)
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize: vi.fn(),
      browser: fakeBrowser(),
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal,
    })

    for (const url of [
      'http://127.0.0.1:5173/',
      'https://token@example.com/',
      'file:///etc/passwd',
    ]) {
      await expect(ipc.invoke(EXTERNAL_OPEN_CHANNEL, url)).rejects.toThrow(
        /external url/i,
      )
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens Skills folders and picks files through validated main-only capabilities', async () => {
    const ipc = new FakeIpcMain()
    const authorize = vi.fn()
    const folderPath = vi.fn((input: { scope: string }) => {
      if (input.scope === 'project')
        throw Object.assign(new Error('internal detail'), {
          toSafe: () => ({
            code: 'skill_scope_unavailable',
            message: 'Project Skills need a Build session bound to a project',
          }),
        })
      return '/home/me/.emperor/skills'
    })
    const openPath = vi.fn(async () => '')
    const selectFile = vi.fn(async () => '/tmp/skill.zip')
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser: fakeBrowser(),
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(),
      skills: { folderPath },
      openPath,
      selectFile,
    })

    await expect(
      ipc.invoke(SKILLS_OPEN_FOLDER_CHANNEL, { scope: 'user' }),
    ).resolves.toEqual({ ok: true, path: '/home/me/.emperor/skills' })
    expect(folderPath).toHaveBeenCalledWith({ scope: 'user', sessionId: null })
    expect(openPath).toHaveBeenCalledWith('/home/me/.emperor/skills')
    await expect(
      ipc.invoke(SKILLS_OPEN_FOLDER_CHANNEL, {
        scope: 'project',
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Project Skills need a Build session bound to a project',
      // The code travels to the renderer, which turns a missing project folder
      // into its own message instead of surfacing a raw error.
      code: 'skill_scope_unavailable',
    })
    await expect(
      ipc.invoke(SKILLS_OPEN_FOLDER_CHANNEL, { scope: '../etc' }),
    ).rejects.toThrow(/scope/)

    await expect(
      ipc.invoke(SELECT_FILE_CHANNEL, {
        title: 'Pick a zip',
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      }),
    ).resolves.toBe('/tmp/skill.zip')
    expect(selectFile).toHaveBeenCalledWith({
      title: 'Pick a zip',
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    })
    await expect(
      ipc.invoke(SELECT_FILE_CHANNEL, {
        filters: [{ name: 'Bad', extensions: ['../x'] }],
      }),
    ).rejects.toThrow(/filters/)
    expect(authorize).toHaveBeenCalledTimes(5)
  })
})

type Handler = (event: unknown, payload?: unknown) => unknown

class FakeIpcMain {
  private readonly handlers = new Map<string, Handler>()
  private readonly listeners = new Map<string, Handler>()

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }

  on(channel: string, handler: Handler): void {
    this.listeners.set(channel, handler)
  }

  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return await handler({ sender: 'renderer' }, payload)
  }

  emit(channel: string, payload?: unknown): void {
    const handler = this.listeners.get(channel)
    if (!handler) throw new Error(`missing listener: ${channel}`)
    handler({ sender: 'renderer' }, payload)
  }
}
