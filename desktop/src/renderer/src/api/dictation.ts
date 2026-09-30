// Editor dictation (VO-01) over the preload bridge. Main makes up the session
// ids; events of other sessions are for someone else and are ignored by
// callers. Without the desktop bridge dictation is simply unavailable.

import type {
  DictationEvent,
  DictationPrivacyPane,
  DictationStartRequest,
  DictationStartResult,
  DictationStatus,
} from '../../../shared/ipc-contract'

export type {
  DictationDevice,
  DictationEndReason,
  DictationErrorCode,
  DictationEvent,
  DictationLocale,
  DictationPermission,
  DictationPrivacyPane,
  DictationStartRequest,
  DictationStartResult,
  DictationStatus,
} from '../../../shared/ipc-contract'

interface DictationBridge {
  platform?: string
  dictationStatus?: () => Promise<DictationStatus>
  dictationStart?: (
    request?: DictationStartRequest,
  ) => Promise<DictationStartResult>
  dictationStop?: (session: string) => Promise<{ ok: boolean }>
  dictationCancel?: (session: string) => Promise<{ ok: boolean }>
  dictationOpenPrivacy?: (
    pane: DictationPrivacyPane,
  ) => Promise<{ opened: boolean }>
  onDictationEvent?: (listener: (event: DictationEvent) => void) => () => void
}

const NO_BRIDGE = '听写只在 Emperor 桌面应用里可用'

function bridge(): DictationBridge | undefined {
  return (globalThis as unknown as { window?: { emperor?: DictationBridge } })
    .window?.emperor
}

function unavailable(reason: string): DictationStatus {
  return {
    supported: false,
    available: false,
    reason,
    engine: null,
    permissions: { microphone: 'unknown', speech: 'unknown' },
    devices: [],
    locales: [],
    systemLocale: null,
    active: false,
  }
}

/**
 * Dictation exists here (the desktop app on macOS). Answered without
 * starting the helper; `dictationStatus` asks the helper itself.
 */
export function dictationSupported(): boolean {
  const current = bridge()
  return (
    current?.platform === 'darwin' &&
    typeof current.dictationStart === 'function'
  )
}

export async function dictationStatus(): Promise<DictationStatus> {
  const read = bridge()?.dictationStatus
  if (typeof read !== 'function') return unavailable(NO_BRIDGE)
  try {
    return await read()
  } catch {
    return { ...unavailable('无法读取听写状态'), supported: true }
  }
}

export async function startDictation(
  request: DictationStartRequest = {},
): Promise<DictationStartResult> {
  const start = bridge()?.dictationStart
  if (typeof start !== 'function')
    return { ok: false, code: 'unavailable', message: NO_BRIDGE }
  try {
    return await start(request)
  } catch {
    return { ok: false, code: 'failed', message: '听写没有开始' }
  }
}

/** Ends the audio; the final result and `ended` follow as events. */
export async function stopDictation(session: string): Promise<boolean> {
  try {
    return (await bridge()?.dictationStop?.(session))?.ok === true
  } catch {
    return false
  }
}

/** Drops the dictation; `ended` (cancelled) follows, with no final result. */
export async function cancelDictation(session: string): Promise<boolean> {
  try {
    return (await bridge()?.dictationCancel?.(session))?.ok === true
  } catch {
    return false
  }
}

/** System Settings at the microphone or speech recognition privacy list. */
export async function openDictationPrivacy(
  pane: DictationPrivacyPane,
): Promise<boolean> {
  try {
    return (await bridge()?.dictationOpenPrivacy?.(pane))?.opened === true
  } catch {
    return false
  }
}

export function onDictationEvent(
  listener: (event: DictationEvent) => void,
): () => void {
  return bridge()?.onDictationEvent?.(listener) ?? (() => {})
}
