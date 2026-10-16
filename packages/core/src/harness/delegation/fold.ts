import { createHash } from 'node:crypto'
import {
  DelegationError,
  TERMINAL_RUN_PHASES,
  type DelegationRecord,
  type DelegationRunRecord,
  type RunPhase,
} from './types'
import type { JournalEntry } from '../../store/persistence'
export interface DelegationMessage {
  id: string
  text: string
  status: 'queued' | 'sending' | 'accepted' | 'delivery_unknown' | 'cancelled'
  seq?: number
  payloadDigest?: string
}
export interface DelegationNotice {
  id: string
  runId: string
  text: string
  delivered: boolean
}
export type DelegationEvent =
  | { type: 'dispatch-paused'; paused: boolean }
  | { type: 'workspace-bound'; leaseId: string; cwd: string }
  | { type: 'created'; record: DelegationRecord }
  | { type: 'message-enqueued'; message: DelegationMessage }
  | {
      type: 'message-delivery'
      messageId: string
      status: DelegationMessage['status']
    }
  | { type: 'run-created'; run: DelegationRunRecord }
  | {
      type: 'run-changed'
      runId: string
      patch: Partial<
        Pick<
          DelegationRunRecord,
          | 'phase'
          | 'recoveryResolved'
          | 'recoveryInspection'
          | 'quotaReserved'
          | 'process'
          | 'quiescent'
          | 'summary'
          | 'failureCode'
          | 'startedAt'
          | 'finishedAt'
          | 'acceptance'
          | 'receiptId'
          | 'usage'
          | 'structured'
        >
      >
    }
  | { type: 'send-intent'; runId: string; messageId: string }
  | {
      type: 'provider-bound'
      runId: string
      sessionId: string
      turnId: string
      generation: number
    }
  | { type: 'availability'; availability: DelegationRecord['availability'] }
  | {
      type: 'interaction'
      requestId: string
      runId: string
      generation: number
      state: 'pending' | 'answering' | 'answered' | 'cancelled'
      questions?: unknown
    }
  | { type: 'outbox'; notice: DelegationNotice }
  | { type: 'notice-delivered'; noticeId: string }
  | {
      type: 'receipt'
      runId: string
      receiptId: string
      acceptance: DelegationRunRecord['acceptance']
    }
  | { type: 'recovery'; reason: string }
export interface DelegationState {
  record?: DelegationRecord
  runs: Record<string, DelegationRunRecord>
  messages: Record<string, DelegationMessage>
  interactions: Record<
    string,
    Extract<DelegationEvent, { type: 'interaction' }>
  >
  outbox: Record<string, DelegationNotice>
  lastSeq: number
}
const transitions: Record<RunPhase, readonly RunPhase[]> = {
  queued: ['preparing', 'cancelled'],
  preparing: ['running', 'cancelling', 'failed', 'outcome_unknown'],
  running: [
    'waiting_input',
    'cancelling',
    'completed',
    'failed',
    'interrupted',
    'outcome_unknown',
  ],
  waiting_input: ['running', 'cancelling', 'interrupted', 'outcome_unknown'],
  cancelling: ['cancelled', 'completed', 'interrupted', 'outcome_unknown'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  outcome_unknown: [],
}
export function safeDelegationKey(id: string): void {
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 160 ||
    id.includes('/') ||
    id.includes('\\') ||
    ['__proto__', 'prototype', 'constructor'].includes(id)
  )
    throw new DelegationError('INVALID_ID', 'invalid delegation record key')
}
export function messageDigest(message: DelegationMessage): string {
  return createHash('sha256')
    .update(JSON.stringify([message.text, message.payloadDigest ?? '']))
    .digest('hex')
}
export class DelegationFold {
  private value: DelegationState = {
    runs: {},
    messages: {},
    interactions: {},
    outbox: {},
    lastSeq: 0,
  }
  get state(): DelegationState {
    return structuredClone(this.value)
  }
  apply(entry: JournalEntry<DelegationEvent>): DelegationState {
    if (entry.seq !== this.value.lastSeq + 1)
      throw new DelegationError(
        'JOURNAL_SEQUENCE',
        'non-contiguous delegation journal',
      )
    const next = structuredClone(this.value)
    const e = entry.payload
    if (e.type !== 'created' && !next.record)
      throw new DelegationError(
        'JOURNAL_CORRUPT',
        'delegation descriptor missing',
      )
    const requireRun = (id: string) => {
      safeDelegationKey(id)
      const r = next.runs[id]
      if (!r) throw new DelegationError('RUN_NOT_FOUND', 'run missing')
      return r
    }
    switch (e.type) {
      case 'dispatch-paused':
        next.record!.dispatchPaused = e.paused
        break
      case 'workspace-bound':
        if (!next.record)
          throw new DelegationError('JOURNAL_CORRUPT', 'descriptor missing')
        if (
          next.record.workspaceLeaseId &&
          next.record.workspaceLeaseId !== e.leaseId
        )
          throw new DelegationError(
            'WORKSPACE_CHANGED',
            'conversation workspace cannot change',
          )
        next.record.cwd = e.cwd
        next.record.workspaceLeaseId = e.leaseId
        break
      case 'created':
        if (next.record)
          throw new DelegationError(
            'IDEMPOTENCY_CONFLICT',
            'delegation already created',
          )
        if (e.record.schemaVersion !== 1 || !e.record.id.startsWith('dlg-'))
          throw new DelegationError(
            'JOURNAL_CORRUPT',
            'invalid delegation descriptor',
          )
        safeDelegationKey(e.record.id)
        next.record = structuredClone(e.record)
        break
      case 'message-enqueued': {
        safeDelegationKey(e.message.id)
        const previous = next.messages[e.message.id]
        if (previous && messageDigest(previous) !== messageDigest(e.message))
          throw new DelegationError(
            'IDEMPOTENCY_CONFLICT',
            'message id has different content',
          )
        next.messages[e.message.id] = { ...e.message, seq: entry.seq }
        break
      }
      case 'message-delivery': {
        const message = next.messages[e.messageId]
        if (!message)
          throw new DelegationError('MESSAGE_NOT_FOUND', 'message missing')
        message.status = e.status
        break
      }
      case 'run-created':
        safeDelegationKey(e.run.id)
        if (next.runs[e.run.id])
          throw new DelegationError(
            'IDEMPOTENCY_CONFLICT',
            'run already exists',
          )
        if (
          e.run.delegationId !== next.record!.id ||
          e.run.phase !== 'queued' ||
          e.run.revision !== 0
        )
          throw new DelegationError('JOURNAL_CORRUPT', 'invalid initial run')
        if (
          Object.values(next.runs).some(
            (r) => !TERMINAL_RUN_PHASES.has(r.phase),
          )
        )
          throw new DelegationError(
            'ACTIVE_RUN',
            'conversation already has an active run',
          )
        next.runs[e.run.id] = structuredClone(e.run)
        next.record!.currentRunId = e.run.id
        next.record!.availability = 'active'
        break
      case 'run-changed': {
        const run = requireRun(e.runId),
          phase = e.patch.phase
        if (
          phase &&
          phase !== run.phase &&
          !transitions[run.phase].includes(phase)
        )
          throw new DelegationError(
            'INVALID_TRANSITION',
            run.phase + ' -> ' + phase,
          )
        Object.assign(run, e.patch)
        run.revision++
        if (TERMINAL_RUN_PHASES.has(run.phase))
          next.record!.availability =
            run.phase === 'outcome_unknown' ? 'needs_recovery' : 'idle'
        break
      }
      case 'send-intent':
        requireRun(e.runId)
        if (next.messages[e.messageId])
          next.messages[e.messageId]!.status = 'sending'
        break
      case 'provider-bound': {
        const run = requireRun(e.runId)
        if (run.generation !== e.generation)
          throw new DelegationError('STALE_RUN', 'provider generation mismatch')
        if (
          next.record!.providerSessionId &&
          next.record!.providerSessionId !== e.sessionId
        )
          throw new DelegationError(
            'PROVIDER_SESSION_CHANGED',
            'resume returned a different conversation',
          )
        next.record!.providerSessionId = e.sessionId
        run.providerTurnId = e.turnId
        break
      }
      case 'availability':
        next.record!.availability = e.availability
        break
      case 'interaction':
        safeDelegationKey(e.requestId)
        requireRun(e.runId)
        next.interactions[e.requestId] = structuredClone(e)
        break
      case 'outbox':
        safeDelegationKey(e.notice.id)
        requireRun(e.notice.runId)
        next.outbox[e.notice.id] = structuredClone(e.notice)
        break
      case 'notice-delivered':
        if (!next.outbox[e.noticeId])
          throw new DelegationError('NOTICE_NOT_FOUND', 'notice missing')
        next.outbox[e.noticeId]!.delivered = true
        break
      case 'receipt': {
        const run = requireRun(e.runId)
        run.receiptId = e.receiptId
        run.acceptance = e.acceptance
        run.revision++
        break
      }
      case 'recovery':
        next.record!.availability = 'needs_recovery'
        break
      default:
        throw new DelegationError('JOURNAL_CORRUPT', 'unknown delegation event')
    }
    next.lastSeq = entry.seq
    this.value = next
    return this.state
  }
}
