/**
 * Runner 纯辅助函数 (MIG-CORE-008 支撑)。对齐 Python `agent/runner_helpers.py`。
 */
import type { ToolCallRequest } from '../providers/base'
import type { ToolResultObj } from '../tools/base'

const TODO_ICON: Record<string, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }

export function renderTodos(todos: Array<Record<string, unknown>>): string {
  const lines: string[] = []
  for (const t of todos) {
    const icon = TODO_ICON[String(t.status ?? 'pending')] ?? '[?]'
    let label = String(t.content ?? '')
    if (t.status === 'in_progress' && t.active_form) label = String(t.active_form ?? '')
    lines.push(`  ${icon} ${t.id}. ${label}`)
  }
  return lines.join('\n')
}

export interface MaxTurnsSummaryInput {
  maxTurns: number | null
  todos: Array<Record<string, unknown>>
  plan?: { title?: string; status?: string; steps?: Array<{ title?: string; status?: string }> } | null
  lastAssistantText?: string
}

const MAX_TURNS_SUMMARY_PENDING_LIMIT = 10
const MAX_TURNS_SUMMARY_PROGRESS_CHARS = 300

export function buildMaxTurnsSummary(input: MaxTurnsSummaryInput): string {
  const lines: string[] = [`（达到 max_turns=${input.maxTurns} 上限，自动收尾）`]
  const todos = input.todos ?? []
  if (todos.length) {
    const pending = todos.filter((t) => t.status !== 'completed')
    lines.push(`已完成 ${todos.length - pending.length}/${todos.length} 项任务。`)
    if (pending.length) {
      lines.push('未完成：')
      for (const todo of pending.slice(0, MAX_TURNS_SUMMARY_PENDING_LIMIT)) {
        lines.push(`- ${String(todo.content ?? todo.id ?? '')}`)
      }
      if (pending.length > MAX_TURNS_SUMMARY_PENDING_LIMIT) {
        lines.push(`- …另有 ${pending.length - MAX_TURNS_SUMMARY_PENDING_LIMIT} 项`)
      }
    }
  } else {
    lines.push('本轮未登记 todo 清单。')
  }
  const plan = input.plan ?? null
  if (plan) {
    const steps = plan.steps ?? []
    const doneSteps = steps.filter((step) => step.status === 'completed').length
    lines.push(`计划「${plan.title ?? ''}」状态 ${plan.status ?? ''}，步骤完成 ${doneSteps}/${steps.length}。`)
  }
  const progress = String(input.lastAssistantText ?? '').trim()
  if (progress) lines.push(`最近进展：${progress.slice(0, MAX_TURNS_SUMMARY_PROGRESS_CHARS)}`)
  lines.push('恢复方式：继续发送消息，我会从未完成项接着执行；如需详情可要求输出完整状态。')
  return lines.join('\n')
}

export function summarizeToolResult(content: string, limit = 560): string {
  const text = String(content ?? '').split(/\s+/).filter((p) => p).join(' ')
  if (text.length <= limit) return text
  return `${text.slice(0, limit).replace(/\s+$/, '')}...`
}

interface PlanDecisionLike {
  signals?: string[]
  reason?: string
  recommendedReadonlyScopes?: string[]
  behavior?: string
  toRuntimeContract?: () => Record<string, unknown>
}

export function planGuardMessage(call: ToolCallRequest, decision: PlanDecisionLike): string {
  const signals = (decision.signals ?? []).join(', ')
  const reason = String(decision.reason || 'high-impact work requires planning')
  const readonlyScopes = (decision.recommendedReadonlyScopes ?? []).join('; ')
  return [
    'Error: PLAN_GUARD_REQUIRED',
    `tool: ${call.name}`,
    `reason: ${reason}`,
    `signals: ${signals}`,
    `readonly_scopes: ${readonlyScopes}`,
    'Before using write or high-impact tools for this request, call the request_plan_mode tool to ask the user to switch into Plan mode, then perform read-only exploration, submit a concrete plan via propose_plan, and wait for user approval.',
  ].join('\n')
}

export function planDecisionContract(decision: PlanDecisionLike): Record<string, unknown> {
  let payload: Record<string, unknown>
  if (typeof decision.toRuntimeContract === 'function') {
    payload = decision.toRuntimeContract()
  } else {
    payload = {
      decision: decision.behavior ?? 'proceed',
      reason: decision.reason ?? '',
      triggers: decision.signals ?? [],
      suggested_questions: [],
      recommended_readonly_scopes: [],
    }
  }
  return {
    decision: String(payload.decision ?? 'proceed'),
    reason: String(payload.reason ?? ''),
    triggers: ((payload.triggers as unknown[]) ?? []).map((item) => String(item)),
    suggested_questions: ((payload.suggested_questions as unknown[]) ?? []).map((item) => String(item)),
    recommended_readonly_scopes: ((payload.recommended_readonly_scopes as unknown[]) ?? []).map((item) => String(item)),
  }
}

export function discoveryFiles(source: string, result: ToolResultObj): string[] {
  if (source === 'read_file') {
    const path = String(result.metadata.path ?? '').trim()
    return path ? [path] : result.artifacts.map((a) => a.path).filter((p) => p)
  }
  if (source === 'grep') {
    const mode = String(result.metadata.output_mode ?? '')
    const lines = result.modelContent
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() && !line.startsWith('('))
      .map((line) => line.trim())
    if (mode === 'content') {
      return dedupeStrings(
        lines.filter((line) => line.includes(':') && !/^\s/.test(line) && !line.startsWith('>')).map((line) => line.split(':', 1)[0]!),
      )
    }
    if (mode === 'count') {
      return dedupeStrings(lines.filter((line) => line.includes(': ')).map((line) => line.split(':', 1)[0]!))
    }
    if (result.modelContent.startsWith('No matches found')) return []
    return dedupeStrings(lines)
  }
  return []
}

export function discoveryEvidenceRefs(source: string, result: ToolResultObj, files: string[]): string[] {
  if (source === 'read_file') {
    const path = String(result.metadata.path ?? (files[0] ?? '')).trim()
    const start = result.metadata.line_start
    const end = result.metadata.line_end
    if (path && start && end) return [`${path}#L${start}-L${end}`]
    return path ? [path] : []
  }
  if (source === 'grep') {
    const pattern = String(result.metadata.pattern ?? '').trim()
    return pattern ? [`grep:${pattern}`] : []
  }
  return []
}

export function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const text = String(item ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

export function latestUserText(history: Array<Record<string, unknown>>): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    if (message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      return content
        .filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text')
        .map((item) => String((item as Record<string, unknown>).text ?? ''))
        .join('\n')
        .trim()
    }
    return String(content ?? '').trim()
  }
  return ''
}

export function contextUsedFromUsage(usage: Record<string, number>): number {
  const inputTokens = Number(usage.input ?? usage.prompt_tokens ?? 0) || 0
  const cacheRead = Number(usage.cache_read ?? usage.cache_read_input_tokens ?? 0) || 0
  const cacheCreate = Number(usage.cache_create ?? usage.cache_creation_input_tokens ?? 0) || 0
  return inputTokens + cacheRead + cacheCreate
}

function contentTextSize(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let total = 0
    for (const item of content) {
      if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
        total += String((item as Record<string, unknown>).text ?? '').length
      }
    }
    return total
  }
  return String(content ?? '').length
}

export function estimateMessagesTokens(messages: Array<Record<string, unknown>>): number {
  let totalChars = 0
  for (const msg of messages) {
    totalChars += contentTextSize(msg.content)
    for (const toolCall of (msg.tool_calls as unknown[]) ?? []) totalChars += String(JSON.stringify(toolCall)).length
  }
  return Math.max(1, Math.trunc(totalChars / 3))
}

export function optionalInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

export function controlInteractionEvent(interaction: Record<string, unknown>): Record<string, unknown> {
  const event = interaction.kind === 'ask' ? 'ask_request' : 'plan_draft'
  return { event, interaction }
}

export const SAFETY_REFUSAL_RE = /command refused by safety policy \(matches dangerous pattern: ([^)]+)\)/

// 单桶键：所有安全拒绝共用一个计数（B4.1）——per-pattern 计数会被
// 「node -e 被拒 → 换 python3 -c」这类换马甲重试绕过，实测于 2026-07-05 会话。
const SAFETY_REFUSAL_BUCKET = 'safety_refusal'

/** 一轮内任意第 2 次安全拒绝即向模型追加换策略的强化提示（P1-4 + B4.1）。 */
export function applyRepeatedRefusalNudge(counts: Map<string, number>, result: ToolResultObj): void {
  if (SAFETY_REFUSAL_RE.exec(result.modelContent) === null) return
  const count = (counts.get(SAFETY_REFUSAL_BUCKET) ?? 0) + 1
  counts.set(SAFETY_REFUSAL_BUCKET, count)
  if (count < 2) return
  result.modelContent +=
    `\n（该类尝试本轮已被拒绝 ${count} 次——包括更换命令形式的重试，必须改变策略：把代码写入临时脚本文件后执行，或运行现有测试/脚本文件；不要再重试同类命令。）`
}
