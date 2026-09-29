import {
  AGENT_DOWNLOAD_MOVE_CHANNEL,
  AGENT_DOWNLOAD_REVEAL_CHANNEL,
  AGENT_DOWNLOAD_SAVE_AS_CHANNEL,
  AGENT_PREVIEW_FRAME_CHANNEL,
  AGENT_PREVIEW_INPUT_CHANNEL,
  AGENT_PREVIEW_START_CHANNEL,
  AGENT_PREVIEW_STOP_CHANNEL,
  BROWSER_ACTION_CHANNEL,
  BROWSER_CONNECT_CHANNEL,
  BROWSER_PAIRING_APPROVE_CHANNEL,
  BROWSER_PAIRING_DENY_CHANNEL,
  BROWSER_PAIRING_REVOKE_CHANNEL,
  BROWSER_PAIRING_STATUS_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  BROWSER_STATE_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  MAC_HELPER_PERMISSION_CHANNEL,
  MAC_HELPER_RECONNECT_CHANNEL,
  MAC_HELPER_RESET_CHANNEL,
  MAC_HELPER_STATUS_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
  VAULT_BIOMETRIC_DISABLE_CHANNEL,
  VAULT_BIOMETRIC_UNLOCK_CHANNEL,
  VAULT_LOCK_CHANNEL,
  VAULT_MASTER_CHANNEL,
  VAULT_REMOVE_CHANNEL,
  VAULT_SAVE_CHANNEL,
  VAULT_STATUS_CHANNEL,
  VAULT_UNLOCK_CHANNEL,
  VAULT_REVEAL_CHANNEL,
  type AgentPreviewFrame,
  type AgentPreviewInput,
  type BrowserViewAction,
  type BrowserViewState,
  type FileDialogFilter,
  type MacHelperPermission,
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
    /** `biometric`: also allow Touch ID unlock with this password's key. */
    vaultUnlock: (password: string, biometric?: boolean) =>
      ipcRenderer.invoke(
        VAULT_UNLOCK_CHANNEL,
        biometric === true ? { password, biometric } : { password },
      ),
    vaultLock: () => ipcRenderer.invoke(VAULT_LOCK_CHANNEL),
    vaultSetMaster: (password: string | null, biometric?: boolean) =>
      ipcRenderer.invoke(
        VAULT_MASTER_CHANNEL,
        biometric === true ? { password, biometric } : { password },
      ),
    vaultReveal: (handleId: string) =>
      ipcRenderer.invoke(VAULT_REVEAL_CHANNEL, { handleId }),
    /** Main runs the system identity check before unlocking. */
    vaultBiometricUnlock: () =>
      ipcRenderer.invoke(VAULT_BIOMETRIC_UNLOCK_CHANNEL),
    vaultBiometricDisable: () =>
      ipcRenderer.invoke(VAULT_BIOMETRIC_DISABLE_CHANNEL),
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
    onBrowserState: (listener: (state: BrowserViewState) => void) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        listener(payload as BrowserViewState)
      ipcRenderer.on(BROWSER_STATE_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(BROWSER_STATE_CHANNEL, wrapped)
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
    connectBrowsers: () => ipcRenderer.invoke(BROWSER_CONNECT_CHANNEL),
    agentPreviewStop: (targetId: string) =>
      ipcRenderer.send(AGENT_PREVIEW_STOP_CHANNEL, { targetId }),
    /** Forwarded only while the user has taken the tab over. */
    agentPreviewInput: (targetId: string, event: AgentPreviewInput) =>
      ipcRenderer.send(AGENT_PREVIEW_INPUT_CHANNEL, { targetId, event }),
    onAgentPreviewFrame: (listener: (frame: AgentPreviewFrame) => void) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        listener(payload as AgentPreviewFrame)
      ipcRenderer.on(AGENT_PREVIEW_FRAME_CHANNEL, wrapped)
      return () =>
        ipcRenderer.removeListener(AGENT_PREVIEW_FRAME_CHANNEL, wrapped)
    },
  }
}
