import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PREVIEW_INPUT_CHANNEL,
  AGENT_DOWNLOAD_MOVE_CHANNEL,
  AGENT_DOWNLOAD_REVEAL_CHANNEL,
  AGENT_PREVIEW_START_CHANNEL,
  AGENT_PREVIEW_STOP_CHANNEL,
  BROWSER_ACTION_CHANNEL,
  BROWSER_PAIRING_APPROVE_CHANNEL,
  BROWSER_PAIRING_DENY_CHANNEL,
  BROWSER_PAIRING_REVOKE_CHANNEL,
  BROWSER_CONNECT_CHANNEL,
  BROWSER_PAIRING_STATUS_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  MAC_HELPER_PERMISSION_CHANNEL,
  MAC_HELPER_RECONNECT_CHANNEL,
  MAC_HELPER_STATUS_CHANNEL,
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
  it('redacts pairing secrets and accepts only canonical pairing identities', async () => {
    const ipc = new FakeIpcMain()
    const authorize = vi.fn()
    const pairingId = 'A'.repeat(21) + 'Q'
    const bridge = {
      isListening: true,
      pendingPairings: () => [
        {
          pairingId,
          extensionId: 'a'.repeat(32),
          code: '123456',
          displayed: true,
          secret: 'must-not-cross-ipc',
        },
      ],
      readyPairings: () => [pairingId],
      approvePairing: vi.fn(async () => true),
      denyPairing: vi.fn(() => true),
      revokePairing: vi.fn(async () => undefined),
      connectBrowsers: vi.fn(async () => ({
        browsers: ['chrome', '../evil'],
      })),
    }
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser: fakeBrowser(),
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(),
      browserPairings: bridge,
      externalAttachedCount: () => 2,
    })
    const status = await ipc.invoke(BROWSER_PAIRING_STATUS_CHANNEL)
    expect(status).toEqual({
      bridgeListening: true,
      pendingPairings: [
        {
          pairingId,
          extensionId: 'a'.repeat(32),
          code: '123456',
          displayed: true,
        },
      ],
      pairedConnections: [pairingId],
      attachedTabs: 2,
    })
    expect(JSON.stringify(status)).not.toContain('must-not-cross-ipc')
    await expect(
      ipc.invoke(BROWSER_PAIRING_APPROVE_CHANNEL, { pairingId }),
    ).resolves.toEqual({ approved: true })
    await expect(
      ipc.invoke(BROWSER_PAIRING_DENY_CHANNEL, { pairingId }),
    ).resolves.toEqual({ denied: true })
    await expect(
      ipc.invoke(BROWSER_PAIRING_REVOKE_CHANNEL, { pairingId }),
    ).resolves.toEqual({ revoked: true })
    await expect(
      ipc.invoke(BROWSER_PAIRING_APPROVE_CHANNEL, { pairingId: '../secret' }),
    ).rejects.toThrow('invalid browser pairing id')
    expect(bridge.approvePairing).toHaveBeenCalledTimes(1)
    expect(bridge.denyPairing).toHaveBeenCalledTimes(1)
    expect(bridge.revokePairing).toHaveBeenCalledTimes(1)
    // Only plain browser keys cross back to the renderer.
    await expect(ipc.invoke(BROWSER_CONNECT_CHANNEL)).resolves.toEqual({
      browsers: ['chrome'],
    })
    expect(authorize).toHaveBeenCalledTimes(6)
  })
  it('exposes bounded helper diagnostics and only explicit permission requests', async () => {
    const ipc = new FakeIpcMain()
    const authorize = vi.fn()
    const requestPermission = vi.fn(async () => ({ opened: true }))
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser: fakeBrowser(),
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(),
      macHelper: {
        status: async () =>
          ({
            available: true,
            connected: true,
            helperVersion: '1.0',
            protocol: 1,
            permissions: {
              accessibility: 'granted',
              'screen-recording': 'denied',
            },
            lastErrorCode: null,
            nonce: 'must-not-cross-ipc',
          }) as never,
        requestPermission,
        resetPermission: vi.fn(),
      },
    })
    const status = await ipc.invoke(MAC_HELPER_STATUS_CHANNEL)
    expect(status).toMatchObject({
      connected: true,
      helperVersion: '1.0',
      protocol: 1,
      permissions: { accessibility: 'granted', 'screen-recording': 'denied' },
    })
    expect(JSON.stringify(status)).not.toContain('must-not-cross-ipc')
    expect(requestPermission).not.toHaveBeenCalled()
    await expect(
      ipc.invoke(MAC_HELPER_PERMISSION_CHANNEL, {
        permission: 'accessibility',
      }),
    ).resolves.toEqual({ opened: true })
    expect(requestPermission).toHaveBeenCalledWith('accessibility')
    await expect(
      ipc.invoke(MAC_HELPER_PERMISSION_CHANNEL, {
        permission: 'tccutil-reset',
      }),
    ).rejects.toThrow(/invalid helper permission/)
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledTimes(3)
  })
  it('resets only a named helper permission after trusted renderer authorization', async () => {
    const ipc = new FakeIpcMain()
    const authorize = vi.fn()
    const resetPermission = vi.fn(async () => ({ reset: true }))
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser: fakeBrowser(),
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(),
      macHelper: {
        status: vi.fn(),
        requestPermission: vi.fn(),
        resetPermission,
      } as never,
    })
    expect(resetPermission).not.toHaveBeenCalled()
    await expect(
      ipc.invoke('emperor:computer-use:mac-helper-reset', {
        permission: 'screen-recording',
      }),
    ).resolves.toEqual({ reset: true })
    await expect(
      ipc.invoke('emperor:computer-use:mac-helper-reset', {
        permission: 'FullDiskAccess',
      }),
    ).rejects.toThrow(/invalid helper permission/)
    expect(resetPermission).toHaveBeenCalledOnce()
    expect(resetPermission).toHaveBeenCalledWith('screen-recording')
    expect(authorize).toHaveBeenCalledTimes(2)
  })
  it('reconnects the helper only after authorization and returns bounded status', async () => {
    const ipc = new FakeIpcMain()
    const authorize = vi.fn()
    const reconnect = vi.fn(
      async () =>
        ({
          available: true,
          connected: false,
          helperVersion: null,
          protocol: null,
          permissions: {
            accessibility: 'unknown',
            'screen-recording': 'unknown',
          },
          lastErrorCode: 'DRIVER_UNAVAILABLE',
          reason: 'Helper 在一分钟内崩溃超过 3 次，已停止自动重启',
          autoRestartSuspended: true,
          nonce: 'must-not-cross-ipc',
        }) as never,
    )
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser: fakeBrowser(),
      references: { revealPath: vi.fn() },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(),
      macHelper: {
        status: vi.fn(),
        requestPermission: vi.fn(),
        resetPermission: vi.fn(),
        reconnect,
      } as never,
    })
    expect(reconnect).not.toHaveBeenCalled()
    const status = await ipc.invoke(MAC_HELPER_RECONNECT_CHANNEL)
    expect(status).toMatchObject({
      connected: false,
      lastErrorCode: 'DRIVER_UNAVAILABLE',
      autoRestartSuspended: true,
    })
    expect(JSON.stringify(status)).not.toContain('must-not-cross-ipc')
    expect(reconnect).toHaveBeenCalledOnce()
    reconnect.mockRejectedValueOnce(new Error('/private/path nonce'))
    const failed = await ipc.invoke(MAC_HELPER_RECONNECT_CHANNEL)
    expect(failed).toMatchObject({
      connected: false,
      reason: '无法连接 Emperor Computer Helper',
    })
    expect(JSON.stringify(failed)).not.toContain('/private/path')
    authorize.mockImplementationOnce(() => {
      throw new Error('untrusted renderer')
    })
    await expect(ipc.invoke(MAC_HELPER_RECONNECT_CHANNEL)).rejects.toThrow(
      /untrusted renderer/,
    )
    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(authorize).toHaveBeenCalledTimes(3)
  })
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
    // One-way messages are dropped quietly: nothing reaches the view and
    // nothing is thrown into the main process.
    expect(() =>
      ipc.emit(BROWSER_BOUNDS_CHANNEL, { x: 0, y: 0, width: 640, height: 480 }),
    ).not.toThrow()
    expect(() => ipc.emit(BROWSER_ACTION_CHANNEL, 'reload')).not.toThrow()
    expect(() => ipc.emit(BROWSER_CLOSE_CHANNEL)).not.toThrow()
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

describe('agent preview IPC', () => {
  const id = 'tab_0f8fad5b-d9cb-469f-a165-70867728950e'
  function setup(authorize = vi.fn()) {
    const ipc = new FakeIpcMain()
    const preview = {
      start: vi.fn(() => ({ ok: true as const, width: 1280, height: 800 })),
      stop: vi.fn(),
      input: vi.fn(() => true),
    }
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser: fakeBrowser(),
      references: { revealPath: vi.fn(() => '') },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(async () => undefined),
      agentPreview: preview,
    })
    return { ipc, preview, authorize }
  }

  it('starts, stops and forwards input by tab id only', async () => {
    const { ipc, preview, authorize } = setup()
    await expect(
      ipc.invoke(AGENT_PREVIEW_START_CHANNEL, { targetId: id }),
    ).resolves.toEqual({
      ok: true,
      width: 1280,
      height: 800,
    })
    ipc.emit(AGENT_PREVIEW_INPUT_CHANNEL, {
      targetId: id,
      event: {
        type: 'mouseDown',
        x: 10,
        y: 20,
        button: 'left',
        clickCount: 1,
        url: 'https://x',
      },
    })
    ipc.emit(AGENT_PREVIEW_INPUT_CHANNEL, {
      targetId: id,
      event: { type: 'keyDown', key: 'Enter', modifiers: ['meta'] },
    })
    ipc.emit(AGENT_PREVIEW_STOP_CHANNEL, { targetId: id })
    expect(preview.start).toHaveBeenCalledWith(id)
    expect(preview.input.mock.calls).toEqual([
      [id, { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 }],
      [id, { type: 'keyDown', key: 'Enter', modifiers: ['meta'] }],
    ])
    expect(preview.stop).toHaveBeenCalledWith(id)
    expect(authorize).toHaveBeenCalledTimes(4)
  })

  it('accepts a helper desktop window id for the live preview', async () => {
    const { ipc, preview } = setup()
    const desktop = 't-256F5CF2-A23D-4041-8ACA-E3C082832F8B'
    await ipc.invoke(AGENT_PREVIEW_START_CHANNEL, { targetId: desktop })
    ipc.emit(AGENT_PREVIEW_STOP_CHANNEL, { targetId: desktop })
    expect(preview.start).toHaveBeenCalledWith(desktop)
    expect(preview.stop).toHaveBeenCalledWith(desktop)
  })

  it('rejects bad ids, bad input and untrusted senders before delegating', async () => {
    const { ipc, preview } = setup()
    await expect(
      ipc.invoke(AGENT_PREVIEW_START_CHANNEL, { targetId: '../x' }),
    ).rejects.toThrow(/agent target id/)
    await expect(
      ipc.invoke(AGENT_PREVIEW_START_CHANNEL, {
        targetId: 't-256f5cf2-a23d-4041-8aca-e3c082832f8b/../x',
      }),
    ).rejects.toThrow(/agent target id/)
    await expect(
      ipc.invoke(AGENT_PREVIEW_START_CHANNEL, {
        targetId: 'https://example.com/',
      }),
    ).rejects.toThrow()
    for (const event of [
      { type: 'eval', code: 'x' },
      { type: 'mouseDown', x: 'NaN', y: 1 },
      { type: 'keyDown', key: 'Enter', modifiers: ['hyper'] },
      { type: 'text', text: 'x'.repeat(5_000) },
      { type: 'mouseDown', x: 1, y: 1, button: 'back' },
    ])
      expect(() =>
        ipc.emit(AGENT_PREVIEW_INPUT_CHANNEL, { targetId: id, event }),
      ).not.toThrow()
    expect(preview.start).not.toHaveBeenCalled()
    expect(preview.input).not.toHaveBeenCalled()

    const refused = setup(
      vi.fn(() => {
        throw new Error('forbidden_ipc_caller')
      }),
    )
    await expect(
      refused.ipc.invoke(AGENT_PREVIEW_START_CHANNEL, { targetId: id }),
    ).rejects.toThrow(/forbidden/)
    expect(refused.preview.start).not.toHaveBeenCalled()
    // A one-way input from an untrusted sender is dropped without throwing.
    expect(() =>
      refused.ipc.emit(AGENT_PREVIEW_INPUT_CHANNEL, {
        targetId: id,
        event: { type: 'keyDown', key: 'Enter', modifiers: [] },
      }),
    ).not.toThrow()
    expect(refused.preview.input).not.toHaveBeenCalled()
  })
})

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

describe('agent download reveal IPC', () => {
  it('reveals inbox files by download id only', async () => {
    const ipc = new FakeIpcMain()
    const reveal = vi.fn((id: string) => id === 'dl_0123456789ab')
    const authorize = vi.fn()
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize,
      browser: fakeBrowser(),
      references: { revealPath: vi.fn(() => '') },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(async () => undefined),
      agentDownloads: { reveal },
    })
    await expect(
      ipc.invoke(AGENT_DOWNLOAD_REVEAL_CHANNEL, {
        downloadId: 'dl_0123456789ab',
      }),
    ).resolves.toEqual({ ok: true })
    await expect(
      ipc.invoke(AGENT_DOWNLOAD_REVEAL_CHANNEL, {
        downloadId: 'dl_ffffffffffff',
      }),
    ).resolves.toMatchObject({ ok: false })
    for (const downloadId of [
      '../../etc/passwd',
      '/Users/me/.ssh/id_rsa',
      'dl_x',
    ])
      await expect(
        ipc.invoke(AGENT_DOWNLOAD_REVEAL_CHANNEL, { downloadId }),
      ).rejects.toThrow(/download id/)
    expect(reveal.mock.calls).toEqual([
      ['dl_0123456789ab'],
      ['dl_ffffffffffff'],
    ])
    expect(authorize).toHaveBeenCalledTimes(5)
  })

  it('moves inbox files into the workspace by download id only', async () => {
    const ipc = new FakeIpcMain()
    const moveToWorkspace = vi.fn(async (id: string) =>
      id === 'dl_0123456789ab' ? '/work/downloads/report.csv' : undefined,
    )
    registerDesktopCapabilityIpc({
      ipcMain: ipc,
      authorize: vi.fn(),
      browser: fakeBrowser(),
      references: { revealPath: vi.fn(() => '') },
      showItemInFolder: vi.fn(),
      openExternal: vi.fn(async () => undefined),
      agentDownloads: { reveal: vi.fn(() => true), moveToWorkspace },
    })
    await expect(
      ipc.invoke(AGENT_DOWNLOAD_MOVE_CHANNEL, {
        downloadId: 'dl_0123456789ab',
      }),
    ).resolves.toEqual({ ok: true, path: '/work/downloads/report.csv' })
    await expect(
      ipc.invoke(AGENT_DOWNLOAD_MOVE_CHANNEL, {
        downloadId: 'dl_ffffffffffff',
      }),
    ).resolves.toMatchObject({ ok: false })
    await expect(
      ipc.invoke(AGENT_DOWNLOAD_MOVE_CHANNEL, { downloadId: '../x' }),
    ).rejects.toThrow(/download id/)
    expect(moveToWorkspace).toHaveBeenCalledTimes(2)
  })
})
