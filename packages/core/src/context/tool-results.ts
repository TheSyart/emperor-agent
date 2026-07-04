/**
 * context_pipeline: 工具结果截断/摘要 (MIG-CORE-003)。
 * 对齐 Python `agent/context_pipeline/tool_results.py`。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { OpenAiMsg } from './pairing'

export const DEFAULT_KEEP_RECENT = 10
export const DEFAULT_MIN_BYTES = 1500
export const DEFAULT_TOOL_RESULT_BUDGET = 8000
export const DEFAULT_TOOL_RESULT_TAIL = 200
export const DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET = 24_000

/** 截断标记的单一来源；tools 层与 context 层共用同一文案。 */
export function truncationNotice(totalChars: number): string {
  return `...[truncated, total ${totalChars} chars]...`
}

export interface ToolResultReplacementRecord {
  turn_id: string
  tool_call_id: string
  tool_name: string
  artifact_path: string
  preview: string
  original_chars: number
}

export function contentTextSize(content: unknown): number {
  const c = content
  if (typeof c === 'string') return c.length
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return sum
      const b = block as Record<string, unknown>
      return b.type === 'text' ? sum + String(b.text ?? '').length : sum
    }, 0)
  }
  return JSON.stringify(c ?? '').length
}

function messageContentSize(msg: OpenAiMsg): number {
  return contentTextSize(msg.content)
}

/** 单条结果硬截断：保留 head(100) + tail + 截断标记。对齐 `cap_tool_results`。 */
export function capToolResults(
  history: OpenAiMsg[],
  perCallLimit: number = DEFAULT_TOOL_RESULT_BUDGET,
  tailChars: number = DEFAULT_TOOL_RESULT_TAIL,
): [OpenAiMsg[], number] {
  let capped = 0
  const headChars = Math.max(1, perCallLimit - tailChars)
  const out = history.map((msg) => {
    if (msg.role !== 'tool') return msg
    const text = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '')
    if (text.length <= perCallLimit) return msg
    capped++
    const head = text.slice(0, headChars)
    const tail = text.slice(-tailChars)
    return { ...msg, content: `${head}\n${truncationNotice(text.length)}\n${tail}` }
  })
  return [out, capped]
}

/** 旧的大工具结果 → 摘要行。对齐 `shrink_old_tool_results`。 */
export function shrinkOldToolResults(
  history: OpenAiMsg[],
  keepRecent: number = DEFAULT_KEEP_RECENT,
  replacementMinBytes: number = DEFAULT_MIN_BYTES,
): [OpenAiMsg[], number] {
  if (history.length <= keepRecent) return [history.slice(), 0]
  const toolIndices: number[] = []
  history.forEach((m, i) => { if (m.role === 'tool') toolIndices.push(i) })
  const cutoff = history.length - keepRecent
  let shrunk = 0
  const out = history.map((msg, i) => {
    if (msg.role !== 'tool' || i >= cutoff) return msg
    if (messageContentSize(msg) <= replacementMinBytes) return msg
    shrunk++
    const name = msg.name ?? ''
    const size = messageContentSize(msg)
    return { ...msg, content: `[shrunk] ${name} → ${size} chars omitted` }
  })
  return [out, shrunk]
}

export class ToolResultStore {
  readonly root: string
  readonly dir: string

  constructor(root: string) {
    this.root = resolve(root)
    this.dir = join(this.root, 'memory', 'tool-results')
    mkdirSync(this.dir, { recursive: true })
  }

  persistLargeResult(
    turnId: string,
    toolCallId: string,
    toolName: string,
    content: string,
    opts: { previewChars?: number } = {},
  ): ToolResultReplacementRecord {
    const digest = createHash('sha256').update(`${turnId}:${toolCallId}:${content}`).digest('hex').slice(0, 16)
    const artifact = join(this.dir, `${digest}.txt`)
    const meta = join(this.dir, `${digest}.json`)
    if (!existsSync(artifact)) writeFileSync(artifact, content, 'utf8')
    const record: ToolResultReplacementRecord = {
      turn_id: turnId,
      tool_call_id: toolCallId,
      tool_name: toolName,
      artifact_path: relative(this.root, artifact),
      preview: content.slice(0, opts.previewChars ?? 1000),
      original_chars: content.length,
    }
    if (!existsSync(meta)) writeFileSync(meta, JSON.stringify(record, null, 2), 'utf8')
    if (existsSync(meta)) {
      try {
        const parsed = JSON.parse(readFileSync(meta, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ToolResultReplacementRecord
      } catch {
        // Fall through to the freshly computed record if metadata is corrupt.
      }
    }
    return record
  }

  /** 按 ref（root 相对路径）回读完整输出；路径围栏拒绝逃出 tool-results 目录的 ref。 */
  readArtifact(ref: string): string {
    const trimmed = String(ref || '').trim()
    if (!trimmed) throw new Error('tool result ref is required')
    const resolved = resolve(this.root, trimmed)
    if (resolved !== this.dir && !resolved.startsWith(this.dir + '/')) {
      throw new Error('tool result ref escapes the tool-results directory')
    }
    if (!existsSync(resolved)) throw new Error('tool result artifact not found')
    return readFileSync(resolved, 'utf8')
  }
}

export function replaceLargeToolResults(
  history: OpenAiMsg[],
  store: ToolResultStore,
  opts: {
    minBytes?: number
    previewChars?: number
    toolResultLimits?: Record<string, number> | null
  } = {},
): [OpenAiMsg[], ToolResultReplacementRecord[]] {
  const replacements: ToolResultReplacementRecord[] = []
  const minBytes = opts.minBytes ?? DEFAULT_TOOL_RESULT_BUDGET
  const limits = opts.toolResultLimits ?? {}
  const out = history.map((msg) => {
    const copied = { ...msg }
    const toolName = String(copied.name || copied.tool_call_id || 'tool')
    const limit = limitForTool(toolName, limits, minBytes)
    if (copied.role !== 'tool' || contentTextSize(copied.content) <= limit) return copied
    const content = String(copied.content || '')
    const toolCallId = String(copied.tool_call_id || copied.id || 'unknown_tool_call')
    const record = store.persistLargeResult(
      String(copied.turn_id || 'unknown_turn'),
      toolCallId,
      toolName,
      content,
      { previewChars: opts.previewChars ?? 1000 },
    )
    replacements.push(record)
    return { ...copied, content: replacementMessage(record) }
  })
  return [out, replacements]
}

export function replaceAggregateToolResults(
  history: OpenAiMsg[],
  store: ToolResultStore,
  opts: {
    budgetChars?: number
    previewChars?: number
  } = {},
): [OpenAiMsg[], ToolResultReplacementRecord[], Array<Record<string, unknown>>] {
  const budgetChars = opts.budgetChars ?? DEFAULT_AGGREGATE_TOOL_RESULT_BUDGET
  if (!Number.isInteger(budgetChars) || budgetChars <= 0) return [history.slice(), [], []]

  const out = history.map((msg) => ({ ...msg }))
  const groups = new Map<string, {
    key: string
    total: number
    entries: Array<{
      index: number
      size: number
      content: string
      toolCallId: string
      toolName: string
      turnId: string
      replaceable: boolean
    }>
  }>()
  let currentBatchKey: string | null = null
  let currentBatchTurnId: string | null = null

  out.forEach((msg, index) => {
    if (msg.role === 'assistant') {
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
      currentBatchKey = toolCalls.length > 0 ? `assistant:${String(msg.turn_id || msg.id || index)}` : null
      currentBatchTurnId = toolCalls.length > 0 ? String(msg.turn_id || msg.id || currentBatchKey) : null
      return
    }
    if (msg.role !== 'tool') {
      currentBatchKey = null
      currentBatchTurnId = null
      return
    }

    const explicitTurnId = String(msg.turn_id || '').trim()
    const groupKey = explicitTurnId ? `turn:${explicitTurnId}` : currentBatchKey ?? `tool:${index}`
    const turnId = explicitTurnId || currentBatchTurnId || 'unknown_turn'
    const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '')
    const size = contentTextSize(msg.content)
    const toolCallId = String(msg.tool_call_id || msg.id || `tool_${index}`)
    const toolName = String(msg.name || toolCallId || 'tool')
    const group = groups.get(groupKey) ?? { key: groupKey, total: 0, entries: [] }
    group.total += size
    group.entries.push({
      index,
      size,
      content,
      toolCallId,
      toolName,
      turnId,
      replaceable: size > 0 && !isToolResultReplacement(content),
    })
    groups.set(groupKey, group)
  })

  const replacements: ToolResultReplacementRecord[] = []
  const groupReports: Array<Record<string, unknown>> = []
  for (const group of groups.values()) {
    if (group.total <= budgetChars) continue
    let currentTotal = group.total
    const replacedCallIds: string[] = []
    const candidates = group.entries
      .filter((entry) => entry.replaceable)
      .sort((a, b) => (b.size - a.size) || (a.index - b.index))

    for (const entry of candidates) {
      if (currentTotal <= budgetChars) break
      const record = store.persistLargeResult(entry.turnId, entry.toolCallId, entry.toolName, entry.content, {
        previewChars: opts.previewChars ?? 1000,
      })
      const replacement = replacementMessage(record)
      const replacementSize = contentTextSize(replacement)
      if (replacementSize >= entry.size) continue
      out[entry.index] = { ...out[entry.index]!, content: replacement }
      currentTotal = currentTotal - entry.size + replacementSize
      replacements.push(record)
      replacedCallIds.push(entry.toolCallId)
    }

    if (replacedCallIds.length) {
      groupReports.push({
        group_key: group.key,
        budget_chars: budgetChars,
        original_chars: group.total,
        projected_chars: currentTotal,
        replaced_tool_call_ids: replacedCallIds,
      })
    }
  }

  return [out, replacements, groupReports]
}

function limitForTool(toolName: string, limits: Record<string, number>, fallback: number): number {
  const value = limits[toolName]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function isToolResultReplacement(content: string): boolean {
  return content.trimStart().startsWith('[tool_result_replacement]')
}

function replacementMessage(record: ToolResultReplacementRecord): string {
  return [
    '[tool_result_replacement]',
    'Tool result stored outside the model context.',
    `tool_name: ${record.tool_name}`,
    `tool_call_id: ${record.tool_call_id}`,
    `artifact_path: ${record.artifact_path}`,
    `original_chars: ${record.original_chars}`,
    'Use read_file on artifact_path if the exact full output is required.',
    '',
    'preview:',
    record.preview,
  ].join('\n').trim()
}
