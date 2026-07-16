import type {
  GoalEvidenceProjection,
  GoalGateProjection,
  RuntimeGoalPhase,
  RuntimeGoalStatus,
  RuntimeGoalSummary,
  RuntimePlanRecord,
} from '../types'

export type GoalCardAction = 'pause' | 'resume' | 'cancel'

export interface GoalAcceptanceRow {
  id: string
  description: string
  verdict: 'pass' | 'fail' | 'missing'
  evidence: string
}

export interface GoalCardViewModel {
  id: string
  outcome: string
  statusLabel: string
  phaseLabel: string
  cycleLabel: string
  acceptanceRows: GoalAcceptanceRow[]
  currentPlan: { id: string; title: string; activeStep: string | null } | null
  notice: string | null
  actions: GoalCardAction[]
  terminal: boolean
}

export interface GoalCardViewModelInput {
  goal: RuntimeGoalSummary
  plan?: RuntimePlanRecord | null
  evidence?: GoalEvidenceProjection | null
  gate?: GoalGateProjection | null
}

export interface GoalStatusBarViewModel {
  id: string
  outcome: string
  phaseLabel: string
  elapsedLabel: string
  actions: GoalCardAction[]
  terminal: boolean
}

const STATUS_LABELS: Record<RuntimeGoalStatus, string> = {
  draft: '待定义',
  active: '进行中',
  completed: '已完成',
  blocked: '已阻塞',
  cancelled: '已取消',
  stopped_by_policy: '已由策略停止',
}

const PHASE_LABELS: Record<RuntimeGoalPhase, string> = {
  contract: '定义验收',
  planning: '规划中',
  executing: '执行中',
  verifying: '核验中',
  awaiting_user: '等待用户处理',
  paused: '已暂停',
  terminal: '已结束',
}

export function toGoalCardViewModel({
  goal,
  plan,
  evidence,
  gate,
}: GoalCardViewModelInput): GoalCardViewModel {
  const terminal = isTerminalGoal(goal)
  return {
    id: goal.id,
    outcome: bounded(goal.outcome, 600),
    statusLabel: STATUS_LABELS[goal.status] || goal.status,
    phaseLabel: PHASE_LABELS[goal.phase] || goal.phase,
    cycleLabel: `第 ${Math.max(0, goal.cyclesUsed)} 轮`,
    acceptanceRows: acceptanceRows(goal, evidence),
    currentPlan: plan
      ? {
          id: plan.id,
          title: bounded(plan.title || '当前计划', 160),
          activeStep:
            plan.steps?.find((step) => step.status === 'in_progress')?.title ||
            null,
        }
      : null,
    notice: noticeForGoal(goal, gate),
    actions: actionsForGoal(goal),
    terminal,
  }
}

export function toGoalStatusBarViewModel(
  goal: RuntimeGoalSummary,
  now = Date.now(),
): GoalStatusBarViewModel {
  return {
    id: goal.id,
    outcome: bounded(goal.outcome, 600),
    phaseLabel: PHASE_LABELS[goal.phase] || goal.phase,
    elapsedLabel: goalElapsedLabel(goal.createdAt, goal.updatedAt, now),
    actions: actionsForGoal(goal),
    terminal: isTerminalGoal(goal),
  }
}

export function goalElapsedLabel(
  createdAt: string | undefined,
  updatedAt: string,
  now = Date.now(),
): string {
  const started = Date.parse(createdAt || updatedAt)
  if (!Number.isFinite(started) || !Number.isFinite(now) || now <= started)
    return '刚刚'
  const seconds = Math.max(0, Math.floor((now - started) / 1_000))
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60)
    return remainder ? `${minutes}分${remainder}秒` : `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  const minuteRemainder = minutes % 60
  return minuteRemainder ? `${hours}小时${minuteRemainder}分` : `${hours}小时`
}

export function renderGoalStatus(
  goals: RuntimeGoalSummary[],
  activeGoalId?: string | null,
): string {
  if (!goals.length) {
    return '当前会话还没有 Goal。使用 `/goal <outcome>` 启动。'
  }
  const ordered = goals
    .slice()
    .sort(
      (a, b) => Number(b.id === activeGoalId) - Number(a.id === activeGoalId),
    )
    .slice(0, 50)
  return [
    `## Goals (${ordered.length})`,
    '',
    ...ordered.map((goal) => {
      const marker = goal.id === activeGoalId ? ' · 当前' : ''
      return `- **${bounded(goal.outcome, 160)}**：${STATUS_LABELS[goal.status]} / ${PHASE_LABELS[goal.phase]} / 第 ${Math.max(0, goal.cyclesUsed)} 轮${marker}`
    }),
  ].join('\n')
}

export function isTerminalGoal(goal: RuntimeGoalSummary): boolean {
  return (
    goal.phase === 'terminal' ||
    goal.status === 'completed' ||
    goal.status === 'blocked' ||
    goal.status === 'cancelled' ||
    goal.status === 'stopped_by_policy'
  )
}

function actionsForGoal(goal: RuntimeGoalSummary): GoalCardAction[] {
  if (isTerminalGoal(goal)) return []
  if (goal.phase === 'paused') return ['resume', 'cancel']
  if (goal.phase === 'awaiting_user') return ['cancel']
  return ['pause', 'cancel']
}

function acceptanceRows(
  goal: RuntimeGoalSummary,
  latest?: GoalEvidenceProjection | null,
): GoalAcceptanceRow[] {
  const rows: GoalAcceptanceRow[] = (goal.acceptance.criteria ?? [])
    .slice(0, 20)
    .map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verdict: criterion.verdict,
      evidence: criterion.evidenceSummary || '',
    }))
  if (latest) {
    const hit = rows.find((row) => row.id === latest.criterionId)
    if (hit) {
      hit.evidence = bounded(latest.summary, 240)
    }
  }
  return rows
}

function noticeForGoal(
  goal: RuntimeGoalSummary,
  gate?: GoalGateProjection | null,
): string | null {
  if (goal.phase === 'awaiting_user')
    return '请先处理当前 Ask 或 Plan 卡片，Goal 会在交互完成后继续。'
  if (goal.phase === 'paused')
    return 'Goal 已暂停，可恢复后继续；重启不会自动写入。'
  if (goal.status === 'blocked') return 'Goal 已阻塞，保留现有证据供复核。'
  if (goal.status === 'cancelled') return 'Goal 已取消，终态不可恢复。'
  if (goal.status === 'stopped_by_policy') return 'Goal 已按安全策略停止。'
  if (goal.status === 'completed') return '所有终止门已通过，Goal 已完成。'
  if (gate && !gate.passed)
    return `终止门未通过：${gate.reasonCount} 项仍需处理。`
  return null
}

function bounded(value: string, limit: number): string {
  const text = String(value || '').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}
