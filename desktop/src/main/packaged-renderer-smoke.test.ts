import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPackagedSmokeAttachment,
  verifyPackagedRenderer,
  type PackagedSmokeWindowLike,
} from './packaged-renderer-smoke'

const CSP = "default-src 'self'; script-src 'self'"

const PROBE = {
  nodeGlobalsAbsent: true,
  bridgeExposed: true,
  rendererSandboxed: true,
  bootstrapOk: true,
  appMounted: true,
  attachmentOk: true,
  attachmentBytes: 22,
  cspHeader: CSP,
  cspMeta: CSP,
  evalBlocked: true,
  microphoneDenied: true,
}

function fakeWindow(
  overrides: {
    probe?: Record<string, unknown>
    devToolsOpens?: boolean
  } = {},
) {
  const destroy = vi.fn()
  let devTools = false
  const win: PackagedSmokeWindowLike = {
    loadURL: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    destroy,
    webContents: {
      executeJavaScript: vi.fn(async () => overrides.probe ?? PROBE),
      openDevTools: vi.fn(() => {
        devTools = overrides.devToolsOpens === true
      }),
      isDevToolsOpened: vi.fn(() => devTools),
    },
  }
  return { win, destroy }
}

const security = (roles: readonly string[] = ['about', 'copy', 'quit']) => ({
  expectedCsp: CSP,
  applicationMenuRoles: () => roles,
  devToolsSettleMs: 0,
})

describe('packaged renderer smoke', () => {
  it('loads the production URL and proves sandbox, bridge, bootstrap and attachment', async () => {
    const { win, destroy } = fakeWindow()

    const receipt = await verifyPackagedRenderer({
      createWindow: () => win,
      attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
      attachmentContent: 'emperor-renderer-smoke',
      chromiumSandboxDisabledForTest: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
      security: security(),
    })

    expect(win.loadURL).toHaveBeenCalledWith('app://bundle/index.html')
    expect(win.loadURL).toHaveBeenCalledWith('app://bundle/chat/packaged-smoke')
    expect(win.webContents.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(receipt).toEqual({
      ok: true,
      nodeGlobalsAbsent: true,
      coreBridge: true,
      coreBootstrap: true,
      deepLinkRenders: true,
      attachment: { ok: true, bytes: 22 },
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
      chromiumSandbox: 'enabled',
      security: {
        cspHeader: true,
        cspMeta: true,
        evalBlocked: true,
        microphoneDenied: true,
        devToolsDisabled: true,
        productionMenu: true,
      },
    })
    expect(win.webContents.openDevTools).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('fails when the packaged main window lacks a renderer defense (SEC-05)', async () => {
    const cases: Array<[string, Parameters<typeof fakeWindow>[0], string[]?]> =
      [
        ['csp-header', { probe: { ...PROBE, cspHeader: null } }],
        ['csp-meta', { probe: { ...PROBE, cspMeta: 'default-src *' } }],
        ['eval', { probe: { ...PROBE, evalBlocked: false } }],
        ['microphone', { probe: { ...PROBE, microphoneDenied: false } }],
        ['devtools', { devToolsOpens: true }],
        ['menu', {}, ['about', 'toggledevtools']],
        ['menu', {}, ['reload']],
      ]
    for (const [name, overrides, roles] of cases) {
      const { win, destroy } = fakeWindow(overrides)
      await expect(
        verifyPackagedRenderer({
          createWindow: () => win,
          attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
          attachmentContent: 'emperor-renderer-smoke',
          chromiumSandboxDisabledForTest: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
          security: security(roles),
        }),
      ).rejects.toThrow(new RegExp(name))
      expect(destroy).toHaveBeenCalledOnce()
    }
  })

  it('fails closed and destroys the window when any renderer invariant is false', async () => {
    const { win, destroy } = fakeWindow({
      probe: {
        nodeGlobalsAbsent: false,
        bridgeExposed: true,
        rendererSandboxed: true,
        bootstrapOk: true,
        attachmentOk: true,
        attachmentBytes: 22,
      },
    })

    await expect(
      verifyPackagedRenderer({
        createWindow: () => win,
        attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
        attachmentContent: 'emperor-renderer-smoke',
        chromiumSandboxDisabledForTest: true,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
        security: security(),
      }),
    ).rejects.toThrow(/renderer sandbox/i)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('rejects a deep-link reload whose renderer stays blank', async () => {
    const { win, destroy } = fakeWindow()
    vi.mocked(win.webContents.executeJavaScript)
      .mockResolvedValueOnce(PROBE)
      .mockResolvedValueOnce({ appMounted: false })

    await expect(
      verifyPackagedRenderer({
        createWindow: () => win,
        attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
        attachmentContent: 'emperor-renderer-smoke',
        chromiumSandboxDisabledForTest: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
        security: security(),
      }),
    ).rejects.toThrow(/deep-link-render/)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('creates a contained attachment fixture without exposing its host path', async () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'emperor-renderer-smoke-'),
    )

    const fixture = await createPackagedSmokeAttachment(stateRoot)

    expect(fixture.url).toMatch(
      /^app:\/\/attachments\/att_2099-01_[a-f0-9]{8}\/raw$/,
    )
    expect(fixture.content).toBe('emperor-packaged-renderer-smoke-v1')
    expect(fs.readFileSync(fixture.path, 'utf8')).toBe(fixture.content)
    expect(fixture.url).not.toContain(stateRoot)
  })
})
