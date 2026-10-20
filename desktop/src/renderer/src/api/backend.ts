import type { OpenPathTarget } from '../../../shared/ipc-contract'
// Electron desktop talks to CoreApi over preload IPC. Browser-only tests inject
// this same bridge surface; the product no longer supports HTTP/WS fallback.

import type {
  CoreIpcErrorEnvelope,
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
  TerminalEvent,
} from '@emperor/core/api'
import type {
  CredentialBinding,
  CredentialHandle,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import type {
  AgentDownloadView,
  AgentPreviewFrame,
  AgentPreviewUpdate,
  AgentPreviewPointer,
  BrowserExtensionInstallResult,
  BrowserExtensionRemoveResult,
  BrowserExtensionStatus,
  BrowserImportRequest,
  BrowserImportResult,
  BrowserImportSource,
  BrowserImportSources,
  BrowserPairingStatus,
  DownloadHistory,
  MacHelperPermission,
  MacHelperStatus,
  UserDownloadView,
} from '../../../shared/ipc-contract'

export type {
  AgentDownloadView,
  AgentPreviewFrame,
  AgentPreviewUpdate,
  BrowserExtensionInstallResult,
  BrowserExtensionRemoveResult,
  BrowserExtensionStatus,
  BrowserImportRequest,
  BrowserImportResult,
  BrowserImportSource,
  BrowserImportSources,
  DownloadHistory,
  UserDownloadView,
}

export interface VaultDraft {
  handleId?: string
  label: string
  bindings: CredentialBinding[]
  username?: string
  password?: string
  totpSecret?: string
  revealUsername?: boolean
  fillMode?: 'auto' | 'confirm'
}

/** Settings-only entry view: the handle plus the entry's own settings. */
export interface VaultEntry extends CredentialHandle {
  readonly revealUsername: boolean
  /** Last time a secret was released for filling (ms). */
  readonly lastUsedAt?: number
  /** Origin or app bundle ID that fill went to; never a value. */
  readonly lastUsedTarget?: string
}

export type VaultProblem =
  | 'key-missing'
  | 'key-invalid'
  | 'key-permissions'
  | 'vault-unreadable'
  | 'vault-newer'

/** 主密码 changes: change and remove need the current one; set types it twice. */
export type VaultMasterRequest =
  | { action: 'set'; password: string; confirmPassword: string }
  | {
      action: 'change'
      currentPassword: string
      password: string
      confirmPassword: string
    }
  | { action: 'remove'; currentPassword: string }

export type VaultExportResult = { ok: true; name: string } | { canceled: true }
export type VaultImportPick = { name: string } | { canceled: true }

export interface VaultStatus {
  available: boolean
  /** Where secrets are sealed: `emperor-local` (Emperor's local key file). */
  backend?: string
  /**
   * Why the vault is unavailable: vault.json cannot be read or a newer
   * Emperor wrote it (从备份恢复 / 重新开始（先备份）, the file is kept), the
   * local key is gone while entries need it or failed its checks (清空), or
   * other users can read the key (修复权限 first).
   */
  problem?: VaultProblem
  locked: boolean
  hasMasterPassword: boolean
  handles: VaultEntry[]
}

export const CORE_BRIDGE_UNAVAILABLE_MESSAGE =
  '无法连接 Emperor 核心：请在 Emperor 桌面窗口中打开。'

interface EmperorBridge {
  vaultStatus?: () => Promise<VaultStatus>
  vaultSave?: (draft: VaultDraft) => Promise<CredentialHandle>
  vaultRemove?: (handleId: string) => Promise<{ ok: boolean }>
  vaultUnlock?: (password: string) => Promise<{ unlocked: boolean }>
  vaultLock?: () => Promise<{ ok: boolean }>
  vaultMaster?: (request: VaultMasterRequest) => Promise<{ ok: boolean }>
  vaultReveal?: (handleId: string) => Promise<{ password: string }>
  vaultReset?: () => Promise<{ ok: boolean }>
  vaultRepairKey?: () => Promise<{ repaired: boolean }>
  vaultStartOver?: () => Promise<{ ok: boolean; backup: string | null }>
  vaultExport?: (
    passphrase: string,
    confirmPassphrase: string,
  ) => Promise<VaultExportResult>
  vaultImportPick?: () => Promise<VaultImportPick>
  vaultImport?: (passphrase: string) => Promise<{ imported: number }>
  selectDirectory?: () => Promise<string | null>
  getPathForFile?: (file: File) => string
  openPath?: (
    target: OpenPathTarget,
  ) => Promise<{ ok?: boolean; error?: string } | void>
  revealReference?: (input: {
    sessionId: string
    referenceId: string
  }) => Promise<{ ok?: boolean; error?: string } | void>
  openExternal?: (
    url: string,
  ) => Promise<{ ok?: boolean; error?: string } | void>
  openLink?: (
    url: string,
  ) => Promise<{ ok?: boolean; opened?: 'builtin' | 'system' | 'refused' }>
  loadRemoteImage?: (url: string) => Promise<RemoteImageResult>
  onBrowserReveal?: (listener: (payload: { url: string }) => void) => () => void
  openSkillsFolder?: (input: {
    scope: SkillFolderScope
    sessionId?: string | null
  }) => Promise<{
    ok?: boolean
    error?: string
    code?: string
    path?: string
  } | void>
  selectFile?: (input?: {
    title?: string
    filters?: FileDialogFilter[]
  }) => Promise<string | null>
  invokeCore?: <Key extends CoreOperationKey>(
    operationKey: Key,
    ...args: CoreOperationArgs<Key>
  ) => Promise<CoreOperationResult<Key> | CoreIpcErrorEnvelope>
  /** The session on screen; every core call carries it (KRN-01). */
  setViewingSession?: (sessionId: string | null) => void
  onCoreEvent?: (listener: (event: unknown) => void) => () => void
  onSessionEvents?: (listener: (batch: SessionEventBatch) => void) => () => void
  onTerminalEvent?: (
    listener: (event: TerminalEvent) => void,
    scope: { sessionId: string; terminalId: string },
  ) => () => void
  openBrowserUrl?: (url: string) => Promise<unknown>
  browserBounds?: (bounds: BrowserViewBounds | null) => void
  browserAction?: (action: BrowserViewAction) => void
  browserClose?: () => void
  browserHistory?: () => Promise<unknown>
  openBrowserHistory?: (id: string) => Promise<unknown>
  clearBrowserData?: () => Promise<unknown>
  onBrowserState?: (listener: (state: BrowserViewState) => void) => () => void
  browserDownloads?: () => Promise<unknown>
  openBrowserDownload?: (id: string) => Promise<unknown>
  revealBrowserDownload?: (id: string) => Promise<unknown>
  removeBrowserDownload?: (id: string) => Promise<unknown>
  chooseDownloadFolder?: () => Promise<unknown>
  browserImportSources?: () => Promise<unknown>
  runBrowserImport?: (request: BrowserImportRequest) => Promise<unknown>
  onBrowserDownload?: (
    listener: (download: UserDownloadView) => void,
  ) => () => void
  agentPreviewStart?: (targetId: string) => Promise<unknown>
  agentPreviewStop?: (targetId: string) => void
  agentDownloadReveal?: (downloadId: string) => Promise<unknown>
  agentDownloadMove?: (downloadId: string) => Promise<unknown>
  agentDownloadSaveAs?: (downloadId: string) => Promise<unknown>
  macHelperStatus?: () => Promise<MacHelperStatus>
  macHelperRequestPermission?: (
    permission: MacHelperPermission,
  ) => Promise<{ opened: boolean }>
  macHelperResetPermission?: (
    permission: MacHelperPermission,
  ) => Promise<{ reset: boolean }>
  macHelperReconnect?: () => Promise<MacHelperStatus>
  browserPairings?: () => Promise<BrowserPairingStatus>
  approveBrowserPairing?: (pairingId: string) => Promise<{ approved: boolean }>
  denyBrowserPairing?: (pairingId: string) => Promise<{ denied: boolean }>
  revokeBrowserPairing?: (pairingId: string) => Promise<{ revoked: boolean }>
  browserExtensionStatus?: () => Promise<BrowserExtensionStatus>
  installBrowserExtension?: () => Promise<BrowserExtensionInstallResult>
  revealBrowserExtension?: () => Promise<{ ok: boolean }>
  removeBrowserExtension?: () => Promise<BrowserExtensionRemoveResult>
  onBrowserPairingRequest?: (listener: () => void) => () => void
  /** App menu items that act in the window (偏好设置… → 设置). */
  onMenuCommand?: (listener: (command: 'open-settings') => void) => () => void
  onAgentPreviewFrame?: (
    listener: (frame: AgentPreviewUpdate) => void,
  ) => () => void
  onAgentPreviewPointer?: (
    listener: (pointer: AgentPreviewPointer) => void,
  ) => () => void
}

export type SkillFolderScope = 'user' | 'project'

/** Extension filter of the native file picker. */
export interface FileDialogFilter {
  name: string
  extensions: string[]
}

/** One batch of raw session-log events of a watched session (`sessions.watch`). */
export interface SessionEventBatch {
  sessionId: string
  events: WireSessionEvent[]
}

/** Viewport rectangle of the embedded browser, in window CSS pixels. */
export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserViewAction = 'back' | 'forward' | 'reload' | 'stop'

/** State of the embedded browser view pushed by main (`onBrowserState`). */
export interface BrowserViewState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Only on the update reporting a failed main-frame load or crash. */
  error?: string
}

export interface BrowserOpenResult {
  ok: boolean
  /** The normalized http(s) URL main started loading. */
  url?: string
  /** User-facing reason when the input was refused or the view is unavailable. */
  error?: string
}

/** The started preview's page viewport. */
export type AgentPreviewStart =
  { ok: true; width: number; height: number } | { ok: false; error: string }

function bridge(): EmperorBridge | undefined {
  return (globalThis as unknown as { window?: { emperor?: EmperorBridge } })
    .window?.emperor
}

export async function vaultStatus(): Promise<VaultStatus> {
  const invoke = bridge()?.vaultStatus
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return invoke()
}

export async function vaultSave(draft: VaultDraft): Promise<CredentialHandle> {
  const invoke = bridge()?.vaultSave
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return invoke(draft)
}

export async function vaultRemove(handleId: string): Promise<void> {
  const invoke = bridge()?.vaultRemove
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  await invoke(handleId)
}

export async function vaultUnlock(password: string): Promise<boolean> {
  const invoke = bridge()?.vaultUnlock
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return (await invoke(password)).unlocked
}

export async function vaultLock(): Promise<void> {
  const invoke = bridge()?.vaultLock
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  await invoke()
}

/** Sets, changes or removes the master password (re-sealing every entry). */
export async function vaultMaster(request: VaultMasterRequest): Promise<void> {
  const invoke = bridge()?.vaultMaster
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  await invoke(request)
}

/** 修复权限: true when the local key is usable afterwards. */
export async function vaultRepairKey(): Promise<boolean> {
  const invoke = bridge()?.vaultRepairKey
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return (await invoke()).repaired
}

/** 重新开始（先备份）: the backup's file name, or null when there was none. */
export async function vaultStartOver(): Promise<{ backup: string | null }> {
  const invoke = bridge()?.vaultStartOver
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const { backup } = await invoke()
  return { backup }
}

/** 导出凭据备份: main asks where to save it. */
export async function vaultExport(
  passphrase: string,
  confirmPassphrase: string,
): Promise<VaultExportResult> {
  const invoke = bridge()?.vaultExport
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return invoke(passphrase, confirmPassphrase)
}

/** Step 1 of 导入 / 从备份恢复: main's open dialog picks the file. */
export async function vaultImportPick(): Promise<VaultImportPick> {
  const invoke = bridge()?.vaultImportPick
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return invoke()
}

/** Step 2: open the picked backup with its passphrase. */
export async function vaultImport(
  passphrase: string,
): Promise<{ imported: number }> {
  const invoke = bridge()?.vaultImport
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return invoke(passphrase)
}

/** 清空: deletes every entry and the master password; confirm first. */
export async function vaultReset(): Promise<void> {
  const invoke = bridge()?.vaultReset
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  await invoke()
}

export async function vaultReveal(handleId: string): Promise<string> {
  const invoke = bridge()?.vaultReveal
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return (await invoke(handleId)).password
}

export async function selectDirectory(): Promise<string | null> {
  const picker = bridge()?.selectDirectory
  return typeof picker === 'function' ? picker() : null
}

export function getPathForFile(file: File): string {
  const resolvePath = bridge()?.getPathForFile
  if (typeof resolvePath !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const path = resolvePath(file).trim()
  if (!path) throw new Error('无法读取所选文件路径')
  return path
}

/**
 * Open a folder in Finder: one Core vouches for (设置 › 诊断's Emperor Home or
 * project, a Skill's folder). Main resolves the path; the renderer cannot
 * name one (SEC-05).
 */
export async function openPath(target: OpenPathTarget): Promise<void> {
  const opener = bridge()?.openPath
  if (typeof opener !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(target)
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : 'Failed to open path',
    )
  }
}

export async function revealReference(input: {
  sessionId: string
  referenceId: string
}): Promise<void> {
  const reveal = bridge()?.revealReference
  if (typeof reveal !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await reveal(input)
  if (result && typeof result === 'object' && result.ok === false)
    throw new Error(result.error || 'Failed to reveal reference')
}

export async function openExternal(url: string): Promise<void> {
  const opener = bridge()?.openExternal
  if (typeof opener !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(url)
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : 'Failed to open external url',
    )
  }
}

export const LINK_REFUSED_MESSAGE = '无法打开这个链接'

/**
 * A web link the user clicked in Emperor's UI: main opens it in the system
 * browser or the built-in one (设置 › 浏览器; addresses of this machine
 * only in the built-in one). `openExternal` stays the explicit "open in the
 * system browser" action. Resolves where it opened; throws when main
 * refused it (not http(s), URL credentials, or a local address while the
 * built-in browser is off).
 */
export async function openLink(url: string): Promise<'builtin' | 'system'> {
  const opener = bridge()?.openLink
  if (typeof opener !== 'function') {
    // A bridge without link routing (tests, the visual harness).
    await openExternal(url)
    return 'system'
  }
  const result = await opener(url)
  if (result?.opened === 'builtin' || result?.opened === 'system')
    return result.opened
  throw new Error(LINK_REFUSED_MESSAGE)
}

export type RemoteImageResult =
  { ok: true; dataUrl: string } | { ok: false; error: string }

/**
 * A remote image in rendered markdown, on the user's request (UI-38): main
 * fetches it through the public HTTP client (no cookies, no local or
 * private addresses) and returns it as a data: URL; the renderer itself
 * never requests a remote address (CSP img-src has no http(s)).
 */
export async function loadRemoteImage(url: string): Promise<RemoteImageResult> {
  const load = bridge()?.loadRemoteImage
  if (typeof load !== 'function')
    return { ok: false, error: CORE_BRIDGE_UNAVAILABLE_MESSAGE }
  const result = await load(url)
  if (result?.ok === true && typeof result.dataUrl === 'string') return result
  return {
    ok: false,
    error:
      result && result.ok === false && typeof result.error === 'string'
        ? result.error
        : '图片加载失败',
  }
}

/** Main opened a clicked link in the built-in browser. */
export function onBrowserReveal(
  listener: (payload: { url: string }) => void,
): () => void {
  return bridge()?.onBrowserReveal?.(listener) ?? (() => {})
}

/** A failed `openSkillsFolder`, carrying the Core error code when there is one. */
export class SkillsFolderError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'SkillsFolderError'
  }
}

/**
 * Open the personal (`user`) or project Skills folder in the OS file manager;
 * resolves the folder path. The user folder is created when missing, a project
 * folder only exists once a project Skill was saved there.
 */
export async function openSkillsFolder(input: {
  scope: SkillFolderScope
  sessionId?: string | null
}): Promise<string> {
  const opener = bridge()?.openSkillsFolder
  if (typeof opener !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(input)
  if (result && typeof result === 'object' && result.ok === false)
    throw new SkillsFolderError(
      result.error || 'Failed to open the Skills folder',
      result.code ?? null,
    )
  return result && typeof result === 'object' ? String(result.path ?? '') : ''
}

/** Native single-file picker (e.g. `{ filters: [{ name: 'Zip', extensions: ['zip'] }] }`). */
export async function selectFile(
  input: { title?: string; filters?: FileDialogFilter[] } = {},
): Promise<string | null> {
  const picker = bridge()?.selectFile
  return typeof picker === 'function' ? picker(input) : null
}

export async function invokeCore<Key extends CoreOperationKey>(
  operationKey: Key,
  ...args: CoreOperationArgs<Key>
): Promise<CoreOperationResult<Key>> {
  const invoke = bridge()?.invokeCore
  if (typeof invoke !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await invoke(operationKey, ...args)
  if (isCoreIpcErrorEnvelope(result)) {
    const safeError = safeCoreIpcError(result)
    const error = new Error(safeError.message) as Error & {
      errorId?: string
      code?: string
      action?: string
    }
    if (safeError.errorId) error.errorId = safeError.errorId
    if (safeError.code) error.code = safeError.code
    if (safeError.action) error.action = safeError.action
    throw error
  }
  return result
}

/**
 * Tell the bridge which session the window shows (null: none, such as a
 * draft). Core reads it from each call instead of keeping a focus of its
 * own (KRN-01).
 */
export function setViewingSession(sessionId: string | null): void {
  bridge()?.setViewingSession?.(sessionId)
}

export function hasCoreBridge(): boolean {
  return typeof bridge()?.invokeCore === 'function'
}

export function onCoreEvent(listener: (event: unknown) => void): () => void {
  const subscribe = bridge()?.onCoreEvent
  if (typeof subscribe !== 'function') return () => {}
  return subscribe(listener)
}

/** Subscribe to raw session-log event batches; a no-op without the bridge. */
export function onSessionEvents(
  listener: (batch: SessionEventBatch) => void,
): () => void {
  const subscribe = bridge()?.onSessionEvents
  if (typeof subscribe !== 'function') return () => {}
  return subscribe(listener)
}

export function onTerminalEvent(
  listener: (event: TerminalEvent) => void,
  scope: { sessionId: string; terminalId: string },
): () => void {
  const subscribe = bridge()?.onTerminalEvent
  if (typeof subscribe !== 'function') return () => {}
  return subscribe(listener, scope)
}

const BROWSER_OPEN_FAILED = '无法打开网址'

/**
 * Open what the user typed in the embedded browser. Trust boundary: only the
 * BrowserPane address bar may call this, on an explicit user submit — never
 * with URLs from markdown, tool output or model text (enforced by
 * `desktop/src/main/trusted-renderer-usage.test.ts`). Main normalizes the
 * input (bare hosts get http:// for this machine, https:// otherwise) and
 * refuses anything but credential-free http(s).
 */
export async function openBrowserUrl(url: string): Promise<BrowserOpenResult> {
  const open = bridge()?.openBrowserUrl
  if (typeof open !== 'function')
    return { ok: false, error: CORE_BRIDGE_UNAVAILABLE_MESSAGE }
  let result: unknown
  try {
    result = await open(url)
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : BROWSER_OPEN_FAILED,
    }
  }
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  if (record.ok === true && typeof record.url === 'string')
    return { ok: true, url: record.url }
  return {
    ok: false,
    error:
      typeof record.error === 'string' && record.error
        ? record.error
        : BROWSER_OPEN_FAILED,
  }
}

/** Place the native browser view; null hides it (it draws above the DOM). */
export function setBrowserBounds(bounds: BrowserViewBounds | null): void {
  bridge()?.browserBounds?.(bounds)
}

export function browserAction(action: BrowserViewAction): void {
  bridge()?.browserAction?.(action)
}

/** Close the view and wipe its in-memory browsing data. */
export function closeBrowserView(): void {
  bridge()?.browserClose?.()
}

export function onBrowserState(
  listener: (state: BrowserViewState) => void,
): () => void {
  return bridge()?.onBrowserState?.(listener) ?? (() => {})
}

/** One page of the built-in browser's temporary history. */
export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string
  time: number
}

/** The temporary history, newest first (empty without a bridge or when off). */
export async function fetchBrowserHistory(): Promise<BrowserHistoryEntry[]> {
  const read = bridge()?.browserHistory
  if (typeof read !== 'function') return []
  let result: unknown
  try {
    result = await read()
  } catch {
    return []
  }
  if (!Array.isArray(result)) return []
  return result.flatMap((item) => {
    const entry = item as Partial<BrowserHistoryEntry> | null
    return entry &&
      typeof entry.id === 'string' &&
      typeof entry.url === 'string' &&
      typeof entry.title === 'string' &&
      typeof entry.time === 'number'
      ? [
          {
            id: entry.id,
            url: entry.url,
            title: entry.title,
            time: entry.time,
          },
        ]
      : []
  })
}

/** Reopen a history entry: only its id goes to main, which checks it again. */
export async function openBrowserHistoryEntry(
  id: string,
): Promise<BrowserOpenResult> {
  return await okOrError(bridge()?.openBrowserHistory, [id], (record) =>
    typeof record.url === 'string' ? { ok: true, url: record.url } : null,
  )
}

/** Clear the built-in browser's data; resolves once main finished. */
export async function clearBrowserData(): Promise<BrowserOpenResult> {
  return await okOrError(bridge()?.clearBrowserData, [], () => ({ ok: true }))
}

// ── 从浏览器导入 (ST-06) ──────────────────────────────────────────────────

/** The browsers to import from and their running state (empty without a bridge). */
export async function fetchBrowserImportSources(): Promise<BrowserImportSources> {
  const read = bridge()?.browserImportSources
  if (typeof read !== 'function') return { browsers: [] }
  try {
    const result = await read()
    const browsers = (result as BrowserImportSources)?.browsers
    return { browsers: Array.isArray(browsers) ? browsers : [] }
  } catch {
    return { browsers: [] }
  }
}

/** Run one import in main; resolves counts on success, or a failure reason. */
export async function runBrowserImport(
  request: BrowserImportRequest,
): Promise<BrowserImportResult> {
  const run = bridge()?.runBrowserImport
  if (typeof run !== 'function') return { ok: false, reason: 'internal' }
  try {
    return (await run(request)) as BrowserImportResult
  } catch {
    return { ok: false, reason: 'internal' }
  }
}

// ── Your downloads (设置 › 浏览器 › 下载) ─────────────────────────────────

/** The download history, newest first (empty without a bridge). */
export async function fetchDownloadHistory(): Promise<DownloadHistory> {
  const read = bridge()?.browserDownloads
  if (typeof read !== 'function') return { user: [], agent: [] }
  let result: unknown
  try {
    result = await read()
  } catch {
    return { user: [], agent: [] }
  }
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  return {
    user: Array.isArray(record.user) ? record.user.filter(isUserDownload) : [],
    agent: Array.isArray(record.agent)
      ? record.agent.filter(isAgentDownload)
      : [],
  }
}

function isUserDownload(value: unknown): value is UserDownloadView {
  const entry = value as Partial<UserDownloadView> | null
  return Boolean(
    entry &&
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.site === 'string' &&
    typeof entry.time === 'number' &&
    typeof entry.state === 'string' &&
    typeof entry.bytes === 'number',
  )
}

function isAgentDownload(value: unknown): value is AgentDownloadView {
  const entry = value as Partial<AgentDownloadView> | null
  return Boolean(
    entry &&
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.site === 'string' &&
    typeof entry.time === 'number' &&
    typeof entry.bytes === 'number' &&
    typeof entry.exists === 'boolean',
  )
}

async function downloadCall(
  call: ((id: string) => Promise<unknown>) | undefined,
  id: string,
  fallback: string,
): Promise<void> {
  if (typeof call !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = (await call(id)) as { ok?: boolean; error?: string } | null
  if (result?.ok !== true) throw new Error(result?.error || fallback)
}

/** Open a finished download of yours; throws with the reason. */
export async function openUserDownload(id: string): Promise<void> {
  await downloadCall(bridge()?.openBrowserDownload, id, '无法打开这个文件')
}

/** Show a finished download of yours in Finder. */
export async function revealUserDownload(id: string): Promise<void> {
  await downloadCall(bridge()?.revealBrowserDownload, id, '找不到这个下载文件')
}

/** Take a download off your list; the file stays. */
export async function removeUserDownload(id: string): Promise<void> {
  await downloadCall(bridge()?.removeBrowserDownload, id, '无法从列表中移除')
}

/**
 * 设置 › 浏览器 › 下载 › 位置: main shows the system folder picker; the
 * chosen folder, or null when cancelled.
 */
export async function chooseDownloadFolder(): Promise<string | null> {
  const choose = bridge()?.chooseDownloadFolder
  if (typeof choose !== 'function') return null
  const folder = await choose()
  return typeof folder === 'string' && folder ? folder : null
}

/** One of your downloads started, moved on or ended. */
export function onUserDownload(
  listener: (download: UserDownloadView) => void,
): () => void {
  return bridge()?.onBrowserDownload?.(listener) ?? (() => {})
}

async function okOrError(
  call: ((...args: string[]) => Promise<unknown>) | undefined,
  args: string[],
  success: (record: Record<string, unknown>) => BrowserOpenResult | null,
): Promise<BrowserOpenResult> {
  if (typeof call !== 'function')
    return { ok: false, error: CORE_BRIDGE_UNAVAILABLE_MESSAGE }
  let result: unknown
  try {
    result = await call(...args)
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : BROWSER_OPEN_FAILED,
    }
  }
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  const done = record.ok === true ? success(record) : null
  if (done) return done
  return {
    ok: false,
    error:
      typeof record.error === 'string' && record.error
        ? record.error
        : BROWSER_OPEN_FAILED,
  }
}

export async function macHelperStatus(): Promise<MacHelperStatus> {
  const read = bridge()?.macHelperStatus
  if (typeof read !== 'function')
    return {
      available: false,
      connected: false,
      helperVersion: null,
      protocol: null,
      permissions: { accessibility: 'unknown', 'screen-recording': 'unknown' },
      lastErrorCode: null,
      reason: 'macOS helper 状态不可用',
    }
  return await read()
}

/** Called only by the Settings button; requests the helper's OS permission flow. */
export async function macHelperRequestPermission(
  permission: MacHelperPermission,
): Promise<{ opened: boolean }> {
  const request = bridge()?.macHelperRequestPermission
  if (typeof request !== 'function') return { opened: false }
  return await request(permission)
}

/** Called only after the user confirms a reset in trusted Settings. */
export async function macHelperResetPermission(
  permission: MacHelperPermission,
): Promise<{ reset: boolean }> {
  const reset = bridge()?.macHelperResetPermission
  if (typeof reset !== 'function') return { reset: false }
  return await reset(permission)
}

/**
 * Settings 「重新连接」 only: clears the Helper's crash-restart latch, restarts
 * it and answers the fresh status.
 */
export async function macHelperReconnect(): Promise<MacHelperStatus> {
  const reconnect = bridge()?.macHelperReconnect
  if (typeof reconnect !== 'function') return await macHelperStatus()
  return await reconnect()
}

export async function browserPairings(): Promise<BrowserPairingStatus> {
  const status = await bridge()?.browserPairings?.()
  return status
    ? { ...status, pairings: status.pairings ?? [] }
    : {
        bridgeListening: false,
        pendingPairings: [],
        pairedConnections: [],
        attachedTabs: 0,
        pairings: [],
      }
}

/**
 * 设置 › 电脑操作 › Chrome 和 Edge: the extension folder and where the
 * extension is loaded; null without the desktop bridge.
 */
export async function browserExtensionStatus(): Promise<BrowserExtensionStatus | null> {
  return (await bridge()?.browserExtensionStatus?.()) ?? null
}

/** 安装扩展程序: the folder, then the browser host; null without the bridge. */
export async function installBrowserExtension(): Promise<BrowserExtensionInstallResult | null> {
  return (await bridge()?.installBrowserExtension?.()) ?? null
}

/** 在访达中显示; false while the folder is not there. */
export async function revealBrowserExtension(): Promise<boolean> {
  return (await bridge()?.revealBrowserExtension?.())?.ok === true
}

/** 移除扩展程序; null without the bridge. */
export async function removeBrowserExtension(): Promise<BrowserExtensionRemoveResult | null> {
  return (await bridge()?.removeBrowserExtension?.()) ?? null
}

/** An extension asked to pair (main sends nothing else). */
export function onBrowserPairingRequest(listener: () => void): () => void {
  return bridge()?.onBrowserPairingRequest?.(listener) ?? (() => {})
}

/** The app menu asked the window to act (偏好设置… ⌘, opens 设置). */
export function onMenuCommand(
  listener: (command: 'open-settings') => void,
): () => void {
  return bridge()?.onMenuCommand?.(listener) ?? (() => {})
}

export async function approveBrowserPairing(
  pairingId: string,
): Promise<boolean> {
  return (await bridge()?.approveBrowserPairing?.(pairingId))?.approved === true
}

export async function denyBrowserPairing(pairingId: string): Promise<boolean> {
  return (await bridge()?.denyBrowserPairing?.(pairingId))?.denied === true
}

export async function revokeBrowserPairing(
  pairingId: string,
): Promise<boolean> {
  return (await bridge()?.revokeBrowserPairing?.(pairingId))?.revoked === true
}

/** Start streaming an Agent tab's frames to this window. */
export async function agentPreviewStart(
  targetId: string,
): Promise<AgentPreviewStart> {
  const start = bridge()?.agentPreviewStart
  if (typeof start !== 'function')
    return { ok: false, error: CORE_BRIDGE_UNAVAILABLE_MESSAGE }
  try {
    const result = (await start(targetId)) as Record<string, unknown> | null
    if (
      result?.ok === true &&
      typeof result.width === 'number' &&
      typeof result.height === 'number'
    )
      return { ok: true, width: result.width, height: result.height }
    return {
      ok: false,
      error: typeof result?.error === 'string' ? result.error : '无法预览',
    }
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : '无法预览',
    }
  }
}

/** Show a completed download of the inbox in Finder / Explorer. */
export async function revealAgentDownload(downloadId: string): Promise<void> {
  const reveal = bridge()?.agentDownloadReveal
  if (typeof reveal !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = (await reveal(downloadId)) as { ok?: boolean; error?: string }
  if (result?.ok !== true)
    throw new Error(result?.error || '找不到这个下载文件')
}

/**
 * Move a completed download into its conversation's workspace
 * (`downloads/`); resolves with the new absolute path.
 */
export async function moveAgentDownload(downloadId: string): Promise<string> {
  const move = bridge()?.agentDownloadMove
  if (typeof move !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = (await move(downloadId)) as {
    ok?: boolean
    path?: string
    error?: string
  }
  if (result?.ok !== true || typeof result.path !== 'string')
    throw new Error(result?.error || '找不到这个下载文件')
  return result.path
}

/**
 * "另存为…": the user picks the destination in the system dialog. Resolves
 * with the new path, or null when the user cancelled.
 */
export async function saveAgentDownloadAs(
  downloadId: string,
): Promise<string | null> {
  const saveAs = bridge()?.agentDownloadSaveAs
  if (typeof saveAs !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = (await saveAs(downloadId)) as {
    ok?: boolean
    path?: string
    cancelled?: boolean
    error?: string
  }
  if (result?.cancelled === true) return null
  if (result?.ok !== true || typeof result.path !== 'string')
    throw new Error(result?.error || '找不到这个下载文件')
  return result.path
}

/** Stop the frame stream; the Agent tab itself keeps running. */
export function agentPreviewStop(targetId: string): void {
  bridge()?.agentPreviewStop?.(targetId)
}

export function onAgentPreviewFrame(
  listener: (frame: AgentPreviewUpdate) => void,
): () => void {
  return bridge()?.onAgentPreviewFrame?.(listener) ?? (() => {})
}

/**
 * Where the Agent's latest action landed on a target, as shares (0–1) of
 * its picture: the preview card draws the pointer there.
 */
export function onAgentPreviewPointer(
  listener: (pointer: AgentPreviewPointer) => void,
): () => void {
  return bridge()?.onAgentPreviewPointer?.(listener) ?? (() => {})
}

function isCoreIpcErrorEnvelope(value: unknown): value is CoreIpcErrorEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return (
    payload.ok === false &&
    Boolean(
      payload.error &&
      typeof payload.error === 'object' &&
      !Array.isArray(payload.error),
    )
  )
}

function safeCoreIpcError(value: CoreIpcErrorEnvelope): {
  message: string
  errorId?: string
  code?: string
  action?: string
} {
  const error = value.error
  const message =
    typeof error.message === 'string' && error.message
      ? error.message
      : 'Internal error'
  return {
    message,
    errorId: typeof error.errorId === 'string' ? error.errorId : undefined,
    code: typeof error.code === 'string' ? error.code : undefined,
    action: typeof error.action === 'string' ? error.action : undefined,
  }
}
