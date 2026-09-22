// Retry, fallback, turn-level notices (error, max-tokens, cost cap), hooks
// and goal mutations.
import type { ConversationDefinition, ConversationMatch } from '../assembler'
import { failureMessage, isEvent } from '../events'
import type {
  CostCapChatData,
  FallbackChatData,
  GoalChatData,
  HookChatData,
  RetryAttemptView,
  RetryChatData,
  TurnErrorChatData,
  TurnMaxTokensChatData,
} from '../types'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode, closedBoundary } from './common'

interface RetryState {
  readonly turn: number
  readonly step: number
  readonly attempts: readonly RetryAttemptView[]
}

function attemptOf(match: ConversationMatch): RetryAttemptView | undefined {
  const event = match.event
  if (!isEvent(event, 'llm/retry')) return undefined
  const data = event.data
  return {
    retryId: data.retryId,
    seq: event.seq,
    time: event.time,
    retry: data.retry,
    delayMs: data.delayMs,
    provider: data.provider,
    message: failureMessage(data.failure),
    code: data.failure.code,
    state: 'scheduled',
    ...(data.maxRetries === undefined ? {} : { maxRetries: data.maxRetries }),
  }
}

/**
 * One step's retry chain on one provider. The kernel mints a retryId per
 * attempt, so attempts group by (turn, step, provider) and
 * `llm/retry-started` links back through its retryId.
 */
export const retryDefinition: ConversationDefinition<RetryState> = {
  kind: 'retry',
  target: 'chat',
  links: (event) => {
    if (!isEvent(event, 'llm/retry')) return []
    const data = event.data
    return [
      {
        ns: 'attempt',
        key: data.retryId,
        id: `${data.turn}:${data.step}:${data.provider}`,
      },
    ]
  },
  match: (event) => {
    if (isEvent(event, 'llm/retry')) {
      const data = event.data
      return {
        id: `${data.turn}:${data.step}:${data.provider}`,
        role: data.retry === 1 ? 'start' : 'update',
      }
    }
    if (isEvent(event, 'llm/retry-started'))
      return { via: { ns: 'attempt', key: event.data.retryId }, role: 'update' }
    return null
  },
  start: (_context, match) => {
    const attempt = attemptOf(match)
    if (attempt === undefined || !isEvent(match.event, 'llm/retry'))
      throw new Error('retry start requires llm/retry')
    return {
      turn: match.event.data.turn,
      step: match.event.data.step,
      attempts: [attempt],
    }
  },
  update: (context, match) => {
    const attempt = attemptOf(match)
    if (attempt !== undefined)
      return {
        ...context.state,
        attempts: [...context.state.attempts, attempt],
      }
    if (!isEvent(match.event, 'llm/retry-started')) return context.state
    const retryId = match.event.data.retryId
    return {
      ...context.state,
      attempts: context.state.attempts.map((item) =>
        item.retryId === retryId ? { ...item, state: 'started' } : item,
      ),
    }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined || state.attempts.length === 0) return null
    const closed = closedBoundary(context.start?.location) !== undefined
    const attempts = state.attempts.map((attempt, index) =>
      closed &&
      index === state.attempts.length - 1 &&
      attempt.state === 'scheduled'
        ? { ...attempt, state: 'cancelled' as const }
        : attempt,
    )
    const current = attempts.at(-1) as RetryAttemptView
    const data: RetryChatData = {
      turn: state.turn,
      step: state.step,
      attempts,
      current,
    }
    return chatNode(context, 'retry', attempts[0]?.seq ?? current.seq, data)
  },
}

/** Model-policy fallback: the rest of the turn uses another route. */
export const fallbackDefinition: ConversationDefinition<FallbackChatData> = {
  kind: 'fallback',
  target: 'chat',
  match: (event) =>
    isEvent(event, 'llm/fallback')
      ? { id: event.data.fallbackId, role: 'start' }
      : null,
  start: (_context, match) => {
    if (!isEvent(match.event, 'llm/fallback'))
      throw new Error('fallback start requires llm/fallback')
    const data = match.event.data
    return {
      turn: data.turn,
      step: data.step,
      from: data.from,
      to: data.to,
      trigger: data.trigger,
      message: failureMessage(data.failure),
      code: data.failure.code,
      time: match.event.time,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state === undefined || context.start === undefined
      ? null
      : chatNode(context, 'fallback', context.start.event.seq, context.state),
}

/** Terminal turn failure recorded on the turn's end reason. */
export const turnErrorDefinition: ConversationDefinition<TurnErrorChatData> = {
  kind: 'turnError',
  target: 'chat',
  match: (event) =>
    isEvent(event, 'turn/end') && event.data.reason.kind === 'error'
      ? { id: String(event.seq), role: 'start' }
      : null,
  start: (_context, match) => {
    const event = match.event
    if (!isEvent(event, 'turn/end') || event.data.reason.kind !== 'error')
      throw new Error('turnError start requires an error turn/end')
    const failure = event.data.reason.error
    return {
      turn: event.data.turn,
      seq: event.seq,
      time: event.time,
      message: failureMessage(failure),
      code: failure.code,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state === undefined
      ? null
      : chatNode(
          context,
          'turnError',
          context.state.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.turnNotice,
          context.state,
        ),
}

/** Notice for a turn the provider ended at its output-token cap. */
export const turnMaxTokensDefinition: ConversationDefinition<TurnMaxTokensChatData> =
  {
    kind: 'turnMaxTokens',
    target: 'chat',
    match: (event) =>
      isEvent(event, 'turn/end') && event.data.reason.kind === 'max-tokens'
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match) => {
      if (!isEvent(match.event, 'turn/end'))
        throw new Error('turnMaxTokens start requires turn/end')
      return {
        turn: match.event.data.turn,
        seq: match.event.seq,
        time: match.event.time,
      }
    },
    update: (context) => context.state,
    buildViewNode: (context) =>
      context.state === undefined
        ? null
        : chatNode(
            context,
            'turnMaxTokens',
            context.state.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.turnNotice,
            context.state,
          ),
  }

/** The per-turn cost cap stopped the turn. */
export const costCapDefinition: ConversationDefinition<CostCapChatData> = {
  kind: 'costCap',
  target: 'chat',
  match: (event) =>
    isEvent(event, 'llm/cost-cap')
      ? { id: String(event.seq), role: 'start' }
      : null,
  start: (_context, match) => {
    if (!isEvent(match.event, 'llm/cost-cap'))
      throw new Error('costCap start requires llm/cost-cap')
    const data = match.event.data
    return {
      turn: data.turn,
      step: data.step,
      time: match.event.time,
      capUsdNanos: data.capUsdNanos,
      spentUsdNanos: data.spentUsdNanos,
      unpricedRoutes: data.unpricedRoutes ?? [],
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state === undefined || context.start === undefined
      ? null
      : chatNode(context, 'costCap', context.start.event.seq, context.state),
}

/**
 * One hook invocation paired with its result. The kernel's handlerId is
 * process-local (it can repeat after a restart), so the invocation seq is
 * the identity and the result links back by the latest earlier handlerId.
 */
export const hookDefinition: ConversationDefinition<HookChatData> = {
  kind: 'hook',
  target: 'chat',
  links: (event) =>
    isEvent(event, 'hook/invoked')
      ? [{ ns: 'handler', key: event.data.handlerId, id: String(event.seq) }]
      : [],
  match: (event) => {
    if (isEvent(event, 'hook/invoked'))
      return { id: String(event.seq), role: 'start' }
    if (isEvent(event, 'hook/result'))
      return {
        via: { ns: 'handler', key: event.data.handlerId },
        role: 'update',
      }
    return null
  },
  start: (_context, match) => {
    if (!isEvent(match.event, 'hook/invoked'))
      throw new Error('hook start requires hook/invoked')
    const data = match.event.data
    return {
      turn: data.turn,
      point: data.point,
      dialect: data.dialect,
      handlerId: data.handlerId,
      status: 'running',
      time: match.event.time,
      ...(data.matcher === undefined ? {} : { matcher: data.matcher }),
    }
  },
  update: (context, match) => {
    if (!isEvent(match.event, 'hook/result')) return context.state
    const data = match.event.data
    return {
      ...context.state,
      status: 'done',
      decision: data.decision,
      durationMs: data.durationMs,
      ...(data.exitCode === undefined ? {} : { exitCode: data.exitCode }),
      ...(data.stderrSummary === undefined
        ? {}
        : { stderrSummary: data.stderrSummary }),
    }
  },
  buildViewNode: (context) =>
    context.state === undefined || context.start === undefined
      ? null
      : chatNode(context, 'hook', context.start.event.seq, context.state),
}

/** Goal mutations as inline rows. */
export const goalDefinition: ConversationDefinition<GoalChatData> = {
  kind: 'goal',
  target: 'chat',
  match: (event) =>
    isEvent(event, 'goal/change')
      ? { id: String(event.seq), role: 'start' }
      : null,
  start: (_context, match) => {
    if (!isEvent(match.event, 'goal/change'))
      throw new Error('goal start requires goal/change')
    const data = match.event.data
    const base = {
      seq: match.event.seq,
      time: match.event.time,
      operation: data.operation,
    }
    if (data.operation === 'clear') {
      return {
        ...base,
        goalId: data.cleared.id,
        revision: data.cleared.revision,
      }
    }
    const goal = data.goal
    return {
      ...base,
      goalId: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: data.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined
        ? {}
        : { blockedReason: goal.blockedReason }),
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state === undefined
      ? null
      : chatNode(context, 'goal', context.state.seq, context.state),
}
