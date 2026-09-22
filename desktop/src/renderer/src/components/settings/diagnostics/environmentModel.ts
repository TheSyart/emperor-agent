import type { CoreOperationResult } from '@emperor/core/api'

export type EnvironmentStatusPayload =
  CoreOperationResult<'environment.getStatus'>
export type EnvironmentTool =
  EnvironmentStatusPayload['status']['tools'][number]

export type EnvironmentTone = 'ok' | 'warn' | 'error' | 'muted' | 'running'

export interface EnvironmentToolSection {
  id: EnvironmentTool['category']
  title: string
  tools: EnvironmentTool[]
}

const CATEGORY_ORDER: EnvironmentTool['category'][] = [
  'base',
  'project',
  'skill',
  'large-prerequisite',
]

const CATEGORY_LABELS: Record<EnvironmentTool['category'], string> = {
  base: '基础工具',
  project: '当前项目',
  skill: 'Skill 依赖',
  'large-prerequisite': '大型依赖',
}

export function environmentToolSections(
  payload: EnvironmentStatusPayload | null | undefined,
): EnvironmentToolSection[] {
  if (!payload) return []
  return CATEGORY_ORDER.map((id) => ({
    id,
    title: CATEGORY_LABELS[id],
    tools: payload.status.tools.filter((tool) => tool.category === id),
  })).filter((section) => section.tools.length)
}

export function environmentToolTone(
  status: EnvironmentTool['status'],
): EnvironmentTone {
  if (status === 'ready') return 'ok'
  if (status === 'installing' || status === 'awaiting_user') return 'running'
  if (status === 'failed' || status === 'blocked') return 'error'
  if (status === 'missing' || status === 'version_mismatch') return 'warn'
  return 'muted'
}

export function environmentToolStatusLabel(
  status: EnvironmentTool['status'],
): string {
  const labels: Record<EnvironmentTool['status'], string> = {
    ready: '已就绪',
    missing: '缺失',
    version_mismatch: '版本不匹配',
    installing: '安装中',
    awaiting_user: '等待系统确认',
    failed: '失败',
    unsupported: '不支持',
    blocked: '被阻止',
  }
  return labels[status]
}

export function environmentJobStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned: '待开始',
    running: '安装中',
    awaiting_user: '等待系统确认',
    cancelling: '正在取消',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  }
  return labels[status] || status || '未知'
}

export function environmentJobTone(status: string): EnvironmentTone {
  if (status === 'completed') return 'ok'
  if (['running', 'planned', 'cancelling', 'awaiting_user'].includes(status))
    return 'running'
  if (status === 'partial' || status === 'cancelled') return 'warn'
  if (status === 'failed' || status === 'interrupted') return 'error'
  return 'muted'
}
