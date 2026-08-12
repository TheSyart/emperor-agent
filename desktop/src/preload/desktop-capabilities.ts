import {
  EXTERNAL_OPEN_CHANNEL,
  PREVIEW_ACTION_CHANNEL,
  PREVIEW_BOUNDS_CHANNEL,
  PREVIEW_CLOSE_CHANNEL,
  PREVIEW_EXTERNAL_CHANNEL,
  PREVIEW_OPEN_CHANNEL,
  PREVIEW_STATE_CHANNEL,
  REFERENCE_REVEAL_CHANNEL,
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

export interface PreviewViewState {
  sessionId: string
  previewId: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export function createDesktopCapabilityBridge(ipcRenderer: IpcRendererLike) {
  return {
    revealReference: (input: { sessionId: string; referenceId: string }) =>
      ipcRenderer.invoke(REFERENCE_REVEAL_CHANNEL, input),
    openExternal: (url: string) =>
      ipcRenderer.invoke(EXTERNAL_OPEN_CHANNEL, url),
    previewOpen: (input: { sessionId: string; previewId: string }) =>
      ipcRenderer.invoke(PREVIEW_OPEN_CHANNEL, input),
    previewExternal: (input: { sessionId: string; previewId: string }) =>
      ipcRenderer.invoke(PREVIEW_EXTERNAL_CHANNEL, input),
    previewBounds: (bounds: {
      x: number
      y: number
      width: number
      height: number
    }) => ipcRenderer.send(PREVIEW_BOUNDS_CHANNEL, bounds),
    previewAction: (action: 'back' | 'forward' | 'reload') =>
      ipcRenderer.send(PREVIEW_ACTION_CHANNEL, action),
    previewClose: () => ipcRenderer.send(PREVIEW_CLOSE_CHANNEL),
    onPreviewState: (listener: (state: PreviewViewState) => void) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        listener(payload as PreviewViewState)
      ipcRenderer.on(PREVIEW_STATE_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(PREVIEW_STATE_CHANNEL, wrapped)
    },
  }
}
