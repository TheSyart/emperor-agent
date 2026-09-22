import type { RuntimeGoalView } from '../types'

export type GoalCardAction = 'pause' | 'resume' | 'cancel'

export interface GoalStatusBarViewModel {
  id: string
  objective: string
  phaseLabel: string
  roundLabel: string
  elapsedLabel: string
  notice: string | null
  actions: GoalCardAction[]
  terminal: boolean
}

const PHASE_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成',
}

export function goalPhaseLabel(goal: RuntimeGoalView): string {
  return PHASE_LABELS[goal.phase] || goal.phase
}

export function goalRoundLabel(goal: RuntimeGoalView): string {
  const started = Math.max(0, Number(goal.roundsStarted || 0))
  const cap = Math.max(0, Number(goal.maxGoalRounds || 0))
  return cap ? `第 ${started}/${cap} 轮` : `第 ${started} 轮`
}

export function toGoalStatusBarViewModel(
  goal: RuntimeGoalView,
  now = Date.now(),
): GoalStatusBarViewModel {
  return {
    id: goal.id,
    objective: bounded(goal.objective, 600),
    phaseLabel: goalPhaseLabel(goal),
    roundLabel: goalRoundLabel(goal),
    elapsedLabel: goalElapsedLabel(goal.createdAt, goal.updatedAt, now),
    notice: noticeForGoal(goal),
    actions: actionsForGoal(goal),
    terminal: isTerminalGoal(goal),
  }
}

/** Elapsed since the goal was created (epoch ms timestamps). */
export function goalElapsedLabel(
  createdAt: number | undefined,
  updatedAt: number | undefined,
  now = Date.now(),
): string {
  const started = Number(createdAt || updatedAt || 0)
  if (!Number.isFinite(started) || started <= 0 || now <= started) return '刚刚'
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

export function renderGoalStatus(goal: RuntimeGoalView | null): string {
  if (!goal) return '当前会话还没有 Goal。使用 `/goal <objective>` 启动。'
  const lines = [
    '## Goal',
    '',
    `- **${bounded(goal.objective, 160)}**`,
    `- 状态：${goalPhaseLabel(goal)} · ${goalRoundLabel(goal)}`,
  ]
  if (goal.blockedReason?.message)
    lines.push(`- 阻塞原因：${bounded(goal.blockedReason.message, 240)}`)
  return lines.join('\n')
}

export function isTerminalGoal(goal: RuntimeGoalView): boolean {
  return goal.phase === 'complete'
}

function actionsForGoal(goal: RuntimeGoalView): GoalCardAction[] {
  if (isTerminalGoal(goal)) return []
  if (goal.phase === 'paused' || goal.phase === 'blocked')
    return ['resume', 'cancel']
  return ['pause', 'cancel']
}

function noticeForGoal(goal: RuntimeGoalView): string | null {
  if (goal.phase === 'blocked')
    return goal.blockedReason?.message
      ? `Goal 已阻塞：${bounded(goal.blockedReason.message, 240)}`
      : 'Goal 已阻塞，可恢复后继续。'
  if (goal.phase === 'paused') return 'Goal 已暂停，可恢复后继续。'
  return null
}

function bounded(value: string, limit: number): string {
  const text = String(value || '').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}
