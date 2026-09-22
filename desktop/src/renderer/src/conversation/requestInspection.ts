// Provider-request inspection (ported from the dsh request-inspection
// contract and its trajectory request/header + assistant Definitions): one
// RequestView per model request, assembled from durable request events.
//
// A pure fold over the loaded window; the M6 trajectory model consumes it
// for the request inspector (Summary / Options / Usage / Timing, prompt diff).
import type {
  ContentBlock,
  EpochHeader,
  TokenUsage,
  ToolSchema,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import {
  failureMessage,
  isAppendSurfaceEvent,
  isEvent,
  isTokenDelta,
} from './events'

/** Model-visible request header in force for an ordinary generation. */
export interface ConversationPromptSnapshot {
  /** Provider/model and sampling configuration (the header's call config). */
  readonly config: EpochHeader['config']
  /** Rendered system prompt; empty when the request had none. */
  readonly system: string
  /** Complete tool catalog sent with the request. */
  readonly tools: readonly ToolSchema[]
}

/** System/tool change introduced while preparing one request. */
export interface RequestPromptChange {
  /** Seq of the request/header event that introduced this state. */
  readonly seq: number
  readonly time: number
  readonly kind: 'initial' | 'system' | 'tools' | 'system-and-tools'
  /** State immediately before; absent for the initial header. */
  readonly previous?: ConversationPromptSnapshot
}

/** Decode timing of one request. */
export interface RequestTiming {
  /** Request start → first token delta. */
  readonly ttftMs: number | null
  /** First token delta → completion. */
  readonly decodeMs: number | null
}

interface RequestViewBase {
  /** Seq that opened the operation. */
  readonly startSeq: number
  readonly startedAt: number
  readonly completedAt: number | null
  readonly status: 'running' | 'complete' | 'error'
  readonly error?: string
  readonly provenance?: { readonly provider: string; readonly model: string }
  readonly usage?: TokenUsage
  /** Assistant message or compaction summary produced by this request. */
  readonly resultSeq?: number
  readonly timing: RequestTiming
}

/** One ordinary assistant generation (one agent step). */
export interface AssistantRequestView extends RequestViewBase {
  readonly purpose: 'assistant'
  readonly turn: number
  readonly step: number
  /** Effective request header (inherited until a later header changes it). */
  readonly prompt?: ConversationPromptSnapshot
  /** Header change logged while preparing this request. */
  readonly promptChange?: RequestPromptChange
  /** Retries scheduled for this step (latest attempt). */
  readonly retry?: number
  readonly maxRetries?: number
  readonly retryDelayMs?: number
  /** Route context (provider/model/window) reported for the request. */
  readonly route?: {
    readonly provider: string
    readonly model: string
    readonly contextWindow?: number
  }
}

/** One compaction provider request. */
export interface CompactionRequestView extends RequestViewBase {
  readonly purpose: 'compaction'
  /** Owning turn, or null for manual compaction between turns. */
  readonly turn: number | null
  readonly step: 0
  readonly compactionId: string
  /** Seq of the replacement checkpoint message. */
  readonly replacementSeq?: number
  readonly summary?: readonly ContentBlock[]
}

export type RequestView = AssistantRequestView | CompactionRequestView

/** Request data consumed by the trajectory inspector. */
export interface RequestInspectionSnapshot {
  readonly requests: readonly RequestView[]
  /** Latest schema per tool name (for the tool inspector's Schema tab). */
  readonly callSchemas: ReadonlyMap<string, ToolSchema>
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function promptOf(header: EpochHeader): ConversationPromptSnapshot {
  return {
    config: header.config,
    system: header.system ?? '',
    tools: Array.isArray(header.tools) ? header.tools : [],
  }
}

function changeOf(
  previous: ConversationPromptSnapshot | undefined,
  prompt: ConversationPromptSnapshot,
  seq: number,
  time: number,
): RequestPromptChange | undefined {
  if (previous === undefined) return { seq, time, kind: 'initial' }
  const system = previous.system !== prompt.system
  const tools = JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools)
  if (!system && !tools) return undefined
  return {
    seq,
    time,
    kind: system && tools ? 'system-and-tools' : system ? 'system' : 'tools',
    previous,
  }
}

function timing(
  startedAt: number,
  firstTokenAt: number | null,
  completedAt: number | null,
): RequestTiming {
  return {
    ttftMs:
      firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
    decodeMs:
      firstTokenAt === null || completedAt === null
        ? null
        : Math.max(0, completedAt - firstTokenAt),
  }
}

interface OpenAssistant {
  view: Mutable<AssistantRequestView>
  firstTokenAt: number | null
  produced: boolean
}

/**
 * Assemble every provider request of a window.
 * @param events - contiguous window in ascending seq order.
 */
export function inspectRequests(
  events: readonly WireSessionEvent[],
): RequestInspectionSnapshot {
  const requests: RequestView[] = []
  const callSchemas = new Map<string, ToolSchema>()
  const steps = new Map<string, OpenAssistant>()
  const compactions = new Map<
    string,
    { view: Mutable<CompactionRequestView>; index: number }
  >()
  let prompt: ConversationPromptSnapshot | undefined
  let pendingChange: RequestPromptChange | undefined
  let open: OpenAssistant | undefined
  const indexOf = new Map<OpenAssistant, number>()

  const publish = (entry: OpenAssistant): void => {
    const view: AssistantRequestView = {
      ...entry.view,
      timing: timing(
        entry.view.startedAt,
        entry.firstTokenAt,
        entry.view.completedAt,
      ),
    }
    const index = indexOf.get(entry)
    if (index === undefined) {
      indexOf.set(entry, requests.length)
      requests.push(view)
    } else requests[index] = view
  }

  for (const event of events) {
    if (isEvent(event, 'request/header')) {
      const next = promptOf(event.data.header)
      for (const tool of next.tools) callSchemas.set(tool.name, tool)
      const change = changeOf(prompt, next, event.seq, event.time)
      prompt = next
      if (open !== undefined && !open.produced) {
        open.view.prompt = next
        if (change !== undefined) open.view.promptChange = change
        publish(open)
      } else if (change !== undefined) pendingChange = change
      continue
    }
    if (isEvent(event, 'step/start')) {
      const entry: OpenAssistant = {
        firstTokenAt: null,
        produced: false,
        view: {
          purpose: 'assistant',
          turn: event.data.turn,
          step: event.data.step,
          startSeq: event.seq,
          startedAt: event.time,
          completedAt: null,
          status: 'running',
          timing: { ttftMs: null, decodeMs: null },
          ...(prompt === undefined ? {} : { prompt }),
          ...(pendingChange === undefined
            ? {}
            : { promptChange: pendingChange }),
        },
      }
      pendingChange = undefined
      steps.set(`${event.data.turn}:${event.data.step}`, entry)
      open = entry
      publish(entry)
      continue
    }
    const data = event.data as { turn?: unknown; step?: unknown }
    const stepKey =
      typeof data.turn === 'number' && typeof data.step === 'number'
        ? `${data.turn}:${data.step}`
        : undefined
    const entry = stepKey === undefined ? undefined : steps.get(stepKey)
    if (isEvent(event, 'request/context')) {
      if (open !== undefined) {
        open.view.route = { ...event.data }
        publish(open)
      }
      continue
    }
    if (entry !== undefined && isEvent(event, 'assistant/chunk')) {
      const chunk = event.data.chunk
      if (chunk.type === 'usage') entry.view.usage = chunk.usage
      else if (isTokenDelta(chunk) && entry.firstTokenAt === null) {
        entry.firstTokenAt = event.time
        entry.produced = true
      } else if (chunk.type === 'finish' && chunk.reason.kind === 'error')
        entry.view.error = failureMessage(chunk.reason.failure)
      publish(entry)
      continue
    }
    if (entry !== undefined && isEvent(event, 'assistant/message')) {
      if (!isAppendSurfaceEvent(event)) continue
      entry.produced = true
      entry.view.status = event.data.interrupted === true ? 'error' : 'complete'
      entry.view.completedAt = event.time
      entry.view.resultSeq = event.seq
      const source = event.data.message.source
      entry.view.provenance = { provider: source.provider, model: source.model }
      if (event.data.usage !== undefined) entry.view.usage = event.data.usage
      if (event.data.interrupted !== true) delete entry.view.error
      publish(entry)
      continue
    }
    if (entry !== undefined && isEvent(event, 'llm/retry')) {
      entry.view.retry = event.data.retry
      entry.view.retryDelayMs = event.data.delayMs
      entry.view.error = failureMessage(event.data.failure)
      if (event.data.maxRetries !== undefined)
        entry.view.maxRetries = event.data.maxRetries
      entry.firstTokenAt = null
      publish(entry)
      continue
    }
    if (entry !== undefined && isEvent(event, 'step/end')) {
      if (entry.view.status === 'running') {
        entry.view.status = 'error'
        entry.view.completedAt = event.time
        publish(entry)
      }
      if (open === entry) open = undefined
      continue
    }
    if (isEvent(event, 'turn/end')) {
      for (const candidate of steps.values()) {
        if (candidate.view.turn !== event.data.turn) continue
        if (candidate.view.status !== 'running') continue
        candidate.view.status = 'error'
        candidate.view.completedAt = event.time
        if (event.data.reason.kind === 'error')
          candidate.view.error = failureMessage(event.data.reason.error)
        publish(candidate)
      }
      open = undefined
      continue
    }
    if (isEvent(event, 'compaction/start')) {
      const view: Mutable<CompactionRequestView> = {
        purpose: 'compaction',
        compactionId: event.data.compactionId,
        turn: event.data.turn,
        step: 0,
        startSeq: event.seq,
        startedAt: event.time,
        completedAt: null,
        status: 'running',
        timing: { ttftMs: null, decodeMs: null },
      }
      compactions.set(event.data.compactionId, {
        view,
        index: requests.length,
      })
      requests.push({ ...view })
      continue
    }
    if (isEvent(event, 'compaction/summary')) {
      const record = compactions.get(event.data.compactionId)
      if (record === undefined) continue
      record.view.summary = event.data.summary
      record.view.resultSeq = event.seq
      record.view.provenance = {
        provider: event.data.provider,
        model: event.data.model,
      }
      if (event.data.usage !== undefined) record.view.usage = event.data.usage
      requests[record.index] = { ...record.view }
      continue
    }
    if (isEvent(event, 'compaction/end')) {
      const record = compactions.get(event.data.compactionId)
      if (record === undefined) continue
      record.view.completedAt = event.time
      record.view.status = event.data.error === undefined ? 'complete' : 'error'
      if (event.data.error !== undefined) record.view.error = event.data.error
      record.view.timing = timing(record.view.startedAt, null, event.time)
      requests[record.index] = { ...record.view }
      continue
    }
    if (
      isEvent(event, 'user/message') &&
      !isAppendSurfaceEvent(event) &&
      event.data.source.kind === 'context' &&
      event.data.source.producer === 'compaction'
    ) {
      for (const record of compactions.values()) {
        if (record.view.replacementSeq !== undefined) continue
        if (record.view.startSeq > event.seq) continue
        record.view.replacementSeq = event.seq
        requests[record.index] = { ...record.view }
      }
    }
  }
  return { requests, callSchemas }
}

/** The ordinary request of one step, when loaded. */
export function requestForStep(
  snapshot: RequestInspectionSnapshot,
  turn: number,
  step: number,
): AssistantRequestView | undefined {
  return snapshot.requests.find(
    (request): request is AssistantRequestView =>
      request.purpose === 'assistant' &&
      request.turn === turn &&
      request.step === step,
  )
}
