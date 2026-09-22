// Trajectory-owned assistant step lifecycle (ported from the dsh
// trajectory-assistant-definition): streamed chunks fold into blocks with
// full tool-call arguments, `assistant/message` finalizes, `llm/retry`
// (and Emperor's `llm/fallback`) restart the attempt while keeping usage and
// the retry facts, `llm/cost-cap` / `llm/fallback` become request notices,
// and a step that closes without a message materializes as interrupted.
import type { TokenUsage } from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationMatch,
  ConversationNodeContext,
} from '../../../conversation/assembler'
import {
  failureMessage,
  isAppendSurfaceEvent,
  isEvent,
  isTokenDelta,
} from '../../../conversation/events'
import type {
  TrajectoryAssistantBlock,
  TrajectoryAssistantNode,
  TrajectoryAssistantRequest,
  TrajectoryPartialAssistant,
  TrajectoryRequestNotice,
} from '../contract'
import {
  closedBoundaryOf,
  compactTrajectoryBlocks,
  foldTrajectoryChunk,
  hasInterruptionEvidence,
  hasVisibleTrajectoryContent,
  toTrajectoryBlocks,
  trajectoryNode,
} from './common'

interface RetryValue {
  readonly message: string
  readonly retry: number
  readonly maxRetries?: number
  readonly delayMs: number
}

interface AssistantState {
  readonly turn: number
  readonly step: number
  readonly startSeq: number
  readonly startTime: number
  readonly started: boolean
  readonly sawChunk: boolean
  readonly blocks: readonly (TrajectoryAssistantBlock | undefined)[]
  readonly firstVisibleSeq: number | undefined
  readonly firstTokenTime: number | undefined
  readonly final: ConversationMatch | undefined
  readonly usage: TokenUsage | undefined
  readonly retry: RetryValue | undefined
  readonly stepEnd: ConversationMatch | undefined
  readonly notices: readonly TrajectoryRequestNotice[]
}

function initialState(
  turn: number,
  step: number,
  startSeq: number,
  startTime: number,
  started: boolean,
): AssistantState {
  return {
    turn,
    step,
    startSeq,
    startTime,
    started,
    sawChunk: false,
    blocks: [],
    firstVisibleSeq: undefined,
    firstTokenTime: undefined,
    final: undefined,
    usage: undefined,
    retry: undefined,
    stepEnd: undefined,
    notices: [],
  }
}

function sumOptional(
  left: number | undefined,
  right: number | undefined,
): { value?: number } {
  return left === undefined && right === undefined
    ? {}
    : { value: (left ?? 0) + (right ?? 0) }
}

/** Usage chunks accumulate across attempts (a retry still spent tokens). */
function addUsage(
  current: TokenUsage | undefined,
  next: TokenUsage,
): TokenUsage {
  const cacheRead = sumOptional(current?.cacheReadTokens, next.cacheReadTokens)
  const cacheWrite = sumOptional(
    current?.cacheWriteTokens,
    next.cacheWriteTokens,
  )
  const reasoning = sumOptional(current?.reasoningTokens, next.reasoningTokens)
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    ...(cacheRead.value === undefined
      ? {}
      : { cacheReadTokens: cacheRead.value }),
    ...(cacheWrite.value === undefined
      ? {}
      : { cacheWriteTokens: cacheWrite.value }),
    ...(reasoning.value === undefined
      ? {}
      : { reasoningTokens: reasoning.value }),
  }
}

function restart(state: AssistantState): AssistantState {
  return {
    ...initialState(
      state.turn,
      state.step,
      state.startSeq,
      state.startTime,
      state.started,
    ),
    firstTokenTime: state.firstTokenTime,
    usage: state.usage,
    retry: state.retry,
    notices: state.notices,
  }
}

function applyMatch(
  state: AssistantState,
  match: ConversationMatch,
): AssistantState {
  const event = match.event
  if (isEvent(event, 'assistant/chunk')) {
    const chunk = event.data.chunk
    if (chunk.type === 'usage')
      return {
        ...state,
        sawChunk: true,
        usage: addUsage(state.usage, chunk.usage),
      }
    const blocks = foldTrajectoryChunk(state.blocks, chunk)
    const visible =
      state.firstVisibleSeq === undefined &&
      hasVisibleTrajectoryContent(compactTrajectoryBlocks(blocks))
    return {
      ...state,
      sawChunk: true,
      blocks,
      ...(visible ? { firstVisibleSeq: event.seq } : {}),
      ...(isTokenDelta(chunk) && state.firstTokenTime === undefined
        ? { firstTokenTime: event.time }
        : {}),
    }
  }
  if (isEvent(event, 'assistant/message')) {
    return {
      ...state,
      blocks: toTrajectoryBlocks(event.data.message.content),
      final: match,
      usage: state.usage ?? event.data.usage,
    }
  }
  if (isEvent(event, 'step/end')) return { ...state, stepEnd: match }
  if (isEvent(event, 'llm/retry')) {
    const data = event.data
    return restart({
      ...state,
      retry: {
        message: failureMessage(data.failure),
        retry: data.retry,
        ...(data.maxRetries === undefined
          ? {}
          : { maxRetries: data.maxRetries }),
        delayMs: data.delayMs,
      },
    })
  }
  if (isEvent(event, 'llm/fallback')) {
    const data = event.data
    return restart({
      ...state,
      notices: [
        ...state.notices,
        {
          kind: 'fallback',
          seq: event.seq,
          time: event.time,
          from: data.from,
          to: data.to,
          trigger: data.trigger,
          message: failureMessage(data.failure),
          code: data.failure.code,
        },
      ],
    })
  }
  if (isEvent(event, 'llm/cost-cap')) {
    const data = event.data
    return {
      ...state,
      notices: [
        ...state.notices,
        {
          kind: 'cost-cap',
          seq: event.seq,
          time: event.time,
          capUsdNanos: data.capUsdNanos,
          spentUsdNanos: data.spentUsdNanos,
          unpricedRoutes: data.unpricedRoutes ?? [],
        },
      ],
    }
  }
  return state
}

function closedBoundary(
  context: ConversationNodeContext<AssistantState>,
): { seq: number; time: number } | undefined {
  const stepEnd = context.state?.stepEnd?.event
  if (stepEnd !== undefined && isEvent(stepEnd, 'step/end')) return stepEnd
  return closedBoundaryOf(
    context.start?.location ?? context.matches.at(-1)?.location,
  )
}

function fallbackState(
  context: ConversationNodeContext<AssistantState>,
): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    const event = match.event
    const data = event.data as { turn?: unknown; step?: unknown }
    if (typeof data.turn !== 'number' || typeof data.step !== 'number') continue
    if (state === undefined) {
      if (isEvent(event, 'step/end')) continue
      state = initialState(data.turn, data.step, event.seq, event.time, false)
    }
    state = applyMatch(state, match)
  }
  return state
}

function finalNode(
  state: AssistantState,
  context: ConversationNodeContext<AssistantState>,
): TrajectoryAssistantNode | undefined {
  const final = state.final
  if (final !== undefined && isEvent(final.event, 'assistant/message')) {
    const event = final.event
    return {
      kind: 'assistant',
      seq: event.seq,
      messageId: String(event.data.message.id),
      time: event.time,
      turn: state.turn,
      step: state.step,
      blocks: toTrajectoryBlocks(event.data.message.content),
      ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
      provenance: {
        provider: event.data.message.source.provider,
        model: event.data.message.source.model,
      },
      timing: {
        stepStartTime: state.started ? state.startTime : null,
        firstTokenTime: state.firstTokenTime ?? null,
        completedTime: event.time,
      },
      ...(event.data.interrupted === true ? { interrupted: true } : {}),
    }
  }
  const boundary = closedBoundary(context)
  const blocks = compactTrajectoryBlocks(state.blocks)
  if (boundary === undefined || !hasInterruptionEvidence(blocks))
    return undefined
  return {
    kind: 'assistant',
    seq: boundary.seq - 0.9,
    time: boundary.time,
    turn: state.turn,
    step: state.step,
    blocks,
    interrupted: true,
  }
}

function assistantRequest(
  state: AssistantState,
  node: TrajectoryAssistantNode | undefined,
  boundary: { seq: number; time: number } | undefined,
): TrajectoryAssistantRequest | undefined {
  if (!state.started) return undefined
  const status =
    node !== undefined && node.interrupted !== true
      ? 'complete'
      : state.retry !== undefined || boundary !== undefined
        ? 'error'
        : 'running'
  const completedAt = node?.time ?? boundary?.time ?? null
  const firstTokenAt = state.firstTokenTime ?? null
  return {
    purpose: 'assistant',
    startSeq: state.startSeq,
    turn: state.turn,
    step: state.step,
    startedAt: state.startTime,
    completedAt,
    status,
    timing: {
      ttftMs:
        firstTokenAt === null
          ? null
          : Math.max(0, firstTokenAt - state.startTime),
      decodeMs:
        firstTokenAt === null || completedAt === null
          ? null
          : Math.max(0, completedAt - firstTokenAt),
    },
    ...(state.retry === undefined
      ? {}
      : {
          error: state.retry.message,
          retry: state.retry.retry,
          ...(state.retry.maxRetries === undefined
            ? {}
            : { maxRetries: state.retry.maxRetries }),
          retryDelayMs: state.retry.delayMs,
        }),
    ...(node?.messageId === undefined
      ? {}
      : {
          resultSeq: node.seq,
          ...(node.provenance === undefined
            ? {}
            : { provenance: node.provenance }),
        }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    ...(state.notices.length === 0 ? {} : { notices: state.notices }),
  }
}

/** Trajectory-owned assistant streaming, settlement, and request lifecycle. */
export const trajectoryAssistantDefinition: ConversationDefinition<AssistantState> =
  {
    kind: 'trajectory-assistant-step',
    target: 'trajectory',
    match: (event) => {
      if (isEvent(event, 'step/start'))
        return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
      if (
        isEvent(event, 'assistant/chunk') ||
        (isEvent(event, 'assistant/message') && isAppendSurfaceEvent(event)) ||
        isEvent(event, 'llm/retry') ||
        isEvent(event, 'llm/fallback') ||
        isEvent(event, 'llm/cost-cap') ||
        isEvent(event, 'step/end')
      ) {
        const data = event.data as { turn: number; step: number }
        return { id: `${data.turn}:${data.step}`, role: 'update' }
      }
      return null
    },
    start: (_context, match) => {
      if (!isEvent(match.event, 'step/start'))
        throw new Error('trajectory-assistant-step start requires step/start')
      return initialState(
        match.event.data.turn,
        match.event.data.step,
        match.event.seq,
        match.event.time,
        true,
      )
    },
    update: (context, match) => applyMatch(context.state, match),
    publication: (match) => {
      const event = match.event
      if (isEvent(event, 'step/start')) return 'none'
      if (!isEvent(event, 'assistant/chunk')) return 'immediate'
      const type = event.data.chunk.type
      return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame'
    },
    buildViewNode: (context) => {
      const state = context.state ?? fallbackState(context)
      if (state === undefined) return null
      const node = finalNode(state, context)
      const boundary = closedBoundary(context)
      const partial: TrajectoryPartialAssistant | null =
        node === undefined && boundary === undefined && state.sawChunk
          ? {
              turn: state.turn,
              step: state.step,
              blocks: compactTrajectoryBlocks(state.blocks),
            }
          : null
      const request = assistantRequest(state, node, boundary)
      if (node === undefined && partial === null && request === undefined)
        return null
      return trajectoryNode(context, state.startSeq, {
        kind: 'assistant',
        ...(node === undefined ? {} : { node }),
        partial,
        ...(request === undefined ? {} : { request }),
      })
    },
  }

interface TurnEndState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly error?: string
}

/** Turn endings (failed turns mark their last request as errored). */
export const trajectoryTurnEndDefinition: ConversationDefinition<TurnEndState> =
  {
    kind: 'trajectory-turn-end',
    target: 'trajectory',
    match: (event) =>
      isEvent(event, 'turn/end')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => {
      if (!isEvent(match.event, 'turn/end'))
        throw new Error('trajectory-turn-end start requires turn/end')
      const reason = match.event.data.reason
      return {
        turn: match.event.data.turn,
        seq: match.event.seq,
        time: match.event.time,
        ...(reason.kind === 'error'
          ? { error: failureMessage(reason.error) }
          : {}),
      }
    },
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state === undefined
        ? null
        : trajectoryNode(context, context.state.seq, {
            kind: 'turn-end',
            turn: context.state.turn,
            time: context.state.time,
            ...(context.state.error === undefined
              ? {}
              : { error: context.state.error }),
          }),
  }
