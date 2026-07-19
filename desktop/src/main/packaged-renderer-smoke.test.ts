import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPackagedSmokeAttachment,
  verifyPackagedRenderer,
  type PackagedSmokeWindowLike,
} from './packaged-renderer-smoke'

function fakeWindow(
  overrides: {
    probe?: Record<string, unknown>
  } = {},
) {
  const destroy = vi.fn()
  const win: PackagedSmokeWindowLike = {
    loadURL: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    destroy,
    webContents: {
      executeJavaScript: vi.fn(
        async () =>
          overrides.probe ?? {
            nodeGlobalsAbsent: true,
            bridgeExposed: true,
            rendererSandboxed: true,
            bootstrapOk: true,
            attachmentOk: true,
            attachmentBytes: 22,
          },
      ),
    },
  }
  return { win, destroy }
}

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
    })

    expect(win.loadURL).toHaveBeenCalledWith('app://bundle/index.html')
    expect(win.webContents.executeJavaScript).toHaveBeenCalledOnce()
    expect(receipt).toEqual({
      ok: true,
      nodeGlobalsAbsent: true,
      coreBridge: true,
      coreBootstrap: true,
      attachment: { ok: true, bytes: 22 },
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
      chromiumSandbox: 'enabled',
    })
    expect(destroy).toHaveBeenCalledOnce()
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
      }),
    ).rejects.toThrow(/renderer sandbox/i)
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
