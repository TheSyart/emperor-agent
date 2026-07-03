/**
 * PlanContextBuilder (MIG-CTRL-013)。对齐 Python `agent/plans/context.py`。
 * 为当前 plan runtime 生成紧凑的模型可见附件（durable runtime state）。
 */
import { PlanStatus, PlanStepStatus, type PlanRecord, type PlanStep } from './models'
import type { PlanStore } from './store'

const ACTIVE_STATUSES = new Set<string>([PlanStatus.APPROVED, PlanStatus.EXECUTING, PlanStatus.FAILED])
const COMPLETED_HISTORY_MARKERS = [
  'plan history',
  'previous plan',
  'completed plan',
  '计划历史',
  '历史计划',
  '刚才的计划',
  '之前的计划',
  '回顾',
]

export class PlanContextBuilder {
  private readonly planStore: PlanStore
  private readonly maxChars: number
  private readonly filter: ((record: PlanRecord) => boolean) | null
  private readonly fullEveryTurns: number
  // Wave4.4 注入记忆：状态未变时逐轮降级为 sparse，避免长执行期每轮全量注入
  private lastSignature = ''
  private sparseTurns = 0
  private seenActivePlanIds = new Set<string>()

  constructor(planStore: PlanStore, opts?: { maxChars?: number; filter?: ((record: PlanRecord) => boolean) | null; fullEveryTurns?: number }) {
    this.planStore = planStore
    this.maxChars = opts?.maxChars ?? 4000
    this.filter = opts?.filter ?? null
    this.fullEveryTurns = Math.max(1, opts?.fullEveryTurns ?? 5)
  }

  messageFor(history: Array<Record<string, unknown>>): { role: string; content: string } | null {
    const record = this.latestScopedPlan()
    if (record === null) return null
    if (!ACTIVE_STATUSES.has(record.status)) {
      if (record.status !== PlanStatus.COMPLETED || !asksAboutCompletedPlan(history)) return null
    }
    const notice = this.oneShotNotice(record)
    const signature = planSignature(record)
    const changed = signature !== this.lastSignature
    let content: string
    if (changed || notice || this.sparseTurns >= this.fullEveryTurns - 1) {
      content = this.buildText(record)
      this.lastSignature = signature
      this.sparseTurns = 0
    } else {
      content = this.buildSparseText(record)
      this.sparseTurns += 1
    }
    if (!content) return null
    return { role: 'system', content: notice ? `${notice}\n${content}` : content }
  }

  /** 首次看到某计划进入活动态时的一次性提示：刚批准 vs 重启后恢复执行中。 */
  private oneShotNotice(record: PlanRecord): string {
    if (!ACTIVE_STATUSES.has(record.status)) return ''
    if (this.seenActivePlanIds.has(record.id)) return ''
    this.seenActivePlanIds.add(record.id)
    if (record.status === PlanStatus.APPROVED) {
      return '[PLAN_NOTICE] 计划已批准：现在可以修改文件并开始执行，请随执行进度同步更新 todo。'
    }
    return '[PLAN_NOTICE] 你正在恢复一个执行中的旧计划：先阅读下方计划状态，决定继续当前步骤还是调整。'
  }

  private buildSparseText(record: PlanRecord): string {
    const lines = [
      '[PLAN_RUNTIME_CONTEXT:SPARSE]',
      `plan_id: ${record.id}`,
      `status: ${record.status}`,
    ]
    const active = record.steps.filter((s) => s.status === PlanStepStatus.ACTIVE)
    for (const step of active.slice(0, 2)) lines.push(`active_step: ${step.id} ${step.title}`)
    const pending = record.steps.filter((s) => s.status === PlanStepStatus.PENDING || s.status === PlanStepStatus.BLOCKED)
    lines.push(`pending_steps: ${pending.length}`)
    lines.push('(plan state unchanged since the last full snapshot)')
    return truncate(lines.join('\n'), 600)
  }

  private latestScopedPlan(): PlanRecord | null {
    const plans = this.planStore.list().filter((record) => (this.filter ? this.filter(record) : true))
    if (!plans.length) return null
    return plans.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  }

  buildText(record: PlanRecord): string {
    const lines = [
      '[PLAN_RUNTIME_CONTEXT]',
      'This is durable runtime state. Use it to continue the approved plan; do not treat it as user input.',
      `plan_id: ${record.id}`,
      `title: ${record.title}`,
      `status: ${record.status}`,
    ]
    const active = record.steps.filter((s) => s.status === PlanStepStatus.ACTIVE)
    const failed = record.steps.filter((s) => s.status === PlanStepStatus.FAILED)
    const blocked = record.steps.filter((s) => s.status === PlanStepStatus.BLOCKED)
    const pending = record.steps.filter((s) => s.status === PlanStepStatus.PENDING || s.status === PlanStepStatus.BLOCKED)
    for (const step of active.slice(0, 3)) {
      lines.push(`active_step: ${step.id} [${step.status}] ${step.title}`)
      lines.push(...stepFiles(step, '  file'))
      lines.push(...stepCommands(step))
    }
    lines.push(`pending_steps: ${pending.length}`)
    for (const step of failed.slice(0, 5)) {
      lines.push(`failed_step: ${step.id} [${step.status}] ${step.title}`)
      const evidence = latestEvidence(step)
      if (Object.keys(evidence).length) {
        const summary = evidenceSummary(evidence)
        if (summary) lines.push(`  latest_evidence: ${summary}`)
        const artifact = artifactRef(evidence)
        if (artifact) lines.push(`  artifact: ${artifact}`)
      }
    }
    for (const step of blocked.slice(0, 5)) {
      lines.push(`blocked_step: ${step.id} [${step.status}] ${step.title}`)
      const reason = blockedReason(step)
      if (reason) lines.push(`  blocked_reason: ${reason}`)
    }
    for (const question of record.draft.openQuestions.slice(0, 5)) {
      const qid = String(question.id ?? '').trim()
      const text = String(question.question ?? '').trim()
      if (qid || text) lines.push(`open_question: ${qid} ${text}`.replace(/\s+$/, ''))
    }
    for (const discovery of record.draft.discoveries.slice(-8)) {
      const source = String(discovery.source ?? 'tool').trim()
      const summary = truncateInline(String(discovery.summary ?? '').trim(), 500)
      if (summary) lines.push(`discovery: ${source} ${summary}`)
      for (const path of discoveryFiles(discovery).slice(0, 5)) lines.push(`  discovery_file: ${path}`)
      for (const ref of discoveryEvidenceRefs(discovery).slice(0, 5)) lines.push(`  evidence_ref: ${ref}`)
    }
    for (const path of relevantFiles(record).slice(0, 20)) lines.push(`file: ${path}`)
    return truncate(lines.join('\n'), this.maxChars)
  }
}

/** 计划状态签名：id/状态/每步状态/未决问题与发现数量。变化即触发全量注入。 */
function planSignature(record: PlanRecord): string {
  return [
    record.id,
    record.status,
    record.steps.map((s) => `${s.id}:${s.status}`).join(','),
    record.draft.openQuestions.length,
    record.draft.discoveries.length,
  ].join('|')
}

function asksAboutCompletedPlan(history: Array<Record<string, unknown>>): boolean {
  let latest = ''
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    if (message.role !== 'user') continue
    latest = contentText(message.content).toLowerCase()
    break
  }
  return COMPLETED_HISTORY_MARKERS.some((marker) => latest.includes(marker))
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text')
      .map((item) => String((item as Record<string, unknown>).text ?? ''))
      .join('\n')
  }
  return String(content ?? '')
}

function latestEvidence(step: PlanStep): Record<string, unknown> {
  for (let i = step.evidence.length - 1; i >= 0; i--) {
    const item = step.evidence[i]
    if (item && typeof item === 'object') return item
  }
  return {}
}

function evidenceSummary(evidence: Record<string, unknown>): string {
  const text = String(
    evidence.summary ?? evidence.error ?? evidence.stderr_tail ?? evidence.stdout_tail ?? '',
  ).trim()
  return truncateInline(text, 500)
}

function artifactRef(evidence: Record<string, unknown>): string {
  for (const key of ['artifact_path', 'path']) {
    const value = String(evidence[key] ?? '').trim()
    if (value) return value
  }
  const artifact = evidence.artifact
  if (artifact && typeof artifact === 'object') return String((artifact as Record<string, unknown>).path ?? '').trim()
  return ''
}

function blockedReason(step: PlanStep): string {
  const evidence = latestEvidence(step)
  return truncateInline(String(evidence.blocked_reason ?? '').trim(), 500)
}

function stepFiles(step: PlanStep, prefix: string): string[] {
  return step.files.slice(0, 10).filter((path) => String(path).trim()).map((path) => `${prefix}: ${path}`)
}

function stepCommands(step: PlanStep): string[] {
  return step.commands.slice(0, 5).filter((command) => String(command).trim()).map((command) => `  command: ${command}`)
}

function relevantFiles(record: PlanRecord): string[] {
  const files: string[] = []
  files.push(...record.draft.relevantFiles)
  for (const discovery of record.draft.discoveries) {
    if (discovery && typeof discovery === 'object') {
      files.push(...discoveryFiles(discovery))
      const path = String(discovery.path ?? discovery.file ?? '').trim()
      if (path) files.push(path)
    }
  }
  for (const step of record.steps) files.push(...step.files)
  return dedupe(files)
}

function discoveryFiles(discovery: Record<string, unknown>): string[] {
  const files = discovery.files
  if (Array.isArray(files)) return files.map((item) => String(item).trim()).filter((item) => item)
  return []
}

function discoveryEvidenceRefs(discovery: Record<string, unknown>): string[] {
  const refs = discovery.evidence_refs ?? discovery.evidenceRefs
  if (Array.isArray(refs)) return refs.map((item) => String(item).trim()).filter((item) => item)
  return []
}

function dedupe(items: string[]): string[] {
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

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 80)).replace(/\s+$/, '') + '\n...[plan runtime context truncated]'
}

function truncateInline(text: string, limit: number): string {
  const compact = String(text ?? '').split(/\s+/).filter((p) => p).join(' ')
  if (compact.length <= limit) return compact
  return compact.slice(0, limit).replace(/\s+$/, '') + '...'
}
