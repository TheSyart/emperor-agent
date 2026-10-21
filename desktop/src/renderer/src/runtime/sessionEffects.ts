import { CORE_BRIDGE_UNAVAILABLE_MESSAGE } from '../api/backend'
import type { SessionEffect, SessionEffectOutput } from './sessionProjection'

export interface SessionEffectExecutorOptions {
  isAvailable: () => boolean
  subscribe: (listener: (event: unknown) => void) => () => void
  onEvent: (event: unknown) => void
}

export class SessionEffectExecutor {
  private unsubscribe: (() => void) | null = null

  constructor(private readonly options: SessionEffectExecutorOptions) {}

  execute(effect: SessionEffect, signal: AbortSignal): SessionEffectOutput {
    if (signal.aborted) throw abortError()
    if (!this.options.isAvailable())
      throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
    if (effect.replace && this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    const reused = Boolean(this.unsubscribe)
    if (!this.unsubscribe)
      this.unsubscribe = this.options.subscribe((event) => {
        if (!signal.aborted) this.options.onEvent(event)
      })
    return { generation: effect.generation, connected: true, reused }
  }

  close(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}

function abortError(): Error {
  const error = new Error('Session subscription cancelled')
  error.name = 'AbortError'
  return error
}
