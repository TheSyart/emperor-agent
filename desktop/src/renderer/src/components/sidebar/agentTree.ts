/** Unified, root-scoped child cache. Only tree revisions invalidate reads. */
import { reactive } from 'vue'
import type { AgentView } from '@emperor/core/api'
import type { RouteLocationRaw } from 'vue-router'
import { core } from '../../api/http'

export const AGENT_TREE_STORAGE_KEY = 'emperor.sidebar.agents.v1'
export interface AgentTree {
  agents: AgentView[]
  byId: Record<string, AgentView>
  children: Record<string, AgentView[]>
  /** Disconnected/cyclic rows stay inspectable, with their actual parent shown. */
  unavailable: AgentView[]
}
type FetchAgents = (input: {
  rootSessionIds: string[]
}) => Promise<{ agents: AgentView[] }>
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
function record<T>(): Record<string, T> {
  return Object.create(null)
}
function active(agent: AgentView): boolean {
  return agent.phase === 'running' || agent.phase === 'waiting'
}
function recentFirst(a: AgentView, b: AgentView): number {
  return (
    Number(active(b)) - Number(active(a)) ||
    b.updatedAt - a.updatedAt ||
    a.id.localeCompare(b.id)
  )
}
export function buildAgentTree(
  rootSessionId: string,
  input: AgentView[],
): AgentTree {
  const byId = record<AgentView>()
  for (const agent of input) {
    if (agent.rootSessionId !== rootSessionId || agent.id === rootSessionId)
      continue
    if (!byId[agent.id] || byId[agent.id].updatedAt < agent.updatedAt)
      byId[agent.id] = agent
  }
  const agents = Object.values(byId).sort(recentFirst)
  const children = record<AgentView[]>()
  const unavailable: AgentView[] = []
  const cyclic = new Set<string>()
  for (const agent of agents) {
    const path: string[] = []
    const positions = new Map<string, number>()
    let id = agent.id
    while (id !== rootSessionId && byId[id] && !positions.has(id)) {
      positions.set(id, path.length)
      path.push(id)
      id = byId[id].parentAgentId
    }
    const cycleStart = positions.get(id)
    if (cycleStart !== undefined)
      for (const member of path.slice(cycleStart)) cyclic.add(member)
  }
  for (const agent of agents) {
    if (
      cyclic.has(agent.id) ||
      (agent.parentAgentId !== rootSessionId && !byId[agent.parentAgentId])
    )
      unavailable.push(agent)
    else (children[agent.parentAgentId] ??= []).push(agent)
  }
  return { agents, byId, children, unavailable }
}
export function visibleAgentChildren(
  agents: AgentView[],
  all: boolean,
): AgentView[] {
  const sorted = [...agents].sort(recentFirst)
  if (all) return sorted
  return sorted.slice(0, Math.max(5, sorted.filter(active).length))
}
export function agentLocation(agent: AgentView): RouteLocationRaw {
  return agent.kind === 'external'
    ? {
        name: 'external-agent',
        params: { sessionId: agent.rootSessionId, delegationId: agent.id },
      }
    : { name: 'chat', params: { sessionId: agent.id } }
}
function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
function booleanMap(value: unknown): Record<string, boolean> {
  const out = record<boolean>()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [id, enabled] of Object.entries(value))
      if (typeof enabled === 'boolean') out[id] = enabled
  }
  return out
}
export function createAgentTreeStore(
  fetchAgents: FetchAgents = (input) => core('agents.list', input),
  options: { debounceMs?: number; storage?: StorageLike } = {},
) {
  const trees = reactive(record<AgentTree>())
  const counts = reactive(record<number>())
  const errors = reactive(record<string>())
  const storage = options.storage ?? browserStorage()
  let persisted: { expanded?: unknown; showAll?: unknown } = {}
  try {
    persisted =
      JSON.parse(storage?.getItem(AGENT_TREE_STORAGE_KEY) || '{}') ?? {}
  } catch {
    /* Malformed state defaults to collapsed. */
  }
  const expanded = reactive(booleanMap(persisted.expanded))
  const showAll = reactive(booleanMap(persisted.showAll))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const generations = new Map<string, number>()
  const seen = new Map<string, Set<string>>()
  const revisions = new Map<string, number>()
  let roots = new Set<string>()
  function persist(): void {
    try {
      storage?.setItem(
        AGENT_TREE_STORAGE_KEY,
        JSON.stringify({ expanded, showAll }),
      )
    } catch {
      /* Storage is best effort. */
    }
  }
  function ancestors(tree: AgentTree, id: string): string[] {
    const path: string[] = []
    const visited = new Set([id])
    let parent = tree.byId[id]?.parentAgentId
    while (parent && !visited.has(parent)) {
      path.push(parent)
      visited.add(parent)
      parent = tree.byId[parent]?.parentAgentId
    }
    return path
  }
  function reveal(root: string, id: string): void {
    const tree = trees[root]
    if (!tree?.byId[id]) return
    expanded[root] = true
    for (const parent of ancestors(tree, id)) {
      expanded[parent] = true
      showAll[parent] = true
    }
    showAll[root] = true
    persist()
  }
  async function refresh(root: string): Promise<void> {
    if (!roots.has(root)) return
    const generation = (generations.get(root) ?? 0) + 1
    generations.set(root, generation)
    try {
      const { agents } = await fetchAgents({ rootSessionIds: [root] })
      if (!roots.has(root) || generations.get(root) !== generation) return
      const tree = buildAgentTree(root, agents)
      const previous = seen.get(root)
      if (previous) {
        for (const agent of tree.agents) {
          if (previous.has(agent.id)) continue
          if (expanded[root] !== false) expanded[root] = true
          for (const parent of ancestors(tree, agent.id))
            if (expanded[parent] !== false) expanded[parent] = true
        }
      }
      const nextSeen = previous ?? new Set<string>()
      for (const agent of tree.agents) nextSeen.add(agent.id)
      seen.set(root, nextSeen)
      trees[root] = tree
      counts[root] = tree.agents.filter(
        (agent) => agent.phase === 'running',
      ).length
      delete errors[root]
      persist()
    } catch {
      if (roots.has(root) && generations.get(root) === generation)
        errors[root] = '子智能体暂时无法加载'
    }
  }
  function sync(ids: readonly string[]): void {
    const next = new Set(ids.filter((id) => id && !id.startsWith('draft:')))
    for (const id of roots) {
      if (next.has(id)) continue
      generations.set(id, (generations.get(id) ?? 0) + 1)
      clearTimeout(timers.get(id))
      timers.delete(id)
      seen.delete(id)
      revisions.delete(id)
      delete trees[id]
      delete counts[id]
      delete errors[id]
    }
    const added = [...next].filter((id) => !roots.has(id))
    roots = next
    for (const id of added) void refresh(id)
  }
  function handleEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return
    const data = event as Record<string, unknown>
    if (
      data.event !== 'agent_tree_changed' ||
      typeof data.rootSessionId !== 'string' ||
      typeof data.revision !== 'number'
    )
      return
    const root = data.rootSessionId
    if (!roots.has(root) || data.revision <= (revisions.get(root) ?? -1)) return
    revisions.set(root, data.revision)
    generations.set(root, (generations.get(root) ?? 0) + 1)
    clearTimeout(timers.get(root))
    timers.set(
      root,
      setTimeout(() => {
        timers.delete(root)
        void refresh(root)
      }, options.debounceMs ?? 100),
    )
  }
  function toggle(id: string): void {
    expanded[id] = !expanded[id]
    persist()
  }
  function toggleShowAll(id: string): void {
    showAll[id] = !showAll[id]
    persist()
  }
  return {
    trees,
    counts,
    errors,
    expanded,
    showAll,
    refresh,
    sync,
    handleEvent,
    reveal,
    toggle,
    toggleShowAll,
  }
}
export type AgentTreeStore = ReturnType<typeof createAgentTreeStore>
let shared: AgentTreeStore | undefined
export function useAgentTree(): AgentTreeStore {
  return (shared ??= createAgentTreeStore())
}
