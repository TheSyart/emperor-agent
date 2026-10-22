/**
 * Kernel extension points. Each dsh Cordis waterfall/serial event becomes
 * one ordered array; subsystems (compaction, plan mode, goals, hooks,
 * retry, subagent report) push their handler at construction time.
 */

import type { LlmCallConfig } from '../../llm/call-config'
import type { UserMessage } from '../../llm/message'
import type { ResolvedRetryPolicy } from '../../llm/retry-policy'
import type { LlmFailure, TokenUsage } from '../../llm/types'
import type { TurnBudgetReason } from '../../session-log/types'
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

export interface RequestEndInput {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  /** The route (model entry id) the request went to. */
  readonly provider: string
  /** What the provider reported for this attempt; undefined when nothing. */
  readonly usage: TokenUsage | undefined
  /** `failed`: the attempt ended in an error (it may be retried). */
  readonly attempt: 'ok' | 'failed'
}

/**
 * Runs after every model request returned, a failed attempt included,
 * before the step goes on (the task budget charges its usage, KRN-03).
 */
export type RequestEndMiddleware = (input: RequestEndInput) => void

export interface BudgetInput {
  readonly agent: Agent
  readonly turn: number
  /** The step about to start (1 for the turn's first). */
  readonly step: number
}

/** A spent budget ends the turn before `step` (KRN-03). */
export interface BudgetStop {
  readonly reason: TurnBudgetReason
  /** Logged before `turn/end`, so the model reads why with its next request. */
  readonly notice?: UserMessage
}

/**
 * Runs before each step, before its messages are claimed. Return a stop to
 * end the turn there (`turn/end` reason `budget`); the first stop wins.
 */
export type BudgetMiddleware = (input: BudgetInput) => BudgetStop | undefined

/** What a pre-assemble hook sees: the agent, its position and the step's signal. */
export interface PreAssembleInput {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/**
 * Runs before each step's prompt (system prompt and tool list) is
 * assembled: resources the step's tools depend on are made ready here, such
 * as the project MCP instance of the agent's session (KRN-01).
 */
export type PreAssembleMiddleware = (input: PreAssembleInput) => Promise<void>

export interface AgentMiddleware {
  preAssemble: PreAssembleMiddleware[]
  preStep: PreStepMiddleware[]
  requestConfig: RequestConfigMiddleware[]
  requestError: RequestErrorMiddleware[]
  requestEnd: RequestEndMiddleware[]
  budget: BudgetMiddleware[]
  turnStopping: TurnStoppingMiddleware[]
}

export function createMiddleware(): AgentMiddleware {
  return {
    preAssemble: [],
    preStep: [],
    requestConfig: [],
    requestError: [],
    requestEnd: [],
    budget: [],
    turnStopping: [],
  }
}
