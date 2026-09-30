/**
 * Trusted-renderer IPC for editor dictation (VO-01). Every channel is
 * authorized before its payload is read. Events of a dictation go only to
 * the window that started it, and the dictation is cancelled when that
 * window goes away.
 */
import {
  DICTATION_CANCEL_CHANNEL,
  DICTATION_EVENT_CHANNEL,
  DICTATION_START_CHANNEL,
  DICTATION_STATUS_CHANNEL,
  DICTATION_STOP_CHANNEL,
  type DictationStartRequest,
  type DictationStartResult,
  type DictationStatus,
} from '../../shared/ipc-contract'
import type { DictationListener } from './dictation-service'
import { validSession } from './protocol'

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void
}

/** The part of `WebContents` a dictation needs. */
interface SenderLike {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
  once?(event: string, listener: () => void): unknown
  removeListener?(event: string, listener: () => void): unknown
}

interface DictationCapability {
  status(): Promise<DictationStatus>
  start(
    request: DictationStartRequest,
    listener: DictationListener,
  ): Promise<DictationStartResult>
  stop(session: string): boolean
  cancel(session: string): boolean
}

/** Window events after which nobody will read the dictation any more. */
const GONE_EVENTS = ['destroyed', 'render-process-gone'] as const

function senderOf(event: unknown): SenderLike | undefined {
  const sender = (event as { sender?: unknown } | null)?.sender as
    Partial<SenderLike> | undefined
  return typeof sender?.send === 'function' &&
    typeof sender.isDestroyed === 'function'
    ? (sender as SenderLike)
    : undefined
}

function startRequest(payload: unknown): DictationStartRequest | undefined {
  if (payload === undefined) return {}
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return undefined
  const body = payload as Record<string, unknown>
  if (Object.keys(body).some((key) => key !== 'locale' && key !== 'device'))
    return undefined
  const request: DictationStartRequest = {}
  for (const key of ['locale', 'device'] as const) {
    const value = body[key]
    if (value === undefined) continue
    if (value !== null && typeof value !== 'string') return undefined
    request[key] = value
  }
  return request
}

function sessionOf(payload: unknown): string | undefined {
  const session = (payload as { session?: unknown } | null | undefined)?.session
  return validSession(session) ? session : undefined
}

export function registerDictationIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  service: DictationCapability
}): void {
  const { ipcMain, service } = input

  ipcMain.handle(DICTATION_STATUS_CHANNEL, async (event) => {
    input.authorize(event)
    return await service.status()
  })

  ipcMain.handle(
    DICTATION_START_CHANNEL,
    async (event, payload): Promise<DictationStartResult> => {
      input.authorize(event)
      const request = startRequest(payload)
      const sender = senderOf(event)
      if (!request || !sender)
        return {
          ok: false,
          code: 'invalid_request',
          message: '听写请求无效',
        }
      let session: string | undefined
      let over = false
      const forget = () => {
        for (const name of GONE_EVENTS) sender.removeListener?.(name, gone)
      }
      const gone = () => {
        forget()
        if (session !== undefined) service.cancel(session)
      }
      const result = await service.start(request, {
        deliver: (dictationEvent) => {
          if (sender.isDestroyed()) return false
          sender.send(DICTATION_EVENT_CHANNEL, dictationEvent)
          return true
        },
        closed: () => {
          over = true
          forget()
        },
      })
      if (result.ok && !over) {
        session = result.session
        for (const name of GONE_EVENTS) sender.once?.(name, gone)
      }
      return result
    },
  )

  ipcMain.handle(DICTATION_STOP_CHANNEL, (event, payload) => {
    input.authorize(event)
    const session = sessionOf(payload)
    return { ok: session !== undefined && service.stop(session) }
  })

  ipcMain.handle(DICTATION_CANCEL_CHANNEL, (event, payload) => {
    input.authorize(event)
    const session = sessionOf(payload)
    return { ok: session !== undefined && service.cancel(session) }
  })
}
