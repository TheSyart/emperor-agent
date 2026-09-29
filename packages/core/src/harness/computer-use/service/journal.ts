/**
 * OperationJournal (spec 00 §4.2, §5.7): tracks each GUI operation through
 * `prepared → dispatched → settled` and mirrors every step into the calling
 * agent's session log before anything is sent to a driver. After a restart
 * the status of an operation is folded from the log; nothing is replayed.
 */

import { randomUUID } from 'node:crypto'
import type { SessionEvent, SessionEventMap } from '../../../session-log/types'
import type {
  ActionOutcome,
  OperationState,
  RedactedUiAction,
  UiActionClass,
} from '../types'

/** The Computer Use event types (never surface events). */
export type UiEventType = Extract<keyof SessionEventMap, `ui/${string}`>

export type JournalAppend = <T extends UiEventType>(
  sessionId: string,
  type: T,
  data: SessionEventMap[T],
) => void

export interface OperationRecord {
  readonly operationId: string
  readonly callId: string
  readonly targetId: string
  readonly callerSessionId: string
  readonly ownerSessionId: string
  readonly action: RedactedUiAction
  readonly startedAt: number
  readonly controller: AbortController
  state: OperationState
  outcome?: ActionOutcome
  errorCode?: string
  afterRevision?: number
}

export interface OperationStatus {
  readonly operationId: string
  readonly callId?: string
  readonly targetId?: string
  readonly state: OperationState
  readonly outcome?: ActionOutcome
  readonly errorCode?: string
  readonly afterRevision?: number
}

export interface PrepareInput {
  readonly callId: string
  readonly targetId: string
  readonly callerSessionId: string
  readonly ownerSessionId: string
  readonly action: RedactedUiAction
  readonly expectedRevision: number
  readonly actionClass: UiActionClass
  readonly grantId?: string
  readonly autoApproved?: boolean
}

const RECENT_LIMIT = 256

export class OperationJournal {
  private readonly operations = new Map<string, OperationRecord>()
  private readonly byCall = new Map<string, string>()

  constructor(private readonly append: JournalAppend) {}

  prepare(input: PrepareInput): OperationRecord {
    const operationId = `op_${randomUUID()}`
    const record: OperationRecord = {
      operationId,
      callId: input.callId,
      targetId: input.targetId,
      callerSessionId: input.callerSessionId,
      ownerSessionId: input.ownerSessionId,
      action: input.action,
      startedAt: Date.now(),
      controller: new AbortController(),
      state: 'prepared',
    }
    this.operations.set(operationId, record)
    this.byCall.set(input.callId, operationId)
    this.trim()
    this.append(input.callerSessionId, 'ui/action-prepared', {
      operationId,
      callId: input.callId,
      targetId: input.targetId,
      action: input.action,
      expectedRevision: input.expectedRevision,
      actionClass: input.actionClass,
      ...(input.grantId === undefined ? {} : { grantId: input.grantId }),
    })
    if (input.autoApproved === true)
      this.append(input.callerSessionId, 'ui/auto-approved', {
        operationId,
        preset: 'computer-use-unrestricted',
        actionClass: input.actionClass,
      })
    return record
  }

  /** Journal "may have been sent" right before the first side effect. */
  dispatched(record: OperationRecord): void {
    if (record.state !== 'prepared') return
    record.state = 'dispatched'
    this.append(record.callerSessionId, 'ui/action-dispatched', {
      operationId: record.operationId,
    })
  }

  settle(
    record: OperationRecord,
    outcome: ActionOutcome,
    detail: { afterRevision?: number; errorCode?: string } = {},
  ): void {
    if (record.outcome !== undefined) return
    record.state = outcome
    record.outcome = outcome
    if (detail.afterRevision !== undefined)
      record.afterRevision = detail.afterRevision
    if (detail.errorCode !== undefined) record.errorCode = detail.errorCode
    this.append(record.callerSessionId, 'ui/action-settled', {
      operationId: record.operationId,
      outcome,
      ...(detail.afterRevision === undefined
        ? {}
        : { afterRevision: detail.afterRevision }),
      ...(detail.errorCode === undefined
        ? {}
        : { errorCode: detail.errorCode }),
    })
  }

  get(operationId: string): OperationRecord | undefined {
    return this.operations.get(operationId)
  }

  forCall(callId: string): OperationRecord | undefined {
    const id = this.byCall.get(callId)
    return id === undefined ? undefined : this.operations.get(id)
  }

  inFlight(): OperationRecord[] {
    return [...this.operations.values()].filter(
      (record) => record.outcome === undefined,
    )
  }

  private trim(): void {
    if (this.operations.size <= RECENT_LIMIT) return
    for (const [id, record] of this.operations) {
      if (this.operations.size <= RECENT_LIMIT) break
      if (record.outcome === undefined) continue
      this.operations.delete(id)
      if (this.byCall.get(record.callId) === id)
        this.byCall.delete(record.callId)
    }
  }
}

export function statusOf(record: OperationRecord): OperationStatus {
  return {
    operationId: record.operationId,
    callId: record.callId,
    targetId: record.targetId,
    state: record.state,
    ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    ...(record.afterRevision === undefined
      ? {}
      : { afterRevision: record.afterRevision }),
  }
}

/** Fold one operation's status from a session log (after a restart). */
export function statusFromLog(
  events: readonly SessionEvent[],
  query: { operationId?: string; callId?: string },
): OperationStatus | undefined {
  let found:
    | {
        operationId: string
        callId?: string
        targetId?: string
        state: OperationState
        outcome?: ActionOutcome
        errorCode?: string
        afterRevision?: number
      }
    | undefined
  for (const event of events) {
    if (event.type === 'ui/action-prepared') {
      if (
        event.data.operationId === query.operationId ||
        (query.callId !== undefined && event.data.callId === query.callId)
      )
        found = {
          operationId: event.data.operationId,
          callId: event.data.callId,
          targetId: event.data.targetId,
          state: 'prepared',
        }
    } else if (found !== undefined && event.type === 'ui/action-dispatched') {
      if (
        event.data.operationId === found.operationId &&
        found.outcome === undefined
      )
        found.state = 'dispatched'
    } else if (found !== undefined && event.type === 'ui/action-settled') {
      if (event.data.operationId === found.operationId) {
        found.state = event.data.outcome
        found.outcome = event.data.outcome
        if (event.data.errorCode !== undefined)
          found.errorCode = event.data.errorCode
        if (event.data.afterRevision !== undefined)
          found.afterRevision = event.data.afterRevision
      }
    }
  }
  return found
}
