/**
 * Conversation compaction (ported from dsh-compaction-basic).
 *
 * Budgets (DSH-4), for a window W and an output cap O (at most W / 2):
 * trigger = floor(min(W × 0.8, W − O − 65536)), never below 0.4 × (W − O);
 * retained tail = 0.16 × (W − O); summary output cap = min(65536, O). An
 * exact `modelPolicies` entry overrides these per model.
 *
 * Triggers:
 * 1. pre-step pressure: total ≥ trigger → prune tool results (never the
 *    ones the model has not read yet), re-measure, then summarize a
 *    head-anchored range keeping the retained tail (up to
 *    compactionRetries+1 attempts). A failure is logged, the turn
 *    continues, and the next 3 pre-step checks of that agent are skipped;
 *    after 3 failures in a row a `compaction/warning` tells the user.
 * 2. request error CONTEXT_WINDOW_EXCEEDED → prune, summarize with a zero
 *    retain budget, retry only if the surface actually shrank (bounded by
 *    maxOverflowRetries per request sequence).
 * 3. manual `/compact` via `agent.runMaintenance`.
 *
 * A span too large for one summary request (always, in overflow recovery)
 * is summarized map-reduce: chunks of at most chunkRatio × W are condensed
 * one by one, then the partial checkpoints are merged. Summary requests use
 * `purpose: 'compaction'`, which adapters send without thinking.
 *
 * Commit: `compaction/start` → summary call(s) → `compaction/summary` →
 * checkpoint `user/message` replacing the range → `compaction/end`.
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { LlmClient } from '../../llm/client'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  errorChain,
  HarnessError,
} from '../../llm/error'
import {
  createUserMessage,
  type Message,
  type UserMessage,
} from '../../llm/message'
import {
  imagePricingForRoute,
  type ImagePricing,
} from '../../llm/token-estimate'
import type { ContentBlock, TokenUsage, ToolSchema } from '../../llm/types'
import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import { logger } from '../../util/log'
import type { Agent } from '../agent/agent'
import type { AgentMiddleware } from '../agent/middleware'
import { turnFallback } from '../agent/model-policy'
import type { ToolResultPruner } from './pruner'
import {
  DEFAULT_IMAGE_PRICING,
  estimateHeader,
  TokenMeter,
  type TokenMeasurement,
} from './token-meter'
import {
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from './tool-pairing'
import './events'

export const COMPACTION_PRODUCER = 'compaction'
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  "- Write concise engineering prose in the conversation's language. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

export class CompactionError extends HarnessError {
  constructor(
    readonly reason:
      'busy' | 'cancelled' | 'summary' | 'changed' | 'commit' | 'none',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, `COMPACTION_${reason.toUpperCase()}`, options)
  }
}

/** Per-model budget override; the most specific match wins. */
export interface CompactionModelPolicy {
  /** Route key (model entry id); omitted: any route serving `model`. */
  provider?: string
  /** Wire model id. */
  model: string
  thresholdRatio?: number
  headroomTokens?: number
  retainRatio?: number
  maxTokens?: number
}

export interface CompactionConfig {
  /** The trigger is at most this share of the window. */
  thresholdRatio: number
  /** Window kept free beyond the output cap: trigger ≤ W − O − headroomTokens. */
  headroomTokens: number
  /** Retained tail as a share of W − O. */
  retainRatio: number
  /** Ceiling of the summary output cap (the cap is min(maxTokens, O)). */
  maxTokens: number
  compactionRetries: number
  maxOverflowRetries: number
  /** Largest share of the window one summary request may carry. */
  chunkRatio: number
  /** Pre-step checks an agent skips after a failed compaction. */
  failureBackoffSteps: number
  /** Failures in a row before the user is told the context is nearly full. */
  warnAfterFailures: number
  auto: boolean
  modelPolicies: readonly CompactionModelPolicy[]
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = Object.freeze({
  thresholdRatio: 0.8,
  headroomTokens: 65_536,
  retainRatio: 0.16,
  maxTokens: 65_536,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  chunkRatio: 0.5,
  failureBackoffSteps: 3,
  warnAfterFailures: 3,
  auto: true,
  modelPolicies: Object.freeze([]),
})

/** Lowest trigger as a share of W − O, for windows too small for the headroom. */
const MIN_TRIGGER_RATIO = 0.4
/** Output cap assumed when neither the request nor the route names one. */
const FALLBACK_OUTPUT_TOKENS = 8_192

/** Token budgets of one routed model. */
export interface CompactionBudget {
  contextWindow: number
  /** Output cap reserved in the window (at most half of it). */
  maxOutputTokens: number
  triggerTokens: number
  retainTokens: number
  summaryMaxTokens: number
  /** Largest span one summary request carries (map-reduce chunk). */
  chunkTokens: number
}

function policyFor(
  config: CompactionConfig,
  target: { provider: string; model: string } | undefined,
): CompactionModelPolicy | undefined {
  if (target === undefined) return undefined
  return (
    config.modelPolicies.find(
      (policy) =>
        policy.provider === target.provider && policy.model === target.model,
    ) ??
    config.modelPolicies.find(
      (policy) =>
        policy.provider === undefined && policy.model === target.model,
    )
  )
}

/**
 * trigger = floor(min(W × thresholdRatio, W − O − headroomTokens)), at
 * least 0.4 × (W − O); retain = 0.16 × (W − O); summary cap = min(65536, O).
 */
export function compactionBudget(
  config: CompactionConfig,
  input: {
    contextWindow: number
    maxOutputTokens: number
    target?: { provider: string; model: string }
  },
): CompactionBudget {
  const policy = policyFor(config, input.target)
  const thresholdRatio = policy?.thresholdRatio ?? config.thresholdRatio
  const headroomTokens = policy?.headroomTokens ?? config.headroomTokens
  const retainRatio = policy?.retainRatio ?? config.retainRatio
  const maxTokens = policy?.maxTokens ?? config.maxTokens
  const contextWindow = Math.max(0, Math.floor(input.contextWindow))
  const maxOutputTokens = Math.min(
    Math.max(0, Math.floor(input.maxOutputTokens)),
    Math.floor(contextWindow / 2),
  )
  const usable = contextWindow - maxOutputTokens
  return {
    contextWindow,
    maxOutputTokens,
    triggerTokens: Math.floor(
      Math.min(
        contextWindow * thresholdRatio,
        Math.max(usable - headroomTokens, usable * MIN_TRIGGER_RATIO),
      ),
    ),
    retainTokens: Math.floor(usable * retainRatio),
    summaryMaxTokens: Math.max(1, Math.min(maxTokens, maxOutputTokens)),
    chunkTokens: Math.floor(contextWindow * config.chunkRatio),
  }
}

/** How one span is summarized. */
interface SummaryPlan {
  /** Output cap of each summary request. */
  maxTokens: number
  /** Largest span one summary request carries. */
  chunkTokens: number
  /** Window a single summary request must fit; unknown: one request. */
  contextWindow?: number
  /** Summarize in chunks whatever the size (overflow recovery). */
  chunked: boolean
}

const CONTINUATION_TEXT =
  '[An earlier part of this conversation is condensed separately; the messages below continue it.]'
const CLIP_MARKER = '\n\n[... middle omitted for this summary ...]\n\n'

export interface CompactionResult {
  compactionId: string
  startSeq: number
  summarySeq: number
  endSeq: number
  summary: ContentBlock[]
  shadowedRange: { start: number; end: number }
  shadowedSeqs: number[]
  shadowedTokenCount: number
}

interface SummaryResult {
  summary: Array<Extract<ContentBlock, { type: 'text' }>>
  provider: string
  model: string
  usage?: TokenUsage
}

/** Observer hook: called after each committed compaction (memory consolidation, UI). */
export type CompactionListener = (
  agent: Agent,
  result: CompactionResult,
) => void

export class CompactionEngine {
  readonly config: CompactionConfig
  readonly meter = new TokenMeter({
    imagePricing: (session) => this.imagePricingFor(session),
  })
  private readonly overflowRetries = new WeakMap<Agent, number>()
  /** Failed pre-step compactions in a row, and checks still to skip. */
  private readonly backoff = new WeakMap<
    Agent,
    { failures: number; skip: number }
  >()
  private readonly listeners = new Set<CompactionListener>()

  constructor(
    private readonly llm: LlmClient,
    private readonly pruner: ToolResultPruner | undefined,
    config: Partial<CompactionConfig> = {},
  ) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config }
    for (const policy of [this.config, ...this.config.modelPolicies]) {
      const threshold = policy.thresholdRatio ?? this.config.thresholdRatio
      const retain = policy.retainRatio ?? this.config.retainRatio
      if (retain >= Math.min(threshold, MIN_TRIGGER_RATIO))
        throw new Error(
          'compaction: retainRatio must be below thresholdRatio and 0.4',
        )
    }
  }

  onCompacted(listener: CompactionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Register pressure + overflow triggers. The overflow handler must precede the retry handler. */
  install(middleware: AgentMiddleware): void {
    if (!this.config.auto) return
    middleware.preStep.push(async ({ agent, signal, turn, step }) => {
      if (signal.aborted) return undefined
      const backoff = this.backoff.get(agent)
      if (backoff !== undefined && backoff.skip > 0) {
        backoff.skip -= 1
        return undefined
      }
      try {
        await this.compactIfNeeded(agent, 'pressure', signal, { turn, step })
        this.backoff.delete(agent)
      } catch (error: unknown) {
        if (signal.aborted) throw error
        const failures = (backoff?.failures ?? 0) + 1
        this.backoff.set(agent, {
          failures,
          skip: this.config.failureBackoffSteps,
        })
        logger.warn(
          `step compaction failed (${failures} in a row): ${errorChain(error)}; continuing the turn`,
        )
        if (failures === this.config.warnAfterFailures)
          agent.session.append('compaction/warning', { failures })
      }
      return undefined
    })
    middleware.requestError.unshift(
      async ({ agent, failure, signal, turn, step }) => {
        if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted)
          return undefined
        const retries = this.overflowRetries.get(agent) ?? 0
        if (retries >= this.config.maxOverflowRetries) return undefined
        const generation = agent.session.surface.replaceGeneration
        try {
          await this.compactIfNeeded(agent, 'context-overflow', signal, {
            turn,
            step,
          })
        } catch (error: unknown) {
          if (
            signal.aborted ||
            agent.session.surface.replaceGeneration <= generation
          ) {
            logger.warn(
              `context-overflow compaction failed: ${errorChain(error)}`,
            )
            return undefined
          }
        }
        if (
          signal.aborted ||
          agent.session.surface.replaceGeneration <= generation
        )
          return undefined
        this.overflowRetries.set(agent, retries + 1)
        return 'retry'
      },
    )
    middleware.turnStopping.push(({ agent }) => {
      this.overflowRetries.delete(agent)
    })
  }

  /** Current pressure measurement (for UI context meters). */
  measure(session: Session): TokenMeasurement {
    return this.meter.measure(session)
  }

  contextWindowFor(session: Session): number | undefined {
    const context = session.requestContext()
    if (context?.contextWindow !== undefined) return context.contextWindow
    const provider = session.requestHeader()?.config.provider
    if (provider === undefined) return undefined
    try {
      return this.llm.route(provider).contextWindow
    } catch {
      return undefined
    }
  }

  /**
   * Budgets of the model the session's requests go to: `routeId` when
   * given (the next request's route), else the last logged request's;
   * undefined without a window.
   */
  budgetFor(session: Session, routeId?: string): CompactionBudget | undefined {
    const header = session.requestHeader()
    const context = session.requestContext()
    const logged = context?.provider ?? header?.config.provider
    if (routeId !== undefined && routeId !== logged) {
      try {
        const route = this.llm.route(routeId)
        return compactionBudget(this.config, {
          contextWindow: route.contextWindow,
          maxOutputTokens: route.maxTokens,
          target: { provider: route.id, model: route.modelId },
        })
      } catch {
        // an unknown route: measure against the logged one
      }
    }
    const contextWindow = this.contextWindowFor(session)
    if (contextWindow === undefined) return undefined
    const provider = logged
    const model = context?.model ?? header?.config.model
    return compactionBudget(this.config, {
      contextWindow,
      maxOutputTokens:
        header?.config.maxTokens ??
        this.routeMaxTokens(provider) ??
        FALLBACK_OUTPUT_TOKENS,
      ...(provider === undefined || model === undefined
        ? {}
        : { target: { provider, model } }),
    })
  }

  /** Route of the agent's next request: this turn's fallback, else its own proposal. */
  private nextRouteOf(agent: Agent): string | undefined {
    try {
      const fallback =
        agent.status === 'running'
          ? turnFallback(agent.session, agent.position.turn)
          : undefined
      return fallback?.to ?? agent.proposedCallConfig().provider
    } catch {
      return undefined
    }
  }

  private routeMaxTokens(provider: string | undefined): number | undefined {
    if (provider === undefined) return undefined
    try {
      return this.llm.route(provider).maxTokens
    } catch {
      return undefined
    }
  }

  private imagePricingFor(session: Session): ImagePricing {
    const provider =
      session.requestContext()?.provider ??
      session.requestHeader()?.config.provider
    if (provider === undefined) return DEFAULT_IMAGE_PRICING
    try {
      return imagePricingForRoute(this.llm.route(provider))
    } catch {
      return DEFAULT_IMAGE_PRICING
    }
  }

  /** One summary request per span when it fits the window, else map-reduce. */
  private summaryPlan(
    session: Session,
    budget: CompactionBudget | undefined,
  ): SummaryPlan {
    if (budget !== undefined)
      return {
        maxTokens: budget.summaryMaxTokens,
        chunkTokens: budget.chunkTokens,
        contextWindow: budget.contextWindow,
        chunked: false,
      }
    return {
      maxTokens: Math.min(
        this.config.maxTokens,
        session.requestHeader()?.config.maxTokens ?? FALLBACK_OUTPUT_TOKENS,
      ),
      chunkTokens: Number.POSITIVE_INFINITY,
      chunked: false,
    }
  }

  async compactIfNeeded(
    agent: Agent,
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal,
    current?: { turn: number; step: number },
  ): Promise<CompactionResult | null> {
    const session = agent.session
    if (session.requestHeader() === undefined) return null
    // Overflow: the rejected request's route (logged); pressure: the next one's.
    const budget =
      trigger === 'context-overflow'
        ? this.budgetFor(session)
        : this.budgetFor(session, this.nextRouteOf(agent))
    let measurement = this.meter.measure(session)
    if (trigger === 'context-overflow') {
      if (this.pruner !== undefined) {
        this.pruner.pruneSession(session, current)
        measurement = this.meter.measure(session)
      }
      const range = selectCompactableRange(session, measurement, 0)
      if (range === null) return null
      // The rejected request held about `totalTokens`: chunks stay well below it.
      const ceiling = Math.min(
        budget?.contextWindow ?? measurement.totalTokens,
        measurement.totalTokens,
      )
      return this.compactRegion(
        agent,
        range.start,
        range.end,
        'current-turn',
        {
          ...this.summaryPlan(session, budget),
          chunkTokens: Math.max(
            1,
            Math.floor(ceiling * this.config.chunkRatio),
          ),
          chunked: true,
        },
        signal,
      )
    }
    if (budget === undefined) return null
    const { triggerTokens, retainTokens } = budget
    if (measurement.totalTokens < triggerTokens) return null
    assertNoActiveCompaction(session)
    if (this.pruner !== undefined) {
      this.pruner.pruneSession(session, current)
      measurement = this.meter.measure(session)
    }
    if (measurement.totalTokens < triggerTokens) return null
    let result: CompactionResult | null = null
    for (
      let attempt = 0;
      attempt <= this.config.compactionRetries;
      attempt += 1
    ) {
      const range = selectCompactableRange(session, measurement, retainTokens)
      if (range === null) {
        if (result === null) return null
        break
      }
      result = await this.compactRegion(
        agent,
        range.start,
        range.end,
        'current-turn',
        this.summaryPlan(session, budget),
        signal,
      )
      measurement = this.meter.measure(session)
      if (measurement.totalTokens < triggerTokens) return result
    }
    throw new Error(
      `compaction still above threshold after ${this.config.compactionRetries + 1} attempts ` +
        `(${measurement.totalTokens} estimated tokens >= threshold ${triggerTokens})`,
    )
  }

  /** Manual idle compaction (`/compact`). Resolves null when nothing is compactable. */
  compactNow(
    agent: Agent,
    signal?: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResult | null> {
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operation =
          signal === undefined
            ? agentSignal
            : AbortSignal.any([agentSignal, signal])
        const range = selectCompactableRange(
          agent.session,
          this.meter.measure(agent.session),
          0,
        )
        if (range === null) return null
        try {
          return await this.compactRegion(
            agent,
            range.start,
            range.end,
            null,
            this.summaryPlan(
              agent.session,
              this.budgetFor(agent.session, this.nextRouteOf(agent)),
            ),
            operation,
            sourceCommandId,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted)
            throw new CompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          throw error
        }
      })
    } catch (error: unknown) {
      return Promise.reject(
        new CompactionError(
          'busy',
          'manual compaction requires an idle agent',
          { cause: error },
        ),
      )
    }
  }

  private async summarize(
    session: Session,
    messages: Message[],
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const header = session.requestHeader()
    const provider =
      header?.config.provider ?? this.llm.defaultCallConfig().provider
    const model = header?.config.model ?? this.llm.defaultCallConfig().model
    const system = header?.system
    const tools: ToolSchema[] | undefined = header?.tools
    const result = await this.llm.complete({
      provider,
      model,
      messages: [...messages, instructionMessage()],
      ...(system === undefined ? {} : { system }),
      ...(tools === undefined ? {} : { tools }),
      maxTokens,
      sessionId: session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    })
    if (result.finish.kind === 'max-tokens')
      throw new Error(
        'summarization truncated at the token cap (incomplete checkpoint)',
      )
    const summary = result.message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    if (!summary.some((block) => block.text.trim().length > 0))
      throw new Error('summarization produced no text summary content')
    return {
      summary,
      provider,
      model,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }
  }

  /**
   * Summarize a surface span: one request when it fits the window,
   * otherwise map-reduce (CORE-27): chunks within the plan's budget are
   * condensed one by one, then the partial checkpoints are merged.
   */
  private async summarizeSpan(
    session: Session,
    seqs: readonly number[],
    measurement: TokenMeasurement,
    plan: SummaryPlan,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const priced = new Map(
      measurement.nodes.map((node) => [node.seq, node.tokens]),
    )
    const spanTokens = seqs.reduce(
      (sum, seq) => sum + (priced.get(seq) ?? 0),
      0,
    )
    const fixedTokens =
      Math.round(
        measurement.calibration * estimateHeader(session.requestHeader()),
      ) + this.meter.estimateMessage(instructionMessage(), session)
    const fits =
      plan.contextWindow === undefined ||
      fixedTokens + spanTokens + plan.maxTokens <= plan.contextWindow
    const messagesOf = (span: readonly number[]): Message[] =>
      span
        .map((seq) => session.deriveEventMessage(session.events[seq]!))
        .filter((message): message is Message => message !== null)
    // Room for messages in one chunk request; none left means chunks cannot help.
    const budget = plan.chunkTokens - fixedTokens
    if ((!plan.chunked && fits) || budget <= 0)
      return this.summarize(session, messagesOf(seqs), plan.maxTokens, signal)
    const partials: SummaryResult[] = []
    for (const chunk of splitSpan(session, seqs, priced, budget)) {
      const messages = messagesOf(chunk).map((message) =>
        this.clipForSummary(session, message, budget),
      )
      if (messages.length === 0) continue
      if (messages[0]!.role !== 'user')
        messages.unshift(contextNote(CONTINUATION_TEXT))
      partials.push(
        await this.summarize(session, messages, plan.maxTokens, signal),
      )
    }
    let level = partials
    while (level.length > 1) {
      const next: SummaryResult[] = []
      for (const group of this.mergeGroups(session, level, budget)) {
        if (group.length === 1) {
          next.push(group[0]!)
          continue
        }
        const merged = await this.summarize(
          session,
          [mergeMessage(group)],
          plan.maxTokens,
          signal,
        )
        next.push({ ...merged, ...sumUsage(group, merged) })
      }
      level = next
    }
    const result = level[0]
    if (result === undefined)
      throw new Error('summarization: the span has no messages')
    return result
  }

  /** Partial checkpoints grouped for one merge request each (at least two per group). */
  private mergeGroups(
    session: Session,
    partials: readonly SummaryResult[],
    budget: number,
  ): SummaryResult[][] {
    const groups: SummaryResult[][] = []
    let current: SummaryResult[] = []
    let tokens = 0
    for (const partial of partials) {
      const cost = this.meter.estimateMessage(
        { content: partial.summary },
        session,
      )
      if (current.length >= 2 && tokens + cost > budget) {
        groups.push(current)
        current = []
        tokens = 0
      }
      current.push(partial)
      tokens += cost
    }
    if (current.length === 1 && groups.length > 0)
      groups.at(-1)!.push(current[0]!)
    else if (current.length > 0) groups.push(current)
    return groups
  }

  /** Keep the head and tail of a message too large for one summary request. */
  private clipForSummary(
    session: Session,
    message: Message,
    budget: number,
  ): Message {
    const tokens = this.meter.estimateMessage(message, session)
    if (tokens <= budget) return message
    return { ...message, content: clipBlocks(message.content, budget / tokens) }
  }

  private async compactRegion(
    agent: Agent,
    start: number,
    end: number,
    owner: 'current-turn' | null,
    plan: SummaryPlan,
    signal?: AbortSignal,
    sourceCommandId?: string,
  ): Promise<CompactionResult> {
    const session = agent.session
    const selection = validateSurfaceRegion(session, start, end)
    assertNoActiveCompaction(session)
    const openTurn = openTurnOf(session.events)
    if (owner === null && openTurn !== null)
      throw new CompactionError(
        'busy',
        'manual compaction: the session already has an open turn',
      )
    if (owner !== null && openTurn === null)
      throw new Error(
        'compactRegion: automatic compaction must be enclosed in a turn',
      )
    const lifecycle = {
      compactionId: randomUUID(),
      turn: owner === null ? null : openTurn,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    }
    const startEvent = session.append('compaction/start', lifecycle)
    let closed = false
    try {
      const measurement = this.meter.measure(session)
      const selectedNodes = measurement.nodes.slice(
        selection.startIdx,
        selection.endIdx + 1,
      )
      const shadowedTokenCount = selectedNodes.reduce(
        (total, node) => total + node.tokens,
        0,
      )
      const summarized = await this.summarizeSpan(
        session,
        selection.shadowedSeqs,
        measurement,
        plan,
        signal,
      )
      const checkpoint: UserMessage = createUserMessage({
        content: frameSummary(summarized.summary),
        source: {
          kind: 'context',
          producer: COMPACTION_PRODUCER,
          form: 'recall',
        },
      })
      const framedTokens = this.meter.estimateMessage(checkpoint, session)
      if (framedTokens >= shadowedTokenCount) {
        throw new Error(
          `summary is not smaller than the shadowed content (${framedTokens} >= ${shadowedTokenCount})`,
        )
      }
      signal?.throwIfAborted()
      if (owner !== null) {
        if (
          !isDeepStrictEqual(
            this.meter.measure(session).nodes,
            measurement.nodes,
          )
        ) {
          throw new CompactionError(
            'changed',
            'compaction: session surface changed during summarization',
          )
        }
      } else {
        const current = validateSurfaceRegion(session, start, end)
        if (!isDeepStrictEqual(current.shadowedSeqs, selection.shadowedSeqs)) {
          throw new CompactionError(
            'changed',
            'compaction: the selected span changed during summarization',
          )
        }
      }
      const summaryEvent = session.append('compaction/summary', {
        compactionId: lifecycle.compactionId,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        summary: summarized.summary,
        shadowedRange: { start, end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount,
        provider: summarized.provider,
        model: summarized.model,
        maxTokens: plan.maxTokens,
        ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
      })
      session.append('user/message', checkpoint, {
        surfaceOp: { op: 'replace', start, end },
        sourceEventSeqs: [
          startEvent.seq,
          summaryEvent.seq,
          ...selection.shadowedSeqs,
        ],
      })
      closed = true
      const endEvent = session.append('compaction/end', lifecycle)
      const result: CompactionResult = {
        compactionId: lifecycle.compactionId,
        startSeq: startEvent.seq,
        summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq,
        summary: summarized.summary,
        shadowedRange: { start, end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount,
      }
      for (const listener of this.listeners) {
        try {
          listener(agent, result)
        } catch (error: unknown) {
          logger.warn(`compaction listener failed: ${errorChain(error)}`)
        }
      }
      return result
    } catch (error: unknown) {
      if (!closed)
        session.append('compaction/end', {
          ...lifecycle,
          error: errorChain(error),
        })
      throw error
    }
  }
}

function instructionMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
    source: { kind: 'context', producer: COMPACTION_PRODUCER },
  })
}

function contextNote(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'context', producer: COMPACTION_PRODUCER },
  })
}

/** Partial checkpoints of consecutive chunks, in order, to merge into one. */
function mergeMessage(partials: readonly SummaryResult[]): UserMessage {
  const content: ContentBlock[] = []
  for (const partial of partials)
    content.push({ type: 'text', text: SUMMARY_OPEN_TAG }, ...partial.summary, {
      type: 'text',
      text: SUMMARY_CLOSE_TAG,
    })
  return createUserMessage({
    content,
    source: { kind: 'context', producer: COMPACTION_PRODUCER, form: 'recall' },
  })
}

/** Usage of a merge plus the partials it consumed. */
function sumUsage(
  partials: readonly SummaryResult[],
  merged: SummaryResult,
): { usage?: TokenUsage } {
  const all = [...partials, merged].flatMap((part) =>
    part.usage === undefined ? [] : [part.usage],
  )
  if (all.length === 0) return {}
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  for (const usage of all) {
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    for (const key of [
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ] as const) {
      if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]
    }
  }
  return { usage: total }
}

/**
 * Consecutive chunks of a span within `budget` priced tokens; a chunk only
 * ends where no tool call waits for its result, and a node larger than the
 * budget is a chunk of its own.
 */
function splitSpan(
  session: Session,
  seqs: readonly number[],
  priced: ReadonlyMap<number, number>,
  budget: number,
): number[][] {
  const chunks: number[][] = []
  let current: number[] = []
  let tokens = 0
  for (const seq of seqs) {
    const cost = priced.get(seq) ?? 0
    if (
      current.length > 0 &&
      tokens + cost > budget &&
      toolPairingBalancedBefore(session, seq)
    ) {
      chunks.push(current)
      current = []
      tokens = 0
    }
    current.push(seq)
    tokens += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function clipBlocks(
  blocks: readonly ContentBlock[],
  keep: number,
): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === 'tool-result')
      return { ...block, content: clipBlocks(block.content, keep) }
    if (block.type !== 'text' && block.type !== 'reasoning') return block
    const points = Array.from(block.text)
    const half = Math.floor((points.length * keep) / 2)
    if (half * 2 >= points.length) return block
    return {
      ...block,
      text:
        points.slice(0, half).join('') +
        CLIP_MARKER +
        points.slice(points.length - half).join(''),
    }
  })
}

/**
 * Head-anchored range that retains a recent tail of at least `retainTokens`
 * and never splits a tool-call/result pair.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): { start: number; end: number } | null {
  const priced = measurement.nodes
  if (priced.length === 0) return null
  const surface = session.surface.nodes
  if (
    surface.length !== priced.length ||
    surface.some((seq, index) => seq !== priced[index]?.seq)
  ) {
    throw new Error(
      'compaction: token-meter surface does not match the current session surface',
    )
  }
  let accumulated = 0
  let keepFromIdx = priced.length
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === 0) return null
  while (keepFromIdx > 0) {
    if (toolPairingBalancedBefore(session, surface[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null
  return { start: surface[0]!, end: surface[keepFromIdx - 1]! }
}

function validateSurfaceRegion(
  session: Session,
  start: number,
  end: number,
): { startIdx: number; endIdx: number; shadowedSeqs: number[] } {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx)
    throw new Error(`compactRegion: invalid surface span ${start}..${end}`)
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!))
    throw new Error(
      `compactRegion: start seq ${start} would split a tool-call/result pair`,
    )
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!))
    throw new Error(
      `compactRegion: end seq ${end} would split a tool-call/result pair`,
    )
  return { startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

function openTurnOf(events: readonly SessionEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'turn/end') return null
    if (event.type === 'turn/start') return event.data.turn
  }
  return null
}

function assertNoActiveCompaction(session: Session): void {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]!.type
    if (type === 'session/end-seed' || type === 'compaction/end') return
    if (type === 'compaction/start')
      throw new CompactionError('busy', 'compaction already in progress')
  }
}
