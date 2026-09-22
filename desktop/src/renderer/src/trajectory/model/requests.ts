// Session-global request numbering with per-request and cumulative usage
// (ported from the dsh TrajectoryView / TrajectoryTable request inspector
// model). Requests are numbered in log order across ordinary generations
// and compactions; the usage of every request (including compactions)
// accumulates into the session-cumulative figure.
import type { TokenUsage } from '@emperor/core/runtime-contract'
import type { RequestTiming } from '../../conversation/requestInspection'
import type {
  TrajectoryAssistantNode,
  TrajectoryEventNode,
  TrajectoryRequestConfig,
  TrajectoryRequestNotice,
  TrajectoryRequestView,
} from './contract'

/** Disjoint provider token buckets for one request or a session prefix. */
export interface TrajectoryUsage {
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

/** Request-inspector fields shared by ordinary generation and compaction. */
interface TrajectoryRequestNumberBase {
  /** Request anchor event sequence. */
  seq?: number
  /** Ledger group the request belongs to (`Step N` / `Compaction N`). */
  group: string
  /** 1-based session-global request number. */
  number: number
  status?: 'complete' | 'running' | 'error'
  startedAt?: number
  completedAt?: number | null
  error?: string
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
  resultSeq?: number
  provider?: string
  model?: string
  requestConfig?: TrajectoryRequestConfig
  usage?: TrajectoryUsage
  cumulativeUsage?: TrajectoryUsage
  /** Emperor: route context window of the request. */
  contextWindow?: number
  /** Emperor: decode timing of the request. */
  timing?: RequestTiming
  /** Emperor: fallback / cost-cap notices. */
  notices?: readonly TrajectoryRequestNotice[]
}

/** One purpose-discriminated request identity with its session-global number. */
export type TrajectoryRequestNumber = TrajectoryRequestNumberBase &
  (
    | { purpose?: 'assistant'; turn: number; step: number }
    | { purpose: 'compaction'; turn: number | null; step: 0 }
  )

/** Convert provider usage into disjoint buckets. */
export function trajectoryRequestUsage(
  value: Partial<TokenUsage> | undefined,
): TrajectoryUsage | undefined {
  if (value === undefined) return undefined
  return {
    ...(value.inputTokens === undefined ? {} : { input: value.inputTokens }),
    ...(value.cacheReadTokens === undefined
      ? {}
      : { cacheRead: value.cacheReadTokens }),
    ...(value.cacheWriteTokens === undefined
      ? {}
      : { cacheWrite: value.cacheWriteTokens }),
    ...(value.outputTokens === undefined ? {} : { output: value.outputTokens }),
    ...(value.reasoningTokens === undefined
      ? {}
      : { reasoning: value.reasoningTokens }),
  }
}

function sumBucket(
  total: number | undefined,
  value: number | undefined,
): number | undefined {
  return total === undefined && value === undefined
    ? undefined
    : (total ?? 0) + (value ?? 0)
}

/** Add one request's usage to a running total (buckets stay absent until seen). */
export function addTrajectoryUsage(
  total: TrajectoryUsage | undefined,
  usage: TrajectoryUsage | undefined,
): TrajectoryUsage | undefined {
  if (usage === undefined) return total
  const next: TrajectoryUsage = {}
  const input = sumBucket(total?.input, usage.input)
  const cacheRead = sumBucket(total?.cacheRead, usage.cacheRead)
  const cacheWrite = sumBucket(total?.cacheWrite, usage.cacheWrite)
  const output = sumBucket(total?.output, usage.output)
  const reasoning = sumBucket(total?.reasoning, usage.reasoning)
  if (input !== undefined) next.input = input
  if (cacheRead !== undefined) next.cacheRead = cacheRead
  if (cacheWrite !== undefined) next.cacheWrite = cacheWrite
  if (output !== undefined) next.output = output
  if (reasoning !== undefined) next.reasoning = reasoning
  return next
}

/** Prompt tokens including cache reads/writes, when any bucket is reported. */
export function trajectoryUsageInputTotal(
  usage: TrajectoryUsage,
): number | undefined {
  if (
    usage.input === undefined &&
    usage.cacheRead === undefined &&
    usage.cacheWrite === undefined
  )
    return undefined
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

/**
 * Number every request of the loaded window in log order.
 * Assistant messages whose request started outside the window still get a
 * number (anchored at the message).
 * @param nodes - Finalized trajectory nodes.
 * @param requests - Trajectory requests (ascending startSeq).
 */
export function deriveTrajectoryRequestNumbers(
  nodes: readonly TrajectoryEventNode[],
  requests: readonly TrajectoryRequestView[],
): readonly TrajectoryRequestNumber[] {
  const assistantsByStep = new Map<string, TrajectoryAssistantNode>()
  for (const node of nodes) {
    if (node.kind !== 'assistant' || node.step <= 0) continue
    assistantsByStep.set(stepKey(node.turn, node.step), node)
  }
  const requestsByStep = new Set(
    requests
      .filter((request) => request.purpose === 'assistant')
      .map((request) => stepKey(request.turn ?? 0, request.step)),
  )
  const ordered = [
    ...requests.map((request) => ({
      seq: request.startSeq,
      request,
      node:
        request.purpose === 'assistant'
          ? assistantsByStep.get(stepKey(request.turn, request.step))
          : undefined,
    })),
    ...[...assistantsByStep.entries()].flatMap(([key, node]) =>
      requestsByStep.has(key)
        ? []
        : [{ seq: node.seq, request: undefined, node }],
    ),
  ].sort((left, right) => left.seq - right.seq)

  const numbered: TrajectoryRequestNumber[] = []
  let cumulativeUsage: TrajectoryUsage | undefined
  for (const [index, entry] of ordered.entries()) {
    const usage = trajectoryRequestUsage(
      entry.request?.usage ?? entry.node?.usage,
    )
    cumulativeUsage = addTrajectoryUsage(cumulativeUsage, usage)
    const request = entry.request
    if (request?.purpose === 'compaction') {
      numbered.push({
        seq: request.startSeq,
        turn: request.turn,
        step: 0,
        group: `Compaction ${request.startSeq}`,
        number: index + 1,
        purpose: 'compaction',
        status: request.status,
        startedAt: request.startedAt,
        completedAt: request.completedAt,
        timing: request.timing,
        ...(request.error === undefined ? {} : { error: request.error }),
        resultSeq: request.startSeq,
        ...(request.provenance === undefined
          ? {}
          : {
              provider: request.provenance.provider,
              model: request.provenance.model,
            }),
        ...(request.requestConfig === undefined
          ? {}
          : { requestConfig: request.requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
      })
      continue
    }
    const node = entry.node
    const turn = request?.turn ?? node?.turn
    const step = request?.step ?? node?.step
    if (turn === undefined || step === undefined) continue
    const provider =
      request?.provenance?.provider ??
      node?.provenance?.provider ??
      request?.route?.provider
    const model =
      request?.provenance?.model ??
      node?.provenance?.model ??
      request?.route?.model
    const requestConfig = request?.requestConfig ?? node?.requestConfig
    numbered.push({
      seq: entry.seq,
      turn,
      step,
      group: `Step ${step}`,
      number: index + 1,
      ...(request === undefined
        ? {}
        : {
            status: request.status,
            startedAt: request.startedAt,
            completedAt: request.completedAt,
            timing: request.timing,
          }),
      ...(request?.error === undefined ? {} : { error: request.error }),
      ...(request?.resultSeq === undefined
        ? {}
        : { resultSeq: request.resultSeq }),
      ...(request?.retry === undefined ? {} : { retry: request.retry }),
      ...(request?.maxRetries === undefined
        ? {}
        : { maxRetries: request.maxRetries }),
      ...(request?.retryDelayMs === undefined
        ? {}
        : { retryDelayMs: request.retryDelayMs }),
      ...(request?.route?.contextWindow === undefined
        ? {}
        : { contextWindow: request.route.contextWindow }),
      ...(request?.notices === undefined ? {} : { notices: request.notices }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(requestConfig === undefined ? {} : { requestConfig }),
      ...(usage === undefined ? {} : { usage }),
      ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
    })
  }
  return numbered
}

/** Key of a request within the ledger (turn + group title). */
export function trajectoryRequestKey(
  turn: number | null,
  group: string,
): string {
  return `${turn}\u0000${group}`
}

/** Index request numbers by ledger key. */
export function indexTrajectoryRequestNumbers(
  numbers: readonly TrajectoryRequestNumber[],
): ReadonlyMap<string, TrajectoryRequestNumber> {
  return new Map(
    numbers.map((request) => [
      trajectoryRequestKey(request.turn, request.group),
      request,
    ]),
  )
}
