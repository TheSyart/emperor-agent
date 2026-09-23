// Electron desktop talks to CoreApi over preload IPC. Browser-only tests inject
// this same bridge surface; the product no longer supports HTTP/WS fallback.

import type {
  CoreIpcErrorEnvelope,
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
  TerminalEvent,
} from '@emperor/core/api'
import type { WireSessionEvent } from '@emperor/core/runtime-contract'

export const CORE_BRIDGE_UNAVAILABLE_MESSAGE =
  'Core IPC bridge is unavailable; use the Electron desktop window.'

interface EmperorBridge {
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

function bridge(): EmperorBridge | undefined {
  return (globalThis as unknown as { window?: { emperor?: EmperorBridge } })
    .window?.emperor
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
