// Trajectory compaction requests and session boundaries (ported from the dsh
// trajectory-compaction-definition). Emperor's checkpoint is a replacement
// `user/message` (context producer `compaction`) logged inside the run; it
// links to the latest open compaction.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationMatch,
} from '../../../conversation/assembler'
import {
  isEvent,
  isReplacementSurfaceEvent,
} from '../../../conversation/events'
import type { TrajectoryCompactionRequest } from '../contract'
import { trajectoryNode } from './common'

interface CompactionState {
  readonly start: ConversationMatch
  readonly summary?: ConversationMatch
  readonly end?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

function isCheckpoint(event: WireSessionEvent): boolean {
  return (
    isEvent(event, 'user/message') &&
    isReplacementSurfaceEvent(event) &&
    event.data.source.kind === 'context' &&
    event.data.source.producer === 'compaction'
  )
}

function eventCompactionId(event: WireSessionEvent): string | undefined {
  if (
    !isEvent(event, 'compaction/start') &&
    !isEvent(event, 'compaction/summary') &&
    !isEvent(event, 'compaction/end')
  )
    return undefined
  const value: unknown = event.data.compactionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requestFromState(
  state: CompactionState,
): TrajectoryCompactionRequest | undefined {
  const start = state.start.event
  if (!isEvent(start, 'compaction/start')) return undefined
  const summary = state.summary?.event
  const end = state.end?.event
  const checkpoint = state.checkpoint?.event
  const ended = end !== undefined && isEvent(end, 'compaction/end')
  const summarized =
    summary !== undefined && isEvent(summary, 'compaction/summary')
  const completedAt = ended ? end.time : null
  const error = ended ? end.data.error : undefined
  return {
    purpose: 'compaction',
    compactionId: start.data.compactionId,
    startSeq: start.seq,
    turn: start.data.turn,
    step: 0,
    startedAt: start.time,
    completedAt,
    status: !ended ? 'running' : error === undefined ? 'complete' : 'error',
    timing: {
      ttftMs: null,
      decodeMs: null,
    },
    ...(error === undefined ? {} : { error }),
    ...(!summarized
      ? {}
      : {
          resultSeq: summary.seq,
          summary: summary.data.summary,
          provenance: {
            provider: summary.data.provider,
            model: summary.data.model,
          },
          requestConfig: {
            provider: summary.data.provider,
            model: summary.data.model,
            purpose: 'compaction' as const,
            ...(summary.data.maxTokens === undefined
              ? {}
              : { maxTokens: summary.data.maxTokens }),
          },
          ...(summary.data.usage === undefined
            ? {}
            : { usage: summary.data.usage }),
        }),
    ...(checkpoint === undefined ? {} : { replacementSeq: checkpoint.seq }),
  }
}

export const trajectoryCompactionDefinition: ConversationDefinition<CompactionState> =
  {
    kind: 'trajectory-compaction',
    target: 'trajectory',
    links: (event) =>
      isEvent(event, 'compaction/start')
        ? [{ ns: 'open', key: 'compaction', id: event.data.compactionId }]
        : [],
    match: (event) => {
      const id = eventCompactionId(event)
      if (id !== undefined)
        return {
          id,
          role: event.type === 'compaction/start' ? 'start' : 'update',
        }
      return isCheckpoint(event)
        ? { via: { ns: 'open', key: 'compaction' }, role: 'update' }
        : null
    },
    start: (_context, match) => {
      if (!isEvent(match.event, 'compaction/start'))
        throw new Error('trajectory-compaction start requires compaction/start')
      return { start: match }
    },
    update: (context, match) => {
      const event = match.event
      if (isEvent(event, 'compaction/summary'))
        return { ...context.state, summary: match }
      if (isEvent(event, 'compaction/end'))
        return { ...context.state, end: match }
      return isCheckpoint(event) && context.state.checkpoint === undefined
        ? { ...context.state, checkpoint: match }
        : context.state
    },
    buildViewNode: (context) => {
      if (context.state === undefined) return null
      const request = requestFromState(context.state)
      return request === undefined
        ? null
        : trajectoryNode(context, request.startSeq, {
            kind: 'compaction',
            request,
          })
    },
  }

interface SessionEndState {
  readonly seq: number
  readonly time: number
}

/** Fork seed boundary: interrupts compactions still running before it. */
export const trajectorySessionEndDefinition: ConversationDefinition<SessionEndState> =
  {
    kind: 'trajectory-session-end',
    target: 'trajectory',
    match: (event) =>
      event.type === 'session/end-seed'
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => ({
      seq: match.event.seq,
      time: match.event.time,
    }),
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state === undefined
        ? null
        : trajectoryNode(context, context.state.seq, {
            kind: 'session-end',
            seq: context.state.seq,
            time: context.state.time,
          }),
  }
