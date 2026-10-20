import { agentTitle, type AgentView } from '@emperor/core/runtime-contract'

type AncestryAgent = Pick<
  AgentView,
  'id' | 'rootSessionId' | 'parentAgentId' | 'title' | 'backend' | 'unavailable'
>
export interface AgentAncestry {
  text: string
  ancestors: AgentView[]
  /** Only a complete, same-root, acyclic chain supplies navigation targets. */
  parentId?: string
  unavailable?: string
}

/** Preserve actual parent evidence; a broken edge never gains a root prefix. */
export function agentAncestry(
  rootId: string,
  agent: AncestryAgent,
  agents: readonly AgentView[],
): AgentAncestry {
  const byId = new Map(agents.map((row) => [row.id, row]))
  const parts = [agentTitle(agent.title, agent.backend)]
  const ancestors: AgentView[] = []
  const seen = new Set([agent.id])
  let current: AncestryAgent = agent
  function broken(reason: string, id: string): AgentAncestry {
    const unavailable = `${reason} · ${id}${id !== agent.parentAgentId ? `（父级 ${agent.parentAgentId}）` : ''}`
    return {
      text: [unavailable, ...parts].join(' / '),
      ancestors: [],
      unavailable,
    }
  }
  while (true) {
    const id = current.parentAgentId
    if (
      current.rootSessionId !== rootId ||
      ['missing_parent', 'foreign_parent', 'conflicting_parent'].includes(
        current.unavailable ?? '',
      )
    )
      return broken('父级不可用', id)
    if (current.unavailable === 'cyclic_parent' || seen.has(id))
      return broken('父级循环', id)
    if (id === rootId)
      return {
        text: ['主会话', ...parts].join(' / '),
        ancestors,
        parentId: agent.parentAgentId,
      }
    const parent = byId.get(id)
    if (!parent || parent.rootSessionId !== rootId)
      return broken('父级不可用', id)
    if (
      parent.unavailable === 'missing_log' ||
      parent.unavailable === 'corrupt_log'
    )
      return broken('父级不可用', id)
    ancestors.unshift(parent)
    parts.unshift(agentTitle(parent.title, parent.backend))
    seen.add(id)
    current = parent
  }
}

const SUMMARY_ORDER = [
  ['running', '运行'],
  ['waiting', '等待'],
  ['completed', '完成'],
  ['failed', '失败'],
  ['interrupted', '中断'],
  ['unknown', '待确认'],
] as const satisfies ReadonlyArray<readonly [AgentView['phase'], string]>

/** The 子智能体 row's value (UI-S05): 「1 运行 · 3 完成 · 1 失败」. */
export function agentSummary(agents: readonly AgentView[]): string {
  const counts = new Map<string, number>()
  for (const agent of agents)
    counts.set(agent.phase, (counts.get(agent.phase) ?? 0) + 1)
  return SUMMARY_ORDER.filter(([phase]) => counts.get(phase))
    .map(([phase, label]) => `${counts.get(phase)} ${label}`)
    .join(' · ')
}

function active(agent: AgentView): boolean {
  return agent.phase === 'running' || agent.phase === 'waiting'
}

/** The faces stacked on the row: active first, then the latest; three at most. */
export function agentStack(agents: readonly AgentView[]): AgentView[] {
  return [...agents]
    .sort(
      (a, b) =>
        Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt,
    )
    .slice(0, 3)
}
