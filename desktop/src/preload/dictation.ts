import {
  DICTATION_CANCEL_CHANNEL,
  DICTATION_EVENT_CHANNEL,
  DICTATION_PRIVACY_CHANNEL,
  DICTATION_START_CHANNEL,
  DICTATION_STATUS_CHANNEL,
  DICTATION_STOP_CHANNEL,
  type DictationEvent,
  type DictationPrivacyPane,
  type DictationStartRequest,
} from '../shared/ipc-contract'

interface IpcRendererLike {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  on(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
}

/** Editor dictation (VO-01): fixed channels, sessions made up by main. */
export function createDictationBridge(ipcRenderer: IpcRendererLike) {
  return {
    dictationStatus: () => ipcRenderer.invoke(DICTATION_STATUS_CHANNEL),
    dictationStart: (request: DictationStartRequest = {}) =>
      ipcRenderer.invoke(DICTATION_START_CHANNEL, {
        ...(request.locale === undefined ? {} : { locale: request.locale }),
        ...(request.device === undefined ? {} : { device: request.device }),
      }),
    dictationStop: (session: string) =>
      ipcRenderer.invoke(DICTATION_STOP_CHANNEL, { session }),
    dictationCancel: (session: string) =>
      ipcRenderer.invoke(DICTATION_CANCEL_CHANNEL, { session }),
    /** Settings › 语音: System Settings at one privacy list. */
    dictationOpenPrivacy: (pane: DictationPrivacyPane) =>
      ipcRenderer.invoke(DICTATION_PRIVACY_CHANNEL, { pane }),
    onDictationEvent: (listener: (event: DictationEvent) => void) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        listener(payload as DictationEvent)
      ipcRenderer.on(DICTATION_EVENT_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(DICTATION_EVENT_CHANNEL, wrapped)
    },
  }
}
