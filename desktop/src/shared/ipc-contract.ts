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
/** Renderer → main: the temporary history, newest first ({@link BrowserHistoryEntry}[]). */
export const BROWSER_HISTORY_CHANNEL = 'emperor:browser:history'
/**
 * Renderer → main history entry id: reopen that page. Only the id travels;
 * main checks the stored address again like a typed one.
 */
export const BROWSER_HISTORY_OPEN_CHANNEL = 'emperor:browser:history-open'
/**
 * Renderer → main (no argument): clear the built-in browser's own partition
 * — cookies, storage, cache, HTTP auth — and its history; answers
 * {@link BrowserClearResult} once the wipe finished or failed.
 */
export const BROWSER_CLEAR_DATA_CHANNEL = 'emperor:browser:clear-data'
export const REFERENCE_REVEAL_CHANNEL = 'emperor:reference:reveal'
export const EXTERNAL_OPEN_CHANNEL = 'emperor:external:open'
/**
 * Renderer → main `url`: a web link the user clicked in Emperor's UI. Main
 * routes it by the user's browser settings (system or built-in browser)
 * and answers `{ ok, opened }`; EXTERNAL_OPEN_CHANNEL always means the
 * system browser.
 */
export const LINK_OPEN_CHANNEL = 'emperor:link:open'
/** Main → renderer `{ url }`: a link opened in the built-in browser; show it. */
export const BROWSER_REVEAL_CHANNEL = 'emperor:browser:reveal'
/** Main-only: open the personal or project Skills folder (created when missing). */
export const SKILLS_OPEN_FOLDER_CHANNEL = 'emperor:skills:open-folder'
/** Main-only: native single-file picker with extension filters. */
export const SELECT_FILE_CHANNEL = 'emperor:select-file'

/**
 * Agent tab and window preview (Computer Use). Agent tabs render offscreen;
 * the renderer asks main to stream frames of one target by id (never a URL)
 * for the conversation's read-only preview. Nothing is sent back.
 */
export const AGENT_PREVIEW_START_CHANNEL = 'emperor:computer-use:preview-start'
export const AGENT_PREVIEW_STOP_CHANNEL = 'emperor:computer-use:preview-stop'
/** Main → renderer {@link AgentPreviewUpdate}. */
export const AGENT_PREVIEW_FRAME_CHANNEL = 'emperor:computer-use:preview-frame'
/**
 * Main → renderer {@link AgentPreviewPointer}: where the Agent's latest
 * desktop or built-in browser action landed, for its preview card to draw
 * the pointer there. Sent only for a target the Agent controls.
 */
export const AGENT_PREVIEW_POINTER_CHANNEL =
  'emperor:computer-use:preview-pointer'
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
/**
 * 设置 › 电脑操作 › Chrome 和 Edge, trusted Settings renderer only, no
 * argument: the extension folder and where the extension is loaded
 * ({@link BrowserExtensionStatus}).
 */
export const BROWSER_EXTENSION_STATUS_CHANNEL =
  'emperor:computer-use:browser-extension-status'
/**
 * 安装扩展程序: copy the extension into its folder and register the
 * Native Messaging host ({@link BrowserExtensionInstallResult}).
 */
export const BROWSER_EXTENSION_INSTALL_CHANNEL =
  'emperor:computer-use:browser-extension-install'
/** 在访达中显示: show the extension folder; answers `{ ok }`. */
export const BROWSER_EXTENSION_REVEAL_CHANNEL =
  'emperor:computer-use:browser-extension-reveal'
/**
 * 移除扩展程序: connected browsers uninstall it, then pairings, host
 * manifests and the folder go ({@link BrowserExtensionRemoveResult}).
 */
export const BROWSER_EXTENSION_REMOVE_CHANNEL =
  'emperor:computer-use:browser-extension-remove'
/**
 * Main → renderer, no payload: an extension asked to pair; the renderer
 * shows 电脑操作 › Chrome 和 Edge for the user to compare the code.
 */
export const BROWSER_PAIRING_REQUEST_CHANNEL =
  'emperor:computer-use:browser-pairing-request'

export interface BrowserPairingStatus {
  bridgeListening: boolean
  pendingPairings: Array<{
    pairingId: string
    extensionId: string
    code: string
    displayed: boolean
    /** What the extension says it runs in (a label). */
    browser?: BrowserExtensionBrowser
  }>
  pairedConnections: string[]
  attachedTabs: number
  /** Every saved pairing, also those whose browser is not running. */
  pairings: BrowserPairingView[]
}

/** A saved pairing, as 设置 › 电脑操作 › Chrome 和 Edge lists it. */
export interface BrowserPairingView {
  pairingId: string
  browser: BrowserExtensionBrowser | null
  /** Its extension is connected now. */
  connected: boolean
  /** Tabs the user connected in that browser. */
  tabs: number
  /** When it was paired (ISO 8601), if known. */
  createdAt: string | null
}

/** Chrome or Edge, as the extension reports itself when it pairs. */
export type BrowserExtensionBrowser = 'chrome' | 'edge'

/** 设置 › 电脑操作 › Chrome 和 Edge: one browser and the Emperor extension in it. */
export interface BrowserExtensionBrowserView {
  browser: BrowserExtensionBrowser
  /** Google Chrome / Microsoft Edge. */
  name: string
  /** The browser has run on this Mac. */
  present: boolean
  /** Loaded from Emperor's folder in some profile: on, off or not at all. */
  extension: 'none' | 'loaded' | 'disabled'
  /** Loaded from another folder instead (`~`-abbreviated). */
  loadedFrom?: string
  /** 开发者模式 is on in some profile. */
  developerMode: boolean
  /** Its Native Messaging manifest admits the Emperor extension. */
  hostRegistered: boolean
}

/** The extension folder and where the extension is loaded (no secrets). */
export interface BrowserExtensionStatus {
  folder: {
    /** `<stateRoot>/browser-extension`, for 拷贝路径. */
    path: string
    /** The same, `~`-abbreviated, to show. */
    displayPath: string
    /** Emperor put the extension there. */
    ready: boolean
    version: string | null
  }
  /** The extension version this Emperor ships. */
  bundledVersion: string | null
  browsers: BrowserExtensionBrowserView[]
}

/** 安装扩展程序: the folder, and the browsers that can now reach Emperor. */
export interface BrowserExtensionInstallResult {
  ok: boolean
  registered: string[]
  /**
   * Why no browser was registered (a development build, no bridge, no
   * Chrome or Edge has run yet), or why the folder could not be written.
   */
  reason?: 'no-host' | 'unavailable' | 'no-browser' | 'no-source' | 'io'
  status: BrowserExtensionStatus
}

/** 移除扩展程序: how many connected browsers uninstalled it themselves. */
export interface BrowserExtensionRemoveResult {
  ok: boolean
  uninstalled: number
  status: BrowserExtensionStatus
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
/** 清空: drop every entry and the master password (and an unusable local key). */
export const VAULT_RESET_CHANNEL = 'emperor:computer-use:vault-reset'
/** 修复权限: make a local key that other users can read private again. */
export const VAULT_REPAIR_KEY_CHANNEL = 'emperor:computer-use:vault-repair-key'
/** 重新开始（先备份）: move an unreadable or newer vault.json aside. */
export const VAULT_START_OVER_CHANNEL = 'emperor:computer-use:vault-start-over'
/** 导出凭据备份: main asks where to save; the passphrase comes from Settings. */
export const VAULT_EXPORT_CHANNEL = 'emperor:computer-use:vault-export'
/** 导入 / 从备份恢复, step 1: main's own open dialog picks the file. */
export const VAULT_IMPORT_PICK_CHANNEL =
  'emperor:computer-use:vault-import-pick'
/** Step 2: open the picked file with its passphrase and merge it in. */
export const VAULT_IMPORT_CHANNEL = 'emperor:computer-use:vault-import'

export interface AgentPreviewFrame {
  targetId: string
  seq: number
  width: number
  height: number
  jpeg: Uint8Array
}

/** Only bounded recovery states cross IPC; native error text stays in main. */
export type AgentPreviewError =
  'screen-recording-permission-missing' | 'preview-unavailable'

export type AgentPreviewUpdate =
  AgentPreviewFrame | { targetId: string; error: AgentPreviewError }

/** Where an action landed: `x`, `y` are shares (0–1) of the window or page. */
export interface AgentPreviewPointer {
  targetId: string
  x: number
  y: number
}

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

/** One page of the built-in browser's temporary history. */
export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string
  time: number
}

export type BrowserClearResult = { ok: true } | { ok: false; error: string }

/**
 * Your own downloads in the built-in browser (设置 › 浏览器 › 下载). Renderer
 * → main, no argument: the download history ({@link DownloadHistory}). Only
 * ids travel: no path crosses to the renderer. Emperor's downloads (the
 * Agent inbox) are listed here too; their actions stay on the
 * AGENT_DOWNLOAD_* channels.
 */
export const BROWSER_DOWNLOADS_CHANNEL = 'emperor:browser:downloads'
/** Renderer → main `{ id }`: open a finished download of yours. */
export const BROWSER_DOWNLOAD_OPEN_CHANNEL = 'emperor:browser:download-open'
/** Renderer → main `{ id }`: show a finished download in Finder / Explorer. */
export const BROWSER_DOWNLOAD_REVEAL_CHANNEL = 'emperor:browser:download-reveal'
/** Renderer → main `{ id }`: take a download off the list (the file stays). */
export const BROWSER_DOWNLOAD_REMOVE_CHANNEL = 'emperor:browser:download-remove'
/**
 * Renderer → main, no argument: pick the download folder in the system
 * dialog; answers the path or null. The renderer saves the choice with
 * `browser.setPreferences`.
 */
export const BROWSER_DOWNLOAD_FOLDER_CHANNEL = 'emperor:browser:download-folder'
/** Main → renderer {@link UserDownloadView}: a download started, moved on or ended. */
export const BROWSER_DOWNLOAD_EVENT_CHANNEL = 'emperor:browser:download'

/**
 * 从浏览器导入 (ST-06). Renderer → main, no argument: the browsers found on
 * this machine, each with its profiles and whether it is still running
 * ({@link BrowserImportSources}). No secret ever crosses; the renderer sees a
 * source list, running state and, after a run, only counts.
 */
export const BROWSER_IMPORT_SOURCES_CHANNEL = 'emperor:browser:import-sources'
/**
 * Renderer → main {@link BrowserImportRequest}: read the chosen profile, save
 * passwords into the vault and cookies into the selected persistent profile,
 * all in main. Answers {@link BrowserImportResult}. Decryption needs macOS
 * Keychain approval (a system prompt); the renderer never sees a value.
 */
export const BROWSER_IMPORT_RUN_CHANNEL = 'emperor:browser:import-run'

/** Which browser a source is; matches the main-side `BrowserId`. */
export type BrowserImportBrowser = 'chrome' | 'edge'

/** One installed browser profile offered as an import source. */
export interface BrowserImportProfile {
  /** Profile directory name, e.g. `Default` or `Profile 1`. */
  dir: string
  /** Display name from the browser's Local State. */
  name: string
}

/** One browser found on this machine (or not), with its running state. */
export interface BrowserImportSource {
  browser: BrowserImportBrowser
  /** Product name, e.g. `Google Chrome`. */
  name: string
  installed: boolean
  /** The browser is still open; import must wait until it is closed. */
  running: boolean
  profiles: BrowserImportProfile[]
}

/** The source dropdown's contents. */
export interface BrowserImportSources {
  browsers: BrowserImportSource[]
}

/** What the dialog asks main to import. */
export interface BrowserImportRequest {
  browser: BrowserImportBrowser
  profileDir: string
  passwords: boolean
  cookies: boolean
  /** Persistent profile id (`p_…`) for cookies; the renderer resolves it. */
  targetProfileId?: string
}

/** Why an import could not run; the renderer maps it to a message. */
export type BrowserImportErrorReason =
  | 'nothing-selected'
  | 'browser-running'
  | 'vault-locked'
  | 'vault-unavailable'
  | 'no-target-profile'
  | 'read-failed'
  | 'internal'

/** The outcome the dialog shows: counts on success, a reason otherwise. */
export type BrowserImportResult =
  | { ok: true; passwords: number; sites: number }
  | { ok: false; reason: BrowserImportErrorReason }

export type UserDownloadState =
  'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'blocked'

/** Why a download was stopped: a program or installer, or over the size limit. */
export type UserDownloadBlock = 'executable' | 'too-large'

/** One of your downloads. */
export interface UserDownloadView {
  /** `ud_` + 12 hex digits. */
  id: string
  name: string
  /** The page's origin, else the file's; '' when neither is known. */
  site: string
  /** When it started (ms). */
  time: number
  state: UserDownloadState
  /** Bytes received so far; the size once completed. */
  bytes: number
  /** While progressing: the announced size, 0 when unknown. */
  totalBytes?: number
  reason?: UserDownloadBlock
  /** Completed: the file is still where it was saved. */
  exists?: boolean
}

/** One of Emperor's downloads (the Agent inbox). */
export interface AgentDownloadView {
  /** `dl_` + 12 hex digits (the AGENT_DOWNLOAD_* channels take it). */
  id: string
  name: string
  /** The origin it came from; '' for downloads saved before it was kept. */
  site: string
  /** The conversation it belongs to (for 移到工作区). */
  sessionId: string | null
  time: number
  bytes: number
  exists: boolean
  /**
   * An inbox file whose macOS source mark (`com.apple.quarantine`) could not
   * be set (SEC-10): the list says 未能标记来源.
   */
  unmarked?: true
  /**
   * Downloaded in the user's own Chrome or Edge (PLAN-CAP-001 RV-09): the
   * file stays in that browser's download folder (no file actions here).
   */
  browser?: 'chrome' | 'edge'
  state?: 'completed' | 'refused' | 'interrupted'
  /** Why a refused one was refused. */
  reason?: 'executable' | 'blocked' | 'denied'
}

/** 设置 › 浏览器 › 下载历史记录, newest first in each group. */
export interface DownloadHistory {
  user: UserDownloadView[]
  agent: AgentDownloadView[]
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

/**
 * The context a Core call carries besides its arguments (KRN-01): the
 * session the renderer shows. The preload puts it first on every core
 * channel; main takes it off and hands it to the operation, which uses it
 * when the call names no session. Nothing in main or Core remembers it.
 */
export const CORE_CALL_CONTEXT_KEY = 'emperorCoreCall'

export interface CoreCallEnvelope {
  readonly [CORE_CALL_CONTEXT_KEY]: 1
  readonly view: { readonly sessionId: string | null }
}

export function coreCallEnvelope(sessionId: string | null): CoreCallEnvelope {
  return { [CORE_CALL_CONTEXT_KEY]: 1, view: { sessionId } }
}

/** Split a core channel's arguments into the call context and the operation's own. */
export function splitCoreCallEnvelope(args: readonly unknown[]): {
  view: { sessionId: string | null } | undefined
  args: unknown[]
} {
  const first = args[0]
  if (
    !first ||
    typeof first !== 'object' ||
    Array.isArray(first) ||
    !Object.hasOwn(first, CORE_CALL_CONTEXT_KEY)
  )
    return { view: undefined, args: [...args] }
  const envelope = first as Record<string, unknown>
  const view = envelope.view as Record<string, unknown> | undefined
  const sessionId = view?.sessionId
  if (
    envelope[CORE_CALL_CONTEXT_KEY] !== 1 ||
    !view ||
    typeof view !== 'object' ||
    Object.keys(envelope).length !== 2 ||
    Object.keys(view).length !== 1 ||
    !(
      sessionId === null ||
      (typeof sessionId === 'string' && sessionId.length <= 256)
    )
  )
    throw new Error('invalid core call context')
  return { view: { sessionId }, args: args.slice(1) }
}

/** One batch of raw session-log events sent on {@link SESSION_EVENT_CHANNEL}. */
export interface SessionEventBatch {
  sessionId: string
  /** Wire-sanitized `SessionEvent`s in seq order. */
  events: unknown[]
}

/**
 * Editor dictation (VO-01, macOS). The trusted main renderer reads the
 * dictation helper's state, and starts, stops or cancels one dictation at a
 * time. Main makes up the session id and pushes {@link DictationEvent}s of
 * that session only to the window that started it. Audio stays inside the
 * helper's memory and transcripts are not written anywhere.
 */
export const DICTATION_STATUS_CHANNEL = 'emperor:dictation:status'
/** {@link DictationStartRequest} → {@link DictationStartResult}. */
export const DICTATION_START_CHANNEL = 'emperor:dictation:start'
/** `{ session }`: end the audio and let the final result arrive. */
export const DICTATION_STOP_CHANNEL = 'emperor:dictation:stop'
/** `{ session }`: drop the dictation without a final result. */
export const DICTATION_CANCEL_CHANNEL = 'emperor:dictation:cancel'
/** Main → renderer {@link DictationEvent}. */
export const DICTATION_EVENT_CHANNEL = 'emperor:dictation:event'
/**
 * `{ pane }`: open System Settings at the microphone or speech recognition
 * privacy list (main owns the URLs). Answers `{ opened }`.
 */
export const DICTATION_PRIVACY_CHANNEL = 'emperor:dictation:open-privacy'

export type DictationPrivacyPane = 'microphone' | 'speech'

/** `unknown`: the helper could not be asked. */
export type DictationPermission =
  'granted' | 'denied' | 'undetermined' | 'restricted' | 'unknown'

export interface DictationDevice {
  /** CoreAudio device UID, stable across restarts. */
  id: string
  name: string
  default: boolean
}

export interface DictationLocale {
  /** BCP 47, e.g. `zh-CN`. */
  id: string
  /** In the system language. */
  name: string
}

export interface DictationStatus {
  /** This platform has dictation at all (macOS only for now). */
  supported: boolean
  /** The helper answered. */
  available: boolean
  /** Why it is not available, for the user. */
  reason?: string
  engine: string | null
  permissions: { microphone: DictationPermission; speech: DictationPermission }
  devices: DictationDevice[]
  /** Languages this Mac recognizes on device right now; nothing else is offered. */
  locales: DictationLocale[]
  systemLocale: string | null
  /** A dictation is running. */
  active: boolean
}

export type DictationErrorCode =
  | 'invalid_request'
  | 'busy'
  | 'not_found'
  | 'permission_denied'
  | 'no_device'
  | 'unsupported_locale'
  | 'recognizer_unavailable'
  | 'failed'
  /** No helper on this platform or in this build, or it would not start. */
  | 'unavailable'
  /** The helper quit, or sent something unreadable, during the dictation. */
  | 'helper_exited'
  /** The helper did not start or end the dictation in time. */
  | 'timeout'

export type DictationEndReason =
  'stopped' | 'cancelled' | 'max_duration' | 'error'

/**
 * One dictation's events, in `seq` order: `started`, `partial`s, at most one
 * `final`, then exactly one `ended` (after an `error` when it failed).
 * `partial` carries the whole transcript so far, not a delta.
 */
export type DictationEvent =
  | { type: 'started'; session: string; seq: number; locale: string }
  | { type: 'partial'; session: string; seq: number; text: string }
  /**
   * RV-06: the microphone's loudness while listening (RMS on a decibel
   * scale, 0–1), about 15 a second, for the composer's waveform. Only
   * between `started` and `final`; never the audio itself.
   */
  | { type: 'level'; session: string; seq: number; value: number }
  | { type: 'final'; session: string; seq: number; text: string }
  | {
      type: 'error'
      session: string
      seq: number
      code: DictationErrorCode
      message: string
    }
  | {
      type: 'ended'
      session: string
      seq: number
      reason: DictationEndReason
    }

/** null or absent: follow the system language, or use the default microphone. */
export interface DictationStartRequest {
  locale?: string | null
  device?: string | null
}

export type DictationStartResult =
  | { ok: true; session: string }
  | { ok: false; code: DictationErrorCode; message: string }

// ── Main window and pet windows (SEC-05: main and preload use these
// constants, no channel name is a string literal there) ──────────────────

/** Renderer → main: the native folder picker; answers the path or null. */
export const SELECT_DIRECTORY_CHANNEL = 'emperor:select-directory'
/**
 * Renderer → main {@link OpenPathTarget}: open a folder Core vouches for in
 * Finder. Never a path of the renderer's choosing (SEC-05); answers
 * `{ ok: true } | { ok: false, error }`.
 */
export const OPEN_PATH_CHANNEL = 'emperor:open-path'
/**
 * 设置 › 高级 › 诊断 › 导出诊断包 (REL-01), trusted main window only.
 * `prepare` (no argument) stages the bundle and answers
 * {@link DiagnosticsBundlePrepareResult}: what the zip will hold, for the
 * user to confirm. `export` `{ id }` asks where to save it and writes the
 * zip ({@link DiagnosticsBundleExportResult}); `reveal` `{ id }` shows an
 * exported zip in Finder; `discard` `{ id }` drops a staged bundle. Ids
 * only: no path crosses IPC.
 */
export const DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL =
  'emperor:diagnostics:bundle-prepare'
export const DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL =
  'emperor:diagnostics:bundle-export'
export const DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL =
  'emperor:diagnostics:bundle-reveal'
export const DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL =
  'emperor:diagnostics:bundle-discard'

/** One file of a staged diagnostics bundle. */
export interface DiagnosticsBundleEntryView {
  /** Inside the zip's folder, e.g. `logs/main.log`. */
  path: string
  /** What it is, in the UI's words. */
  title: string
  bytes: number
}

export interface DiagnosticsBundleView {
  /** `b_` + 12 hex. */
  id: string
  /** The zip's folder and default file name (without `.zip`). */
  name: string
  entries: DiagnosticsBundleEntryView[]
  /** What the bundle never holds. */
  excluded: string[]
}

export type DiagnosticsBundlePrepareResult =
  { ok: true; bundle: DiagnosticsBundleView } | { ok: false; error: string }

export type DiagnosticsBundleExportResult =
  | { ok: true; name: string; location: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string }
/**
 * Main window → main: the composer's + › 截图 (UI-S04, macOS). Main hides
 * the window, runs the system's interactive region capture into a private
 * temporary folder, reads the PNG back, deletes it and answers
 * {@link ScreenshotCaptureResult}. One capture at a time.
 */
export const SCREENSHOT_CAPTURE_CHANNEL = 'emperor:screenshot:capture'

export type ScreenshotCaptureResult =
  | { ok: true; name: string; mime: 'image/png'; data: Uint8Array }
  | {
      ok: false
      /**
       * `cancelled`: Esc (no picture). `busy`: a capture is already open.
       * `permission`: screen recording is not allowed for Emperor.
       */
      reason: 'cancelled' | 'busy' | 'unsupported' | 'permission' | 'failed'
      message: string
    }
/** Main window → main: open, close or ask about the desktop pet. */
export const PET_OPEN_CHANNEL = 'emperor:pet:open'
export const PET_CLOSE_CHANNEL = 'emperor:pet:close'
export const PET_STATUS_REQUEST_CHANNEL = 'emperor:pet:status'
/**
 * Pet window → main (src/pet/preload.js keeps these strings literally: it is
 * plain sandboxed JS; pet-sandbox.test.ts checks they match).
 */
export const PET_RENDERER_BOOTSTRAP_CHANNEL = 'emperor:pet:renderer-bootstrap'
export const PET_RENDERER_CLOSE_CHANNEL = 'emperor:pet:renderer-close'

/**
 * What `emperor:open-path` may open — names Core resolves, never a path the
 * renderer picked:
 * - diagnostic: 设置 › 诊断's Emperor Home or the current project;
 * - skill: an installed Skill's folder (by name, in a session's scope);
 * - invalid-skill: a rejected Skill folder Core lists for that scope.
 */
export type OpenPathTarget =
  | {
      kind: 'diagnostic'
      /** `logs-path`: the folder of main.log and core.log (REL-01). */
      rowId: 'global-state-root' | 'active-project-path' | 'logs-path'
      /** The session the Diagnostics page was opened from (its project row). */
      sessionId?: string | null
    }
  | { kind: 'skill'; name: string; sessionId?: string | null }
  | { kind: 'invalid-skill'; path: string; sessionId?: string | null }

/**
 * Renderer → main `{ url }`: a remote image in rendered markdown the user
 * asked to see (UI-38). Main fetches it through the public HTTP client (no
 * cookies, no local or private addresses) and answers
 * {@link RemoteImageResult}; the renderer never requests remote images.
 */
export const MARKDOWN_REMOTE_IMAGE_CHANNEL = 'emperor:markdown:remote-image'

export type RemoteImageResult =
  { ok: true; dataUrl: string } | { ok: false; error: string }

/** Main → renderer {@link AppMenuCommand}: an app menu item was chosen. */
export const APP_MENU_COMMAND_CHANNEL = 'emperor:menu:command'

export type AppMenuCommand = 'open-settings'
