import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ATTACHMENT_CONTENT = 'emperor-packaged-renderer-smoke-v1'
const ATTACHMENT_MONTH = '2099-01'
const PRODUCTION_RENDERER_URL = 'app://bundle/index.html'

export interface PackagedSmokeWindowLike {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  destroy(): void
  webContents: {
    executeJavaScript(source: string): Promise<unknown>
  }
}

export interface PackagedRendererSmokeReceipt {
  ok: boolean
  nodeGlobalsAbsent: boolean
  coreBridge: boolean
  coreBootstrap: boolean
  attachment: { ok: boolean; bytes: number }
  webPreferences: {
    sandbox: boolean
    contextIsolation: boolean
    nodeIntegration: boolean
  }
  chromiumSandbox: 'enabled' | 'disabled-for-linux-test' | 'unknown'
}

export async function createPackagedSmokeAttachment(
  stateRoot: string,
): Promise<{
  url: string
  path: string
  content: string
}> {
  const hash8 = createHash('sha256')
    .update(ATTACHMENT_CONTENT)
    .digest('hex')
    .slice(0, 8)
  const dir = join(
    resolve(stateRoot),
    'memory',
    'attachments',
    ATTACHMENT_MONTH,
  )
  const path = join(dir, `${hash8}-renderer-smoke.png`)
  await mkdir(dir, { recursive: true })
  await writeFile(path, ATTACHMENT_CONTENT, { encoding: 'utf8', mode: 0o600 })
  return {
    url: `app://attachments/att_${ATTACHMENT_MONTH}_${hash8}/raw`,
    path,
    content: ATTACHMENT_CONTENT,
  }
}

export async function verifyPackagedRenderer(opts: {
  createWindow: () => PackagedSmokeWindowLike
  attachmentUrl: string
  attachmentContent: string
  chromiumSandboxDisabledForTest: boolean
  webPreferences: {
    sandbox?: unknown
    contextIsolation?: unknown
    nodeIntegration?: unknown
  }
  timeoutMs?: number
  releaseWindow?: (window: PackagedSmokeWindowLike) => void
}): Promise<PackagedRendererSmokeReceipt> {
  const win = opts.createWindow()
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 15_000)
  try {
    await withTimeout(win.loadURL(PRODUCTION_RENDERER_URL), timeoutMs)
    const probe = asRecord(
      await withTimeout(
        win.webContents.executeJavaScript(
          rendererProbeSource(opts.attachmentUrl, opts.attachmentContent),
        ),
        timeoutMs,
      ),
    )
    const preferences = opts.webPreferences
    const receipt: PackagedRendererSmokeReceipt = {
      ok: true,
      nodeGlobalsAbsent: probe.nodeGlobalsAbsent === true,
      coreBridge: probe.bridgeExposed === true,
      coreBootstrap: probe.bootstrapOk === true,
      attachment: {
        ok: probe.attachmentOk === true,
        bytes: boundedInteger(probe.attachmentBytes),
      },
      webPreferences: {
        sandbox:
          preferences.sandbox === true && probe.rendererSandboxed === true,
        contextIsolation: preferences.contextIsolation === true,
        nodeIntegration: preferences.nodeIntegration === true,
      },
      chromiumSandbox: opts.chromiumSandboxDisabledForTest
        ? 'disabled-for-linux-test'
        : 'enabled',
    }
    const expectedBytes = Buffer.byteLength(opts.attachmentContent)
    const failed = [
      !receipt.nodeGlobalsAbsent && 'node-globals',
      !receipt.coreBridge && 'core-bridge',
      !receipt.coreBootstrap && 'core-bootstrap',
      (!receipt.attachment.ok || receipt.attachment.bytes !== expectedBytes) &&
        'attachment',
      !receipt.webPreferences.sandbox && 'sandbox-preference',
      !receipt.webPreferences.contextIsolation && 'context-isolation',
      receipt.webPreferences.nodeIntegration && 'node-integration',
    ].filter(Boolean)
    if (failed.length)
      throw new Error(
        `packaged renderer sandbox verification failed: ${failed.join(', ')}`,
      )
    return receipt
  } finally {
    if (!win.isDestroyed()) win.destroy()
    opts.releaseWindow?.(win)
  }
}

export function rendererProbeSource(
  attachmentUrl: string,
  attachmentContent: string,
): string {
  const url = JSON.stringify(attachmentUrl)
  const content = JSON.stringify(attachmentContent)
  return `(async () => {
    const nodeGlobalsAbsent =
      typeof globalThis.process === 'undefined' &&
      typeof globalThis.require === 'undefined' &&
      typeof globalThis.Buffer === 'undefined'
    const bridge = globalThis.emperor
    const bridgeExposed = Boolean(
      bridge && typeof bridge.invokeCore === 'function'
    )
    const rendererSandboxed = bridgeExposed && bridge.sandboxed === true
    let bootstrapOk = false
    if (bridgeExposed) {
      const boot = await bridge.invokeCore('bootstrap')
      bootstrapOk = Boolean(boot && boot.app === 'Emperor Agent')
    }
    let response
    try {
      response = await fetch(${url})
    } catch (error) {
      throw new Error('renderer attachment fetch failed after Core bootstrap')
    }
    const body = await response.text()
    return {
      nodeGlobalsAbsent,
      bridgeExposed,
      rendererSandboxed,
      bootstrapOk,
      attachmentOk: response.ok && body === ${content},
      attachmentBytes: new TextEncoder().encode(body).byteLength,
    }
  })()`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function boundedInteger(value: unknown): number {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 1_048_576
    ? numeric
    : -1
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('packaged renderer smoke timed out')),
          timeoutMs,
        )
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
