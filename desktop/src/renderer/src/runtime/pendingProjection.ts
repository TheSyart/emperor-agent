import type { PendingState } from '../types'
import type {
  ActionEffectDescriptor,
  ActionEffectTaskResult,
} from './actionEffect'

export interface PendingProjectionState {
  pending: PendingState
  version: number
}

export interface PendingEffect extends ActionEffectDescriptor {
  domain: 'pending'
  type: 'clear_after' | 'cancel_clear'
  version: number
  delayMs: number
}

export interface PendingEffectOutput {
  version: number
}

export type PendingProjectionAction =
  | {
      type: 'pending_set'
      label: string
      detail: string
      tone: PendingState['tone']
      autoClearMs: number
    }
  | {
      type: 'pending_effect_result'
      result: ActionEffectTaskResult<PendingEffect, PendingEffectOutput>
    }

export function createPendingProjectionState(): PendingProjectionState {
  return { pending: { label: '', detail: '' }, version: 0 }
}

export function reducePendingProjection(
  state: PendingProjectionState,
  action: PendingProjectionAction,
): { state: PendingProjectionState; effects: PendingEffect[] } {
  if (action.type === 'pending_set') {
    const version = state.version + 1
    const delayMs =
      action.label && action.autoClearMs > 0
        ? Math.max(1, Math.round(action.autoClearMs))
        : 0
    const effect: PendingEffect = {
      id: `pending:${version}:${delayMs ? 'clear' : 'cancel'}`,
      key: 'pending:clear-timer',
      domain: 'pending',
      type: delayMs ? 'clear_after' : 'cancel_clear',
      version,
      delayMs,
      ...(delayMs ? { timeoutMs: delayMs + 1_000 } : {}),
    }
    return {
      state: {
        version,
        pending: {
          label: action.label,
          detail: action.detail,
          tone: action.label ? action.tone : undefined,
        },
      },
      effects: [effect],
    }
  }

  const { result } = action
  if (
    result.status !== 'success' ||
    result.effect.type !== 'clear_after' ||
    result.effect.version !== state.version ||
    result.output?.version !== state.version
  )
    return { state, effects: [] }
  return {
    state: {
      version: state.version,
      pending: { label: '', detail: '' },
    },
    effects: [],
  }
}

export function executePendingEffect(
  effect: PendingEffect,
  signal: AbortSignal,
): PendingEffectOutput | Promise<PendingEffectOutput> {
  if (effect.type === 'cancel_clear') return { version: effect.version }
  return new Promise<PendingEffectOutput>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve({ version: effect.version })
    }, effect.delayMs)
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(): Error {
  const error = new Error('Pending timer cancelled')
  error.name = 'AbortError'
  return error
}
