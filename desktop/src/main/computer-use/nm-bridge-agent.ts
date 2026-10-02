/**
 * The extension's Agent messages (PLAN-CAP-001 RV-09), kept apart from the
 * pairing bridge: the requests main may send, and the events the extension
 * reports about the Agent's own browsing. Everything here crossed the
 * encrypted channel, but the page controls part of it (file names, where a
 * page went), so every field is checked and bounded; a malformed known
 * event is a protocol error that closes the connection.
 */
import { isExactHttpOrigin } from './web-origin'

/** Main → extension requests beyond observation and action. */
export const AGENT_REQUEST_METHODS = [
  'tab.open',
  'target.navigate',
  'target.follow',
  'download.resolve',
  // 历史记录 (RV-10).
  'history.search',
] as const

export type NmAgentEvent =
  | {
      /** A target's page moved by itself; it waits for follow or detach. */
      readonly type: 'target-navigated'
      readonly pairingId: string
      readonly targetId: string
      readonly generation: number
      readonly origin: string
    }
  | {
      /** A download from a tab the Agent works in waits for a verdict. */
      readonly type: 'download-pending'
      readonly pairingId: string
      /** The browser's own download id. */
      readonly downloadId: number
      readonly targetId: string
      readonly generation: number
      /** Origin of the file ('' when the browser does not say). */
      readonly origin: string
      readonly filename: string
      readonly mimeType: string
      /** -1 when unknown. */
      readonly bytes: number
      readonly browser: 'chrome' | 'edge'
    }
  | {
      /** An allowed download ended. */
      readonly type: 'download-done'
      readonly pairingId: string
      readonly downloadId: number
      readonly state: 'complete' | 'interrupted'
      readonly filename: string
      readonly bytes: number
    }

function mismatch(): Error {
  const error = new Error('PROTOCOL_MISMATCH')
  error.name = 'PROTOCOL_MISMATCH'
  return error
}

function count(value: unknown, min = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') throw mismatch()
  return value.slice(0, max)
}

/**
 * One of the Agent events, or null when `name` is not one (the bridge then
 * refuses it as before). Throws PROTOCOL_MISMATCH for a malformed one.
 */
export function parseAgentEvent(
  name: string,
  data: Record<string, unknown>,
  pairingId: string,
): NmAgentEvent | null {
  if (name === 'target.navigated') {
    if (
      typeof data.targetId !== 'string' ||
      data.targetId.length > 64 ||
      !count(data.generation, 1) ||
      !isExactHttpOrigin(data.origin)
    )
      throw mismatch()
    return {
      type: 'target-navigated',
      pairingId,
      targetId: data.targetId,
      generation: data.generation,
      origin: data.origin as string,
    }
  }
  if (name === 'download.pending') {
    if (
      !count(data.downloadId) ||
      typeof data.targetId !== 'string' ||
      data.targetId.length > 64 ||
      !count(data.generation, 1) ||
      !(data.origin === '' || isExactHttpOrigin(data.origin)) ||
      !count(data.bytes, -1)
    )
      throw mismatch()
    return {
      type: 'download-pending',
      pairingId,
      downloadId: data.downloadId,
      targetId: data.targetId,
      generation: data.generation,
      origin: data.origin as string,
      filename: text(data.filename, 200),
      mimeType: text(data.mimeType ?? '', 200),
      bytes: data.bytes,
      browser: data.browser === 'edge' ? 'edge' : 'chrome',
    }
  }
  if (name === 'download.done') {
    if (
      !count(data.downloadId) ||
      (data.state !== 'complete' && data.state !== 'interrupted') ||
      !count(data.bytes)
    )
      throw mismatch()
    return {
      type: 'download-done',
      pairingId,
      downloadId: data.downloadId,
      state: data.state,
      filename: text(data.filename, 200),
      bytes: data.bytes,
    }
  }
  return null
}
