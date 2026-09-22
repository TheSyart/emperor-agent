/**
 * `ToolRegistry`: registered tools plus the execution pipeline
 * (ported from dsh-tools `ToolRuntime`, with ordered middleware arrays in
 * place of Cordis waterfalls).
 *
 * One call: validate arguments → pre-execute middleware (allow/ask/deny,
 * strongest wins) → approval when asked → guards (deny-only) → body under
 * its timeout → post-execute middleware (accept/replace/block) → content
 * finalizer → result observers. Every failure becomes an `isError` result
 * the model can read; nothing thrown by a tool reaches the loop.
 */

import { deepFreeze } from '../../llm/freeze'
import type { UserMessage } from '../../llm/message'
import type { ContentBlock, ToolSchema } from '../../llm/types'
import { snapshotJsonValue } from '../../session-log/json'
import type { JsonValue } from '../../session-log/json'
import { deadline, timeoutOf } from '../../util/timeout'
import type { Agent } from '../agent/agent'
import {
  normalizeToolReturn,
  TOOL_TIMEOUT,
  toolAbortedResult,
  toolErrorResult,
  ToolNotFoundError,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolRunContext,
} from './definition'

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export type PostToolDecision =
  | {
      kind: 'accept'
      content?: ContentBlock[]
      additionalContexts?: UserMessage[]
    }
  | {
      kind: 'block'
      feedback: ContentBlock[]
      additionalContexts?: UserMessage[]
    }

/** A pending call as middleware sees it. */
export interface ToolCallInfo {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  readonly signal: AbortSignal
}

export type PreExecuteMiddleware = (
  call: ToolCallInfo,
) => Promise<PreToolDecision | undefined> | PreToolDecision | undefined
export type PostExecuteMiddleware = (
  call: ToolCallInfo,
  result: ToolExecutionResult,
) => Promise<PostToolDecision | undefined> | PostToolDecision | undefined
/** Deny-only synchronous guard; return a reason to refuse. */
export type ToolGuard = (call: ToolCallInfo) => string | undefined
export type ToolResultObserver = (
  call: ToolCallInfo,
  result: ToolExecutionResult,
) => void
export type ApprovalOutcome =
  'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export type ApprovalHandler = (request: {
  agent: Agent
  toolName: string
  callId: string
  reason?: string
  signal: AbortSignal
}) => Promise<ApprovalOutcome>

/** Per-agent tool visibility. */
export interface ToolFilter {
  /** Only these names are visible (exact names). */
  allow?: readonly string[]
  /** These names are hidden. */
  deny?: readonly string[]
}

export type ScheduledPreparation =
  | { kind: 'dispatch'; context: ToolRunContext }
  | {
      kind: 'post-result'
      context: ToolRunContext
      result: ToolExecutionResult
    }
  | {
      kind: 'final-result'
      context: ToolRunContext
      result: ToolExecutionResult
    }

const RANK: Record<PreToolDecision['kind'], number> = {
  allow: 0,
  ask: 1,
  deny: 2,
}

interface CallState {
  definition: ToolDefinition | undefined
  deferred: UserMessage[]
  concludes: boolean
  bodyInvoked: boolean
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly visibility = new Map<
    string,
    (agent: Agent | undefined) => boolean
  >()
  readonly preExecute: PreExecuteMiddleware[] = []
  readonly postExecute: PostExecuteMiddleware[] = []
  readonly guards: ToolGuard[] = []
  readonly observers: ToolResultObserver[] = []
  private approval: ApprovalHandler | undefined
  private readonly states = new WeakMap<ToolRunContext, CallState>()

  /**
   * Register one tool. `visible` narrows which agents see it (e.g. `report`
   * only for delegated children); invisible tools are neither listed nor callable.
   */
  register(
    definition: ToolDefinition,
    options: { visible?: (agent: Agent | undefined) => boolean } = {},
  ): () => void {
    if (this.tools.has(definition.name))
      throw new Error(`tool "${definition.name}" is already registered`)
    this.tools.set(definition.name, definition)
    if (options.visible !== undefined)
      this.visibility.set(definition.name, options.visible)
    return () => {
      if (this.tools.get(definition.name) !== definition) return
      this.tools.delete(definition.name)
      this.visibility.delete(definition.name)
    }
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approval = handler
  }

  names(): string[] {
    return [...this.tools.keys()].sort()
  }

  private visible(name: string, agent?: Agent): boolean {
    const predicate = this.visibility.get(name)
    if (predicate !== undefined && !predicate(agent)) return false
    const filter = agent?.toolFilter
    if (filter === undefined) return true
    if (filter.allow !== undefined && !filter.allow.includes(name)) return false
    return filter.deny?.includes(name) !== true
  }

  get(name: string, agent?: Agent): ToolDefinition | undefined {
    const definition = this.tools.get(name)
    return definition !== undefined && this.visible(name, agent)
      ? definition
      : undefined
  }

  /** Model-facing schemas visible to one agent, sorted by name for cache stability. */
  schemas(agent?: Agent): ToolSchema[] {
    return this.names()
      .filter((name) => this.visible(name, agent))
      .map((name) => {
        const definition = this.tools.get(name)!
        return {
          name,
          description: definition.description,
          parameters:
            definition.parametersFor?.(agent) ?? definition.parameters,
        }
      })
  }

  /** Whether a call may overlap other parallel calls. Unknown/invalid calls run exclusively. */
  executionMode(
    name: string,
    rawArguments: unknown,
    agent?: Agent,
  ): 'parallel' | 'exclusive' {
    const definition = this.get(name, agent)
    if (definition?.isConcurrencySafe === undefined) return 'exclusive'
    try {
      return definition.isConcurrencySafe(definition.parse(rawArguments))
        ? 'parallel'
        : 'exclusive'
    } catch {
      return 'exclusive'
    }
  }

  /** Run one call end to end (host-initiated or nested calls). */
  async execute(call: {
    callId: string
    name: string
    arguments: unknown
    agent?: Agent
    signal: AbortSignal
  }): Promise<ToolExecutionResult> {
    const prepared = await this.prepare(call)
    switch (prepared.kind) {
      case 'dispatch':
        return this.finalize(
          prepared.context,
          await this.dispatch(prepared.context),
        )
      case 'post-result':
        return this.finalize(prepared.context, prepared.result)
      case 'final-result':
        return this.finish(prepared.context, prepared.result)
    }
  }

  /** Stage 1: validate, consult pre-execute middleware, approval, and guards. */
  async prepare(call: {
    callId: string
    name: string
    arguments: unknown
    agent?: Agent
    signal: AbortSignal
  }): Promise<ScheduledPreparation> {
    const state: CallState = {
      definition: this.get(call.name, call.agent),
      deferred: [],
      concludes: false,
      bodyInvoked: false,
    }
    const makeContext = (args: unknown): ToolRunContext => {
      const context: ToolRunContext = {
        callId: call.callId,
        name: call.name,
        arguments: args,
        signal: call.signal,
        ...(call.agent === undefined ? {} : { agent: call.agent }),
        deferContext: (message: UserMessage) => {
          state.deferred.push(message)
        },
        concludeTurn: () => {
          state.concludes = true
        },
      }
      this.states.set(context, state)
      return context
    }
    if (state.definition === undefined) {
      return {
        kind: 'final-result',
        context: makeContext(call.arguments),
        result: toolErrorResult(new ToolNotFoundError(call.name)),
      }
    }
    let args: unknown
    try {
      const parsed = state.definition.parse(call.arguments)
      const detached = snapshotJsonValue(parsed)
      args = deepFreeze(detached === undefined ? parsed : detached)
    } catch (error: unknown) {
      return {
        kind: 'final-result',
        context: makeContext(call.arguments),
        result: toolErrorResult(error),
      }
    }
    const context = makeContext(args)
    if (call.signal.aborted)
      return { kind: 'final-result', context, result: toolAbortedResult(true) }
    try {
      let decision: PreToolDecision = { kind: 'allow' }
      for (const middleware of this.preExecute) {
        const next = await middleware(context)
        if (next !== undefined && RANK[next.kind] > RANK[decision.kind])
          decision = next
        if (decision.kind === 'deny') break
      }
      if (decision.kind === 'ask')
        decision = await this.serviceAsk(context, decision.reason)
      const denial =
        decision.kind === 'deny' ? decision.reason : this.guardReason(context)
      if (call.signal.aborted)
        return { kind: 'post-result', context, result: toolAbortedResult(true) }
      if (denial !== undefined) {
        return {
          kind: 'post-result',
          context,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Error: ${denial}` }],
            error: { message: denial },
          },
        }
      }
      return { kind: 'dispatch', context }
    } catch (error: unknown) {
      return { kind: 'final-result', context, result: toolErrorResult(error) }
    }
  }

  private guardReason(call: ToolCallInfo): string | undefined {
    for (const guard of this.guards) {
      const reason = guard(call)
      if (reason !== undefined) return reason
    }
    return undefined
  }

  private async serviceAsk(
    context: ToolRunContext,
    reason: string | undefined,
  ): Promise<PreToolDecision> {
    if (this.approval === undefined || context.agent === undefined) {
      return {
        kind: 'deny',
        reason:
          reason ??
          `tool "${context.name}" requires approval, but no approval channel is available`,
      }
    }
    const outcome = await this.approval({
      agent: context.agent,
      toolName: context.name,
      callId: context.callId,
      ...(reason === undefined ? {} : { reason }),
      signal: context.signal,
    })
    switch (outcome) {
      case 'allowed-once':
        return { kind: 'allow' }
      case 'rejected':
        return {
          kind: 'deny',
          reason: `the user rejected tool "${context.name}"`,
        }
      case 'cancelled':
        return {
          kind: 'deny',
          reason: `approval for tool "${context.name}" was cancelled`,
        }
      case 'unavailable':
        return {
          kind: 'deny',
          reason: `tool "${context.name}" requires approval, but no approval channel is available`,
        }
    }
  }

  /** Stage 2: run the body under the caller signal and the tool timeout. */
  async dispatch(context: ToolRunContext): Promise<ToolExecutionResult> {
    const state = this.states.get(context)
    const definition = state?.definition
    if (state === undefined || definition === undefined)
      return toolErrorResult(new ToolNotFoundError(context.name))
    if (context.signal.aborted) return toolAbortedResult(true)
    const limit =
      definition.timeoutMs === undefined
        ? undefined
        : deadline(context.signal, definition.timeoutMs, TOOL_TIMEOUT)
    const bodyContext: ToolRunContext =
      limit === undefined ? context : { ...context, signal: limit.signal }
    this.states.set(bodyContext, state)
    try {
      state.bodyInvoked = true
      const body = definition.execute(context.arguments, bodyContext)
      const returned =
        limit === undefined
          ? await body
          : await Promise.race([
              body,
              new Promise<never>((_resolve, reject) => {
                limit.signal.addEventListener(
                  'abort',
                  () => {
                    reject(limit.signal.reason)
                  },
                  { once: true },
                )
              }),
            ])
      const normalized = normalizeToolReturn(returned)
      const meta =
        normalized.meta === undefined
          ? undefined
          : snapshotJsonValue(normalized.meta)
      const result: ToolExecutionResult = {
        isError: normalized.isError,
        content: normalized.content,
        ...(meta === undefined ? {} : { meta: meta as JsonValue }),
        ...(normalized.isError
          ? {
              error: {
                message: normalized.content
                  .map((b) => (b.type === 'text' ? b.text : ''))
                  .join(''),
              },
            }
          : {}),
      }
      if (context.signal.aborted && !result.isError)
        return toolAbortedResult(false)
      return result
    } catch (error: unknown) {
      const timeout =
        limit === undefined ? undefined : timeoutOf(limit.signal, TOOL_TIMEOUT)
      if (timeout !== undefined && !context.signal.aborted) {
        const message = `tool "${context.name}" timed out after ${timeout.timeoutMs}ms`
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${message}` }],
          error: {
            message,
            info: { name: 'TimeoutError', code: TOOL_TIMEOUT },
          },
        }
      }
      if (context.signal.aborted) return toolAbortedResult(false)
      return toolErrorResult(error)
    } finally {
      limit?.dispose()
    }
  }

  /** Stage 3: post-execute middleware, then {@link finish}. */
  async finalize(
    context: ToolRunContext,
    result: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    let current = result
    try {
      for (const middleware of this.postExecute) {
        const decision = await middleware(context, current)
        if (decision === undefined) continue
        const contexts = [
          ...(current.additionalContexts ?? []),
          ...(decision.additionalContexts ?? []),
        ]
        if (decision.kind === 'block') {
          const message =
            decision.feedback
              .map((b) => (b.type === 'text' ? b.text : ''))
              .join('') || 'tool result blocked by post-execute policy'
          current = {
            isError: true,
            content: decision.feedback,
            error: { message },
            ...(contexts.length > 0 ? { additionalContexts: contexts } : {}),
          }
          break
        }
        current = {
          ...current,
          ...(decision.content === undefined
            ? {}
            : { content: decision.content }),
          ...(contexts.length > 0 ? { additionalContexts: contexts } : {}),
        }
      }
    } catch (error: unknown) {
      current = toolErrorResult(error)
    }
    return this.finish(context, current)
  }

  /** Stage 4: merge deferred contexts and conclusion, apply the content finalizer, notify observers. */
  finish(
    context: ToolRunContext,
    result: ToolExecutionResult,
  ): ToolExecutionResult {
    const state = this.states.get(context)
    let final: ToolExecutionResult = result
    if (state !== undefined) {
      const contexts = [...state.deferred, ...(result.additionalContexts ?? [])]
      final = {
        ...result,
        ...(contexts.length > 0 ? { additionalContexts: contexts } : {}),
        ...(state.concludes && !result.isError
          ? { concludesTurn: true as const }
          : {}),
      }
      try {
        const content = state.definition?.finalizeContent?.(context, final)
        if (content !== undefined) final = { ...final, content }
      } catch (error: unknown) {
        final = toolErrorResult(error)
      }
    }
    for (const observer of this.observers) {
      try {
        observer(context, final)
      } catch {
        // Observers never change an outcome.
      }
    }
    return final
  }
}
