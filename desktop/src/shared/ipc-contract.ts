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

/**
 * Agent tab preview (Computer Use). Agent tabs render offscreen; the
 * renderer asks main to stream frames of one tab by id (never a URL) and,
 * only while the user has taken the tab over, sends input back.
 */
export const AGENT_PREVIEW_START_CHANNEL = 'emperor:computer-use:preview-start'
export const AGENT_PREVIEW_STOP_CHANNEL = 'emperor:computer-use:preview-stop'
/** Main → renderer {@link AgentPreviewFrame}. */
export const AGENT_PREVIEW_FRAME_CHANNEL = 'emperor:computer-use:preview-frame'
/** Renderer → main `{ targetId, event: AgentPreviewInput }`. */
export const AGENT_PREVIEW_INPUT_CHANNEL = 'emperor:computer-use:preview-input'
/** Renderer → main `{ downloadId }`: show an inbox file in Finder / Explorer. */
export const AGENT_DOWNLOAD_REVEAL_CHANNEL =
  'emperor:computer-use:download-reveal'
/**
 * Renderer → main `{ downloadId }`: move an inbox file into its
 * conversation's workspace (`downloads/`). Returns the workspace-relative path.
 */
export const AGENT_DOWNLOAD_MOVE_CHANNEL = 'emperor:computer-use:download-move'
/**
 * Renderer → main `{ downloadId }`: the user picks where the file goes in the
 * system save dialog ("另存为…"); main moves it there.
 */
export const AGENT_DOWNLOAD_SAVE_AS_CHANNEL =
  'emperor:computer-use:download-save-as'
/** Trusted Settings renderer → main; only bounded, non-secret helper diagnostics. */
export const MAC_HELPER_STATUS_CHANNEL =
  'emperor:computer-use:mac-helper-status'
/** Explicit user click in Settings → helper's OS permission request. */
export const MAC_HELPER_PERMISSION_CHANNEL =
  'emperor:computer-use:mac-helper-permission'
/** Explicit trusted Settings action; resets only the Helper's TCC record. */
export const MAC_HELPER_RESET_CHANNEL = 'emperor:computer-use:mac-helper-reset'
/**
 * Explicit trusted Settings action (「重新连接」): clears the crash-restart
 * latch, closes any current Helper and connects again. Answers MacHelperStatus.
 */
export const MAC_HELPER_RECONNECT_CHANNEL =
  'emperor:computer-use:mac-helper-reconnect'
/** Trusted Settings renderer only; pairing secret never crosses these channels. */
export const BROWSER_PAIRING_STATUS_CHANNEL =
  'emperor:computer-use:browser-pairing-status'
export const BROWSER_PAIRING_APPROVE_CHANNEL =
  'emperor:computer-use:browser-pairing-approve'
export const BROWSER_PAIRING_DENY_CHANNEL =
  'emperor:computer-use:browser-pairing-deny'
export const BROWSER_PAIRING_REVOKE_CHANNEL =
  'emperor:computer-use:browser-pairing-revoke'
/** Settings › 连接 Chrome/Edge: register the Native Messaging host (01 §11). */
export const BROWSER_CONNECT_CHANNEL = 'emperor:computer-use:browser-connect'

export interface BrowserConnectResult {
  /** Browsers that can now reach Emperor (e.g. `chrome`, `edge`). */
  browsers: string[]
  /** Why none could be registered: a development build, or no bridge. */
  reason?: 'no-host' | 'unavailable'
}

export interface BrowserPairingStatus {
  bridgeListening: boolean
  pendingPairings: Array<{
    pairingId: string
    extensionId: string
    code: string
    displayed: boolean
  }>
  pairedConnections: string[]
  attachedTabs: number
}

export type MacHelperPermission = 'accessibility' | 'screen-recording'
export type MacHelperPermissionStatus =
  'granted' | 'denied' | 'unknown' | 'stale'

export interface MacHelperStatus {
  available: boolean
  previewBuild?: boolean
  connected: boolean
  helperVersion: string | null
  protocol: number | null
  permissions: Record<MacHelperPermission, MacHelperPermissionStatus>
  lastErrorCode: string | null
  reason?: string
  /**
   * The Helper crashed or failed to start more than 3 times in a minute;
   * it stays unavailable until the user reconnects it (00 §12).
   */
  autoRestartSuspended?: boolean
}
/** Trusted Settings renderer → main credential vault. Never routed through Core. */
export const VAULT_STATUS_CHANNEL = 'emperor:computer-use:vault-status'
export const VAULT_SAVE_CHANNEL = 'emperor:computer-use:vault-save'
export const VAULT_REMOVE_CHANNEL = 'emperor:computer-use:vault-remove'
export const VAULT_UNLOCK_CHANNEL = 'emperor:computer-use:vault-unlock'
export const VAULT_LOCK_CHANNEL = 'emperor:computer-use:vault-lock'
export const VAULT_MASTER_CHANNEL = 'emperor:computer-use:vault-master'
export const VAULT_REVEAL_CHANNEL = 'emperor:computer-use:vault-reveal'
/** Unlock with the key kept for biometric unlock, after system verification. */
export const VAULT_BIOMETRIC_UNLOCK_CHANNEL =
  'emperor:computer-use:vault-biometric-unlock'
export const VAULT_BIOMETRIC_DISABLE_CHANNEL =
  'emperor:computer-use:vault-biometric-disable'

export interface AgentPreviewFrame {
  targetId: string
  seq: number
  width: number
  height: number
  jpeg: Uint8Array
}

export type AgentPreviewModifier = 'shift' | 'control' | 'alt' | 'meta'

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
