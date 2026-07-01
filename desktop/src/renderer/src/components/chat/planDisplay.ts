import type { ControlInteraction, RuntimePlanRecord } from '../../types'

export type PlanTone = 'waiting' | 'running' | 'done' | 'error' | 'default'

export interface PlanStatusPresentation {
  label: string
  tone: PlanTone
  risk: string
}

export interface PlanProgressSummary {
  total: number
  done: number
  active: number
  failed: number
  label: string
}

export function planDisplayMarkdown(interaction: ControlInteraction, plan?: RuntimePlanRecord | null): string {
  return String(plan?.plan_markdown || plan?.planMarkdown || interaction.plan_markdown || '').trim()
}

export function planDecisionVisible(interaction: ControlInteraction): boolean {
  return interaction.status === 'waiting'
}

export function planStatusPresentation(interaction: ControlInteraction, plan?: RuntimePlanRecord | null): PlanStatusPresentation {
  const status = String(plan?.status || interaction.status || '')
  return {
    label: statusLabel(status),
    tone: statusTone(status),
    risk: riskLabel(interaction.risk_level),
  }
}

export function planProgressSummary(plan?: RuntimePlanRecord | null): PlanProgressSummary {
  const steps = plan?.steps || []
  const total = steps.length
  const done = steps.filter((step) => step.status === 'done' || step.status === 'completed').length
  const active = steps.filter((step) => step.status === 'active' || step.status === 'executing' || step.status === 'in_progress').length
  const failed = steps.filter((step) => step.status === 'failed' || step.status === 'blocked').length
  const parts = total ? [`${done}/${total} 完成`] : ['暂无步骤']
  if (active) parts.push(`${active} 执行中`)
  if (failed) parts.push(`${failed} 异常`)
  return { total, done, active, failed, label: parts.join(' · ') }
}

export function statusLabel(status?: string): string {
  const labels: Record<string, string> = {
    waiting: '等待批准',
    waiting_approval: '等待批准',
    approved: '已批准',
    executing: '执行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    pending: '待执行',
    active: '执行中',
    done: '已完成',
    blocked: '受阻',
    skipped: '已跳过',
  }
  const key = String(status || '').trim()
  return labels[key] || key || '未知'
}

function statusTone(status: string): PlanTone {
  if (status === 'waiting' || status === 'waiting_approval' || status === 'pending') return 'waiting'
  if (status === 'executing' || status === 'active' || status === 'approved') return 'running'
  if (status === 'completed' || status === 'done') return 'done'
  if (status === 'failed' || status === 'blocked' || status === 'cancelled') return 'error'
  return 'default'
}

function riskLabel(risk?: string): string {
  if (risk === 'high') return '高风险'
  if (risk === 'low') return '低风险'
  return '中风险'
}
