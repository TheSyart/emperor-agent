import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPackagedSmokeAttachment,
  PROTOCOL_TRAVERSAL_PROBES,
  rendererProbeSource,
  verifyPackagedRenderer,
  type PackagedSmokeWindowLike,
} from './packaged-renderer-smoke'

const CSP = "default-src 'self'; script-src 'self'"

const PROBE = {
  nodeGlobalsAbsent: true,
  bridgeExposed: true,
  rendererSandboxed: true,
  bootstrapOk: true,
  // REL-05: what window.emperor.appVersion() answered (app.getVersion()).
  appVersion: '0.2.0',
  appMounted: true,
  attachmentOk: true,
  attachmentBytes: 22,
  cspHeader: CSP,
  cspMeta: CSP,
  evalBlocked: true,
  microphoneDenied: true,
  href: 'app://bundle/index.html',
  // REL-04: every traversal request refused (attachments, media and pet with
  // an error status; the bundle's SPA fallback without the file).
  traversal: PROTOCOL_TRAVERSAL_PROBES.map((probe) => ({
    url: probe.url,
    status: probe.mustFail ? 404 : 200,
    leaked: false,
  })),
}

const TRAVERSAL = {
  canary: 'emperor-traversal-canary-0123456789abcdef',
  hostSecret: 'root:*:0:0:System Administrator:/var/root:/bin/sh',
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
      rendererUrl: 'app://bundle/index.html',
      appVersion: '0.2.0',
      attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
      attachmentContent: 'emperor-renderer-smoke',
      traversal: TRAVERSAL,
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
      appVersion: '0.2.0',
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
        rendererUrlPinned: true,
        protocolTraversalRefused: true,
      },
    })
    expect(win.webContents.openDevTools).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('6. fails when the main window would load anything but app://bundle (SEC-04)', async () => {
    for (const [rendererUrl, href] of [
      ['https://example.com/', 'https://example.com/'],
      ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173/'],
      ['app://bundle/index.html', 'https://example.com/'],
    ]) {
      const { win, destroy } = fakeWindow({ probe: { ...PROBE, href } })
      await expect(
        verifyPackagedRenderer({
          createWindow: () => win,
          rendererUrl,
          appVersion: '0.2.0',
          attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
          attachmentContent: 'emperor-renderer-smoke',
          traversal: TRAVERSAL,
          chromiumSandboxDisabledForTest: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
          security: security(),
        }),
      ).rejects.toThrow(/renderer-url/)
      expect(win.loadURL).toHaveBeenNthCalledWith(1, rendererUrl)
      expect(destroy).toHaveBeenCalledOnce()
    }
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
          rendererUrl: 'app://bundle/index.html',
          appVersion: '0.2.0',
          attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
          attachmentContent: 'emperor-renderer-smoke',
          traversal: TRAVERSAL,
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
        rendererUrl: 'app://bundle/index.html',
        appVersion: '0.2.0',
        attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
        attachmentContent: 'emperor-renderer-smoke',
        traversal: TRAVERSAL,
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

  it.each([
    ['another version', { appVersion: '0.1.0' }],
    ['no version at all', { appVersion: null }],
    ['a bridge without appVersion', { appVersion: undefined }],
  ])(
    '5. fails when the renderer sees %s instead of app.getVersion() (REL-05)',
    async (_name, override) => {
      const { win, destroy } = fakeWindow({ probe: { ...PROBE, ...override } })
      await expect(
        verifyPackagedRenderer({
          createWindow: () => win,
          rendererUrl: 'app://bundle/index.html',
          appVersion: '0.2.0',
          attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
          attachmentContent: 'emperor-renderer-smoke',
          traversal: TRAVERSAL,
          chromiumSandboxDisabledForTest: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
          security: security(),
        }),
      ).rejects.toThrow(/app-version/)
      expect(destroy).toHaveBeenCalledOnce()
    },
  )

  it('5. asks the preload bridge for the version, the way the renderer does (REL-05)', () => {
    const source = rendererProbeSource(
      'app://attachments/att_2099-01_abcdef12/raw',
      'emperor-renderer-smoke',
      TRAVERSAL,
    )
    expect(source).toContain('bridge.appVersion()')
  })

  it('rejects a deep-link reload whose renderer stays blank', async () => {
    const { win, destroy } = fakeWindow()
    vi.mocked(win.webContents.executeJavaScript)
      .mockResolvedValueOnce(PROBE)
      .mockResolvedValueOnce({ appMounted: false })

    await expect(
      verifyPackagedRenderer({
        createWindow: () => win,
        rendererUrl: 'app://bundle/index.html',
        appVersion: '0.2.0',
        attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
        attachmentContent: 'emperor-renderer-smoke',
        traversal: TRAVERSAL,
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

  it('8. asks for app://attachments/../../etc/passwd and the other traversal paths (REL-04)', () => {
    const urls = PROTOCOL_TRAVERSAL_PROBES.map((probe) => probe.url)
    expect(urls).toContain('app://attachments/../../etc/passwd')
    for (const host of ['attachments', 'media', 'bundle', 'pet', 'pet-assets'])
      expect(
        urls.some((url) => url.startsWith(`app://${host}/`)),
        host,
      ).toBe(true)
    // Encoded dot segments too, which the URL parser does not fold away.
    expect(urls.some((url) => /%2e%2e/i.test(url))).toBe(true)
    expect(urls.some((url) => /\.\.%2f/i.test(url))).toBe(true)
    const source = rendererProbeSource(
      'app://attachments/att_2099-01_abcdef12/raw',
      'emperor-renderer-smoke',
      TRAVERSAL,
    )
    for (const url of urls) expect(source).toContain(JSON.stringify(url))
    expect(source).toContain(JSON.stringify(TRAVERSAL.canary))
    expect(source).toContain(JSON.stringify(TRAVERSAL.hostSecret))
  })

  it.each([
    [
      'a request that returned a host file',
      (url: string) => ({ url, status: 200, leaked: url.includes('etc') }),
    ],
    [
      'an attachment traversal answered 200',
      (url: string) => ({ url, status: 200, leaked: false }),
    ],
    ['a traversal request that was never made', () => null],
  ])('8. fails closed on %s', async (_name, outcome) => {
    const traversal = PROTOCOL_TRAVERSAL_PROBES.map((probe) =>
      outcome(probe.url),
    ).filter(Boolean)
    const { win, destroy } = fakeWindow({ probe: { ...PROBE, traversal } })
    await expect(
      verifyPackagedRenderer({
        createWindow: () => win,
        rendererUrl: 'app://bundle/index.html',
        appVersion: '0.2.0',
        attachmentUrl: 'app://attachments/att_2099-01_abcdef12/raw',
        attachmentContent: 'emperor-renderer-smoke',
        traversal: TRAVERSAL,
        chromiumSandboxDisabledForTest: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
        security: security(),
      }),
    ).rejects.toThrow(/protocol-traversal/)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('plants a traversal canary next to the attachments, outside every app:// root', async () => {
    const stateRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'emperor-renderer-smoke-'),
    )
    const fixture = await createPackagedSmokeAttachment(stateRoot)
    expect(fixture.traversalCanary).toMatch(
      /^emperor-traversal-canary-[a-f0-9]{16}$/,
    )
    expect(
      fs.readFileSync(
        path.join(stateRoot, 'smoke-traversal-canary.txt'),
        'utf8',
      ),
    ).toBe(fixture.traversalCanary)
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
