// Compaction runs, completed-turn tails, and session facts (todos, request
// context) consumed by the chat snapshot builder.
import type {
  RequestContext,
  TodoItem,
  TokenUsage,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationMatch,
  ConversationNodeContext,
} from '../assembler'
import {
  contentText,
  isAppendSurfaceEvent,
  isEvent,
  isTokenDelta,
} from '../events'
import type { CompactionChatData, TurnTailChatData, TurnUsage } from '../types'
import { chatNode } from './common'

interface CompactionState {
  readonly data: CompactionChatData
}

/** One compaction run: start → summary → end (or error). */
export const compactionDefinition: ConversationDefinition<CompactionState> = {
  kind: 'compaction',
  target: 'chat',
  match: (event) => {
    if (
      isEvent(event, 'compaction/start') ||
      isEvent(event, 'compaction/summary') ||
      isEvent(event, 'compaction/end')
    ) {
      const id = event.data.compactionId
      if (typeof id !== 'string' || id === '') return null
      return {
        id,
        role: event.type === 'compaction/start' ? 'start' : 'update',
      }
    }
    return null
  },
  start: (_context, match) => {
    if (!isEvent(match.event, 'compaction/start'))
      throw new Error('compaction start requires compaction/start')
    const data = match.event.data
    return {
      data: {
        compactionId: data.compactionId,
        turn: data.turn,
        status: 'running',
        time: match.event.time,
        summary: null,
        shadowedItemCount: null,
        shadowedTokenCount: null,
        ...(data.sourceCommandId === undefined
          ? {}
          : { sourceCommandId: data.sourceCommandId }),
      },
    }
  },
  update: (context, match) => {
    const event = match.event
    const data = context.state.data
    if (isEvent(event, 'compaction/summary')) {
      const text = contentText(event.data.summary).trim()
      return {
        data: {
          ...data,
          summary: text === '' ? null : text,
          shadowedItemCount: event.data.shadowedSeqs.length,
          shadowedTokenCount: event.data.shadowedTokenCount,
        },
      }
    }
    if (isEvent(event, 'compaction/end')) {
      return {
        data: {
          ...data,
          status: event.data.error === undefined ? 'done' : 'error',
          ...(event.data.error === undefined
            ? {}
            : { error: event.data.error }),
        },
      }
    }
    return context.state
  },
  buildViewNode: (context) =>
    context.state === undefined || context.start === undefined
      ? null
      : chatNode(
          context,
          'compaction',
          context.start.event.seq,
          context.state.data,
        ),
}

interface StepReading {
  readonly startTime: number | null
  readonly firstTokenTime: number | null
  readonly completedTime: number | null
  readonly usage: TokenUsage | null
  readonly closingText: string | null
}

interface TurnTailState {
  readonly turn: number
  readonly startedAt: number | null
  readonly steps: ReadonlyMap<number, StepReading>
  readonly end: ConversationMatch | undefined
}

const EMPTY_READING: StepReading = {
  startTime: null,
  firstTokenTime: null,
  completedTime: null,
  usage: null,
  closingText: null,
}

function withStep(
  state: TurnTailState,
  step: number,
  update: (reading: StepReading) => StepReading,
): TurnTailState {
  const previous = state.steps.get(step) ?? EMPTY_READING
  const next = update(previous)
  if (next === previous) return state
  const steps = new Map(state.steps)
  steps.set(step, next)
  return { ...state, steps }
}

function turnOfEvent(event: WireSessionEvent): number | undefined {
  const turn = (event.data as { turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

function applyTail(
  state: TurnTailState,
  match: ConversationMatch,
): TurnTailState {
  const event = match.event
  if (isEvent(event, 'turn/end')) return { ...state, end: match }
  if (isEvent(event, 'step/start'))
    return withStep(state, event.data.step, (reading) => ({
      ...reading,
      startTime: event.time,
    }))
  if (isEvent(event, 'assistant/chunk')) {
    const chunk = event.data.chunk
    if (!isTokenDelta(chunk)) return state
    return withStep(state, event.data.step, (reading) =>
      reading.firstTokenTime === null
        ? { ...reading, firstTokenTime: event.time }
        : reading,
    )
  }
  if (isEvent(event, 'assistant/message')) {
    const text = contentText(event.data.message.content).trim()
    return withStep(state, event.data.step, (reading) => ({
      ...reading,
      completedTime: event.time,
      usage: event.data.usage ?? reading.usage,
      closingText: text === '' ? null : text,
    }))
  }
  return state
}

function sumUsage(readings: Iterable<StepReading>): TurnUsage {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  for (const reading of readings) {
    const usage = reading.usage
    if (usage === null) continue
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    total.reasoningTokens += usage.reasoningTokens ?? 0
  }
  return total
}

function tailData(state: TurnTailState): TurnTailChatData | null {
  const end = state.end?.event
  if (end === undefined || !isEvent(end, 'turn/end')) return null
  if (end.data.reason.kind !== 'completed') return null
  // No settled assistant step in the window: nothing to summarize.
  if (![...state.steps.values()].some((step) => step.completedTime !== null))
    return null
  const ordered = [...state.steps.entries()].sort(([a], [b]) => a - b)
  const first = ordered[0]?.[1]
  const ttftMs =
    first?.startTime != null && first.firstTokenTime !== null
      ? Math.max(0, first.firstTokenTime - first.startTime)
      : undefined
  let decodeMs = 0
  let outputTokens = 0
  let closingText: string | null = null
  let steps = 0
  for (const [, reading] of ordered) {
    if (reading.completedTime !== null) steps++
    if (reading.closingText !== null) closingText = reading.closingText
    if (
      reading.firstTokenTime !== null &&
      reading.completedTime !== null &&
      reading.usage !== null
    ) {
      decodeMs += Math.max(0, reading.completedTime - reading.firstTokenTime)
      outputTokens += reading.usage.outputTokens
    }
  }
  return {
    turn: state.turn,
    seq: end.seq,
    startedAt: state.startedAt,
    endedAt: end.time,
    usage: sumUsage(state.steps.values()),
    steps,
    closingText,
    ...(state.startedAt === null
      ? {}
      : { durationMs: Math.max(0, end.time - state.startedAt) }),
    ...(ttftMs === undefined ? {} : { ttftMs }),
    ...(decodeMs > 0
      ? { tokensPerSecond: outputTokens / (decodeMs / 1000) }
      : {}),
  }
}

function tailFallback(
  context: ConversationNodeContext<TurnTailState>,
): TurnTailState | undefined {
  const turn = Number(context.id)
  if (!Number.isFinite(turn)) return undefined
  let state: TurnTailState = {
    turn,
    startedAt: null,
    steps: new Map(),
    end: undefined,
  }
  for (const match of context.matches) state = applyTail(state, match)
  return state
}

/** Footer of a completed turn: duration, TTFT, tok/s, usage. */
export const turnTailDefinition: ConversationDefinition<TurnTailState> = {
  kind: 'turnTail',
  target: 'chat',
  match: (event) => {
    if (isEvent(event, 'turn/start'))
      return { id: String(event.data.turn), role: 'start' }
    if (
      event.type === 'turn/end' ||
      event.type === 'step/start' ||
      event.type === 'assistant/chunk' ||
      (event.type === 'assistant/message' && isAppendSurfaceEvent(event))
    ) {
      const turn = turnOfEvent(event)
      return turn === undefined ? null : { id: String(turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (!isEvent(match.event, 'turn/start'))
      throw new Error('turnTail start requires turn/start')
    return {
      turn: match.event.data.turn,
      startedAt: match.event.time,
      steps: new Map(),
      end: undefined,
    }
  },
  update: (context, match) => applyTail(context.state, match),
  publication: (match) =>
    match.event.type === 'turn/end' ? 'immediate' : 'none',
  buildViewNode: (context) => {
    const state = context.state ?? tailFallback(context)
    if (state?.end === undefined) return null
    const data = tailData(state)
    return data === null ? null : chatNode(context, 'turnTail', data.seq, data)
  },
}

/** Latest todo list (hidden fact consumed by the snapshot builder). */
export const todosFactDefinition: ConversationDefinition<readonly TodoItem[]> =
  {
    kind: 'fact:todos',
    target: 'chat',
    match: (event) =>
      isEvent(event, 'todo/write')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) =>
      isEvent(match.event, 'todo/write') ? match.event.data.todos : [],
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state === undefined || context.start === undefined
        ? null
        : {
            key: context.key,
            kind: 'fact:todos',
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            visibility: 'hidden',
            data: context.state,
          },
  }

/** Route/window of each request (hidden fact for context usage). */
export const requestContextFactDefinition: ConversationDefinition<RequestContext> =
  {
    kind: 'fact:request-context',
    target: 'chat',
    match: (event) =>
      isEvent(event, 'request/context')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => {
      if (!isEvent(match.event, 'request/context'))
        throw new Error('request-context start requires request/context')
      return match.event.data
    },
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state === undefined || context.start === undefined
        ? null
        : {
            key: context.key,
            kind: 'fact:request-context',
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            visibility: 'hidden',
            data: context.state,
          },
  }
