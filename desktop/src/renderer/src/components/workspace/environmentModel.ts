export interface EnvironmentSubagentGroups<T extends object> {
  active: T[]
  recent: T[]
  completedCount: number
  failedCount: number
  hiddenCount: number
}

const ACTIVE_STATUSES = new Set(['running', 'queued', 'pending'])
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'interrupted'])

/** Subagent 状态点色调(对齐 Codex 右栏彩点):运行脉冲/排队高亮/完成绿/失败红/取消灰 */
export function subagentStatusTone(value: unknown): string {
  const status =
    value && typeof value === 'object' && !Array.isArray(value)
      ? String((value as Record<string, unknown>)['status'] ?? '')
      : ''
  if (status === 'running') return 'running'
  if (status === 'queued' || status === 'pending') return 'pending'
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'cancelled' || status === 'interrupted') return 'cancelled'
  return 'unknown'
}

export function environmentSubagentGroups<T extends object>(
  agents: T[],
): EnvironmentSubagentGroups<T> {
  const active = agents.filter((agent) =>
    ACTIVE_STATUSES.has(String(field(agent, 'status') ?? '')),
  )
  const terminal = agents
    .filter((agent) => !active.includes(agent))
    .sort(
      (left, right) =>
        terminalTimestamp(right) - terminalTimestamp(left) ||
        String(field(right, 'id') ?? '').localeCompare(
          String(field(left, 'id') ?? ''),
        ),
    )
  const completedCount = terminal.filter(
    (agent) => String(field(agent, 'status') ?? '') === 'completed',
  ).length
  const failedCount = terminal.filter((agent) =>
    FAILED_STATUSES.has(String(field(agent, 'status') ?? '')),
  ).length
  const recent = terminal.slice(0, 3)
  return {
    active,
    recent,
    completedCount,
    failedCount,
    hiddenCount: Math.max(0, terminal.length - recent.length),
  }
}

function terminalTimestamp(agent: object): number {
  const raw = Number(
    field(agent, 'ended_at') ??
      field(agent, 'endedAt') ??
      field(agent, 'started_at') ??
      0,
  )
  return Number.isFinite(raw) ? raw : 0
}

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key]
}
