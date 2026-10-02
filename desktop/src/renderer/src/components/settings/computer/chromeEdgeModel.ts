/**
 * 设置 › 电脑操作 › Chrome 和 Edge, as data: the page head, the four
 * install steps and the rows of 连接, from the pairing status and the
 * extension folder status. Pure, for ChromeEdgePage.vue and its tests.
 *
 * The extension connecting to Emperor is the main signal: a pairing
 * request or a saved pairing means the folder was loaded, whatever the
 * browser's preference files (written ~10 s late) say yet.
 */
import type {
  BrowserExtensionBrowser,
  BrowserExtensionStatus,
  BrowserPairingStatus,
} from '../../../../../shared/ipc-contract'

export type StepKey = 'folder' | 'developer' | 'load' | 'connect'
export type StepState = 'done' | 'now' | 'todo'

export interface InstallStep {
  readonly key: StepKey
  readonly state: StepState
}

export interface HeroView {
  readonly tone: 'ok' | 'warn' | 'neutral'
  readonly badge: string
  readonly dot: boolean
  readonly description: string
  /** 安装扩展程序 before the extension is in a browser, then 重新安装. */
  readonly installLabel: string
  readonly installPrimary: boolean
  readonly canRemove: boolean
}

export interface ConnectionRow {
  readonly key: string
  readonly title: string
  readonly description: string
  /** 断开 a connected pairing, 撤销 a saved one, 安装步骤 for a browser without it. */
  readonly action?: 'disconnect' | 'revoke' | 'setup'
  readonly pairingId?: string
}

export interface ExtensionAddress {
  readonly browser: BrowserExtensionBrowser
  readonly url: string
}

const NAMES: Record<BrowserExtensionBrowser, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
}
const SHORT: Record<BrowserExtensionBrowser, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
}

export function browserName(
  browser: BrowserExtensionBrowser | null | undefined,
): string {
  return browser ? NAMES[browser] : 'Chrome 或 Edge'
}

/** The six digits as `482 913`. */
export function formatCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

function connectedCount(pairing: BrowserPairingStatus): number {
  return pairing.pairings.length
    ? pairing.pairings.filter((item) => item.connected).length
    : pairing.pairedConnections.length
}

/** The extension is in a browser: loaded there, paired, or asking to pair. */
export function extensionInBrowser(
  pairing: BrowserPairingStatus,
  extension: BrowserExtensionStatus | null,
): boolean {
  return (
    pairing.pendingPairings.length > 0 ||
    pairing.pairings.length > 0 ||
    pairing.pairedConnections.length > 0 ||
    (extension?.browsers ?? []).some(
      (item) => item.extension !== 'none' || Boolean(item.loadedFrom),
    )
  )
}

export function heroView(
  pairing: BrowserPairingStatus,
  extension: BrowserExtensionStatus | null,
): HeroView {
  const connected = connectedCount(pairing)
  const inBrowser = extensionInBrowser(pairing, extension)
  const version = extension?.folder.version ?? extension?.bundledVersion
  // A connected browser is the page's state even while another one asks
  // to pair (its row is in 连接); a lone request is what needs the user.
  const [tone, badge, dot] =
    connected > 0
      ? (['ok', `已连接 ${connected} 个浏览器`, true] as const)
      : pairing.pendingPairings.length > 0
        ? (['warn', '有配对等待确认', false] as const)
        : inBrowser
          ? (['neutral', '已安装 · 未连接', false] as const)
          : (['neutral', '未安装扩展', false] as const)
  return {
    tone,
    badge,
    dot,
    description:
      inBrowser && version
        ? `扩展 ${version}`
        : '让 Emperor 操作你在自己浏览器里连接的标签页',
    installLabel: inBrowser ? '重新安装扩展程序' : '安装扩展程序',
    installPrimary: !inBrowser,
    canRemove: inBrowser,
  }
}

/** The 安装扩展 card shows until a browser is paired (or on request). */
export function setupNeeded(pairing: BrowserPairingStatus): boolean {
  return connectedCount(pairing) === 0 && pairing.pairings.length === 0
}

/** Each step is ticked on its own; the first open one is the current one. */
export function installSteps(
  pairing: BrowserPairingStatus,
  extension: BrowserExtensionStatus | null,
): InstallStep[] {
  const browsers = extension?.browsers ?? []
  const reached =
    pairing.pendingPairings.length > 0 ||
    pairing.pairings.length > 0 ||
    pairing.pairedConnections.length > 0
  const loaded = reached || browsers.some((item) => item.extension === 'loaded')
  const done: Record<StepKey, boolean> = {
    folder: extension?.folder.ready === true || reached,
    developer: loaded || browsers.some((item) => item.developerMode),
    load: loaded,
    connect: connectedCount(pairing) > 0,
  }
  const keys: StepKey[] = ['folder', 'developer', 'load', 'connect']
  const current = keys.find((key) => !done[key])
  return keys.map((key) => ({
    key,
    state: done[key] ? 'done' : key === current ? 'now' : 'todo',
  }))
}

/** The extension is loaded but switched off in some browser. */
export function extensionSwitchedOff(
  extension: BrowserExtensionStatus | null,
): boolean {
  return (extension?.browsers ?? []).some(
    (item) => item.extension === 'disabled',
  )
}

/**
 * Where to open the extensions page: Edge's own address when Edge is the
 * only browser here, both when both are.
 */
export function extensionAddresses(
  extension: BrowserExtensionStatus | null,
): ExtensionAddress[] {
  const present = (extension?.browsers ?? [])
    .filter((item) => item.present)
    .map((item) => item.browser)
  const browsers: BrowserExtensionBrowser[] = present.length
    ? present
    : ['chrome']
  return browsers.map((browser) => ({
    browser,
    url: `${browser}://extensions`,
  }))
}

/** A browser that loaded the extension from another folder (a checkout). */
export function loadedElsewhere(
  extension: BrowserExtensionStatus | null,
): { name: string; path: string } | null {
  const found = (extension?.browsers ?? []).find((item) => item.loadedFrom)
  return found ? { name: found.name, path: found.loadedFrom! } : null
}

function pairedOn(createdAt: string | null): string {
  if (!createdAt) return ''
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime())
    ? ''
    : ` · 配对于 ${date.getMonth() + 1}月${date.getDate()}日`
}

/**
 * 连接: Chrome, then Edge, then pairings that did not say which browser;
 * one row per saved pairing, else one row about the browser itself.
 */
export function connectionRows(
  pairing: BrowserPairingStatus,
  extension: BrowserExtensionStatus | null,
  setupShown: boolean,
): ConnectionRow[] {
  const rows: ConnectionRow[] = []
  const describe = (
    item: BrowserPairingStatus['pairings'][number],
    many: boolean,
  ) =>
    (item.connected
      ? `已连接 · ${item.tabs} 个可操作标签页`
      : '未连接 · 浏览器打开后自动连接') +
    (many ? pairedOn(item.createdAt) : '')
  for (const browser of ['chrome', 'edge'] as const) {
    const saved = pairing.pairings.filter((item) => item.browser === browser)
    const state = extension?.browsers.find((item) => item.browser === browser)
    const title = state?.name || NAMES[browser]
    if (saved.length) {
      for (const item of saved)
        rows.push({
          key: item.pairingId,
          title,
          description: describe(item, saved.length > 1),
          action: item.connected ? 'disconnect' : 'revoke',
          pairingId: item.pairingId,
        })
      continue
    }
    if (state && !state.present) {
      rows.push({
        key: browser,
        title,
        description: `这台 Mac 没有安装 ${SHORT[browser]}`,
      })
      continue
    }
    rows.push(
      state?.extension === 'loaded'
        ? {
            key: browser,
            title,
            description:
              '扩展已加载，还没有配对：在扩展的引导页点「连接 Emperor」',
          }
        : state?.extension === 'disabled'
          ? {
              key: browser,
              title,
              description: '扩展已停用：在扩展页打开它的开关',
            }
          : {
              key: browser,
              title,
              description: '未安装扩展',
              ...(setupShown ? {} : { action: 'setup' as const }),
            },
    )
  }
  const unlabelled = pairing.pairings.filter((item) => item.browser === null)
  for (const item of unlabelled)
    rows.push({
      key: item.pairingId,
      title: browserName(null),
      description: describe(item, unlabelled.length > 1),
      action: item.connected ? 'disconnect' : 'revoke',
      pairingId: item.pairingId,
    })
  return rows
}
