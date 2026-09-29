import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PREVIEW_FRAME_CHANNEL,
  AGENT_PREVIEW_INPUT_CHANNEL,
  AGENT_PREVIEW_START_CHANNEL,
  AGENT_PREVIEW_STOP_CHANNEL,
  BROWSER_ACTION_CHANNEL,
  BROWSER_CONNECT_CHANNEL,
  BROWSER_PAIRING_APPROVE_CHANNEL,
  BROWSER_PAIRING_DENY_CHANNEL,
  BROWSER_PAIRING_REVOKE_CHANNEL,
  BROWSER_PAIRING_STATUS_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  BROWSER_STATE_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  MAC_HELPER_RECONNECT_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
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
      'agentPreviewInput',
      'agentPreviewStart',
      'agentPreviewStop',
      'approveBrowserPairing',
      'browserAction',
      'browserBounds',
      'browserClose',
      'browserPairings',
      'connectBrowsers',
      'denyBrowserPairing',
      'macHelperReconnect',
      'macHelperRequestPermission',
      'macHelperResetPermission',
      'macHelperStatus',
      'onAgentPreviewFrame',
      'onBrowserState',
      'openBrowserUrl',
      'openExternal',
      'openSkillsFolder',
      'revealReference',
      'revokeBrowserPairing',
      'selectFile',
      'vaultBiometricDisable',
      'vaultBiometricUnlock',
      'vaultLock',
      'vaultRemove',
      'vaultReveal',
      'vaultSave',
      'vaultSetMaster',
      'vaultStatus',
      'vaultUnlock',
    ])
  })

  it('routes browser pairing only through fixed channels', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    const pairingId = 'A'.repeat(21) + 'Q'
    await bridge.browserPairings()
    await bridge.approveBrowserPairing(pairingId)
    await bridge.denyBrowserPairing(pairingId)
    await bridge.revokeBrowserPairing(pairingId)
    await bridge.connectBrowsers()
    expect(ipc.invoked).toEqual([
      [BROWSER_PAIRING_STATUS_CHANNEL, undefined],
      [BROWSER_PAIRING_APPROVE_CHANNEL, { pairingId }],
      [BROWSER_PAIRING_DENY_CHANNEL, { pairingId }],
      [BROWSER_PAIRING_REVOKE_CHANNEL, { pairingId }],
      [BROWSER_CONNECT_CHANNEL, undefined],
    ])
  })

  it('addresses Agent tab previews by id only', async () => {
    const ipc = new FakeIpcRenderer()
    const bridge = createDesktopCapabilityBridge(ipc)
    const id = 'tab_00000000-0000-0000-0000-000000000000'
    await bridge.agentPreviewStart(id)
    bridge.agentPreviewInput(id, { type: 'text', text: '你好' })
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
    expect(ipc.sent).toEqual([
      [
        AGENT_PREVIEW_INPUT_CHANNEL,
        { targetId: id, event: { type: 'text', text: '你好' } },
      ],
      [AGENT_PREVIEW_STOP_CHANNEL, { targetId: id }],
    ])
    expect(listener).toHaveBeenCalledTimes(1)
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
