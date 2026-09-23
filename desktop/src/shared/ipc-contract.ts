import type { CoreOperationKey } from '@emperor/core/api'

export const CORE_IPC_PREFIX = 'emperor:core:'
export const CORE_EVENT_CHANNEL = 'emperor:core:event'
/** Raw session-log events of watched sessions, batched per session (`SessionEventBatch`). */
export const SESSION_EVENT_CHANNEL = 'emperor:core:session-event'
export const PET_EVENT_CHANNEL = 'emperor:pet:event'
export const PET_STATUS_CHANNEL = 'emperor:pet:status-event'
export const TERMINAL_EVENT_CHANNEL = 'emperor:terminal:event'
export const TERMINAL_SUBSCRIPTION_CHANNEL = 'emperor:terminal:subscription'
/**
 * Main-only embedded browser (`BrowserViewHost`). Open takes `{ url }` typed by
 * the user in the BrowserPane address bar; main normalizes it and answers
 * `{ ok: true, url } | { ok: false, error }`.
 */
export const BROWSER_OPEN_CHANNEL = 'emperor:browser:open'
/** Viewport rectangle of the browser view; null or too small hides it. */
export const BROWSER_BOUNDS_CHANNEL = 'emperor:browser:bounds'
/** One of {@link BrowserViewAction}. */
export const BROWSER_ACTION_CHANNEL = 'emperor:browser:action'
export const BROWSER_CLOSE_CHANNEL = 'emperor:browser:close'
/** Main → renderer {@link BrowserViewState} updates. */
export const BROWSER_STATE_CHANNEL = 'emperor:browser:state'
export const REFERENCE_REVEAL_CHANNEL = 'emperor:reference:reveal'
export const EXTERNAL_OPEN_CHANNEL = 'emperor:external:open'
/** Main-only: open the personal or project Skills folder (created when missing). */
export const SKILLS_OPEN_FOLDER_CHANNEL = 'emperor:skills:open-folder'
/** Main-only: native single-file picker with extension filters. */
export const SELECT_FILE_CHANNEL = 'emperor:select-file'

export type BrowserViewAction = 'back' | 'forward' | 'reload' | 'stop'

/** State of the embedded browser view, sent on {@link BROWSER_STATE_CHANNEL}. */
export interface BrowserViewState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Set on the update that reports a failed main-frame load or crash. */
  error?: string
}

/** Extension filter of the native file picker (`SELECT_FILE_CHANNEL`). */
export interface FileDialogFilter {
  name: string
  extensions: string[]
}

const OPERATION_KEY_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/

export function channelForCoreOperation(
  operationKey: CoreOperationKey,
): string {
  const key = String(operationKey || '').trim()
  if (!OPERATION_KEY_RE.test(key))
    throw new Error(`invalid core IPC operation: ${operationKey}`)
  return CORE_IPC_PREFIX + key.replaceAll('.', ':')
}

/** One batch of raw session-log events sent on {@link SESSION_EVENT_CHANNEL}. */
export interface SessionEventBatch {
  sessionId: string
  /** Wire-sanitized `SessionEvent`s in seq order. */
  events: unknown[]
}
