import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { nowIsoUtc8 } from '../memory/time-utc8'

export type TurnCheckpointPhase =
  | 'user_received'
  | 'context_built'
  | 'model_called'
  | 'tool_calls_pending'
  | 'tool_calls_running'
  | 'tool_calls_completed'
  | 'assistant_response_pending'
  | 'history_commit_pending'
  | 'committed'
  | 'aborted'

export interface TurnCheckpointToolCall {
  toolCallId: string
  toolName: string
  argsHash: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export interface TurnCheckpoint {
  schemaVersion: 'emperor.turn-checkpoint.v1'
  sessionId: string
  turnId: string
  baseHistorySeq: number
  createdAt: string
  updatedAt: string
  phase: TurnCheckpointPhase
  contextPlanId?: string
  promptSnapshotId?: string
  pendingToolCalls?: TurnCheckpointToolCall[]
  partialMessages: Array<Record<string, unknown>>
  committedHistorySeq?: number
  legacy?: boolean
}

export interface CheckpointWriteOptions {
  sessionId?: string | null
  turnId?: string | null
  baseHistorySeq?: number | null
  phase?: TurnCheckpointPhase | null
  contextPlanId?: string | null
  promptSnapshotId?: string | null
  pendingToolCalls?: TurnCheckpointToolCall[] | null
  committedHistorySeq?: number | null
}

export interface CheckpointReadOptions {
  sessionId?: string | null
  lastHistorySeq?: number | null
}

export interface CheckpointReadResult {
  exists: boolean
  recoverable: boolean
  reason: string
  checkpoint: TurnCheckpoint | null
  legacy: boolean
}

export function writeTurnCheckpoint(path: string, history: Array<Record<string, unknown>>, opts: CheckpointWriteOptions = {}): TurnCheckpoint {
  const now = nowIsoUtc8()
  const partialMessages = jsonSafeArray(history)
  const checkpoint: TurnCheckpoint = {
    schemaVersion: 'emperor.turn-checkpoint.v1',
    sessionId: cleanString(opts.sessionId) || 'unknown',
    turnId: cleanString(opts.turnId) || inferTurnId(partialMessages),
    baseHistorySeq: nonNegativeInt(opts.baseHistorySeq),
    createdAt: now,
    updatedAt: now,
    phase: opts.phase ?? 'tool_calls_pending',
    partialMessages,
  }
  if (opts.contextPlanId) checkpoint.contextPlanId = String(opts.contextPlanId)
  if (opts.promptSnapshotId) checkpoint.promptSnapshotId = String(opts.promptSnapshotId)
  if (opts.pendingToolCalls?.length) checkpoint.pendingToolCalls = opts.pendingToolCalls.map((call) => ({ ...call }))
  if (opts.committedHistorySeq !== undefined && opts.committedHistorySeq !== null) checkpoint.committedHistorySeq = nonNegativeInt(opts.committedHistorySeq)

  mkdirSync(dirname(path), { recursive: true })
  const tmp = path.replace(/\.json$/, '') + '.json.tmp'
  writeFileSync(tmp, JSON.stringify({ ...checkpoint, history: partialMessages }, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
  return checkpoint
}

export function readTurnCheckpoint(path: string, opts: CheckpointReadOptions = {}): CheckpointReadResult {
  if (!existsSync(path)) return { exists: false, recoverable: false, reason: 'missing', checkpoint: null, legacy: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8') || '{}')
  } catch (exc) {
    return { exists: true, recoverable: false, reason: `corrupt:${exc instanceof Error ? exc.message : String(exc)}`, checkpoint: null, legacy: false }
  }
  const checkpoint = normalizeCheckpoint(parsed, opts)
  if (!checkpoint) return { exists: true, recoverable: false, reason: 'unsupported_checkpoint_shape', checkpoint: null, legacy: false }
  const reason = recoveryBlockReason(checkpoint, { lastSeq: nonNegativeInt(opts.lastHistorySeq) })
  return {
    exists: true,
    recoverable: reason === null,
    reason: reason ?? 'recoverable',
    checkpoint,
    legacy: checkpoint.legacy === true,
  }
}

export function readRecoverableCheckpointHistory(path: string, opts: CheckpointReadOptions = {}): Array<Record<string, unknown>> | null {
  const result = readTurnCheckpoint(path, opts)
  return result.recoverable && result.checkpoint ? result.checkpoint.partialMessages : null
}

export function shouldRecoverFromCheckpoint(checkpoint: TurnCheckpoint, history: { lastSeq: number }): boolean {
  return recoveryBlockReason(checkpoint, history) === null
}

export function clearTurnCheckpoint(path: string): void {
  rmSync(path, { force: true })
}

function normalizeCheckpoint(value: unknown, opts: CheckpointReadOptions): TurnCheckpoint | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion === 'emperor.turn-checkpoint.v1') {
    const partialMessages = Array.isArray(value.partialMessages)
      ? jsonSafeArray(value.partialMessages as Array<Record<string, unknown>>)
      : Array.isArray(value.history)
        ? jsonSafeArray(value.history as Array<Record<string, unknown>>)
        : []
    return {
      schemaVersion: 'emperor.turn-checkpoint.v1',
      sessionId: cleanString(value.sessionId) || cleanString(opts.sessionId) || 'unknown',
      turnId: cleanString(value.turnId) || inferTurnId(partialMessages),
      baseHistorySeq: nonNegativeInt(value.baseHistorySeq),
      createdAt: cleanString(value.createdAt) || cleanString(value.ts) || '',
      updatedAt: cleanString(value.updatedAt) || cleanString(value.ts) || '',
      phase: normalizePhase(value.phase),
      contextPlanId: cleanString(value.contextPlanId) || undefined,
      promptSnapshotId: cleanString(value.promptSnapshotId) || undefined,
      pendingToolCalls: normalizePendingToolCalls(value.pendingToolCalls),
      partialMessages,
      committedHistorySeq: value.committedHistorySeq === undefined || value.committedHistorySeq === null ? undefined : nonNegativeInt(value.committedHistorySeq),
      legacy: value.legacy === true,
    }
  }
  if (Array.isArray(value.history)) {
    const partialMessages = jsonSafeArray(value.history as Array<Record<string, unknown>>)
    return {
      schemaVersion: 'emperor.turn-checkpoint.v1',
      sessionId: cleanString(opts.sessionId) || 'legacy',
      turnId: inferTurnId(partialMessages),
      baseHistorySeq: 0,
      createdAt: cleanString(value.ts) || '',
      updatedAt: cleanString(value.ts) || '',
      phase: 'tool_calls_pending',
      partialMessages,
      legacy: true,
    }
  }
  return null
}

function recoveryBlockReason(checkpoint: TurnCheckpoint, history: { lastSeq: number }): string | null {
  if (checkpoint.phase === 'committed') return 'committed'
  if (checkpoint.phase === 'aborted') return 'aborted'
  if (checkpoint.baseHistorySeq > nonNegativeInt(history.lastSeq)) return 'stale_base_history'
  if (checkpoint.committedHistorySeq !== undefined) return 'already_committed'
  if (!checkpoint.partialMessages.length) return 'empty_partial_messages'
  return null
}

function inferTurnId(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const value = messages[i]?.turn_id ?? messages[i]?.turnId
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function normalizePhase(value: unknown): TurnCheckpointPhase {
  return PHASES.has(String(value)) ? String(value) as TurnCheckpointPhase : 'tool_calls_pending'
}

const PHASES = new Set<string>([
  'user_received',
  'context_built',
  'model_called',
  'tool_calls_pending',
  'tool_calls_running',
  'tool_calls_completed',
  'assistant_response_pending',
  'history_commit_pending',
  'committed',
  'aborted',
])

function normalizePendingToolCalls(value: unknown): TurnCheckpointToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls = value.filter(isRecord).map((call) => ({
    toolCallId: cleanString(call.toolCallId) || cleanString(call.tool_call_id),
    toolName: cleanString(call.toolName) || cleanString(call.tool_name),
    argsHash: cleanString(call.argsHash) || cleanString(call.args_hash),
    status: normalizeToolStatus(call.status),
  })).filter((call) => call.toolCallId || call.toolName || call.argsHash)
  return calls.length ? calls : undefined
}

function normalizeToolStatus(value: unknown): TurnCheckpointToolCall['status'] {
  if (value === 'pending' || value === 'running' || value === 'completed' || value === 'failed') return value
  return 'pending'
}

function nonNegativeInt(value: unknown): number {
  const n = Math.trunc(Number(value) || 0)
  return n > 0 ? n : 0
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function jsonSafeArray(value: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return value.map((item) => jsonSafe(item) as Record<string, unknown>)
}

function jsonSafe(obj: unknown): unknown {
  try {
    JSON.stringify(obj)
    return obj
  } catch {
    if (Array.isArray(obj)) return obj.map(jsonSafe)
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = jsonSafe(v)
      return out
    }
    return String(obj)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
