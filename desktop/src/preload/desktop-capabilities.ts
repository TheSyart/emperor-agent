import {
  BROWSER_ACTION_CHANNEL,
  BROWSER_BOUNDS_CHANNEL,
  BROWSER_CLOSE_CHANNEL,
  BROWSER_OPEN_CHANNEL,
  BROWSER_STATE_CHANNEL,
  EXTERNAL_OPEN_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
  SELECT_FILE_CHANNEL,
  SKILLS_OPEN_FOLDER_CHANNEL,
  type BrowserViewAction,
  type BrowserViewState,
  type FileDialogFilter,
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
  }
}
