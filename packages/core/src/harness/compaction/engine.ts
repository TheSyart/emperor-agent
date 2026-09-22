/**
 * Conversation compaction (ported from dsh-compaction-basic).
 *
 * Triggers:
 * 1. pre-step pressure: total ≥ floor(contextWindow × thresholdRatio) →
 *    prune tool results, re-measure, then summarize a head-anchored range
 *    retaining floor(contextWindow × retainRatio) tokens (up to
 *    compactionRetries+1 attempts). Failures are logged; the turn continues.
 * 2. request error CONTEXT_WINDOW_EXCEEDED → prune, summarize with a zero
 *    retain budget, retry only if the surface actually shrank (bounded by
 *    maxOverflowRetries per request sequence).
 * 3. manual `/compact` via `agent.runMaintenance`.
 *
 * Commit: `compaction/start` → summary call → `compaction/summary` →
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
import type { ContentBlock, TokenUsage, ToolSchema } from '../../llm/types'
import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import { logger } from '../../util/log'
import type { Agent } from '../agent/agent'
import type { AgentMiddleware } from '../agent/middleware'
import type { ToolResultPruner } from './pruner'
import { TokenMeter, type TokenMeasurement } from './token-meter'
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

export interface CompactionConfig {
  thresholdRatio: number
  retainRatio: number
  /** Summary output cap. */
  maxTokens: number
  compactionRetries: number
  maxOverflowRetries: number
  auto: boolean
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = Object.freeze({
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  maxTokens: 8192,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  auto: true,
})

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
  readonly meter = new TokenMeter()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly listeners = new Set<CompactionListener>()

  constructor(
    private readonly llm: LlmClient,
    private readonly pruner: ToolResultPruner | undefined,
    config: Partial<CompactionConfig> = {},
  ) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config }
    if (this.config.retainRatio >= this.config.thresholdRatio) {
      throw new Error('compaction: retainRatio must be below thresholdRatio')
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
    middleware.preStep.push(async ({ agent, signal }) => {
      if (signal.aborted) return undefined
      try {
        await this.compactIfNeeded(agent, 'pressure', signal)
      } catch (error: unknown) {
        if (signal.aborted) throw error
        logger.warn(
          `step compaction failed: ${errorChain(error)}; continuing the turn`,
        )
      }
      return undefined
    })
    middleware.requestError.unshift(async ({ agent, failure, signal }) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted)
        return undefined
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= this.config.maxOverflowRetries) return undefined
      const generation = agent.session.surface.replaceGeneration
      try {
        await this.compactIfNeeded(agent, 'context-overflow', signal)
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
    })
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

  async compactIfNeeded(
    agent: Agent,
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    if (session.requestHeader() === undefined) return null
    let measurement = this.meter.measure(session)
    if (trigger === 'context-overflow') {
      if (this.pruner !== undefined) {
        this.pruner.pruneSession(session)
        measurement = this.meter.measure(session)
      }
      const range = selectCompactableRange(session, measurement, 0)
      if (range === null) return null
      return this.compactRegion(
        agent,
        range.start,
        range.end,
        'current-turn',
        signal,
      )
    }
    const window = this.contextWindowFor(session)
    if (window === undefined) return null
    const thresholdTokens = Math.floor(window * this.config.thresholdRatio)
    const retainTokens = Math.floor(window * this.config.retainRatio)
    if (measurement.totalTokens < thresholdTokens) return null
    assertNoActiveCompaction(session)
    if (this.pruner !== undefined) {
      this.pruner.pruneSession(session)
      measurement = this.meter.measure(session)
    }
    if (measurement.totalTokens < thresholdTokens) return null
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
        signal,
      )
      measurement = this.meter.measure(session)
      if (measurement.totalTokens < thresholdTokens) return result
    }
    throw new Error(
      `compaction still above threshold after ${this.config.compactionRetries + 1} attempts ` +
        `(${measurement.totalTokens} estimated tokens >= threshold ${thresholdTokens})`,
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
      messages: [
        ...messages,
        createUserMessage({
          content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
          source: { kind: 'context', producer: COMPACTION_PRODUCER },
        }),
      ],
      ...(system === undefined ? {} : { system }),
      ...(tools === undefined ? {} : { tools }),
      maxTokens: this.config.maxTokens,
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

  private async compactRegion(
    agent: Agent,
    start: number,
    end: number,
    owner: 'current-turn' | null,
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
      const messages = selection.shadowedSeqs
        .map((seq) => session.deriveEventMessage(session.events[seq]!))
        .filter((message): message is Message => message !== null)
      const summarized = await this.summarize(session, messages, signal)
      const checkpoint: UserMessage = createUserMessage({
        content: frameSummary(summarized.summary),
        source: {
          kind: 'context',
          producer: COMPACTION_PRODUCER,
          form: 'recall',
        },
      })
      const framedTokens = this.meter.estimateMessage(checkpoint)
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
        maxTokens: this.config.maxTokens,
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
