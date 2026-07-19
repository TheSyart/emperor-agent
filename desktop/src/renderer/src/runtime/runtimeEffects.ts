import type { WsEvent } from '../types'
import type {
  ActionEffectDescriptor,
  ActionEffectTaskResult,
} from './actionEffect'

export interface RuntimeEffect extends ActionEffectDescriptor {
  domain: 'runtime'
  type: 'refresh_memory'
  sessionId: string
  eventSeq: number
}

export interface RuntimeEffectOutput {
  refreshed: boolean
}

export interface RuntimeEffectState {
  results: Array<{
    effectId: string
    status: string
    sessionId: string
    eventSeq: number
  }>
}

export type RuntimeEffectAction =
  | {
      type: 'runtime_event_committed'
      origin: 'live' | 'replay'
      sessionId: string
      event: WsEvent
    }
  | {
      type: 'runtime_effect_result'
      result: ActionEffectTaskResult<RuntimeEffect, RuntimeEffectOutput>
    }

export function createRuntimeEffectState(): RuntimeEffectState {
  return { results: [] }
}

export function reduceRuntimeEffects(
  state: RuntimeEffectState,
  action: RuntimeEffectAction,
): { state: RuntimeEffectState; effects: RuntimeEffect[] } {
  if (action.type === 'runtime_event_committed') {
    if (action.origin !== 'live' || action.event.event !== 'assistant_done')
      return { state, effects: [] }
    const seq = Math.max(0, Number(action.event.seq || 0))
    return {
      state,
      effects: [
        {
          id: `runtime:refresh-memory:${action.sessionId || 'none'}:${seq}`,
          key: `runtime:refresh-memory:${action.sessionId || 'none'}`,
          domain: 'runtime',
          type: 'refresh_memory',
          sessionId: action.sessionId,
          eventSeq: seq,
          timeoutMs: 10_000,
        },
      ],
    }
  }

  return {
    state: {
      results: [
        ...state.results,
        {
          effectId: action.result.effect.id,
          status: action.result.status,
          sessionId: action.result.effect.sessionId,
          eventSeq: action.result.effect.eventSeq,
        },
      ].slice(-32),
    },
    effects: [],
  }
}
