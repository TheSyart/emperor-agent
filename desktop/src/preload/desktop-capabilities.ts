import {
  AGENT_DOWNLOAD_MOVE_CHANNEL,
  AGENT_DOWNLOAD_REVEAL_CHANNEL,
  AGENT_DOWNLOAD_SAVE_AS_CHANNEL,
  AGENT_PREVIEW_FRAME_CHANNEL,
  AGENT_PREVIEW_POINTER_CHANNEL,
  AGENT_PREVIEW_START_CHANNEL,
  AGENT_PREVIEW_STOP_CHANNEL,
  BROWSER_ACTION_CHANNEL,
  BROWSER_EXTENSION_INSTALL_CHANNEL,
  BROWSER_EXTENSION_REMOVE_CHANNEL,
  BROWSER_EXTENSION_REVEAL_CHANNEL,
  BROWSER_EXTENSION_STATUS_CHANNEL,
  BROWSER_PAIRING_REQUEST_CHANNEL,
  BROWSER_PAIRING_APPROVE_CHANNEL,
  BROWSER_PAIRING_DENY_CHANNEL,
  BROWSER_PAIRING_REVOKE_CHANNEL,
  BROWSER_PAIRING_STATUS_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_HISTORY_CHANNEL,
  BROWSER_HISTORY_OPEN_CHANNEL,
  BROWSER_CLEAR_DATA_CHANNEL,
  BROWSER_DOWNLOADS_CHANNEL,
  BROWSER_DOWNLOAD_EVENT_CHANNEL,
  BROWSER_DOWNLOAD_FOLDER_CHANNEL,
  BROWSER_DOWNLOAD_OPEN_CHANNEL,
  BROWSER_DOWNLOAD_REMOVE_CHANNEL,
  BROWSER_DOWNLOAD_REVEAL_CHANNEL,
  BROWSER_IMPORT_RUN_CHANNEL,
  BROWSER_IMPORT_SOURCES_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  BROWSER_REVEAL_CHANNEL,
  BROWSER_STATE_CHANNEL,
  DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL,
  DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL,
  DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL,
  DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL,
  HOME_BACKUP_DISCARD_CHANNEL,
  HOME_BACKUP_EXPORT_CHANNEL,
  HOME_BACKUP_OPEN_CHANNEL,
  HOME_BACKUP_PLAN_CHANNEL,
  HOME_BACKUP_RESTORE_CHANNEL,
  HOME_BACKUP_REVEAL_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  LINK_OPEN_CHANNEL,
  APP_MENU_COMMAND_CHANNEL,
  MARKDOWN_REMOTE_IMAGE_CHANNEL,
  MAC_HELPER_PERMISSION_CHANNEL,
  MAC_HELPER_RECONNECT_CHANNEL,
  MAC_HELPER_RESET_CHANNEL,
  MAC_HELPER_STATUS_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
  VAULT_EXPORT_CHANNEL,
  VAULT_IMPORT_CHANNEL,
  VAULT_IMPORT_PICK_CHANNEL,
  VAULT_LOCK_CHANNEL,
  VAULT_MASTER_CHANNEL,
  VAULT_REMOVE_CHANNEL,
  VAULT_REPAIR_KEY_CHANNEL,
  VAULT_RESET_CHANNEL,
  VAULT_SAVE_CHANNEL,
  VAULT_START_OVER_CHANNEL,
  VAULT_STATUS_CHANNEL,
  VAULT_UNLOCK_CHANNEL,
  VAULT_REVEAL_CHANNEL,
  type AgentPreviewUpdate,
  type AppMenuCommand,
  type AgentPreviewPointer,
  type BrowserViewAction,
  type BrowserViewState,
  type FileDialogFilter,
  type MacHelperPermission,
  type BrowserImportRequest,
  type UserDownloadView,
} from '../shared/ipc-contract'

interface IpcRendererLike {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  send(channel: string, payload?: unknown): void
  on(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
}

export function createDesktopCapabilityBridge(ipcRenderer: IpcRendererLike) {
  return {
    revealReference: (input: { sessionId: string; referenceId: string }) =>
      ipcRenderer.invoke(REFERENCE_REVEAL_CHANNEL, input),
    openExternal: (url: string) =>
      ipcRenderer.invoke(EXTERNAL_OPEN_CHANNEL, url),
    /** A clicked web link: main picks the system or the built-in browser. */
    openLink: (url: string) => ipcRenderer.invoke(LINK_OPEN_CHANNEL, url),
    /** A remote markdown image the user asked to see: main fetches it. */
    loadRemoteImage: (url: string) =>
      ipcRenderer.invoke(MARKDOWN_REMOTE_IMAGE_CHANNEL, { url }),
    /** App menu items that act in the window (偏好设置… opens 设置). */
    onMenuCommand: (listener: (command: AppMenuCommand) => void) => {
      const wrapped = (_event: unknown, command: unknown) => {
        if (command === 'open-settings') listener(command)
      }
      ipcRenderer.on(APP_MENU_COMMAND_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(APP_MENU_COMMAND_CHANNEL, wrapped)
    },
    openSkillsFolder: (input: {
      scope: 'user' | 'project'
      sessionId?: string | null
    }) => ipcRenderer.invoke(SKILLS_OPEN_FOLDER_CHANNEL, input),
    selectFile: (
      input: { title?: string; filters?: FileDialogFilter[] } = {},
    ) => ipcRenderer.invoke(SELECT_FILE_CHANNEL, input),
    vaultStatus: () => ipcRenderer.invoke(VAULT_STATUS_CHANNEL),
    vaultSave: (draft: unknown) =>
      ipcRenderer.invoke(VAULT_SAVE_CHANNEL, draft),
    vaultRemove: (handleId: string) =>
      ipcRenderer.invoke(VAULT_REMOVE_CHANNEL, { handleId }),
    vaultUnlock: (password: string) =>
      ipcRenderer.invoke(VAULT_UNLOCK_CHANNEL, { password }),
    vaultLock: () => ipcRenderer.invoke(VAULT_LOCK_CHANNEL),
    /** set (typed twice) / change / remove; change and remove need the current one. */
    vaultMaster: (request: {
      action: 'set' | 'change' | 'remove'
      currentPassword?: string
      password?: string
      confirmPassword?: string
    }) =>
      ipcRenderer.invoke(VAULT_MASTER_CHANNEL, {
        action: request.action,
        ...(request.currentPassword === undefined
          ? {}
          : { currentPassword: request.currentPassword }),
        ...(request.password === undefined
          ? {}
          : { password: request.password }),
        ...(request.confirmPassword === undefined
          ? {}
          : { confirmPassword: request.confirmPassword }),
      }),
    vaultReveal: (handleId: string) =>
      ipcRenderer.invoke(VAULT_REVEAL_CHANNEL, { handleId }),
    /** 清空 (Settings confirms first): every entry and the master password. */
    vaultReset: () => ipcRenderer.invoke(VAULT_RESET_CHANNEL),
    /** 修复权限: make the local key private again. */
    vaultRepairKey: () => ipcRenderer.invoke(VAULT_REPAIR_KEY_CHANNEL),
    /** 重新开始（先备份） (Settings confirms first). */
    vaultStartOver: () => ipcRenderer.invoke(VAULT_START_OVER_CHANNEL),
    /** 导出凭据备份: main asks where to save it. */
    vaultExport: (passphrase: string, confirmPassphrase: string) =>
      ipcRenderer.invoke(VAULT_EXPORT_CHANNEL, {
        passphrase,
        confirmPassphrase,
      }),
    /** Main's open dialog picks the backup; no path crosses IPC. */
    vaultImportPick: () => ipcRenderer.invoke(VAULT_IMPORT_PICK_CHANNEL),
    vaultImport: (passphrase: string) =>
      ipcRenderer.invoke(VAULT_IMPORT_CHANNEL, { passphrase }),
    /** Address-bar submit only; main normalizes and may answer ok:false. */
    openBrowserUrl: (url: string) =>
      ipcRenderer.invoke(BROWSER_OPEN_CHANNEL, { url }),
    /** null hides the native view (it draws above the DOM). */
    browserBounds: (
      bounds: { x: number; y: number; width: number; height: number } | null,
    ) => ipcRenderer.send(BROWSER_BOUNDS_CHANNEL, bounds),
    browserAction: (action: BrowserViewAction) =>
      ipcRenderer.send(BROWSER_ACTION_CHANNEL, action),
    browserClose: () => ipcRenderer.send(BROWSER_CLOSE_CHANNEL),
    /** The built-in browser's temporary history, newest first. */
    browserHistory: () => ipcRenderer.invoke(BROWSER_HISTORY_CHANNEL),
    /** Reopen a history entry by id; main checks its address again. */
    openBrowserHistory: (id: string) =>
      ipcRenderer.invoke(BROWSER_HISTORY_OPEN_CHANNEL, id),
    /** Clear the built-in browser's data (its own partition only). */
    clearBrowserData: () => ipcRenderer.invoke(BROWSER_CLEAR_DATA_CHANNEL),
    onBrowserState: (listener: (state: BrowserViewState) => void) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        listener(payload as BrowserViewState)
      ipcRenderer.on(BROWSER_STATE_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(BROWSER_STATE_CHANNEL, wrapped)
    },
    /** 设置 › 浏览器 › 下载历史记录: your downloads and Emperor's. */
    browserDownloads: () => ipcRenderer.invoke(BROWSER_DOWNLOADS_CHANNEL),
    openBrowserDownload: (id: string) =>
      ipcRenderer.invoke(BROWSER_DOWNLOAD_OPEN_CHANNEL, { id }),
    revealBrowserDownload: (id: string) =>
      ipcRenderer.invoke(BROWSER_DOWNLOAD_REVEAL_CHANNEL, { id }),
    removeBrowserDownload: (id: string) =>
      ipcRenderer.invoke(BROWSER_DOWNLOAD_REMOVE_CHANNEL, { id }),
    /** The system folder picker for 设置 › 浏览器 › 下载 › 位置. */
    chooseDownloadFolder: () =>
      ipcRenderer.invoke(BROWSER_DOWNLOAD_FOLDER_CHANNEL),
    /** 从浏览器导入: the source list and each browser's running state. */
    browserImportSources: () =>
      ipcRenderer.invoke(BROWSER_IMPORT_SOURCES_CHANNEL),
    /** 从浏览器导入: run one import in main; resolves counts, never a value. */
    runBrowserImport: (request: BrowserImportRequest) =>
      ipcRenderer.invoke(BROWSER_IMPORT_RUN_CHANNEL, request),
    /** One of your downloads started, moved on or ended. */
    onBrowserDownload: (listener: (download: UserDownloadView) => void) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        listener(payload as UserDownloadView)
      ipcRenderer.on(BROWSER_DOWNLOAD_EVENT_CHANNEL, wrapped)
      return () =>
        ipcRenderer.removeListener(BROWSER_DOWNLOAD_EVENT_CHANNEL, wrapped)
    },
    /** Main opened a clicked link in the built-in browser: show the pane. */
    onBrowserReveal: (listener: (payload: { url: string }) => void) => {
      const wrapped = (_event: unknown, payload: unknown) => {
        const url = (payload as { url?: unknown } | null)?.url
        if (typeof url === 'string') listener({ url })
      }
      ipcRenderer.on(BROWSER_REVEAL_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(BROWSER_REVEAL_CHANNEL, wrapped)
    },
    /** Computer Use: stream frames of one Agent tab (by id). */
    agentPreviewStart: (targetId: string) =>
      ipcRenderer.invoke(AGENT_PREVIEW_START_CHANNEL, { targetId }),
    agentDownloadReveal: (downloadId: string) =>
      ipcRenderer.invoke(AGENT_DOWNLOAD_REVEAL_CHANNEL, { downloadId }),
    agentDownloadMove: (downloadId: string) =>
      ipcRenderer.invoke(AGENT_DOWNLOAD_MOVE_CHANNEL, { downloadId }),
    agentDownloadSaveAs: (downloadId: string) =>
      ipcRenderer.invoke(AGENT_DOWNLOAD_SAVE_AS_CHANNEL, { downloadId }),
    /** 导出诊断包 (REL-01): stage and list; then export / reveal / discard by id. */
    prepareDiagnosticsBundle: () =>
      ipcRenderer.invoke(DIAGNOSTICS_BUNDLE_PREPARE_CHANNEL),
    exportDiagnosticsBundle: (id: string) =>
      ipcRenderer.invoke(DIAGNOSTICS_BUNDLE_EXPORT_CHANNEL, { id }),
    revealDiagnosticsBundle: (id: string) =>
      ipcRenderer.invoke(DIAGNOSTICS_BUNDLE_REVEAL_CHANNEL, { id }),
    discardDiagnosticsBundle: (id: string) =>
      ipcRenderer.invoke(DIAGNOSTICS_BUNDLE_DISCARD_CHANNEL, { id }),
    // REL-03 备份与恢复: main picks every path; an opened backup is an id.
    planHomeBackup: () => ipcRenderer.invoke(HOME_BACKUP_PLAN_CHANNEL),
    exportHomeBackup: (input: {
      includeSessions: boolean
      passphrase?: string
      confirmation?: string
    }) =>
      ipcRenderer.invoke(HOME_BACKUP_EXPORT_CHANNEL, {
        includeSessions: input.includeSessions,
        ...(input.passphrase === undefined
          ? {}
          : { passphrase: input.passphrase }),
        ...(input.confirmation === undefined
          ? {}
          : { confirmation: input.confirmation }),
      }),
    revealHomeBackup: () => ipcRenderer.invoke(HOME_BACKUP_REVEAL_CHANNEL),
    openHomeBackup: () => ipcRenderer.invoke(HOME_BACKUP_OPEN_CHANNEL),
    restoreHomeBackup: (id: string, passphrase?: string) =>
      ipcRenderer.invoke(HOME_BACKUP_RESTORE_CHANNEL, {
        id,
        ...(passphrase === undefined ? {} : { passphrase }),
      }),
    discardHomeBackup: (id: string) =>
      ipcRenderer.invoke(HOME_BACKUP_DISCARD_CHANNEL, { id }),
    macHelperStatus: () => ipcRenderer.invoke(MAC_HELPER_STATUS_CHANNEL),
    macHelperRequestPermission: (permission: MacHelperPermission) =>
      ipcRenderer.invoke(MAC_HELPER_PERMISSION_CHANNEL, { permission }),
    macHelperResetPermission: (permission: MacHelperPermission) =>
      ipcRenderer.invoke(MAC_HELPER_RESET_CHANNEL, { permission }),
    /** Settings 「重新连接」: clears the crash latch and connects again. */
    macHelperReconnect: () => ipcRenderer.invoke(MAC_HELPER_RECONNECT_CHANNEL),
    browserPairings: () => ipcRenderer.invoke(BROWSER_PAIRING_STATUS_CHANNEL),
    approveBrowserPairing: (pairingId: string) =>
      ipcRenderer.invoke(BROWSER_PAIRING_APPROVE_CHANNEL, { pairingId }),
    denyBrowserPairing: (pairingId: string) =>
      ipcRenderer.invoke(BROWSER_PAIRING_DENY_CHANNEL, { pairingId }),
    revokeBrowserPairing: (pairingId: string) =>
      ipcRenderer.invoke(BROWSER_PAIRING_REVOKE_CHANNEL, { pairingId }),
    /** 设置 › 电脑操作 › Chrome 和 Edge: the extension folder; no argument. */
    browserExtensionStatus: () =>
      ipcRenderer.invoke(BROWSER_EXTENSION_STATUS_CHANNEL),
    installBrowserExtension: () =>
      ipcRenderer.invoke(BROWSER_EXTENSION_INSTALL_CHANNEL),
    revealBrowserExtension: () =>
      ipcRenderer.invoke(BROWSER_EXTENSION_REVEAL_CHANNEL),
    removeBrowserExtension: () =>
      ipcRenderer.invoke(BROWSER_EXTENSION_REMOVE_CHANNEL),
    /** An extension asked to pair; nothing about it crosses. */
    onBrowserPairingRequest: (listener: () => void) => {
      const wrapped = () => listener()
      ipcRenderer.on(BROWSER_PAIRING_REQUEST_CHANNEL, wrapped)
      return () =>
        ipcRenderer.removeListener(BROWSER_PAIRING_REQUEST_CHANNEL, wrapped)
    },
    agentPreviewStop: (targetId: string) =>
      ipcRenderer.send(AGENT_PREVIEW_STOP_CHANNEL, { targetId }),
    onAgentPreviewFrame: (listener: (frame: AgentPreviewUpdate) => void) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        listener(payload as AgentPreviewUpdate)
      ipcRenderer.on(AGENT_PREVIEW_FRAME_CHANNEL, wrapped)
      return () =>
        ipcRenderer.removeListener(AGENT_PREVIEW_FRAME_CHANNEL, wrapped)
    },
    /** Where the Agent's latest action landed, for its preview card. */
    onAgentPreviewPointer: (
      listener: (pointer: AgentPreviewPointer) => void,
    ) => {
      const wrapped = (_event: unknown, payload: unknown) => {
        const pointer = previewPointerOf(payload)
        if (pointer !== null) listener(pointer)
      }
      ipcRenderer.on(AGENT_PREVIEW_POINTER_CHANNEL, wrapped)
      return () =>
        ipcRenderer.removeListener(AGENT_PREVIEW_POINTER_CHANNEL, wrapped)
    },
  }
}

const share = (value: unknown): value is number =>
  typeof value === 'number' && value >= 0 && value <= 1

/** A target id and two shares (0–1); anything else is dropped. */
function previewPointerOf(payload: unknown): AgentPreviewPointer | null {
  if (payload === null || typeof payload !== 'object') return null
  const { targetId, x, y } = payload as Record<string, unknown>
  if (typeof targetId !== 'string' || targetId === '') return null
  return share(x) && share(y) ? { targetId, x, y } : null
}
