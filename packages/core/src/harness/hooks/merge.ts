/**
 * Merge matched hooks into one most-restrictive outcome (ported from
 * dsh-hook-protocol merge.ts). Precedence `deny > ask > allow`; the first
 * `continue:false` is sticky; reasons of the winning rank are joined;
 * context and system messages accumulate in hook order.
 */

import type { HookOutput } from './types'

export type MergedDecision = 'allow' | 'ask' | 'deny' | 'none'

export interface MergedHookOutcome {
  /** `block`/`deny` fold to `deny`, `approve`/`allow` to `allow`; `none` when nobody decided. */
  decision: MergedDecision
  /** Reasons of the winning (deny/ask) rank, joined by a blank line. */
  reason?: string
  stop: boolean
  stopReason?: string
  additionalContext: string[]
  systemMessages: string[]
}

function rank(decision: HookOutput['decision']): number {
  switch (decision) {
    case 'deny':
    case 'block':
      return 3
    case 'ask':
      return 2
    case 'approve':
    case 'allow':
      return 1
    default:
      return 0
  }
}

function decisionForRank(maxRank: number): MergedDecision {
  switch (maxRank) {
    case 3:
      return 'deny'
    case 2:
      return 'ask'
    case 1:
      return 'allow'
    default:
      return 'none'
  }
}

export function mergeHookOutputs(
  outputs: readonly HookOutput[],
): MergedHookOutcome {
  let maxRank = 0
  const reasonsByRank = new Map<number, string[]>()
  let stop = false
  let stopReason: string | undefined
  const additionalContext: string[] = []
  const systemMessages: string[] = []

  for (const out of outputs) {
    const r = rank(out.decision)
    if (r > maxRank) maxRank = r
    if (r >= 2 && out.reason !== undefined && out.reason.length > 0) {
      const list = reasonsByRank.get(r) ?? []
      list.push(out.reason)
      reasonsByRank.set(r, list)
    }
    if (out.continue === false && !stop) {
      stop = true
      if (out.stopReason !== undefined) stopReason = out.stopReason
    }
    if (out.additionalContext !== undefined && out.additionalContext.length > 0)
      additionalContext.push(out.additionalContext)
    if (out.systemMessage !== undefined && out.systemMessage.length > 0)
      systemMessages.push(out.systemMessage)
  }

  const reasons = reasonsByRank.get(maxRank) ?? []
  return {
    decision: decisionForRank(maxRank),
    ...(reasons.length > 0 ? { reason: reasons.join('\n\n') } : {}),
    stop,
    ...(stopReason !== undefined ? { stopReason } : {}),
    additionalContext,
    systemMessages,
  }
}
