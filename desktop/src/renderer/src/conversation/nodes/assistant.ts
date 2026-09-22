// Per-step assistant Definition: streamed chunks fold into blocks,
// `assistant/message` finalizes, a retry/fallback discards the failed
// attempt's partial output, and a step or turn that closes without a message
// freezes the partial as interrupted.
import type { TokenUsage } from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationMatch,
  ConversationNodeContext,
} from '../assembler'
import {
  compactBlocks,
  foldChunk,
  hasVisibleContent,
  isAppendSurfaceEvent,
  isEvent,
  isTokenDelta,
  toAssistantBlocks,
} from '../events'
import type { AssistantBlock, AssistantChatData } from '../types'
import {
  CHAT_SYNTHETIC_SEQ_OFFSETS,
  chatNode,
  closedBoundary,
  contextLocation,
} from './common'

interface AssistantState {
  readonly turn: number
  readonly step: number
  readonly stepStartTime: number | null
  readonly blocks: readonly (AssistantBlock | undefined)[]
  readonly firstVisibleSeq: number | undefined
  readonly firstVisibleTime: number | undefined
  readonly firstTokenTime: number | undefined
  readonly final: ConversationMatch | undefined
  readonly usage: TokenUsage | undefined
}

function initialState(
  turn: number,
  step: number,
  stepStartTime: number | null,
): AssistantState {
  return {
    turn,
    step,
    stepStartTime,
    blocks: [],
    firstVisibleSeq: undefined,
    firstVisibleTime: undefined,
    firstTokenTime: undefined,
    final: undefined,
    usage: undefined,
  }
}

/** A failed attempt's partial output never belongs to the settled step. */
function resetForRetry(state: AssistantState): AssistantState {
  return {
    ...initialState(state.turn, state.step, state.stepStartTime),
    firstTokenTime: state.firstTokenTime,
  }
}

function applyMatch(
  state: AssistantState,
  match: ConversationMatch,
): AssistantState {
  const event = match.event
  if (isEvent(event, 'assistant/chunk')) {
    const chunk = event.data.chunk
    if (chunk.type === 'usage') return { ...state, usage: chunk.usage }
    const blocks = foldChunk(state.blocks, chunk)
    if (blocks === state.blocks) return state
    const visible =
      state.firstVisibleSeq === undefined &&
      hasVisibleContent(compactBlocks(blocks))
    return {
      ...state,
      blocks,
      ...(visible
        ? { firstVisibleSeq: event.seq, firstVisibleTime: event.time }
        : {}),
      ...(isTokenDelta(chunk) && state.firstTokenTime === undefined
        ? { firstTokenTime: event.time }
        : {}),
    }
  }
  if (isEvent(event, 'assistant/message')) {
    return {
      ...state,
      blocks: toAssistantBlocks(event.data.message.content),
      final: match,
      usage: event.data.usage ?? state.usage,
    }
  }
  if (isEvent(event, 'llm/retry') || isEvent(event, 'llm/fallback'))
    return resetForRetry(state)
  return state
}

function fallbackState(
  context: ConversationNodeContext<AssistantState>,
): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    const data = match.event.data as { turn?: number; step?: number }
    if (data.turn === undefined || data.step === undefined) continue
    state ??= initialState(data.turn, data.step, null)
    state = applyMatch(state, match)
  }
  return state
}

function project(
  context: ConversationNodeContext<AssistantState>,
  state: AssistantState,
): { data: AssistantChatData; anchorSeq: number; visible: boolean } {
  const final = state.final
  if (final !== undefined && isEvent(final.event, 'assistant/message')) {
    const event = final.event
    const blocks = compactBlocks(state.blocks)
    const interrupted = event.data.interrupted === true
    const source = event.data.message.source
    return {
      anchorSeq: event.seq,
      visible: hasVisibleContent(blocks),
      data: {
        status: interrupted ? 'interrupted' : 'settled',
        turn: state.turn,
        step: state.step,
        blocks,
        time: event.time,
        messageId: String(event.data.message.id),
        provenance: { provider: source.provider, model: source.model },
        timing: {
          stepStartTime: state.stepStartTime,
          firstTokenTime: state.firstTokenTime ?? null,
          completedTime: event.time,
        },
        ...(state.usage === undefined ? {} : { usage: state.usage }),
      },
    }
  }
  const blocks = compactBlocks(state.blocks)
  const visible = hasVisibleContent(blocks)
  const boundary = closedBoundary(
    context.start?.location ?? context.matches.at(-1)?.location,
  )
  if (boundary !== undefined) {
    return {
      anchorSeq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
      visible,
      data: {
        status: 'interrupted',
        turn: state.turn,
        step: state.step,
        blocks,
        time: boundary.time,
        timing: {
          stepStartTime: state.stepStartTime,
          firstTokenTime: state.firstTokenTime ?? null,
          completedTime: boundary.time,
        },
        ...(state.usage === undefined ? {} : { usage: state.usage }),
      },
    }
  }
  const first = context.matches[0]?.event
  return {
    anchorSeq: state.firstVisibleSeq ?? first?.seq ?? 0,
    visible,
    data: {
      status: 'running',
      turn: state.turn,
      step: state.step,
      blocks,
      time: state.firstVisibleTime ?? first?.time ?? 0,
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    },
  }
}

export const assistantDefinition: ConversationDefinition<AssistantState> = {
  kind: 'assistant',
  target: 'chat',
  match: (event) => {
    if (isEvent(event, 'step/start'))
      return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (
      isEvent(event, 'assistant/chunk') ||
      (isEvent(event, 'assistant/message') && isAppendSurfaceEvent(event)) ||
      isEvent(event, 'llm/retry') ||
      isEvent(event, 'llm/fallback')
    ) {
      const data = event.data as { turn: number; step: number }
      return { id: `${data.turn}:${data.step}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (!isEvent(match.event, 'step/start'))
      throw new Error('assistant start requires step/start')
    return initialState(
      match.event.data.turn,
      match.event.data.step,
      match.event.time,
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
    const projected = project(context, state)
    const interruptedWithEvidence =
      projected.data.status === 'interrupted' &&
      projected.data.blocks.some(
        (block) =>
          (block.kind !== 'text' && block.kind !== 'reasoning') ||
          block.text.trim() !== '',
      )
    return chatNode(context, 'assistant', projected.anchorSeq, projected.data, {
      location: contextLocation(context),
      visibility:
        projected.visible || interruptedWithEvidence ? 'visible' : 'hidden',
    })
  },
}
