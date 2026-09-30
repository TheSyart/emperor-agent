/**
 * Main-process side of the dictation helper's wire protocol (VO-01): one
 * JSON object per line on the helper's stdin (requests) and stdout (events).
 * The helper is Emperor's own child, so the pipe is the authenticated
 * channel; this module keeps both directions to the shapes and sizes the
 * Swift side (DictationCore/DictationProtocol.swift) accepts and produces.
 */
import type {
  DictationDevice,
  DictationEndReason,
  DictationErrorCode,
  DictationLocale,
} from '../../shared/ipc-contract'

export const DICTATION_PROTOCOL_VERSION = 1
/** Longest line either side accepts, in UTF-8 bytes. */
export const DICTATION_MAX_LINE_BYTES = 64 * 1024
/** Upper bound for one dictation, in seconds. */
export const DICTATION_MAX_SECONDS = 600

export type HelperPermission =
  'granted' | 'denied' | 'undetermined' | 'restricted'

/** The codes the helper itself sends (main adds its own). */
export type HelperErrorCode = Exclude<
  DictationErrorCode,
  'unavailable' | 'helper_exited' | 'timeout'
>

export interface HelperStatus {
  permissions: { microphone: HelperPermission; speech: HelperPermission }
  devices: DictationDevice[]
  locales: DictationLocale[]
  systemLocale: string
  engine: string
}

export type HelperRequest =
  | { type: 'hello'; protocol: number }
  | { type: 'status' }
  | {
      type: 'start'
      session: string
      locale: string | null
      device: string | null
      maxSeconds: number
    }
  | { type: 'stop'; session: string }
  | { type: 'cancel'; session: string }

/** Events about one dictation. */
export type HelperSessionEvent =
  | { type: 'started'; session: string; seq: number; locale: string }
  | { type: 'partial'; session: string; seq: number; text: string }
  | { type: 'final'; session: string; seq: number; text: string }
  | { type: 'ended'; session: string; seq: number; reason: DictationEndReason }
  | {
      type: 'error'
      session: string | null
      seq: number | null
      code: HelperErrorCode
      message: string
    }

export type HelperEvent =
  | { type: 'hello'; protocol: number; engine: string }
  | ({ type: 'status' } & HelperStatus)
  | HelperSessionEvent

export class DictationProtocolError extends Error {
  override readonly name = 'DictationProtocolError'
}

const PERMISSIONS: readonly HelperPermission[] = [
  'granted',
  'denied',
  'undetermined',
  'restricted',
]
const ERROR_CODES: readonly HelperErrorCode[] = [
  'invalid_request',
  'busy',
  'not_found',
  'permission_denied',
  'no_device',
  'unsupported_locale',
  'recognizer_unavailable',
  'failed',
]
const END_REASONS: readonly DictationEndReason[] = [
  'stopped',
  'cancelled',
  'max_duration',
  'error',
]
const SESSION = /^[A-Za-z0-9-]{8,64}$/
/** `zh-CN`, `en_US`, `yue-Hant-HK`: what the helper takes in a start. */
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/
/** Tags the helper reports may carry extensions (`en-US-u-mu-celsius`). */
const REPORTED_LOCALE = /^[A-Za-z0-9_-]{2,80}$/
const MAX_TEXT = 32 * 1024

export function validSession(value: unknown): value is string {
  return typeof value === 'string' && SESSION.test(value)
}

export function validLocale(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 && LOCALE.test(value)
}

/** A CoreAudio device UID. */
export function validDevice(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function fail(message: string): never {
  throw new DictationProtocolError(message)
}

export function encodeRequest(request: HelperRequest): string {
  switch (request.type) {
    case 'hello':
      if (!Number.isSafeInteger(request.protocol)) fail('bad protocol version')
      break
    case 'status':
      break
    case 'start':
      if (!validSession(request.session)) fail('bad session id')
      if (request.locale !== null && !validLocale(request.locale))
        fail('bad locale')
      if (request.device !== null && !validDevice(request.device))
        fail('bad device')
      if (
        !Number.isSafeInteger(request.maxSeconds) ||
        request.maxSeconds < 1 ||
        request.maxSeconds > DICTATION_MAX_SECONDS
      )
        fail('bad maxSeconds')
      break
    case 'stop':
    case 'cancel':
      if (!validSession(request.session)) fail('bad session id')
      break
    default:
      fail('unknown request')
  }
  return `${JSON.stringify(request)}\n`
}

type Body = Record<string, unknown>

function record(value: unknown, what: string): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${what} is not an object`)
  return value as Body
}

function text(
  value: unknown,
  what: string,
  max: number,
  empty = false,
): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value))
    fail(`${what} is not a string of at most ${max} characters`)
  return value
}

function seq(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail('seq is not a positive integer')
  return value as number
}

function session(value: unknown): string {
  if (!validSession(value)) fail('bad session id')
  return value
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  what: string,
): T {
  if (!options.includes(value as T)) fail(`unknown ${what}`)
  return value as T
}

function list<T>(
  value: unknown,
  max: number,
  what: string,
  item: (value: Body) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) fail(`${what} is not a list`)
  return value.map((entry) => item(record(entry, what)))
}

function status(body: Body): HelperEvent {
  const permissions = record(body.permissions, 'permissions')
  return {
    type: 'status',
    permissions: {
      microphone: oneOf(permissions.microphone, PERMISSIONS, 'permission'),
      speech: oneOf(permissions.speech, PERMISSIONS, 'permission'),
    },
    devices: list(body.devices, 64, 'device', (device) => {
      if (!validDevice(device.id)) fail('bad device id')
      if (typeof device.default !== 'boolean') fail('bad device default')
      return {
        id: device.id,
        name: text(device.name, 'device name', 256),
        default: device.default,
      }
    }),
    locales: list(body.locales, 512, 'locale', (locale) => {
      if (typeof locale.id !== 'string' || !REPORTED_LOCALE.test(locale.id))
        fail('bad locale id')
      return { id: locale.id, name: text(locale.name, 'locale name', 256) }
    }),
    systemLocale:
      typeof body.systemLocale === 'string' &&
      REPORTED_LOCALE.test(body.systemLocale)
        ? body.systemLocale
        : fail('bad system locale'),
    engine: text(body.engine, 'engine', 64),
  }
}

/** One stdout line of the helper; anything else is a protocol error. */
export function parseHelperEvent(line: string): HelperEvent {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    fail('line is not JSON')
  }
  const body = record(value, 'event')
  switch (body.type) {
    case 'hello':
      if (!Number.isSafeInteger(body.protocol)) fail('bad protocol version')
      return {
        type: 'hello',
        protocol: body.protocol as number,
        engine: text(body.engine, 'engine', 64),
      }
    case 'status':
      return status(body)
    case 'started':
      if (typeof body.locale !== 'string' || !REPORTED_LOCALE.test(body.locale))
        fail('bad locale')
      return {
        type: 'started',
        session: session(body.session),
        seq: seq(body.seq),
        locale: body.locale,
      }
    case 'partial':
    case 'final':
      return {
        type: body.type,
        session: session(body.session),
        seq: seq(body.seq),
        text: text(body.text, 'text', MAX_TEXT, true),
      }
    case 'ended':
      return {
        type: 'ended',
        session: session(body.session),
        seq: seq(body.seq),
        reason: oneOf(body.reason, END_REASONS, 'end reason'),
      }
    case 'error':
      return {
        type: 'error',
        session: body.session === null ? null : session(body.session),
        seq: body.seq === null ? null : seq(body.seq),
        code: oneOf(body.code, ERROR_CODES, 'error code'),
        message: text(body.message, 'message', 1024, true),
      }
    default:
      return fail('unknown event type')
  }
}

/**
 * Splits a byte stream into lines. A line longer than the limit is a
 * protocol error: the helper never writes one.
 */
export class LineDecoder {
  private pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): string[] {
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : chunk
    const lines: string[] = []
    let start = 0
    let end: number
    while ((end = this.pending.indexOf(0x0a, start)) >= 0) {
      if (end - start > DICTATION_MAX_LINE_BYTES) fail('line is too long')
      if (end > start)
        lines.push(this.pending.subarray(start, end).toString('utf8'))
      start = end + 1
    }
    this.pending = this.pending.subarray(start)
    if (this.pending.length > DICTATION_MAX_LINE_BYTES) fail('line is too long')
    return lines
  }
}
