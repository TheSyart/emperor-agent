/** Request-header call configuration (pure; safe for any consumer). */

/** Provider, model, reasoning effort, and sampling scalars of one request header. */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** Config fields materialized from route defaults rather than the caller. */
export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

/** Field-wise equality over call configs (stop compared element-wise). */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider ||
    a.model !== b.model ||
    a.reasoningEffort !== b.reasoningEffort ||
    a.temperature !== b.temperature ||
    a.maxTokens !== b.maxTokens
  )
    return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return (
    a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
  )
}
