// UI-S14: one row per subagent in the conversation. A subagent's row says
// who it is (portrait, or the Claude Code / Codex logo), where it runs, its
// status with how long it has run or took, and, once it has ended, one line
// of what it reported or why it failed. The subagents one step sent out
// together form a group; the status bar above the composer lists the groups
// still at work. Everything here is pure: the rows come from the tool call
// that started the subagent (the conversation log) and, when the agent list
// knows it, from the same AgentView the environment card shows — that list
// decides the status, so the conversation, the status bar and the card agree.
import {
  agentSourceLabel,
  agentTitle,
  type AgentBackend,
  type AgentPhase,
  type AgentView,
} from '@emperor/core/runtime-contract'
import type { ToolChatData } from '../../conversation/types'
import { formatRunDuration } from './chatFormat'
import {
  argsOf,
  nativeAgentTarget,
  resultText,
  stringArg,
} from './tools/toolModel'

/** A call that starts a subagent (local, Claude Code or Codex). */
export function isDelegationCall(data: Pick<ToolChatData, 'name'>): boolean {
  return data.name === 'subagent' || data.name === 'subagent_fork'
}

export type SubagentState =
  | 'starting'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'background'
  | 'waiting'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'cancelled'
  | 'max-tokens'
  | 'refusal'
  | 'budget'
  | 'interrupted'
  | 'unknown'

/** running: neutral spinner; attention: waits for someone; error: failed. */
export type SubagentTone = 'running' | 'attention' | 'error' | 'muted' | 'done'

interface StateSpec {
  readonly label: string
  readonly tone: SubagentTone
  /** The AgentPhase it counts as (the environment card's categories). */
  readonly phase: AgentPhase
}

const STATES: Readonly<Record<SubagentState, StateSpec>> = {
  starting: { label: '启动中', tone: 'running', phase: 'running' },
  queued: { label: '等待调度', tone: 'running', phase: 'running' },
  preparing: { label: '正在准备', tone: 'running', phase: 'running' },
  running: { label: '运行中', tone: 'running', phase: 'running' },
  background: { label: '后台运行中', tone: 'running', phase: 'running' },
  waiting: { label: '等待回答', tone: 'attention', phase: 'waiting' },
  stopping: { label: '正在停止', tone: 'running', phase: 'running' },
  completed: { label: '已完成', tone: 'done', phase: 'completed' },
  failed: { label: '失败', tone: 'error', phase: 'failed' },
  aborted: { label: '已中止', tone: 'muted', phase: 'failed' },
  cancelled: { label: '已取消', tone: 'muted', phase: 'failed' },
  'max-tokens': { label: '输出超限', tone: 'error', phase: 'failed' },
  refusal: { label: '已拒绝', tone: 'error', phase: 'failed' },
  budget: { label: '达到费用上限', tone: 'error', phase: 'failed' },
  interrupted: { label: '已中断', tone: 'muted', phase: 'interrupted' },
  unknown: { label: '结果待确认', tone: 'attention', phase: 'unknown' },
}

export type SubagentFace =
  | { readonly kind: 'sprite'; readonly id: string }
  | { readonly kind: 'logo'; readonly backend: 'claude-code' | 'codex' }

export interface SubagentRowView {
  /** Stable key: the starting call, or the agent for a row from the list. */
  readonly key: string
  readonly callId?: string
  /** `sub-…` (local) or `dlg-…` (Claude Code / Codex); absent before start. */
  readonly agentId?: string
  readonly backend: AgentBackend
  readonly title: string
  /** 本地 / Claude Code / Codex. */
  readonly source: string
  readonly face: SubagentFace
  readonly state: SubagentState
  readonly label: string
  readonly tone: SubagentTone
  /** The environment card's category (counts). */
  readonly phase: AgentPhase
  /** Still at work (running, starting, waiting for an answer). */
  readonly active: boolean
  readonly startedAt: number | null
  /** Set once it has ended. */
  readonly endedAt: number | null
  /** One line after the end: the report's opening, or why it failed. */
  readonly summary: string
  /** Claude Code / Codex: the run 任务详情 opens. */
  readonly run?: { readonly delegationId: string; readonly runId: string }
}

const LOCAL_STOP: Readonly<Record<string, SubagentState>> = {
  completed: 'completed',
  error: 'failed',
  aborted: 'aborted',
  'max-tokens': 'max-tokens',
  refusal: 'refusal',
  interrupted: 'interrupted',
  budget: 'budget',
}

const EXTERNAL_PHASE: Readonly<Record<string, SubagentState>> = {
  queued: 'queued',
  preparing: 'preparing',
  running: 'running',
  waiting_input: 'waiting',
  cancelling: 'stopping',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  outcome_unknown: 'unknown',
}

function isActive(state: SubagentState): boolean {
  const phase = STATES[state].phase
  return phase === 'running' || phase === 'waiting'
}

/** The state the starting call alone tells. */
function callState(data: ToolChatData): SubagentState {
  const external = data.externalAgent
  if (external !== undefined) return EXTERNAL_PHASE[external.phase] ?? 'running'
  const sub = data.subagent
  if (sub === undefined) {
    if (data.status === 'running') return 'starting'
    if (data.status === 'interrupted') return 'interrupted'
    return data.result?.isError === true ? 'failed' : 'completed'
  }
  if (sub.status === 'running') return sub.background ? 'background' : 'running'
  return LOCAL_STOP[sub.stopReason ?? 'completed'] ?? 'completed'
}

/**
 * The agent list's phase decides; the call refines the words when it agrees
 * (a background run, an external run being prepared, a finer failure).
 */
function mergedState(call: SubagentState, agent: AgentView): SubagentState {
  const own = STATES[call].phase
  switch (agent.phase) {
    case 'running':
      return own === 'running' ? call : 'running'
    case 'waiting':
      return 'waiting'
    case 'completed':
      return 'completed'
    case 'failed':
      return own === 'failed' ? call : 'failed'
    case 'interrupted':
      return 'interrupted'
    case 'unknown':
      return 'unknown'
  }
}

/** The agent a call names: the started child, the run, a continued child. */
export function subagentAgentId(data: ToolChatData): string | undefined {
  return (
    data.subagent?.subagentId ??
    data.externalAgent?.delegationId ??
    nativeAgentTarget(data)
  )
}

function backendOf(data: ToolChatData, agent?: AgentView): AgentBackend {
  const backend =
    data.externalAgent?.backend ??
    agent?.backend ??
    stringArg(argsOf(data), 'backend')
  return backend === 'codex' || backend === 'claude-code' ? backend : 'internal'
}

function faceOf(backend: AgentBackend, id: string | undefined): SubagentFace {
  return backend === 'internal'
    ? { kind: 'sprite', id: id ?? '' }
    : { kind: 'logo', backend }
}

const MARKS = /[*_`#>~|]/gu

/**
 * The opening of a report on one line: markdown marks and links dropped,
 * lines joined, at most 240 characters (the row cuts it to its width).
 */
export function reportOpening(text: string): string {
  const flat = text
    .replace(/```[^\n]*\n?/gu, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
        .replace(MARKS, '')
        .trim(),
    )
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const chars = [...flat]
  return chars.length > 240 ? `${chars.slice(0, 239).join('')}…` : flat
}

/** Why a foreground local run failed: the diagnostic its call result carries. */
function localFailure(data: ToolChatData): string {
  if (data.result?.isError !== true) return ''
  const text = resultText(data)
  const diagnostic = /^Diagnostic:\s*(.+)$/mu.exec(text)?.[1]
  return diagnostic === undefined ? '' : reportOpening(diagnostic)
}

function summaryOf(data: ToolChatData, state: SubagentState): string {
  if (isActive(state)) return ''
  const external = data.externalAgent
  if (external !== undefined) {
    if (state === 'completed')
      return reportOpening(external.detail ?? external.text)
    return reportOpening(external.detail ?? '')
  }
  if (state === 'completed') return reportOpening(data.subagent?.text ?? '')
  if (STATES[state].phase === 'failed') return localFailure(data)
  return ''
}

/** Start and end the call recorded, when they fit the state shown. */
function callTimes(data: ToolChatData): {
  start: number | undefined
  end: number | undefined
} {
  const external = data.externalAgent
  if (external !== undefined)
    return { start: external.startedAt ?? data.time, end: external.finishedAt }
  const sub = data.subagent
  return {
    start: sub?.startedAt ?? data.time,
    end:
      sub?.settledAt ??
      (sub === undefined && data.status !== 'running'
        ? data.result?.time
        : undefined),
  }
}

function timesOf(
  data: ToolChatData,
  state: SubagentState,
  agent: AgentView | undefined,
): { startedAt: number | null; endedAt: number | null } {
  const active = isActive(state)
  const call = callTimes(data)
  const agrees = active ? call.end === undefined : call.end !== undefined
  if (agrees && call.start !== undefined)
    return { startedAt: call.start, endedAt: active ? null : call.end! }
  if (agent !== undefined && agent.createdAt > 0) {
    // An external run in progress started at its run (`updatedAt`).
    const start =
      active && agent.kind === 'external' && agent.updatedAt >= agent.createdAt
        ? agent.updatedAt
        : agent.createdAt
    return {
      startedAt: start,
      endedAt:
        active || agent.updatedAt < agent.createdAt ? null : agent.updatedAt,
    }
  }
  return { startedAt: call.start ?? null, endedAt: null }
}

function titleOf(data: ToolChatData, agent?: AgentView): string {
  const backend = backendOf(data, agent)
  const external = data.externalAgent
  if (external !== undefined) return agentTitle(external.title, backend)
  if (isDelegationCall(data))
    return agentTitle(
      data.subagent?.description ?? stringArg(argsOf(data), 'description'),
      backend,
    )
  return agentTitle(agent?.title, backend)
}

function viewOf(
  base: Omit<SubagentRowView, 'label' | 'tone' | 'phase' | 'active'>,
): SubagentRowView {
  const spec = STATES[base.state]
  return {
    ...base,
    label: spec.label,
    tone: spec.tone,
    phase: spec.phase,
    active: isActive(base.state),
  }
}

/**
 * The row of a call that started (or continued) a subagent. `agent` is the
 * same agent from the agent list, when the list has it.
 */
export function subagentRowOf(
  data: ToolChatData,
  agent?: AgentView,
): SubagentRowView {
  const agentId = subagentAgentId(data) ?? agent?.id
  const backend = backendOf(data, agent)
  const own = callState(data)
  const state = agent === undefined ? own : mergedState(own, agent)
  const external = data.externalAgent
  return viewOf({
    key: data.callId,
    callId: data.callId,
    ...(agentId === undefined ? {} : { agentId }),
    backend,
    title: titleOf(data, agent),
    source: agentSourceLabel(backend),
    face: faceOf(backend, agentId),
    state,
    ...timesOf(data, state, agent),
    summary: summaryOf(data, state),
    ...(external === undefined
      ? {}
      : {
          run: { delegationId: external.delegationId, runId: external.runId },
        }),
  })
}

const PHASE_STATE: Readonly<Record<AgentPhase, SubagentState>> = {
  running: 'running',
  waiting: 'waiting',
  completed: 'completed',
  failed: 'failed',
  interrupted: 'interrupted',
  unknown: 'unknown',
}

/** A row from the agent list alone (a running subagent with no loaded row). */
export function subagentRowOfAgent(agent: AgentView): SubagentRowView {
  const state = PHASE_STATE[agent.phase]
  const active = isActive(state)
  const known = agent.createdAt > 0 && agent.updatedAt >= agent.createdAt
  return viewOf({
    key: agent.id,
    agentId: agent.id,
    backend: agent.backend,
    title: agentTitle(agent.title, agent.backend),
    source: agentSourceLabel(agent.backend),
    face: faceOf(agent.backend, agent.id),
    state,
    startedAt: known
      ? active && agent.kind === 'external'
        ? agent.updatedAt
        : agent.createdAt
      : null,
    endedAt: known && !active ? agent.updatedAt : null,
    summary: '',
  })
}

/**
 * The status as the row reads it: 「运行中 · 49 秒」, 「已完成 · 用时 1 分
 * 12 秒」, 「失败 · 用时 14 秒」; waiting and unknown states stand alone.
 */
export function subagentStatusText(row: SubagentRowView, now: number): string {
  if (row.startedAt === null) return row.label
  if (row.active) {
    if (row.state === 'waiting') return row.label
    return `${row.label} · ${formatRunDuration(Math.max(0, now - row.startedAt))}`
  }
  if (row.state === 'unknown' || row.endedAt === null) return row.label
  return `${row.label} · 用时 ${formatRunDuration(Math.max(0, row.endedAt - row.startedAt))}`
}

/** At most three faces, the ones at work first. */
export function subagentFaces(
  rows: readonly SubagentRowView[],
): SubagentRowView[] {
  return [
    ...rows.filter((row) => row.active),
    ...rows.filter((row) => !row.active),
  ].slice(0, 3)
}

const COUNT_ORDER: ReadonlyArray<readonly [AgentPhase, string]> = [
  ['running', '运行中'],
  ['waiting', '等待回答'],
  ['completed', '完成'],
  ['failed', '失败'],
  ['interrupted', '中断'],
  ['unknown', '结果待确认'],
]

function counts(rows: readonly SubagentRowView[], skip?: AgentPhase): string[] {
  const tally = new Map<AgentPhase, number>()
  for (const row of rows) tally.set(row.phase, (tally.get(row.phase) ?? 0) + 1)
  return COUNT_ORDER.filter(
    ([phase]) => phase !== skip && (tally.get(phase) ?? 0) > 0,
  ).map(([phase, label]) => `${tally.get(phase)} ${label}`)
}

/**
 * A group's head: 「派出 11 个子智能体 · 8 运行中 · 2 失败」 while any is at
 * work, 「11 个子智能体 · 9 完成 · 2 失败 · 用时 6 分 12 秒」 after.
 */
export function subagentGroupHead(rows: readonly SubagentRowView[]): {
  title: string
  counts: string
} {
  const active = rows.some((row) => row.active)
  const parts = counts(rows)
  if (!active) {
    const starts = rows.flatMap((row) =>
      row.startedAt === null ? [] : [row.startedAt],
    )
    const ends = rows.flatMap((row) =>
      row.endedAt === null ? [] : [row.endedAt],
    )
    if (starts.length > 0 && ends.length === rows.length)
      parts.push(
        `用时 ${formatRunDuration(Math.max(0, Math.max(...ends) - Math.min(...starts)))}`,
      )
  }
  return {
    title: active
      ? `派出 ${rows.length} 个子智能体`
      : `${rows.length} 个子智能体`,
    counts: parts.join(' · '),
  }
}

// ── status bar ──────────────────────────────────────────────────────────

/**
 * What ChatTimeline reports (its `agents` event): the subagent rows of the
 * loaded window — `agents:<first call key>` and their calls' node keys —
 * and the ids of those on screen.
 */
export interface TimelineAgents {
  readonly groups: readonly {
    readonly id: string
    readonly members: readonly string[]
  }[]
  readonly visible: readonly string[]
}

/** A subagent row of the conversation flow (`agents:<first call key>`). */
export interface SubagentFlowGroup {
  readonly id: string
  readonly rows: readonly SubagentRowView[]
}

export interface SubagentDockState {
  readonly shown: boolean
  /** The groups still at work, then running subagents with no loaded row. */
  readonly rows: readonly SubagentRowView[]
  /** The group 「回到列表 ↑」 goes back to (the latest still at work). */
  readonly target: string | null
}

/**
 * The status bar shows while subagents of this conversation are at work and
 * none of the groups they belong to is on screen. It lists those groups
 * (the ones at work first) and running subagents whose row is not loaded.
 */
export function subagentDockState(input: {
  readonly groups: readonly SubagentFlowGroup[]
  readonly orphans: readonly SubagentRowView[]
  readonly visible: ReadonlySet<string> | readonly string[]
}): SubagentDockState {
  const visible = new Set(input.visible)
  const working = input.groups.filter((group) =>
    group.rows.some((row) => row.active),
  )
  const seen = new Set<string>()
  const listed: SubagentRowView[] = []
  for (const row of [
    ...working.flatMap((group) => group.rows),
    ...input.orphans.filter((row) => row.active),
  ]) {
    const identity = row.agentId ?? row.key
    if (seen.has(identity)) continue
    seen.add(identity)
    listed.push(row)
  }
  const shown =
    listed.some((row) => row.active) &&
    !working.some((group) => visible.has(group.id))
  if (!shown) return { shown: false, rows: [], target: null }
  return {
    shown,
    rows: [
      ...listed.filter((row) => row.active),
      ...listed.filter((row) => !row.active),
    ],
    target: working.at(-1)?.id ?? null,
  }
}

/** The bar's head: 「8 个子智能体运行中」 and the other counts. */
export function subagentDockHead(rows: readonly SubagentRowView[]): {
  title: string
  counts: string
} {
  const running = rows.filter((row) => row.phase === 'running').length
  if (running > 0)
    return {
      title: `${running} 个子智能体运行中`,
      counts: counts(rows, 'running').join(' · '),
    }
  const waiting = rows.filter((row) => row.phase === 'waiting').length
  return {
    title: `${waiting} 个子智能体等待回答`,
    counts: counts(rows, 'waiting').join(' · '),
  }
}

/** Where a row leads: the child's conversation, or the run's page. */
export function subagentHref(
  row: Pick<SubagentRowView, 'agentId' | 'backend'>,
  rootSessionId: string,
): string | null {
  if (row.agentId === undefined || row.agentId === '') return null
  return row.backend === 'internal'
    ? `/chat/${encodeURIComponent(row.agentId)}`
    : `/chat/${encodeURIComponent(rootSessionId)}/agents/${encodeURIComponent(row.agentId)}`
}
