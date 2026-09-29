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
  BrowserConnectResult,
  BrowserPairingStatus,
  MacHelperPermission,
  MacHelperStatus,
} from '../../../shared/ipc-contract'

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

export interface VaultStatus {
  available: boolean
  /** safeStorage key store: keychain, dpapi, a Linux backend, or unknown. */
  backend?: string
  locked: boolean
  hasMasterPassword: boolean
  /** The user opted into unlocking with Touch ID or the login password. */
  biometricUnlock?: boolean
  /** This system can verify the user for biometric unlock. */
  biometricSupported?: boolean
  handles: VaultEntry[]
}

export const CORE_BRIDGE_UNAVAILABLE_MESSAGE =
  'Core IPC bridge is unavailable; use the Electron desktop window.'

interface EmperorBridge {
  vaultStatus?: () => Promise<VaultStatus>
  vaultSave?: (draft: VaultDraft) => Promise<CredentialHandle>
  vaultRemove?: (handleId: string) => Promise<{ ok: boolean }>
  vaultUnlock?: (
    password: string,
    biometric?: boolean,
  ) => Promise<{ unlocked: boolean }>
  vaultLock?: () => Promise<{ ok: boolean }>
  vaultSetMaster?: (
    password: string | null,
    biometric?: boolean,
  ) => Promise<{ ok: boolean }>
  vaultReveal?: (handleId: string) => Promise<{ password: string }>
  vaultBiometricUnlock?: () => Promise<{ unlocked: boolean }>
  vaultBiometricDisable?: () => Promise<{ ok: boolean }>
  selectDirectory?: () => Promise<string | null>
  getPathForFile?: (file: File) => string
  openPath?: (
    target: string,
  ) => Promise<{ ok?: boolean; error?: string } | void>
  revealReference?: (input: {
    sessionId: string
    referenceId: string
  }) => Promise<{ ok?: boolean; error?: string } | void>
  openExternal?: (
    url: string,
  ) => Promise<{ ok?: boolean; error?: string } | void>
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
  onBrowserState?: (listener: (state: BrowserViewState) => void) => () => void
  agentPreviewStart?: (targetId: string) => Promise<unknown>
  agentPreviewStop?: (targetId: string) => void
  agentDownloadReveal?: (downloadId: string) => Promise<unknown>
  agentDownloadMove?: (downloadId: string) => Promise<unknown>
  agentDownloadSaveAs?: (downloadId: string) => Promise<unknown>
  agentPreviewInput?: (targetId: string, event: AgentPreviewInput) => void
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
  connectBrowsers?: () => Promise<BrowserConnectResult>
  onAgentPreviewFrame?: (
    listener: (frame: AgentPreviewFrame) => void,
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

/** One JPEG frame of an Agent tab (computer use preview). */
export interface AgentPreviewFrame {
  targetId: string
  seq: number
  width: number
  height: number
  jpeg: Uint8Array
}

export type AgentPreviewModifier = 'shift' | 'control' | 'alt' | 'meta'

/** User input on a taken-over Agent tab, in page CSS pixels. */
export type AgentPreviewInput =
  | {
      type: 'mouseDown' | 'mouseUp' | 'mouseMove'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle'
      clickCount?: number
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | {
      type: 'keyDown' | 'keyUp'
      key: string
      modifiers?: AgentPreviewModifier[]
    }
  | { type: 'text'; text: string }

/** The started preview's page viewport, the coordinate space of input. */
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

/** `biometric`: on success, also allow Touch ID unlock from now on. */
export async function vaultUnlock(
  password: string,
  options: { biometric?: boolean } = {},
): Promise<boolean> {
  const invoke = bridge()?.vaultUnlock
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return (await (options.biometric ? invoke(password, true) : invoke(password)))
    .unlocked
}

export async function vaultLock(): Promise<void> {
  const invoke = bridge()?.vaultLock
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  await invoke()
}

/**
 * Replacing or removing the master password turns Touch ID unlock off;
 * `biometric` re-enables it for the new password.
 */
export async function vaultSetMaster(
  password: string | null,
  options: { biometric?: boolean } = {},
): Promise<void> {
  const invoke = bridge()?.vaultSetMaster
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  await (options.biometric ? invoke(password, true) : invoke(password))
}

/** Main verifies the user (Touch ID or login password) before unlocking. */
export async function vaultBiometricUnlock(): Promise<boolean> {
  const invoke = bridge()?.vaultBiometricUnlock
  if (!invoke) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return (await invoke()).unlocked
}

export async function vaultBiometricDisable(): Promise<void> {
  const invoke = bridge()?.vaultBiometricDisable
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

export async function openPath(target: string): Promise<void> {
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
  return (
    (await bridge()?.browserPairings?.()) ?? {
      bridgeListening: false,
      pendingPairings: [],
      pairedConnections: [],
      attachedTabs: 0,
    }
  )
}

export async function approveBrowserPairing(
  pairingId: string,
): Promise<boolean> {
  return (await bridge()?.approveBrowserPairing?.(pairingId))?.approved === true
}

export async function denyBrowserPairing(pairingId: string): Promise<boolean> {
  return (await bridge()?.denyBrowserPairing?.(pairingId))?.denied === true
}

/** Settings › 连接 Chrome/Edge: let the Emperor extension reach this app. */
export async function connectBrowsers(): Promise<BrowserConnectResult> {
  return (
    (await bridge()?.connectBrowsers?.()) ?? {
      browsers: [],
      reason: 'unavailable',
    }
  )
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

/** Main forwards input only while the user has taken the tab over. */
export function agentPreviewInput(
  targetId: string,
  event: AgentPreviewInput,
): void {
  bridge()?.agentPreviewInput?.(targetId, event)
}

export function onAgentPreviewFrame(
  listener: (frame: AgentPreviewFrame) => void,
): () => void {
  return bridge()?.onAgentPreviewFrame?.(listener) ?? (() => {})
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
