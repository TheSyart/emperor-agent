// Process rows (UI-S03; DSH-22 grouped work, DSH-23 preparing calls): the
// virtual rows ChatTimeline renders. Within one turn, the steps between the
// prompt and the answer — thinking, tool calls, delegated work, retries,
// compaction and, with 显示系统步骤, context injections and hooks — fold into
// one `process` row; the prompt, the answer, the files card, the turn tail
// and the notices stay rows of their own. The running turn's trailing steps
// form a live row, and calls the model is still writing (no `tool/call` yet)
// join it as preparing members. A step is one row of the expanded list: a
// thinking block, a tool call, a system or notice row; narration is not.
import type { ProcessDisplay } from '../../composables/useUiPreferences'
import { conversationContextKey, deepEqual } from '../../conversation/assembler'
import type { ConversationTimeline } from '../../conversation/locationIndex'
import type {
  AssistantBlock,
  AssistantChatNode,
  ChatNode,
  ChatSnapshot,
  ToolChatData,
} from '../../conversation/types'
import { formatRunDuration } from './chatFormat'
import { toolView } from './tools/registry'
import {
  argsOf,
  firstLine,
  metaOf,
  partialJsonObject,
  stringArg,
  truncate,
} from './tools/toolModel'

/** One entry of a process row's expanded list. */
export type ProcessMember =
  /** A chat node; `reasoningOnly`: only the answer's thinking blocks. */
  | {
      readonly kind: 'node'
      readonly key: string
      readonly reasoningOnly?: true
    }
  /** Tool call `index` of assistant `key`, still being written (DSH-23). */
  | { readonly kind: 'preparing'; readonly key: string; readonly index: number }

export interface ProcessRow {
  readonly kind: 'process'
  /** `process:<turn>:<n>`, stable while the turn's groups keep their order. */
  readonly id: string
  readonly turn: number
  readonly members: readonly ProcessMember[]
  /** Rows of the expanded list that count as steps. */
  readonly steps: number
  /** The open turn's trailing process, its answer not started yet. */
  readonly live: boolean
  readonly startedAt: number | null
  /** Null while live or when the end is outside the window. */
  readonly endedAt: number | null
}

export interface NodeRow {
  readonly kind: 'node'
  /** The chat node key. */
  readonly id: string
  /** An answer whose thinking moved into the process row before it. */
  readonly answerOnly?: true
  /** An assistant row directly followed by its turn tail. */
  readonly closing?: true
}

export type TimelineRow = NodeRow | ProcessRow

export interface TimelineRowsInput {
  readonly order: readonly string[]
  readonly nodes: ReadonlyMap<string, ChatNode>
  readonly timeline: ConversationTimeline
  /** The running turn, if any. */
  readonly openTurn: number | null
  /** 设置 › 常规 › 开发者 › 显示系统步骤. */
  readonly showSystemSteps: boolean
}

// ── steps ─────────────────────────────────────────────────────────────

/**
 * Whether AssistantStep shows a thinking block: it has text, or it is the
 * last block of a step still streaming (the live placeholder).
 */
export function reasoningShown(
  blocks: readonly AssistantBlock[],
  index: number,
  running: boolean,
): boolean {
  const block = blocks[index]
  if (block?.kind !== 'reasoning') return false
  return block.text.trim() !== '' || (running && index === blocks.length - 1)
}

function reasoningSteps(node: AssistantChatNode): number {
  const running = node.data.status === 'running'
  let count = 0
  for (let index = 0; index < node.data.blocks.length; index++)
    if (reasoningShown(node.data.blocks, index, running)) count++
  return count
}

/** Visible answer material: text, an image, an unknown block. */
function hasAnswer(node: AssistantChatNode): boolean {
  return node.data.blocks.some((block) =>
    block.kind === 'text'
      ? block.text.trim() !== ''
      : block.kind === 'image' || block.kind === 'other',
  )
}

function memberSteps(
  member: ProcessMember,
  nodes: ReadonlyMap<string, ChatNode>,
): number {
  if (member.kind === 'preparing') return 1
  const node = nodes.get(member.key)
  if (node === undefined) return 0
  return node.kind === 'assistant' ? reasoningSteps(node) : 1
}

// ── grouping ──────────────────────────────────────────────────────────

const SYSTEM_KINDS = new Set(['context', 'hook'])
const PROCESS_KINDS = new Set([
  'assistant',
  'tool',
  'workflowRun',
  'retry',
  'fallback',
  'compaction',
  'context',
  'hook',
])

function inProcess(node: ChatNode): boolean {
  return node.turn !== null && PROCESS_KINDS.has(node.kind)
}

const toolKey = (callId: string) => conversationContextKey('tool', callId)
const assistantKey = (turn: number, step: number) =>
  conversationContextKey('assistant', `${turn}:${step}`)

/** Calls of the open turn's current step that have no tool row yet. */
function preparingMembers(input: TimelineRowsInput): ProcessMember[] {
  if (input.openTurn === null) return []
  const turn = input.timeline.turns.get(input.openTurn)
  let step = -1
  for (const location of turn?.steps ?? [])
    if (location.step > step) step = location.step
  if (step < 0) return []
  const key = assistantKey(input.openTurn, step)
  const node = input.nodes.get(key)
  if (node?.kind !== 'assistant' || node.data.status === 'interrupted')
    return []
  const members: ProcessMember[] = []
  node.data.blocks.forEach((block, index) => {
    if (block.kind !== 'tool-call') return
    if (block.callId !== '' && input.nodes.has(toolKey(block.callId))) return
    if (block.callId === '' && block.name === '') return
    members.push({ kind: 'preparing', key, index })
  })
  return members
}

function nodeTime(node: ChatNode | undefined): number | null {
  if (node === undefined) return null
  switch (node.kind) {
    case 'retry':
      return node.data.current.time
    case 'turnTail':
      return node.data.endedAt
    case 'turnFiles':
    case 'delegationResult':
    case 'workflowRun':
      return null
    default:
      return node.data.time
  }
}

/** Rows of one snapshot (see {@link timelineRows}). */
export function timelineRowsOf(
  snapshot: Pick<ChatSnapshot, 'order' | 'nodes' | 'timeline' | 'turnStatus'>,
  options: { readonly showSystemSteps: boolean },
  previous?: readonly TimelineRow[],
): readonly TimelineRow[] {
  return timelineRows(
    {
      order: snapshot.order,
      nodes: snapshot.nodes,
      timeline: snapshot.timeline,
      openTurn: snapshot.turnStatus?.turn ?? null,
      showSystemSteps: options.showSystemSteps,
    },
    previous,
  )
}

/**
 * Virtual rows of the chat flow. `previous` lends identity: an unchanged
 * row keeps its object, and an unchanged list returns `previous` itself, so
 * the scroller re-renders only what moved.
 */
export function timelineRows(
  input: TimelineRowsInput,
  previous?: readonly TimelineRow[],
): readonly TimelineRow[] {
  const { nodes, openTurn } = input
  const rows: TimelineRow[] = []
  const groupsPerTurn = new Map<number, number>()
  let preparing = preparingMembers(input)
  let run: ChatNode[] = []

  const emitGroup = (
    turn: number,
    members: ProcessMember[],
    live: boolean,
  ): void => {
    const ordinal = groupsPerTurn.get(turn) ?? 0
    groupsPerTurn.set(turn, ordinal + 1)
    let steps = 0
    for (const member of members) steps += memberSteps(member, nodes)
    const location = input.timeline.turns.get(turn)
    const first = members[0]
    rows.push({
      kind: 'process',
      id: `process:${turn}:${ordinal}`,
      turn,
      members,
      steps,
      live,
      startedAt:
        ordinal === 0 && location?.start !== undefined
          ? location.start.time
          : first === undefined
            ? null
            : nodeTime(nodes.get(first.key)),
      endedAt: null,
    })
  }

  /**
   * `trailing`: no later row of the same turn follows the run; `last`: the
   * end of the flow, where calls written after the turn's last row land.
   */
  const flush = (trailing: boolean, last = false): void => {
    const first = run[0]
    if (first === undefined && !(last && preparing.length > 0)) return
    const turn = (first?.turn ?? openTurn) as number
    const open = turn === openTurn && trailing
    const members: ProcessMember[] = run.map((node) => ({
      kind: 'node',
      key: node.key,
    }))
    if (open && preparing.length > 0) {
      members.push(...preparing)
      preparing = []
    }
    let lastTool = -1
    members.forEach((member, index) => {
      if (member.kind === 'preparing') lastTool = index
      else {
        const kind = nodes.get(member.key)?.kind
        if (kind === 'tool' || kind === 'workflowRun') lastTool = index
      }
    })
    const isAnswer = (member: ProcessMember | undefined): boolean => {
      if (member?.kind !== 'node') return false
      const node = nodes.get(member.key)
      return node?.kind === 'assistant' && hasAnswer(node)
    }
    if (lastTool < 0) {
      // No tool call: the open turn's thinking is live until its answer
      // starts; otherwise the rows stay as they are.
      if (open && !members.some(isAnswer)) emitGroup(turn, members, true)
      else for (const node of run) rows.push({ kind: 'node', id: node.key })
      run = []
      return
    }
    const grouped: ProcessMember[] = []
    const answers: NodeRow[] = []
    members.forEach((member, index) => {
      if (index > lastTool && member.kind === 'node' && isAnswer(member)) {
        const node = nodes.get(member.key) as AssistantChatNode
        const thinking = reasoningSteps(node) > 0
        if (thinking)
          grouped.push({ kind: 'node', key: member.key, reasoningOnly: true })
        answers.push(
          thinking
            ? { kind: 'node', id: member.key, answerOnly: true }
            : { kind: 'node', id: member.key },
        )
      } else grouped.push(member)
    })
    emitGroup(turn, grouped, open && answers.length === 0)
    rows.push(...answers)
    run = []
  }

  for (const key of input.order) {
    const node = nodes.get(key)
    if (node === undefined) continue
    if (!input.showSystemSteps && SYSTEM_KINDS.has(node.kind)) continue
    if (inProcess(node)) {
      if (run.length > 0 && run[0]?.turn !== node.turn) flush(true)
      run.push(node)
      continue
    }
    const sameTurn = run.length > 0 && run[0]?.turn === node.turn
    flush(!sameTurn)
    rows.push({ kind: 'node', id: key })
  }
  flush(true, true)
  // Calls written after the turn's last visible row (a steering prompt...).
  if (preparing.length > 0) flush(true, true)

  return stabilize(finish(rows, input), previous)
}

/** Durations and the closing flag, which need the rows around each row. */
function finish(rows: TimelineRow[], input: TimelineRowsInput): TimelineRow[] {
  const { nodes } = input
  // Whether a later process row of the same turn follows (one backward pass).
  const later = new Array<boolean>(rows.length).fill(false)
  const seen = new Set<number>()
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row?.kind !== 'process') continue
    later[index] = seen.has(row.turn)
    seen.add(row.turn)
  }
  return rows.map((row, index) => {
    if (row.kind === 'node') {
      const next = rows[index + 1]
      const closing =
        nodes.get(row.id)?.kind === 'assistant' &&
        next?.kind === 'node' &&
        nodes.get(next.id)?.kind === 'turnTail'
      return closing ? { ...row, closing: true } : row
    }
    if (row.live) return row
    const location = input.timeline.turns.get(row.turn)
    let endedAt: number | null = null
    if (
      !later[index] &&
      location?.status === 'closed' &&
      location.end !== undefined
    )
      endedAt = location.end.time
    else {
      const next = rows[index + 1]
      const node = next?.kind === 'node' ? nodes.get(next.id) : undefined
      if (node !== undefined && node.turn === row.turn) endedAt = nodeTime(node)
    }
    return endedAt === null ? row : { ...row, endedAt }
  })
}

function stabilize(
  rows: TimelineRow[],
  previous: readonly TimelineRow[] | undefined,
): readonly TimelineRow[] {
  if (previous === undefined) return rows
  const byId = new Map(previous.map((row) => [row.id, row]))
  let same = rows.length === previous.length
  const next = rows.map((row, index) => {
    const old = byId.get(row.id)
    const kept = old !== undefined && deepEqual(old, row) ? old : row
    if (kept !== previous[index]) same = false
    return kept
  })
  return same ? previous : next
}

// ── lookups ───────────────────────────────────────────────────────────

/** Row index of every node key, member key and row id. */
export function rowIndexOf(rows: readonly TimelineRow[]): Map<string, number> {
  const index = new Map<string, number>()
  rows.forEach((row, position) => {
    index.set(row.id, position)
    if (row.kind === 'process')
      for (const member of row.members)
        if (member.kind === 'node' && !index.has(member.key))
          index.set(member.key, position)
  })
  return index
}

/** The chat node a row stands for in `order` (the scrubber's first-visible). */
export function rowNodeKey(row: TimelineRow): string {
  return row.kind === 'node' ? row.id : (row.members[0]?.key ?? row.id)
}

/**
 * Expansion-store key and default of a process row for the 处理过程
 * preference. 完成后收起 keeps the running phase on its own key, so a list
 * opened to watch the steps folds when the turn completes; 始终收起 leaves
 * that to the reader.
 */
export function processExpansionKey(
  row: Pick<ProcessRow, 'id' | 'live'>,
  display: ProcessDisplay,
): { key: string; fallback: boolean } {
  if (display === 'collapse-when-done' && row.live)
    return { key: `${row.id}:live`, fallback: false }
  return { key: row.id, fallback: display === 'expanded' }
}

// ── labels ────────────────────────────────────────────────────────────

/** The folded line: 「已处理 9 步 · 用时 1 分 12 秒」. */
export function processSummary(
  row: Pick<ProcessRow, 'steps' | 'startedAt' | 'endedAt'>,
): string {
  const head = `已处理 ${row.steps} 步`
  return row.startedAt === null || row.endedAt === null
    ? head
    : `${head} · 用时 ${formatRunDuration(Math.max(0, row.endedAt - row.startedAt))}`
}

/** The verb a call is phrased with (「正在读取」, 「准备读取」). */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  bash: '运行',
  read: '读取',
  write: '写入',
  edit: '编辑',
  memory_edit: '更新记忆',
  glob: '查找文件',
  grep: '搜索',
  web_search: '搜索网页',
  web_fetch: '查看网页',
  todo_write: '更新任务清单',
  subagent: '委派',
  subagent_fork: '委派',
  workflow: '运行工作流',
  ralph: '运行 Ralph 循环',
  skill: '加载技能',
  scheduler: '设置定时任务',
  mcp_config: '配置 MCP',
  job_output: '读取任务输出',
  job_kill: '停止任务',
  job_list: '查看后台任务',
  ask_user_question: '提问',
  exit_plan_mode: '提交计划',
}

function baseName(path: string): string {
  return (
    path
      .split(/[\\/]/u)
      .filter((part) => part !== '')
      .at(-1) ?? path
  )
}

/** What a call works on: a file name, a command, the summary head. */
function toolObject(data: ToolChatData): string {
  const view = toolView(data.name, data)
  const args = argsOf(data)
  if (view.pathSummary) {
    const meta = metaOf(data)
    const path =
      (typeof meta?.path === 'string' ? meta.path : undefined) ??
      stringArg(args, 'file_path') ??
      ''
    return baseName(path)
  }
  if (data.name === 'bash') {
    const description = stringArg(args, 'description')?.trim()
    return truncate(
      description || firstLine(stringArg(args, 'command') ?? ''),
      60,
    )
  }
  if (data.name === 'subagent' || data.name === 'subagent_fork')
    return truncate(view.title(data), 60)
  return truncate(view.summary(data).split(' · ')[0] ?? '', 60)
}

function phrase(prefix: string, data: ToolChatData): string {
  const verb =
    TOOL_VERBS[data.name] ?? `调用 ${toolView(data.name).title(data)}`
  const object = toolObject(data)
  return object === '' ? `${prefix}${verb}` : `${prefix}${verb} ${object}`
}

/** Live phrasing of a running call: 「正在读取 SettingsView.vue」. */
export function toolLiveLabel(data: ToolChatData): string {
  if (data.question !== undefined && data.question.outcome === undefined)
    return '等待你的回答'
  if (data.approvals.some((approval) => approval.outcome === undefined))
    return `等待审批 · ${toolView(data.name, data).title(data)}`
  if (data.grants?.some((grant) => grant.decision === undefined))
    return '等待电脑操作授权'
  if (data.name === 'exit_plan_mode') return '等待你确认计划'
  return phrase('正在', data)
}

/** A preparing call as a tool row's data: the arguments parsed so far. */
export function preparingToolData(
  node: AssistantChatNode,
  index: number,
): ToolChatData | null {
  const block = node.data.blocks[index]
  if (block?.kind !== 'tool-call') return null
  return {
    callId: block.callId || `${node.key}#${index}`,
    name: block.name,
    argsRaw: JSON.stringify(partialJsonObject(block.draft ?? '') ?? {}),
    turn: node.data.turn,
    step: node.data.step,
    time: node.data.time,
    status: 'running',
    approvals: [],
  }
}

/** Live label of one member, or null when it is not working right now. */
function activeLabel(
  member: ProcessMember,
  nodes: ReadonlyMap<string, ChatNode>,
): string | null {
  const node = nodes.get(member.key)
  if (member.kind === 'preparing') {
    if (node?.kind !== 'assistant') return null
    const data = preparingToolData(node, member.index)
    return data === null ? null : phrase('准备', data)
  }
  switch (node?.kind) {
    case 'tool':
      return node.data.status === 'running' ? toolLiveLabel(node.data) : null
    case 'assistant':
      return node.data.status === 'running' ? '正在思考' : null
    case 'retry':
      return node.data.current.state === 'scheduled' ? '等待重试' : null
    case 'compaction':
      return node.data.status === 'running' ? '正在压缩上下文' : null
    case 'hook':
      return node.data.status === 'running' ? '正在运行 Hook' : null
    case 'workflowRun':
      return node.data.status === 'running'
        ? `正在运行工作流 ${node.data.name}`
        : null
    default:
      return null
  }
}

/**
 * The live line of a running process: the last member at work, and its
 * step number. With nothing at work the model is writing the next step.
 */
export function processLiveStep(
  row: Pick<ProcessRow, 'members' | 'steps'>,
  nodes: ReadonlyMap<string, ChatNode>,
): { label: string; ordinal: number } {
  let ordinal = 0
  let current: { label: string; ordinal: number } | null = null
  for (const member of row.members) {
    const steps = memberSteps(member, nodes)
    const label = activeLabel(member, nodes)
    if (label !== null)
      current = { label, ordinal: steps === 0 ? ordinal + 1 : ordinal + steps }
    ordinal += steps
  }
  return current ?? { label: '正在思考', ordinal: row.steps + 1 }
}
