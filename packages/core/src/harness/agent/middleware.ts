/**
 * Kernel extension points. Each dsh Cordis waterfall/serial event becomes
 * one ordered array; subsystems (compaction, plan mode, goals, hooks,
 * retry, subagent report) push their handler at construction time.
 */

import type { LlmCallConfig } from '../../llm/call-config'
import type { UserMessage } from '../../llm/message'
import type { ResolvedRetryPolicy } from '../../llm/retry-policy'
import type { LlmFailure } from '../../llm/types'
import type { Agent } from './agent'

export type PreStepDecision =
  { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }

export interface PreStepInput {
  readonly agent: Agent
  /** Messages entering this step so far (claimed inbox + runtime context + earlier middleware). */
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/**
 * Runs before each step. Return `undefined` to pass, a new `enter` to
 * replace the entering messages, or `reject` to end the turn as blocked.
 */
export type PreStepMiddleware = (
  input: PreStepInput,
) => Promise<PreStepDecision | undefined> | PreStepDecision | undefined

export interface RequestConfigInput {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly config: LlmCallConfig
}

/** May replace the proposed request config (e.g. a per-session model override). */
export type RequestConfigMiddleware = (
  input: RequestConfigInput,
) => LlmCallConfig | undefined

export interface RequestErrorInput {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: LlmFailure
  readonly retryPolicy: ResolvedRetryPolicy | undefined
  readonly signal: AbortSignal
}

/** Return `'retry'` to re-request inside the same step; the first retry wins. */
export type RequestErrorMiddleware = (
  input: RequestErrorInput,
) => Promise<'retry' | undefined> | 'retry' | undefined

export interface TurnStoppingInput {
  readonly agent: Agent
  readonly turn: number
  readonly signal: AbortSignal
}

/**
 * Runs serially when a turn could stop. A handler may `agent.steer()` a
 * message to force another step (Stop hooks, goal rounds, reminders).
 */
export type TurnStoppingMiddleware = (
  input: TurnStoppingInput,
) => Promise<void> | void

export interface AgentMiddleware {
  preStep: PreStepMiddleware[]
  requestConfig: RequestConfigMiddleware[]
  requestError: RequestErrorMiddleware[]
  turnStopping: TurnStoppingMiddleware[]
}

export function createMiddleware(): AgentMiddleware {
  return { preStep: [], requestConfig: [], requestError: [], turnStopping: [] }
}
