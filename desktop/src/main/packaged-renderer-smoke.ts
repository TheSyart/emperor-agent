import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ATTACHMENT_CONTENT = 'emperor-packaged-renderer-smoke-v1'
const ATTACHMENT_MONTH = '2099-01'
const PRODUCTION_RENDERER_URL = 'app://bundle/index.html'
const PRODUCTION_ORIGIN = 'app://bundle/'
const DEEP_LINK_RENDERER_URL = 'app://bundle/chat/packaged-smoke'
/** Next to `memory/`, outside every root app:// serves (REL-04). */
const TRAVERSAL_CANARY_FILE = 'smoke-traversal-canary.txt'

/**
 * REL-04 (card test 8): requests from the main window that try to climb out
 * of an app:// root, plain and with encoded dot segments and slashes. Hosts
 * that serve files must answer with an error (`mustFail`); the bundle falls
 * back to index.html for an unknown route, so it may answer 200 but never
 * with the file. None may return the canary planted in the Emperor Home or
 * the host's /etc/passwd.
 */
export const PROTOCOL_TRAVERSAL_PROBES: ReadonlyArray<{
  url: string
  mustFail: boolean
}> = [
  { url: 'app://attachments/../../etc/passwd', mustFail: true },
  {
    url: 'app://attachments/..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd/raw',
    mustFail: true,
  },
  {
    url: `app://attachments/%2e%2e/%2e%2e/%2e%2e/${TRAVERSAL_CANARY_FILE}`,
    mustFail: true,
  },
  {
    url: `app://attachments/att_${ATTACHMENT_MONTH}_00000000/..%2F..%2F..%2F..%2F${TRAVERSAL_CANARY_FILE}`,
    mustFail: true,
  },
  { url: `app://media/../../../${TRAVERSAL_CANARY_FILE}`, mustFail: true },
  {
    url: 'app://media/..%2F..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd/raw',
    mustFail: true,
  },
  {
    url: 'app://bundle/..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd',
    mustFail: false,
  },
  {
    url: 'app://bundle/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    mustFail: false,
  },
  {
    url: 'app://pet/..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd',
    mustFail: true,
  },
  {
    url: 'app://pet-assets/..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd',
    mustFail: true,
  },
]

/** What a leaked file would contain: the planted canary, and /etc/passwd's root line. */
export interface ProtocolTraversalMarkers {
  canary: string
  hostSecret: string | null
}

/** The root line of /etc/passwd, which no app:// response may contain. */
export function traversalHostSecret(path = '/etc/passwd'): string | null {
  try {
    return (
      readFileSync(path, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('root:')) ?? null
    )
  } catch {
    return null
  }
}

/** Why the reported traversal requests are not all refused (empty: refused). */
export function traversalProblems(reported: unknown): string[] {
  const list = Array.isArray(reported) ? reported.map(asRecord) : []
  const problems: string[] = []
  for (const probe of PROTOCOL_TRAVERSAL_PROBES) {
    const result = list.find((item) => item.url === probe.url)
    if (!result) problems.push(`${probe.url} was not requested`)
    else if (result.leaked === true)
      problems.push(`${probe.url} returned a file outside its root`)
    else if (
      probe.mustFail &&
      Number(result.status) >= 200 &&
      Number(result.status) < 300
    )
      problems.push(`${probe.url} answered ${String(result.status)}`)
  }
  return problems
}

export interface PackagedSmokeWindowLike {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  destroy(): void
  webContents: {
    executeJavaScript(source: string): Promise<unknown>
    openDevTools(options?: { mode: 'detach' }): void
    isDevToolsOpened(): boolean
  }
}

/** SEC-05 defenses of the packaged main window. */
export interface PackagedRendererSecurity {
  /** `app://bundle` sends the CSP header (content-security-policy.ts). */
  cspHeader: boolean
  /** index.html carries the same policy as a meta tag. */
  cspMeta: boolean
  /** `eval` throws an EvalError (script-src has no 'unsafe-eval'). */
  evalBlocked: boolean
  /** getUserMedia is refused by the default session's permission handler. */
  microphoneDenied: boolean
  /** `webPreferences.devTools` is off: opening DevTools does nothing. */
  devToolsDisabled: boolean
  /** The app menu has no reload, force reload or DevTools item. */
  productionMenu: boolean
  /**
   * SEC-04: the main window loads app://bundle whatever ELECTRON_RENDERER_URL
   * says (the runner sets it to a local server that must see no request).
   */
  rendererUrlPinned: boolean
  /**
   * REL-04: every PROTOCOL_TRAVERSAL_PROBES request from the main window was
   * refused (an error status, or the bundle's index.html, never the file).
   */
  protocolTraversalRefused: boolean
}

const DEVELOPMENT_MENU_ROLES = ['reload', 'forcereload', 'toggledevtools']

export interface PackagedRendererSmokeReceipt {
  ok: boolean
  nodeGlobalsAbsent: boolean
  coreBridge: boolean
  coreBootstrap: boolean
  deepLinkRenders: boolean
  attachment: { ok: boolean; bytes: number }
  webPreferences: {
    sandbox: boolean
    contextIsolation: boolean
    nodeIntegration: boolean
  }
  chromiumSandbox: 'enabled' | 'disabled-for-linux-test' | 'unknown'
  security: PackagedRendererSecurity
}

export async function createPackagedSmokeAttachment(
  stateRoot: string,
): Promise<{
  url: string
  path: string
  content: string
  /** Planted next to memory/; no app:// request may return it (REL-04). */
  traversalCanary: string
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
  const traversalCanary = `emperor-traversal-canary-${randomBytes(8).toString('hex')}`
  await writeFile(
    join(resolve(stateRoot), TRAVERSAL_CANARY_FILE),
    traversalCanary,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  )
  return {
    url: `app://attachments/att_${ATTACHMENT_MONTH}_${hash8}/raw`,
    path,
    content: ATTACHMENT_CONTENT,
    traversalCanary,
  }
}

export async function verifyPackagedRenderer(opts: {
  createWindow: () => PackagedSmokeWindowLike
  /** What the real main window loads (renderer-url.ts mainRendererUrl). */
  rendererUrl: string
  attachmentUrl: string
  attachmentContent: string
  /** REL-04: what a request that escaped its app:// root would return. */
  traversal: ProtocolTraversalMarkers
  chromiumSandboxDisabledForTest: boolean
  webPreferences: {
    sandbox?: unknown
    contextIsolation?: unknown
    nodeIntegration?: unknown
  }
  timeoutMs?: number
  releaseWindow?: (window: PackagedSmokeWindowLike) => void
  security: {
    expectedCsp: string
    /** Roles of every item of the installed application menu. */
    applicationMenuRoles: () => readonly string[]
    /** How long to give DevTools to open (default 500 ms). */
    devToolsSettleMs?: number
  }
}): Promise<PackagedRendererSmokeReceipt> {
  const win = opts.createWindow()
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 15_000)
  try {
    await withTimeout(win.loadURL(opts.rendererUrl), timeoutMs)
    const probe = asRecord(
      await withTimeout(
        win.webContents.executeJavaScript(
          rendererProbeSource(
            opts.attachmentUrl,
            opts.attachmentContent,
            opts.traversal,
          ),
        ),
        timeoutMs,
      ),
    )
    const traversal = traversalProblems(probe.traversal)
    await withTimeout(win.loadURL(DEEP_LINK_RENDERER_URL), timeoutMs)
    const deepProbe = asRecord(
      await withTimeout(
        win.webContents.executeJavaScript(
          rendererProbeSource(
            opts.attachmentUrl,
            opts.attachmentContent,
            opts.traversal,
          ),
        ),
        timeoutMs,
      ),
    )
    win.webContents.openDevTools({ mode: 'detach' })
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, opts.security.devToolsSettleMs ?? 500)),
    )
    const roles = opts.security
      .applicationMenuRoles()
      .map((role) => String(role).toLowerCase())
    const security: PackagedRendererSecurity = {
      cspHeader: probe.cspHeader === opts.security.expectedCsp,
      cspMeta: probe.cspMeta === opts.security.expectedCsp,
      evalBlocked: probe.evalBlocked === true,
      microphoneDenied: probe.microphoneDenied === true,
      devToolsDisabled: !win.webContents.isDevToolsOpened(),
      productionMenu:
        roles.length > 0 &&
        !roles.some((role) => DEVELOPMENT_MENU_ROLES.includes(role)),
      rendererUrlPinned:
        opts.rendererUrl === PRODUCTION_RENDERER_URL &&
        typeof probe.href === 'string' &&
        probe.href.startsWith(PRODUCTION_ORIGIN),
      protocolTraversalRefused: traversal.length === 0,
    }
    const preferences = opts.webPreferences
    const receipt: PackagedRendererSmokeReceipt = {
      ok: true,
      nodeGlobalsAbsent: probe.nodeGlobalsAbsent === true,
      coreBridge: probe.bridgeExposed === true,
      coreBootstrap: probe.bootstrapOk === true,
      deepLinkRenders:
        probe.appMounted === true && deepProbe.appMounted === true,
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
      security,
    }
    const expectedBytes = Buffer.byteLength(opts.attachmentContent)
    const failed = [
      !receipt.nodeGlobalsAbsent && 'node-globals',
      !receipt.coreBridge && 'core-bridge',
      !receipt.coreBootstrap && 'core-bootstrap',
      !receipt.deepLinkRenders && 'deep-link-render',
      (!receipt.attachment.ok || receipt.attachment.bytes !== expectedBytes) &&
        'attachment',
      !receipt.webPreferences.sandbox && 'sandbox-preference',
      !receipt.webPreferences.contextIsolation && 'context-isolation',
      receipt.webPreferences.nodeIntegration && 'node-integration',
      !security.cspHeader && 'csp-header',
      !security.cspMeta && 'csp-meta',
      !security.evalBlocked && 'eval',
      !security.microphoneDenied && 'microphone',
      !security.devToolsDisabled && 'devtools',
      !security.productionMenu && 'menu',
      !security.rendererUrlPinned && 'renderer-url',
      !security.protocolTraversalRefused &&
        `protocol-traversal (${traversal.join('; ')})`,
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
  traversal: ProtocolTraversalMarkers,
): string {
  const url = JSON.stringify(attachmentUrl)
  const content = JSON.stringify(attachmentContent)
  const traversalUrls = JSON.stringify(
    PROTOCOL_TRAVERSAL_PROBES.map((probe) => probe.url),
  )
  const canary = JSON.stringify(traversal.canary)
  const hostSecret = JSON.stringify(traversal.hostSecret)
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
    const appMounted = await new Promise((resolve) => {
      const app = document.querySelector('#app')
      if (app?.childElementCount) return resolve(true)
      const observer = new MutationObserver(() => {
        if (!app?.childElementCount) return
        observer.disconnect()
        resolve(true)
      })
      if (app) observer.observe(app, { childList: true })
      setTimeout(() => { observer.disconnect(); resolve(false) }, 3000)
    })
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
    // SEC-05: the document's CSP (header and meta), eval, the microphone.
    let cspHeader = null
    try {
      const page = await fetch(location.href, { cache: 'no-store' })
      cspHeader = page.headers.get('content-security-policy')
    } catch {}
    const cspMeta =
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? null
    const evalBlocked = await new Promise((resolve) => {
      setTimeout(() => {
        try {
          ;(0, eval)('1')
          resolve(false)
        } catch (error) {
          resolve(error instanceof EvalError)
        }
      }, 0)
    })
    const microphoneDenied = await Promise.race([
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop())
          return false
        })
        .catch((error) => Boolean(error) && error.name === 'NotAllowedError'),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ])
    // REL-04: requests that try to leave their app:// root.
    const traversal = []
    for (const target of ${traversalUrls}) {
      let status = 0
      let leaked = false
      try {
        const answer = await fetch(target, { cache: 'no-store' })
        status = answer.status
        const text = await answer.text()
        const secret = ${hostSecret}
        leaked =
          answer.ok &&
          (text.includes(${canary}) || (secret !== null && text.includes(secret)))
      } catch {}
      traversal.push({ url: target, status, leaked })
    }
    return {
      nodeGlobalsAbsent,
      bridgeExposed,
      rendererSandboxed,
      appMounted,
      bootstrapOk,
      attachmentOk: response.ok && body === ${content},
      attachmentBytes: new TextEncoder().encode(body).byteLength,
      cspHeader,
      cspMeta,
      evalBlocked,
      microphoneDenied,
      traversal,
      href: location.href,
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
