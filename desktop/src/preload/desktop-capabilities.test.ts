import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PREVIEW_FRAME_CHANNEL,
  AGENT_PREVIEW_POINTER_CHANNEL,
  AGENT_PREVIEW_START_CHANNEL,
  AGENT_PREVIEW_STOP_CHANNEL,
  BROWSER_ACTION_CHANNEL,
  BROWSER_REVEAL_CHANNEL,
  BROWSER_EXTENSION_INSTALL_CHANNEL,
  BROWSER_EXTENSION_REMOVE_CHANNEL,
  BROWSER_EXTENSION_REVEAL_CHANNEL,
  BROWSER_EXTENSION_STATUS_CHANNEL,
  BROWSER_PAIRING_REQUEST_CHANNEL,
  BROWSER_PAIRING_APPROVE_CHANNEL,
  BROWSER_PAIRING_DENY_CHANNEL,
  BROWSER_PAIRING_REVOKE_CHANNEL,
  BROWSER_PAIRING_STATUS_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  BROWSER_STATE_CHANNEL,
  DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL,
  DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL,
  DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL,
  DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  HOME_BACKUP_DISCARD_CHANNEL,
  HOME_BACKUP_EXPORT_CHANNEL,
  HOME_BACKUP_OPEN_CHANNEL,
  HOME_BACKUP_PLAN_CHANNEL,
  HOME_BACKUP_RESTORE_CHANNEL,
  HOME_BACKUP_REVEAL_CHANNEL,
  LINK_OPEN_CHANNEL,
  MARKDOWN_REMOTE_IMAGE_CHANNEL,
  APP_MENU_COMMAND_CHANNEL,
  MAC_HELPER_RECONNECT_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  BROWSER_HISTORY_CHANNEL,
  BROWSER_HISTORY_OPEN_CHANNEL,
  BROWSER_CLEAR_DATA_CHANNEL,
  BROWSER_DOWNLOADS_CHANNEL,
  BROWSER_DOWNLOAD_EVENT_CHANNEL,
  BROWSER_DOWNLOAD_FOLDER_CHANNEL,
  BROWSER_DOWNLOAD_OPEN_CHANNEL,
  BROWSER_DOWNLOAD_REMOVE_CHANNEL,
  BROWSER_DOWNLOAD_REVEAL_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
  VAULT_EXPORT_CHANNEL,
  VAULT_IMPORT_CHANNEL,
  VAULT_IMPORT_PICK_CHANNEL,
  VAULT_MASTER_CHANNEL,
  VAULT_REPAIR_KEY_CHANNEL,
  VAULT_RESET_CHANNEL,
  VAULT_START_OVER_CHANNEL,
  VAULT_UNLOCK_CHANNEL,
  WORKSPACE_MEDIA_OPEN_CHANNEL,
} from '../shared/ipc-contract'
import { createDesktopCapabilityBridge } from './desktop-capabilities'

describe('desktop capability preload bridge', () => {
  it('exposes fixed channels and removes browser subscriptions', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)

    await bridge.openBrowserUrl('localhost:5173')
    await bridge.revealReference({
      sessionId: 'session-1',
      referenceId: 'reference-1',
    })
    await bridge.openExternal('https://example.com/')
    bridge.browserBounds({ x: 0, y: 0, width: 640, height: 480 })
    bridge.browserBounds(null)
    bridge.browserAction('stop')
    bridge.browserClose()
    await bridge.browserHistory()
    await bridge.openBrowserHistory('h3')
    await bridge.clearBrowserData()

    const listener = vi.fn()
    const dispose = bridge.onBrowserState(listener)
    const state = {
      url: 'http://localhost:5173/',
      title: 'Dev',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    }
    ipc.emit(BROWSER_STATE_CHANNEL, state)
    dispose()
    ipc.emit(BROWSER_STATE_CHANNEL, state)

    expect(ipc.invoked).toEqual([
      [BROWSER_OPEN_CHANNEL, { url: 'localhost:5173' }],
      [
        REFERENCE_REVEAL_CHANNEL,
        { sessionId: 'session-1', referenceId: 'reference-1' },
      ],
      [EXTERNAL_OPEN_CHANNEL, 'https://example.com/'],
      [BROWSER_HISTORY_CHANNEL, undefined],
      [BROWSER_HISTORY_OPEN_CHANNEL, 'h3'],
      [BROWSER_CLEAR_DATA_CHANNEL, undefined],
    ])
    expect(ipc.sent).toEqual([
      [BROWSER_BOUNDS_CHANNEL, { x: 0, y: 0, width: 640, height: 480 }],
      [BROWSER_BOUNDS_CHANNEL, null],
      [BROWSER_ACTION_CHANNEL, 'stop'],
      [BROWSER_CLOSE_CHANNEL, undefined],
    ])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(state)
    expect(ipc.removed).toHaveLength(1)
  })

  it('exposes no preview-id or raw IPC surface', () => {
    const bridge = createDesktopCapabilityBridge(new FakeIpcRenderer())
    expect(Object.keys(bridge).sort()).toEqual([
      'agentDownloadMove',
      'agentDownloadReveal',
      'agentDownloadSaveAs',
      'agentPreviewStart',
      'agentPreviewStop',
      'approveBrowserPairing',
      'browserAction',
      'browserBounds',
      'browserClose',
      'browserDownloads',
      'browserExtensionStatus',
      'browserHistory',
      'browserImportSources',
      'browserPairings',
      'chooseDownloadFolder',
      'clearBrowserData',
      'denyBrowserPairing',
      'discardDiagnosticsBundle',
      'discardHomeBackup',
      'exportDiagnosticsBundle',
      'exportHomeBackup',
      'installBrowserExtension',
      'loadRemoteImage',
      'macHelperReconnect',
      'macHelperRequestPermission',
      'macHelperResetPermission',
      'macHelperStatus',
      'onAgentPreviewFrame',
      'onAgentPreviewPointer',
      'onBrowserDownload',
      'onBrowserPairingRequest',
      'onBrowserReveal',
      'onBrowserState',
      'onMenuCommand',
      'openBrowserDownload',
      'openBrowserHistory',
      'openBrowserUrl',
      'openExternal',
      'openHomeBackup',
      'openLink',
      'openSkillsFolder',
      'openWorkspaceMedia',
      'planHomeBackup',
      'prepareDiagnosticsBundle',
      'removeBrowserDownload',
      'removeBrowserExtension',
      'restoreHomeBackup',
      'revealBrowserDownload',
      'revealBrowserExtension',
      'revealDiagnosticsBundle',
      'revealHomeBackup',
      'revealReference',
      'revokeBrowserPairing',
      'runBrowserImport',
      'selectFile',
      'vaultExport',
      'vaultImport',
      'vaultImportPick',
      'vaultLock',
      'vaultMaster',
      'vaultRemove',
      'vaultRepairKey',
      'vaultReset',
      'vaultReveal',
      'vaultSave',
      'vaultStartOver',
      'vaultStatus',
      'vaultUnlock',
    ])
  })

  it('names a video by its granted media address, never by path (BUG-05)', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    const url = `app://workspace-media/${'a'.repeat(32)}`
    await bridge.openWorkspaceMedia(url)
    expect(ipc.invoked.at(-1)).toEqual([WORKSPACE_MEDIA_OPEN_CHANNEL, { url }])
  })

  it('asks main for 备份与恢复 by id, forwarding only known fields (REL-03)', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    await bridge.planHomeBackup()
    expect(ipc.invoked.at(-1)).toEqual([HOME_BACKUP_PLAN_CHANNEL, undefined])
    await bridge.exportHomeBackup({
      includeSessions: true,
      passphrase: 'p',
      confirmation: 'p',
      path: '/etc/x',
    } as never)
    expect(ipc.invoked.at(-1)).toEqual([
      HOME_BACKUP_EXPORT_CHANNEL,
      { includeSessions: true, passphrase: 'p', confirmation: 'p' },
    ])
    await bridge.revealHomeBackup()
    expect(ipc.invoked.at(-1)).toEqual([HOME_BACKUP_REVEAL_CHANNEL, undefined])
    await bridge.openHomeBackup()
    expect(ipc.invoked.at(-1)).toEqual([HOME_BACKUP_OPEN_CHANNEL, undefined])
    await bridge.restoreHomeBackup('r_0123456789ab', 'secret phrase')
    expect(ipc.invoked.at(-1)).toEqual([
      HOME_BACKUP_RESTORE_CHANNEL,
      { id: 'r_0123456789ab', passphrase: 'secret phrase' },
    ])
    await bridge.discardHomeBackup('r_0123456789ab')
    expect(ipc.invoked.at(-1)).toEqual([
      HOME_BACKUP_DISCARD_CHANNEL,
      { id: 'r_0123456789ab' },
    ])
  })

  it('sends clicked links to main for routing and relays reveals', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    await bridge.openLink('https://example.com/')
    expect(ipc.invoked.at(-1)).toEqual([
      LINK_OPEN_CHANNEL,
      'https://example.com/',
    ])
    const listener = vi.fn()
    const dispose = bridge.onBrowserReveal(listener)
    ipc.emit(BROWSER_REVEAL_CHANNEL, { url: 'http://localhost:5173/' })
    ipc.emit(BROWSER_REVEAL_CHANNEL, { url: 42 })
    dispose()
    ipc.emit(BROWSER_REVEAL_CHANNEL, { url: 'https://late.example/' })
    expect(listener.mock.calls).toEqual([[{ url: 'http://localhost:5173/' }]])
  })

  it('asks main for a remote markdown image (UI-38)', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    await bridge.loadRemoteImage('https://example.com/a.png')
    expect(ipc.invoked.at(-1)).toEqual([
      MARKDOWN_REMOTE_IMAGE_CHANNEL,
      { url: 'https://example.com/a.png' },
    ])
  })

  it('relays only known app menu commands (MAIN-20)', () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    const listener = vi.fn()
    const dispose = bridge.onMenuCommand(listener)
    ipc.emit(APP_MENU_COMMAND_CHANNEL, 'open-settings')
    ipc.emit(APP_MENU_COMMAND_CHANNEL, 'reload')
    dispose()
    ipc.emit(APP_MENU_COMMAND_CHANNEL, 'open-settings')
    expect(listener.mock.calls).toEqual([['open-settings']])
  })

  it('routes browser pairing only through fixed channels', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    const pairingId = 'A'.repeat(21) + 'Q'
    await bridge.browserPairings()
    await bridge.approveBrowserPairing(pairingId)
    await bridge.denyBrowserPairing(pairingId)
    await bridge.revokeBrowserPairing(pairingId)
    expect(ipc.invoked).toEqual([
      [BROWSER_PAIRING_STATUS_CHANNEL, undefined],
      [BROWSER_PAIRING_APPROVE_CHANNEL, { pairingId }],
      [BROWSER_PAIRING_DENY_CHANNEL, { pairingId }],
      [BROWSER_PAIRING_REVOKE_CHANNEL, { pairingId }],
    ])
  })

  it('sends the master password alone and clears only through the reset channel', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    await bridge.vaultUnlock!('correct horse battery', true)
    await bridge.vaultMaster!({
      action: 'change',
      currentPassword: 'correct horse battery',
      password: 'another passphrase',
      confirmPassword: 'another passphrase',
      biometric: true,
    })
    await bridge.vaultMaster!({ action: 'remove', currentPassword: 'x' })
    await bridge.vaultReset!('ignored')
    expect(ipc.invoked).toEqual([
      [VAULT_UNLOCK_CHANNEL, { password: 'correct horse battery' }],
      [
        VAULT_MASTER_CHANNEL,
        {
          action: 'change',
          currentPassword: 'correct horse battery',
          password: 'another passphrase',
          confirmPassword: 'another passphrase',
        },
      ],
      [VAULT_MASTER_CHANNEL, { action: 'remove', currentPassword: 'x' }],
      [VAULT_RESET_CHANNEL, undefined],
    ])
  })

  it('repairs, starts over, exports and imports through fixed vault channels (SEC-09)', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    await bridge.vaultRepairKey!('ignored')
    await bridge.vaultStartOver!('ignored')
    await bridge.vaultExport!(
      'backup passphrase 1',
      'backup passphrase 1',
      '/x',
    )
    await bridge.vaultImportPick!('/etc/passwd')
    await bridge.vaultImport!('backup passphrase 1', '/x')
    expect(ipc.invoked).toEqual([
      [VAULT_REPAIR_KEY_CHANNEL, undefined],
      [VAULT_START_OVER_CHANNEL, undefined],
      [
        VAULT_EXPORT_CHANNEL,
        {
          passphrase: 'backup passphrase 1',
          confirmPassphrase: 'backup passphrase 1',
        },
      ],
      // The file is chosen in main's own dialog; no path crosses IPC.
      [VAULT_IMPORT_PICK_CHANNEL, undefined],
      [VAULT_IMPORT_CHANNEL, { passphrase: 'backup passphrase 1' }],
    ])
  })

  it('reaches the extension folder through fixed channels without arguments', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    await bridge.browserExtensionStatus()
    await bridge.installBrowserExtension()
    await bridge.revealBrowserExtension()
    await bridge.removeBrowserExtension()
    expect(ipc.invoked).toEqual([
      [BROWSER_EXTENSION_STATUS_CHANNEL, undefined],
      [BROWSER_EXTENSION_INSTALL_CHANNEL, undefined],
      [BROWSER_EXTENSION_REVEAL_CHANNEL, undefined],
      [BROWSER_EXTENSION_REMOVE_CHANNEL, undefined],
    ])
    // A pairing request carries nothing; the listener gets nothing.
    const listener = vi.fn()
    const dispose = bridge.onBrowserPairingRequest(listener)
    ipc.emit(BROWSER_PAIRING_REQUEST_CHANNEL, { code: '123456' })
    dispose()
    ipc.emit(BROWSER_PAIRING_REQUEST_CHANNEL, undefined)
    expect(listener.mock.calls).toEqual([[]])
    expect(ipc.removed).toHaveLength(1)
  })

  it('addresses Agent tab previews by id only, and sends nothing back to the tab', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    const id = 'tab_00000000-0000-0000-0000-000000000000'
    await bridge.agentPreviewStart(id)
    expect(bridge).not.toHaveProperty('agentPreviewInput')
    bridge.agentPreviewStop(id)
    const listener = vi.fn()
    const dispose = bridge.onAgentPreviewFrame(listener)
    const frame = {
      targetId: id,
      seq: 1,
      width: 10,
      height: 10,
      jpeg: new Uint8Array(1),
    }
    ipc.emit(AGENT_PREVIEW_FRAME_CHANNEL, frame)
    dispose()
    ipc.emit(AGENT_PREVIEW_FRAME_CHANNEL, frame)
    expect(ipc.invoked).toEqual([
      [AGENT_PREVIEW_START_CHANNEL, { targetId: id }],
    ])
    expect(ipc.sent).toEqual([[AGENT_PREVIEW_STOP_CHANNEL, { targetId: id }]])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('relays only well-formed Agent pointers for the preview cards', () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    const listener = vi.fn()
    const dispose = bridge.onAgentPreviewPointer(listener)
    ipc.emit(AGENT_PREVIEW_POINTER_CHANNEL, {
      targetId: 't-1',
      x: 0.25,
      y: 1,
      extra: 'dropped',
    })
    for (const bad of [
      null,
      'pointer',
      { targetId: '', x: 0.5, y: 0.5 },
      { targetId: 42, x: 0.5, y: 0.5 },
      { targetId: 't-1', x: 1.5, y: 0.5 },
      { targetId: 't-1', x: 0.5, y: -0.1 },
      { targetId: 't-1', x: Number.NaN, y: 0.5 },
      { targetId: 't-1', x: '0.5', y: 0.5 },
    ])
      ipc.emit(AGENT_PREVIEW_POINTER_CHANNEL, bad)
    dispose()
    ipc.emit(AGENT_PREVIEW_POINTER_CHANNEL, { targetId: 't-1', x: 0, y: 0 })
    expect(listener.mock.calls).toEqual([[{ targetId: 't-1', x: 0.25, y: 1 }]])
    expect(ipc.removed).toHaveLength(1)
  })

  it('exposes the Skills folder and file picker channels', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)

    await bridge.openSkillsFolder({ scope: 'project', sessionId: 's1' })
    await bridge.selectFile({ filters: [{ name: 'Zip', extensions: ['zip'] }] })
    await bridge.selectFile()

    expect(ipc.invoked).toEqual([
      [SKILLS_OPEN_FOLDER_CHANNEL, { scope: 'project', sessionId: 's1' }],
      [
        SELECT_FILE_CHANNEL,
        { filters: [{ name: 'Zip', extensions: ['zip'] }] },
      ],
      [SELECT_FILE_CHANNEL, {}],
    ])
  })

  it('reaches the download history by id only, and relays download pushes', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    const id = 'ud_0123456789ab'
    await bridge.browserDownloads()
    await bridge.openBrowserDownload(id)
    await bridge.revealBrowserDownload(id)
    await bridge.removeBrowserDownload(id)
    await bridge.chooseDownloadFolder()
    expect(ipc.invoked).toEqual([
      [BROWSER_DOWNLOADS_CHANNEL, undefined],
      [BROWSER_DOWNLOAD_OPEN_CHANNEL, { id }],
      [BROWSER_DOWNLOAD_REVEAL_CHANNEL, { id }],
      [BROWSER_DOWNLOAD_REMOVE_CHANNEL, { id }],
      [BROWSER_DOWNLOAD_FOLDER_CHANNEL, undefined],
    ])
    const listener = vi.fn()
    const dispose = bridge.onBrowserDownload(listener)
    const view = {
      id,
      name: 'report.csv',
      site: 'https://news.example',
      time: 1,
      state: 'progressing',
      bytes: 0,
    }
    ipc.emit(BROWSER_DOWNLOAD_EVENT_CHANNEL, view)
    dispose()
    ipc.emit(BROWSER_DOWNLOAD_EVENT_CHANNEL, view)
    expect(listener.mock.calls).toEqual([[view]])
    expect(ipc.removed).toHaveLength(1)
  })

  it('reaches the diagnostics bundle by id only (REL-01)', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    await bridge.prepareDiagnosticsBundle()
    await bridge.exportDiagnosticsBundle('b_0123456789ab')
    await bridge.revealDiagnosticsBundle('b_0123456789ab')
    await bridge.discardDiagnosticsBundle('b_0123456789ab')
    expect(ipc.invoked).toEqual([
      [DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL, undefined],
      [DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL, { id: 'b_0123456789ab' }],
      [DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL, { id: 'b_0123456789ab' }],
      [DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL, { id: 'b_0123456789ab' }],
    ])
  })

  it('reconnects the macOS Helper through a fixed channel without payload', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    await bridge.macHelperReconnect()
    expect(ipc.invoked).toEqual([[MAC_HELPER_RECONNECT_CHANNEL, undefined]])
  })
})

type Listener = (_event: unknown, payload: unknown) => void

class FakeIpcRenderer {
  readonly invoked: Array<[string, unknown]> = []
  readonly sent: Array<[string, unknown]> = []
  readonly removed: Array<[string, Listener]> = []
  private readonly listeners = new Map<string, Listener>()

  async invoke(channel: string, payload: unknown): Promise<unknown> {
    this.invoked.push([channel, payload])
    return { ok: true }
  }

  send(channel: string, payload?: unknown): void {
    this.sent.push([channel, payload])
  }

  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener)
  }

  removeListener(channel: string, listener: Listener): void {
    this.removed.push([channel, listener])
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel)
  }

  emit(channel: string, payload: unknown): void {
    this.listeners.get(channel)?.({}, payload)
  }
}
