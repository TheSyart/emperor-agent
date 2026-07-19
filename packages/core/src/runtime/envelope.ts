import { createHash, randomUUID } from 'node:crypto'

export const EVENT_ENVELOPE_SCHEMA_VERSION = 2 as const

export type EventVisibility = 'model' | 'user' | 'diagnostic' | 'internal'
export type RuntimeCorrelationKind =
  'request' | 'attempt' | 'task' | 'tool' | 'event'

export interface EventEnvelopeV2<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  schemaVersion: typeof EVENT_ENVELOPE_SCHEMA_VERSION
  eventId: string
  idempotencyKey?: string
  sessionId: string
  turnId?: string
  requestId?: string
  attemptId?: string
  taskId?: string
  parentTaskId?: string
  toolCallId?: string
  ownerId: string
  sequence: number
  timestamp: string
  visibility: EventVisibility
  type: TType
  payload: TPayload
}

export interface RuntimeEnvelopeOptions {
  eventId?: string | null
  idempotencyKey?: string | null
  sessionId?: string | null
  turnId?: string | null
  requestId?: string | null
  attemptId?: string | null
  taskId?: string | null
  parentTaskId?: string | null
  toolCallId?: string | null
  ownerId?: string | null
  sequence?: number | null
  timestamp?: string | number | null
  visibility?: EventVisibility | null
}

type Row = Record<string, unknown>

const EVENT_VISIBILITIES = new Set<EventVisibility>([
  'model',
  'user',
  'diagnostic',
  'internal',
])

const DIAGNOSTIC_EVENT_TYPES = new Set([
  'context_projection',
  'mcp_connection_state',
  'model_provider_retry',
  'partial_stream_capture',
  'record_degraded',
  'turn_phase',
])

const INTERNAL_EVENT_TYPES = new Set(['ready'])

export function newRuntimeCorrelationId(kind: RuntimeCorrelationKind): string {
  const prefix =
    kind === 'request'
      ? 'req'
      : kind === 'attempt'
        ? 'attempt'
        : kind === 'task'
          ? 'task'
          : kind === 'tool'
            ? 'tool'
            : 'evt'
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

export function runtimeEventVisibility(type: string): EventVisibility {
  if (DIAGNOSTIC_EVENT_TYPES.has(type) || type.startsWith('model_attempt_'))
    return 'diagnostic'
  if (INTERNAL_EVENT_TYPES.has(type)) return 'internal'
  return 'user'
}

export function createEventEnvelopeV2(
  event: Row,
  opts: RuntimeEnvelopeOptions = {},
): EventEnvelopeV2 {
  const type = cleanString(event.event ?? event.type)
  if (!type) throw new Error('runtime event type is required')
  const sequence = nonNegativeInteger(opts.sequence ?? event.seq ?? 0)
  const sessionId =
    cleanString(opts.sessionId ?? event.session_id ?? event.sessionId) ||
    'global'
  const turnId = optionalString(
    opts.turnId ??
      event.turn_id ??
      event.turnId ??
      nested(event.owner, 'turn_id'),
  )
  const requestId = optionalString(
    opts.requestId ?? event.request_id ?? event.requestId,
  )
  const attemptId = optionalString(
    opts.attemptId ?? event.attempt_id ?? event.attemptId,
  )
  const taskId = optionalString(
    opts.taskId ?? event.task_id ?? event.taskId ?? nested(event.task, 'id'),
  )
  const parentTaskId = optionalString(
    opts.parentTaskId ?? event.parent_task_id ?? event.parentTaskId,
  )
  const toolCallId = optionalString(
    opts.toolCallId ??
      event.tool_call_id ??
      event.toolCallId ??
      (type.includes('tool') ? event.id : null),
  )
  const payload = runtimePayload(event)
  const timestamp = normalizeTimestamp(opts.timestamp ?? event.ts)
  const visibility =
    opts.visibility ??
    normalizeVisibility(event.visibility) ??
    runtimeEventVisibility(type)
  const ownerId =
    cleanString(
      opts.ownerId ??
        event.owner_id ??
        event.ownerId ??
        nested(event.owner, 'owner_id') ??
        nested(event.owner, 'id'),
    ) ||
    taskId ||
    turnId ||
    sessionId
  const idempotencyKey = optionalString(
    opts.idempotencyKey ?? event.idempotency_key ?? event.idempotencyKey,
  )
  const eventId =
    cleanString(opts.eventId ?? event.event_id ?? event.eventId) ||
    newRuntimeCorrelationId('event')
  return {
    schemaVersion: EVENT_ENVELOPE_SCHEMA_VERSION,
    eventId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    sessionId,
    ...(turnId ? { turnId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ownerId,
    sequence,
    timestamp,
    visibility,
    type,
    payload,
  }
}

export function isEventEnvelopeV2(value: unknown): value is EventEnvelopeV2 {
  if (!isRecord(value) || value.schemaVersion !== 2) return false
  return Boolean(
    cleanString(value.eventId) &&
    cleanString(value.sessionId) &&
    cleanString(value.ownerId) &&
    Number.isInteger(value.sequence) &&
    Number(value.sequence) >= 0 &&
    normalizeTimestampOrNull(value.timestamp) &&
    normalizeVisibility(value.visibility) &&
    cleanString(value.type) &&
    isRecord(value.payload),
  )
}

export function adaptRuntimeEventToEnvelope(
  event: Row,
  defaults: Pick<RuntimeEnvelopeOptions, 'sessionId'> = {},
): EventEnvelopeV2 {
  if (isEventEnvelopeV2(event)) return cloneEnvelope(event)
  const existingEventId = cleanString(event.event_id ?? event.eventId)
  const draft = createEventEnvelopeV2(event, {
    ...defaults,
    eventId: existingEventId || 'legacy-placeholder',
    timestamp: normalizeLegacyTimestamp(event.ts, event.seq),
  })
  if (existingEventId) return draft
  return {
    ...draft,
    eventId: `evt_legacy_${createHash('sha256')
      .update(
        stableStringify({
          sessionId: draft.sessionId,
          sequence: draft.sequence,
          timestamp: draft.timestamp,
          type: draft.type,
          payload: draft.payload,
        }),
      )
      .digest('hex')
      .slice(0, 32)}`,
  }
}

export function projectEventEnvelopeV2(envelope: EventEnvelopeV2): Row {
  const ts = Date.parse(envelope.timestamp) / 1000
  return {
    ...envelope.payload,
    event: envelope.type,
    seq: envelope.sequence,
    ts: Number.isFinite(ts) ? ts : 0,
    session_id: envelope.sessionId,
    ...(envelope.turnId ? { turn_id: envelope.turnId } : {}),
    ...(envelope.requestId ? { request_id: envelope.requestId } : {}),
    ...(envelope.attemptId ? { attempt_id: envelope.attemptId } : {}),
    ...(envelope.taskId ? { task_id: envelope.taskId } : {}),
    ...(envelope.parentTaskId ? { parent_task_id: envelope.parentTaskId } : {}),
    ...(envelope.toolCallId ? { tool_call_id: envelope.toolCallId } : {}),
    owner: {
      owner_id: envelope.ownerId,
      session_id: envelope.sessionId,
      ...(envelope.turnId ? { turn_id: envelope.turnId } : {}),
      ...(envelope.taskId ? { task_id: envelope.taskId } : {}),
    },
    source: envelope.payload.source ?? 'core',
    event_id: envelope.eventId,
    ...(envelope.idempotencyKey
      ? { idempotency_key: envelope.idempotencyKey }
      : {}),
    schema_version: EVENT_ENVELOPE_SCHEMA_VERSION,
    visibility: envelope.visibility,
  }
}

export function modelVisibleEnvelopePayloads(
  envelopes: EventEnvelopeV2[],
): Row[] {
  return envelopes
    .filter((envelope) => envelope.visibility === 'model')
    .map((envelope) => ({ event: envelope.type, ...envelope.payload }))
}

function runtimePayload(event: Row): Row {
  const out: Row = {}
  for (const [key, value] of Object.entries(event)) {
    if (ENVELOPE_METADATA_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

const ENVELOPE_METADATA_KEYS = new Set([
  'event',
  'type',
  'seq',
  'ts',
  'schemaVersion',
  'schema_version',
  'eventId',
  'event_id',
  'idempotencyKey',
  'idempotency_key',
  'sessionId',
  'session_id',
  'turnId',
  'turn_id',
  'requestId',
  'request_id',
  'attemptId',
  'attempt_id',
  'taskId',
  'task_id',
  'parentTaskId',
  'parent_task_id',
  'toolCallId',
  'tool_call_id',
  'ownerId',
  'owner_id',
  'owner',
  'sequence',
  'timestamp',
  'visibility',
  'payload',
])

function cloneEnvelope(envelope: EventEnvelopeV2): EventEnvelopeV2 {
  return {
    ...envelope,
    payload: { ...envelope.payload },
  }
}

function normalizeTimestamp(value: unknown): string {
  return normalizeTimestampOrNull(value) ?? new Date().toISOString()
}

function normalizeLegacyTimestamp(ts: unknown, seq: unknown): string {
  return (
    normalizeTimestampOrNull(ts) ??
    new Date(nonNegativeInteger(seq) || 0).toISOString()
  )
}

function normalizeTimestampOrNull(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value))
    return new Date(value * 1000).toISOString()
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function normalizeVisibility(value: unknown): EventVisibility | null {
  const visibility = String(value ?? '') as EventVisibility
  return EVENT_VISIBILITIES.has(visibility) ? visibility : null
}

function cleanString(value: unknown): string {
  return String(value ?? '').trim()
}

function optionalString(value: unknown): string | undefined {
  return cleanString(value) || undefined
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

function nested(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  const out: Row = {}
  for (const key of Object.keys(value).sort())
    out[key] = stableValue(value[key])
  return out
}
