import type { SessionLogStore } from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import type { SubagentRecord } from '../../harness/subagent/manager'
import { ownDescriptor } from '../../harness/host/session-views'
import type { DelegationState } from '../../harness/delegation/fold'
import {
  agentTitle,
  type AgentView,
  type AgentPhase,
} from '../../runtime/agent-view'

type Started = SessionEvent<'subagent/started'>['data'] & {
  at: number
  stopReason?: string
  settledAt?: number
}
interface InternalFacts {
  id: string
  parent?: string
  description?: string
  parentCallId?: string
  createdAt: number
  updatedAt: number
  phase: AgentPhase
  stopReason?: string
  unavailable?: AgentView['unavailable']
  children: Started[]
}
interface Options {
  sessions: SessionLogStore
  /** Readable sidebar roots, including archived roots (listing is read-only). */
  roots(): string[]
  external(): DelegationState[]
  live(id: string): SubagentRecord | undefined
  waiting(id: string): boolean
  changed(event: { rootSessionId: string; revision: number }): void
}
const RELEVANT = new Set([
  'subagent/descriptor',
  'subagent/started',
  'subagent/settled',
  'turn/start',
  'turn/end',
])
function settledPhase(reason?: string): AgentPhase {
  return reason === 'completed'
    ? 'completed'
    : reason === 'interrupted' || !reason
      ? 'unknown'
      : 'failed'
}
function externalView(state: DelegationState): AgentView | undefined {
  const r = state.record
  if (
    !r ||
    !/^dlg-[a-zA-Z0-9-]+$/.test(r.id) ||
    !r.owner ||
    typeof r.owner.rootSessionId !== 'string' ||
    typeof r.owner.parentAgentId !== 'string' ||
    !['codex', 'claude-code'].includes(r.backend) ||
    !Number.isFinite(r.createdAt)
  )
    return undefined
  const run = r.currentRunId ? state.runs[r.currentRunId] : undefined
  const p = run?.phase
  return {
    id: r.id,
    kind: 'external',
    backend: r.backend,
    rootSessionId: r.owner.rootSessionId,
    parentAgentId: r.owner.parentAgentId,
    title: agentTitle(r.startSpec?.description, r.backend),
    phase:
      p === 'waiting_input'
        ? 'waiting'
        : p === 'completed'
          ? 'completed'
          : p === 'failed' || p === 'cancelled'
            ? 'failed'
            : p === 'outcome_unknown' || p === 'interrupted' || !p
              ? 'unknown'
              : 'running',
    ...(r.availability === 'needs_recovery'
      ? { unavailable: 'needs_recovery' as const }
      : {}),
    createdAt: r.createdAt,
    updatedAt: run?.finishedAt ?? run?.startedAt ?? r.createdAt,
    ...(r.currentRunId ? { currentRunId: r.currentRunId } : {}),
    ...(r.owner.parentCallId ? { parentCallId: r.owner.parentCallId } : {}),
    ...(p &&
    ['failed', 'cancelled', 'interrupted', 'outcome_unknown'].includes(p)
      ? { stopReason: run?.failureCode ?? p }
      : {}),
  }
}
/** Rebuildable in-memory read index. History is read once, then only on state events.
 * Text chunks/output projections never invalidate the index. No agents are opened.
 */
export class CoreAgentService {
  private initialized = false
  private readonly facts = new Map<string, InternalFacts>()
  private readonly externalRows = new Map<string, AgentView>()
  private rows: AgentView[] = []
  private readonly dirty = new Set<string>()
  private queued = false
  private readonly revisions = new Map<string, number>()
  constructor(private readonly options: Options) {}

  /** Drop the derived cache after startup reconciliation or explicit maintenance. */
  rebuild(): void {
    this.initialized = false
    this.facts.clear()
    this.externalRows.clear()
    this.dirty.clear()
    this.ensure()
  }
  list(rootSessionIds: string[]): { agents: AgentView[] } {
    this.ensure()
    this.refresh()
    const roots = new Set(rootSessionIds)
    return {
      agents: this.rows
        .filter((r) => roots.has(r.rootSessionId))
        .map((r) => ({ ...r })),
    }
  }
  sessionChanged(id: string, event?: SessionEvent): void {
    if (event && !RELEVANT.has(event.type)) return
    this.ensure()
    this.dirty.add(id)
    // A parent's start fact is emitted after the child's descriptor/attachment.
    if (
      event?.type === 'subagent/started' ||
      event?.type === 'subagent/settled'
    )
      this.dirty.add(event.data.subagentId)
    this.schedule()
  }
  externalChanged(state: DelegationState): void {
    this.ensure()
    const row = externalView(state)
    if (row) {
      const previous = this.externalRows.get(row.id)
      if (previous && signature(previous) === signature(row)) return
      row.updatedAt = Math.max(
        row.updatedAt,
        previous?.updatedAt ?? 0,
        Date.now(),
      )
      this.externalRows.set(row.id, row)
      this.schedule()
    }
  }
  private schedule(): void {
    if (this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      this.refresh()
    })
  }
  private ensure(): void {
    if (this.initialized) return
    this.initialized = true
    const ids = new Set([
      ...this.options.sessions.listStored(),
      ...this.options.sessions.list().map((s) => s.id),
    ])
    for (const id of ids) this.read(id)
    for (const state of this.options.external()) {
      const row = externalView(state)
      if (row) this.externalRows.set(row.id, row)
    }
    this.rows = this.build()
  }
  private read(id: string): void {
    try {
      const s = this.options.sessions.readSnapshot(id)
      const descriptor = ownDescriptor(s)
      const own = s.events.slice(s.header.seedLength ?? 0)
      const children = new Map<string, Started>()
      let phase: AgentPhase = 'unknown',
        stopReason: string | undefined
      let updatedAt = s.header.createdAt
      for (const e of own) {
        if (!RELEVANT.has(e.type)) continue
        updatedAt = e.time
        if (e.type === 'subagent/started')
          children.set(e.data.subagentId, { ...e.data, at: e.time })
        if (e.type === 'subagent/settled') {
          const child = children.get(e.data.subagentId)
          if (child) {
            child.stopReason = e.data.stopReason
            child.settledAt = e.time
          }
        }
        if (e.type === 'turn/start') {
          phase = this.options.live(id) ? 'running' : 'unknown'
          stopReason = 'interrupted'
        }
        if (e.type === 'turn/end') {
          stopReason =
            e.data.reason.kind === 'blocked' ? 'refusal' : e.data.reason.kind
          phase = settledPhase(stopReason)
        }
      }
      const live = this.options.live(id)
      if (live?.status === 'running') {
        phase = this.options.waiting(id) ? 'waiting' : 'running'
        stopReason = undefined
      } else if (live?.lastStopReason) {
        stopReason = live.lastStopReason
        phase = settledPhase(stopReason)
      }
      this.facts.set(id, {
        id,
        parent:
          descriptor?.parentSession ??
          (s.header.origin === 'subagent' ? s.header.parentSession : undefined),
        description: descriptor?.description,
        parentCallId: descriptor?.parentCallId,
        createdAt: s.header.createdAt,
        updatedAt,
        phase,
        stopReason,
        ...(descriptor &&
        s.header.parentSession &&
        descriptor.parentSession !== s.header.parentSession
          ? { unavailable: 'conflicting_parent' as const }
          : {}),
        children: [...children.values()],
      })
    } catch {
      this.facts.set(id, {
        id,
        createdAt: 0,
        updatedAt: 0,
        phase: 'unknown',
        unavailable: this.options.sessions.has(id)
          ? 'corrupt_log'
          : 'missing_log',
        children: [],
      })
    }
  }
  private refresh(): void {
    for (const id of this.dirty) this.read(id)
    this.dirty.clear()
    const next = this.build()
    const roots = new Set([...this.rows, ...next].map((r) => r.rootSessionId))
    const changed = [...roots].filter(
      (root) =>
        JSON.stringify(
          this.rows.filter((r) => r.rootSessionId === root).map(signature),
        ) !==
        JSON.stringify(
          next.filter((r) => r.rootSessionId === root).map(signature),
        ),
    )
    this.rows = next
    for (const rootSessionId of changed) {
      const revision = (this.revisions.get(rootSessionId) ?? 0) + 1
      this.revisions.set(rootSessionId, revision)
      this.options.changed({ rootSessionId, revision })
    }
  }
  private build(): AgentView[] {
    const roots = new Set(this.options.roots())
    const nodes = new Map(this.facts)
    // Start facts salvage missing/corrupt children, but never override the
    // child's own descriptor/header or copy relationships from a fork seed.
    for (const parent of this.facts.values())
      for (const started of parent.children) {
        if (roots.has(started.subagentId)) continue
        const existing = nodes.get(started.subagentId)
        if (
          existing &&
          existing.unavailable !== 'missing_log' &&
          existing.unavailable !== 'corrupt_log'
        )
          continue
        nodes.set(started.subagentId, {
          id: started.subagentId,
          parent: parent.id,
          description: started.description,
          parentCallId: started.callId,
          createdAt: started.at,
          updatedAt: started.settledAt ?? started.at,
          phase: 'unknown',
          stopReason: started.stopReason,
          unavailable: existing?.unavailable ?? 'missing_log',
          children: [],
        })
      }
    const rootOf = (id: string): string | undefined => {
      const seen = new Set<string>()
      let current: string | undefined = id
      while (current) {
        if (roots.has(current)) return current
        if (seen.has(current)) return undefined
        seen.add(current)
        current = nodes.get(current)?.parent
      }
      return undefined
    }
    const rows: AgentView[] = []
    for (const node of nodes.values()) {
      if (!node.parent || roots.has(node.id)) continue
      const root = rootOf(node.id)
      if (!root) continue
      const started = nodes
        .get(node.parent)
        ?.children.find((c) => c.subagentId === node.id)
      rows.push({
        id: node.id,
        kind: 'internal',
        backend: 'internal',
        rootSessionId: root,
        parentAgentId: node.parent,
        title: agentTitle(node.description ?? started?.description, 'internal'),
        phase:
          node.unavailable || node.stopReason || node.phase !== 'unknown'
            ? node.phase
            : settledPhase(started?.stopReason),
        createdAt: node.createdAt,
        updatedAt: Math.max(node.updatedAt, started?.settledAt ?? 0),
        ...((node.parentCallId ?? started?.callId)
          ? { parentCallId: node.parentCallId ?? started?.callId }
          : {}),
        ...((node.stopReason ?? started?.stopReason)
          ? { stopReason: node.stopReason ?? started?.stopReason }
          : {}),
        ...(node.unavailable ? { unavailable: node.unavailable } : {}),
      })
    }
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const row of this.externalRows.values())
      if (roots.has(row.rootSessionId)) {
        rows.push({ ...row })
        byId.set(row.id, row)
      }
    for (const row of rows) {
      if (row.kind !== 'external' || row.parentAgentId === row.rootSessionId)
        continue
      const seen = new Set([row.id])
      let parent = row.parentAgentId
      while (parent !== row.rootSessionId) {
        if (seen.has(parent)) {
          row.unavailable = 'cyclic_parent'
          break
        }
        seen.add(parent)
        const entry = byId.get(parent)
        if (!entry) {
          row.unavailable =
            rootOf(parent) && rootOf(parent) !== row.rootSessionId
              ? 'foreign_parent'
              : 'missing_parent'
          break
        }
        if (entry.rootSessionId !== row.rootSessionId) {
          row.unavailable = 'foreign_parent'
          break
        }
        parent = entry.parentAgentId
      }
    }
    return rows.sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    )
  }
}
function signature(row: AgentView): string {
  const { updatedAt: _updatedAt, ...value } = row
  return JSON.stringify(value)
}
