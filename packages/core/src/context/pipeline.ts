/**
 * context_pipeline: 微压缩 + 流水线编排 (MIG-CORE-004/005)。
 * 对齐 Python `agent/context_pipeline/microcompact.py` + `pipeline.py`。
 */
import { type OpenAiMsg, pairToolCalls } from './pairing'
import { DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET, DEFAULT_TOOL_RESULT_BUDGET, capToolResults, replaceAggregateToolResults, replaceLargeToolResults, shrinkOldToolResults, ToolResultStore } from './tool-results'

export { pairToolCalls, capToolResults, replaceAggregateToolResults, replaceLargeToolResults, shrinkOldToolResults, ToolResultStore }
export { DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET, DEFAULT_KEEP_RECENT, DEFAULT_TOOL_RESULT_BUDGET } from './tool-results'

export const DEFAULT_MICROCOMPACT_KEEP_RECENT = 12
export const DEFAULT_MICROCOMPACT_MIN_CHARS = 6000
export const DEFAULT_MICROCOMPACT_HEAD_CHARS = 1200
export const DEFAULT_MICROCOMPACT_TAIL_CHARS = 600

export type PlanContextProvider = (history: OpenAiMsg[]) => OpenAiMsg | null

export interface Projection {
  messages: OpenAiMsg[]
  filled: number
  dropped: number
  cappedCount: number
  shrunkCount: number
  report: Record<string, unknown>
}

export class ContextPipeline {
  readonly perCallLimit: number
  readonly keepRecent: number
  readonly replacementMinBytes: number
  readonly replacementPreviewChars: number
  readonly aggregateToolResultBudget: number
  readonly toolResultStore: ToolResultStore | null
  readonly toolResultLimits: Record<string, number>
  readonly planContextProvider: PlanContextProvider | null
  readonly microcompactKeepRecent: number
  readonly microcompactMinChars: number
  readonly microcompactHeadChars: number
  readonly microcompactTailChars: number

  constructor(opts?: {
    perCallLimit?: number
    keepRecent?: number
    toolResultStore?: ToolResultStore | null
    replacementMinBytes?: number
    replacementPreviewChars?: number
    aggregateToolResultBudget?: number
    toolResultLimits?: Record<string, number> | null
    planContextProvider?: PlanContextProvider | null
    microcompactKeepRecent?: number
    microcompactMinChars?: number
    microcompactHeadChars?: number
    microcompactTailChars?: number
  }) {
    this.perCallLimit = opts?.perCallLimit ?? DEFAULT_TOOL_RESULT_BUDGET
    this.keepRecent = opts?.keepRecent ?? 10
    this.toolResultStore = opts?.toolResultStore ?? null
    this.replacementMinBytes = opts?.replacementMinBytes ?? DEFAULT_TOOL_RESULT_BUDGET
    this.replacementPreviewChars = opts?.replacementPreviewChars ?? 1000
    this.aggregateToolResultBudget = opts?.aggregateToolResultBudget ?? DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET
    this.toolResultLimits = { ...(opts?.toolResultLimits ?? {}) }
    this.planContextProvider = opts?.planContextProvider ?? null
    this.microcompactKeepRecent = opts?.microcompactKeepRecent ?? DEFAULT_MICROCOMPACT_KEEP_RECENT
    this.microcompactMinChars = opts?.microcompactMinChars ?? DEFAULT_MICROCOMPACT_MIN_CHARS
    this.microcompactHeadChars = opts?.microcompactHeadChars ?? DEFAULT_MICROCOMPACT_HEAD_CHARS
    this.microcompactTailChars = opts?.microcompactTailChars ?? DEFAULT_MICROCOMPACT_TAIL_CHARS
  }

  project(history: OpenAiMsg[]): Projection {
    const [paired, filled, dropped] = pairToolCalls(history)
    let prepared = paired
    let perCallReplacements: Array<Record<string, unknown>> = []
    let aggregateReplacements: Array<Record<string, unknown>> = []
    let aggregateReports: Array<Record<string, unknown>> = []
    if (this.toolResultStore) {
      const [replaced, records] = replaceLargeToolResults(paired, this.toolResultStore, {
        minBytes: this.replacementMinBytes,
        previewChars: this.replacementPreviewChars,
        toolResultLimits: this.toolResultLimits,
      })
      prepared = replaced
      perCallReplacements = records.map((record) => ({ ...record, replacement_reason: 'per_call_limit' }))
      const [aggregatePrepared, aggregateRecords, reports] = replaceAggregateToolResults(prepared, this.toolResultStore, {
        budgetChars: this.aggregateToolResultBudget,
        previewChars: this.replacementPreviewChars,
      })
      prepared = aggregatePrepared
      aggregateReplacements = aggregateRecords.map((record) => ({ ...record, replacement_reason: 'aggregate_budget' }))
      aggregateReports = reports
    }
    const [capped, cappedCount] = capToolResults(prepared, this.perCallLimit)
    const [shrunk, shrunkCount] = shrinkOldToolResults(capped, this.keepRecent)
    const [microed, microcompactRecords] = this.microcompact(shrunk)
    const planContext = this.planContextProvider ? this.planContextProvider(history) : null
    const messages = planContext ? [planContext, ...microed] : microed
    const report = {
      paired_missing_tool_results: filled,
      dropped_orphan_tool_results: dropped,
      plan_context_attached: planContext ? 1 : 0,
      replaced_tool_results: perCallReplacements.length + aggregateReplacements.length,
      per_call_replaced_tool_results: perCallReplacements.length,
      aggregate_replaced_tool_results: aggregateReplacements.length,
      tool_result_replacements: [...perCallReplacements, ...aggregateReplacements],
      aggregate_tool_result_replacements: aggregateReplacements,
      aggregate_tool_result_budget: this.aggregateToolResultBudget,
      aggregate_tool_result_reports: aggregateReports,
      capped_tool_results: cappedCount,
      shrunk_old_tool_results: shrunkCount,
      microcompacted_messages: microcompactRecords.length,
      microcompact_records: microcompactRecords,
      // Transitional aliases for callers/tests that still read the simplified TS report.
      filled,
      dropped,
      capped: cappedCount,
      shrunk: shrunkCount,
    }
    return { messages, filled, dropped, cappedCount, shrunkCount, report }
  }

  /** 超阈值时压缩更早历史。对齐 `microcompact`。 */
  private microcompact(history: OpenAiMsg[]): [OpenAiMsg[], Array<Record<string, unknown>>] {
    const cutoff = Math.max(0, history.length - this.microcompactKeepRecent)
    if (cutoff <= 0) return [history.slice(), []]
    const records: Array<Record<string, unknown>> = []
    const out = history.map((msg, index) => {
      const content = msg.content
      if (!this.shouldMicrocompact(msg, content, index, cutoff)) return msg
      const text = String(content)
      const head = text.slice(0, Math.max(1, this.microcompactHeadChars))
      const tail = this.microcompactTailChars > 0 ? text.slice(-Math.max(0, this.microcompactTailChars)) : ''
      records.push({
        index,
        role: String(msg.role || ''),
        original_chars: text.length,
        kept_head_chars: head.length,
        kept_tail_chars: tail.length,
      })
      return {
        ...msg,
        content: microcompactMessage({
          role: String(msg.role || 'message'),
          originalChars: text.length,
          head,
          tail,
        }),
      }
    })
    return [out, records]
  }

  private shouldMicrocompact(msg: OpenAiMsg, content: unknown, index: number, cutoff: number): boolean {
    if (index >= cutoff) return false
    if (msg.role !== 'user' && msg.role !== 'assistant') return false
    if (msg.tool_calls) return false
    return typeof content === 'string' && content.length > this.microcompactMinChars
  }
}

function microcompactMessage(opts: { role: string; originalChars: number; head: string; tail: string }): string {
  const lines = [
    '[local_microcompact]',
    `role: ${opts.role}`,
    `original_chars: ${opts.originalChars}`,
    'This older text message was locally shortened before the model request.',
    '',
    'head:',
    opts.head,
  ]
  if (opts.tail) lines.push('', 'tail:', opts.tail)
  return lines.join('\n').trim()
}
