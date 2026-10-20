// Incremental `chat` target builder (ported from the dsh
// chat-snapshot-builder, without the legacy compatibility slice).
//
// Visible nodes are ordered by (anchorSeq, key). Hidden `fact:*` nodes never
// render: they carry session facts (latest todo list, request route/window)
// folded into the snapshot's scalar fields.
//
// A flush whose only change is the text of streaming assistant rows (same
// blocks, same emptiness, same status) returns the previous snapshot object
// (FIX-04): those rows reach the UI through the store's per-key node refs,
// and everything that derives from the snapshot (rows, the environment card,
// the turn scrubber) stays put. Facts are refreshed incrementally: the todo
// list when a todo fact moves, context usage when an assistant row's usage
// or a request fact moves, the plan summary when a plan row, the todos or
// the order move.
import type { RequestContext, TodoItem } from '@emperor/core/runtime-contract'
import {
  ConversationAssembler,
  deepEqual,
  type ConversationDefinition,
  type ConversationViewBuilder,
  type ConversationViewDefinition,
  type ConversationViewNode,
} from './assembler'
import { EMPTY_TIMELINE, type ConversationTimeline } from './locationIndex'
import { CHAT_DEFINITIONS } from './nodes'
import {
  EXIT_PLAN_MODE_TOOL,
  planSummaryOf,
  type PlanSummary,
} from './planSummary'
import type {
  AssistantChatNode,
  ChatNode,
  ChatSnapshot,
  ContextUsage,
  ToolChatNode,
} from './types'

const EMPTY_KEYS: readonly string[] = []
const EMPTY_TODOS: readonly TodoItem[] = []

/** Empty chat snapshot (before the first flush). */
export const EMPTY_CHAT_SNAPSHOT: ChatSnapshot = {
  order: EMPTY_KEYS,
  nodes: new Map(),
  running: false,
  turnStatus: null,
  todos: EMPTY_TODOS,
  contextUsage: null,
  timeline: EMPTY_TIMELINE,
  planSummary: null,
}

function isFact(node: ConversationViewNode): boolean {
  return node.kind.startsWith('fact:')
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function compareNodes(left: ChatNode, right: ChatNode): number {
  return (
    left.anchorSeq - right.anchorSeq ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  )
}

function isPlanRow(node: ChatNode | undefined): node is ToolChatNode {
  return node?.kind === 'tool' && node.data.name === EXIT_PLAN_MODE_TOOL
}

const blank = (text: string): boolean => text.trim() === ''

/**
 * Whether `next` differs from `previous` only in the text of its text and
 * reasoning blocks (each staying empty or non-empty) and in the drafts of
 * its tool calls: a streaming delta. Nothing derived from the snapshot
 * (rows, labels, resources, facts) can see such a change.
 */
export function onlyTextGrew(previous: ChatNode, next: ChatNode): boolean {
  if (previous.kind !== 'assistant' || next.kind !== 'assistant') return false
  if (
    previous.anchorSeq !== next.anchorSeq ||
    previous.visibility !== next.visibility ||
    previous.turn !== next.turn ||
    previous.step !== next.step ||
    previous.id !== next.id
  )
    return false
  const before = previous.data
  const after = next.data
  if (
    before.status !== after.status ||
    before.turn !== after.turn ||
    before.step !== after.step ||
    before.time !== after.time ||
    before.messageId !== after.messageId ||
    before.blocks.length !== after.blocks.length ||
    !deepEqual(before.usage, after.usage) ||
    !deepEqual(before.provenance, after.provenance) ||
    !deepEqual(before.timing, after.timing)
  )
    return false
  for (let index = 0; index < after.blocks.length; index++) {
    const left = before.blocks[index]
    const right = after.blocks[index]
    if (left === right) continue
    if (left === undefined || right === undefined) return false
    if (left.kind === 'text' || left.kind === 'reasoning') {
      if (right.kind !== left.kind || blank(left.text) !== blank(right.text))
        return false
    } else if (left.kind === 'tool-call') {
      if (
        right.kind !== 'tool-call' ||
        left.callId !== right.callId ||
        left.name !== right.name
      )
        return false
    } else return false
  }
  return true
}

/** Incremental keyed chat builder registered under the `chat` target. */
export class ChatSnapshotBuilder implements ConversationViewBuilder<
  ConversationViewNode,
  ChatSnapshot
> {
  readonly empty = EMPTY_CHAT_SNAPSHOT
  private readonly store = new Map<string, ChatNode>()
  private readonly facts = new Map<string, ConversationViewNode>()
  /** Assistant rows that carry usage (context usage reads the latest). */
  private readonly usageKeys = new Set<string>()
  /** `exit_plan_mode` rows (the plan summary reads the latest visible). */
  private readonly planKeys = new Set<string>()
  private order: readonly string[] = EMPTY_KEYS
  private todos: readonly TodoItem[] = EMPTY_TODOS
  private contextUsage: ContextUsage | null = null
  private turnStatus: ChatSnapshot['turnStatus'] = null
  private timeline: ConversationTimeline = EMPTY_TIMELINE
  private plan: PlanSummary | null = null
  private current: ChatSnapshot = EMPTY_CHAT_SNAPSHOT

  replace(input: {
    readonly nodes: readonly ConversationViewNode[]
    readonly timeline: ConversationTimeline
  }): ChatSnapshot {
    this.store.clear()
    this.facts.clear()
    this.usageKeys.clear()
    this.planKeys.clear()
    for (const node of input.nodes) this.put(node)
    this.reorder()
    this.refreshTodos()
    this.refreshUsage()
    this.refreshPlan()
    this.refreshTimeline(input.timeline)
    return this.publish()
  }

  apply(input: {
    readonly upserts: readonly ConversationViewNode[]
    readonly removals: readonly string[]
    readonly timeline: ConversationTimeline
  }): ChatSnapshot {
    let structural = false
    let changed = input.removals.length > 0
    let todos = false
    let usage = false
    let plan = false
    for (const key of input.removals) {
      const fact = this.facts.get(key)
      if (fact !== undefined) {
        this.facts.delete(key)
        if (fact.kind === 'fact:todos') todos = true
        else if (fact.kind === 'fact:request-context') usage = true
      }
      if (this.store.delete(key)) structural = true
      if (this.usageKeys.delete(key)) usage = true
      if (this.planKeys.delete(key)) plan = true
    }
    for (const node of input.upserts) {
      if (isFact(node)) {
        this.facts.set(node.key, node)
        if (node.kind === 'fact:todos') todos = true
        else if (node.kind === 'fact:request-context') usage = true
        continue
      }
      const previous = this.store.get(node.key)
      const next = node as ChatNode
      if (
        previous === undefined ||
        previous.anchorSeq !== next.anchorSeq ||
        previous.visibility !== next.visibility
      )
        structural = true
      if (previous === undefined || !onlyTextGrew(previous, next))
        changed = true
      if (this.trackUsage(previous, next)) usage = true
      if (isPlanRow(next) || this.planKeys.has(next.key)) {
        plan = true
        if (isPlanRow(next)) this.planKeys.add(next.key)
        else this.planKeys.delete(next.key)
      }
      this.store.set(node.key, next)
    }
    if (structural) this.reorder()
    if (todos) this.refreshTodos()
    if (usage) this.refreshUsage()
    if (plan || todos || (structural && this.planKeys.size > 0))
      this.refreshPlan()
    this.refreshTimeline(input.timeline)
    return changed || todos || usage || plan || structural
      ? this.publish()
      : this.republish()
  }

  private put(node: ConversationViewNode): void {
    if (isFact(node)) {
      this.facts.set(node.key, node)
      return
    }
    const chat = node as ChatNode
    this.store.set(node.key, chat)
    this.trackUsage(undefined, chat)
    if (isPlanRow(chat)) this.planKeys.add(chat.key)
  }

  /** Track an assistant row's usage; true when context usage may move. */
  private trackUsage(previous: ChatNode | undefined, next: ChatNode): boolean {
    const had =
      previous?.kind === 'assistant' && previous.data.usage !== undefined
    const has = next.kind === 'assistant' && next.data.usage !== undefined
    if (has) this.usageKeys.add(next.key)
    else this.usageKeys.delete(next.key)
    if (!had && !has) return false
    if (had !== has || previous === undefined) return true
    const left = previous as AssistantChatNode
    const right = next as AssistantChatNode
    return (
      left.anchorSeq !== right.anchorSeq ||
      !deepEqual(left.data.usage, right.data.usage) ||
      !deepEqual(left.data.provenance, right.data.provenance)
    )
  }

  private reorder(): void {
    const next = [...this.store.values()]
      .filter((node) => node.visibility === 'visible')
      .sort(compareNodes)
      .map((node) => node.key)
    if (!sameReferences(this.order, next)) this.order = next
  }

  private refreshTodos(): void {
    let todos: ConversationViewNode | undefined
    for (const fact of this.facts.values())
      if (
        fact.kind === 'fact:todos' &&
        (todos === undefined || fact.anchorSeq > todos.anchorSeq)
      )
        todos = fact
    const next = (todos?.data as readonly TodoItem[] | undefined) ?? EMPTY_TODOS
    if (next !== this.todos) this.todos = next
  }

  private refreshUsage(): void {
    let latest: AssistantChatNode | undefined
    for (const key of this.usageKeys) {
      const node = this.store.get(key)
      if (node?.kind !== 'assistant') continue
      if (latest === undefined || node.anchorSeq > latest.anchorSeq)
        latest = node
    }
    const usage = latest?.data.usage
    if (latest === undefined || usage === undefined) {
      this.contextUsage = null
      return
    }
    const anchor = latest.anchorSeq
    let route: RequestContext | undefined
    let routeSeq = -1
    for (const fact of this.facts.values()) {
      if (fact.kind !== 'fact:request-context') continue
      if (fact.anchorSeq <= anchor && fact.anchorSeq > routeSeq) {
        route = fact.data as RequestContext
        routeSeq = fact.anchorSeq
      }
    }
    const usedTokens =
      usage.inputTokens +
      usage.outputTokens +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0)
    const window = route?.contextWindow ?? null
    const next: ContextUsage = {
      usedTokens,
      contextWindow: window,
      ratio:
        window === null || window <= 0
          ? null
          : Math.min(1, usedTokens / window),
      provider: route?.provider ?? latest.data.provenance?.provider ?? null,
      model: route?.model ?? latest.data.provenance?.model ?? null,
    }
    const previous = this.contextUsage
    if (
      previous === null ||
      previous.usedTokens !== next.usedTokens ||
      previous.contextWindow !== next.contextWindow ||
      previous.provider !== next.provider ||
      previous.model !== next.model
    )
      this.contextUsage = next
  }

  private refreshPlan(): void {
    let latest: ToolChatNode | undefined
    for (const key of this.planKeys) {
      const node = this.store.get(key)
      if (!isPlanRow(node) || node.visibility !== 'visible') continue
      if (latest === undefined || compareNodes(node, latest) > 0) latest = node
    }
    const next = latest === undefined ? null : planSummaryOf(latest, this.todos)
    if (!deepEqual(next, this.plan)) this.plan = next
  }

  private refreshTimeline(timeline: ConversationTimeline): void {
    this.timeline = timeline
    let status: ChatSnapshot['turnStatus'] = null
    for (let index = timeline.turnOrder.length - 1; index >= 0; index--) {
      const turn = timeline.turns.get(timeline.turnOrder[index] as number)
      if (turn === undefined) continue
      if (turn.status === 'open' && turn.start !== undefined)
        status = { turn: turn.turn, startedAt: turn.start.time }
      break
    }
    const previous = this.turnStatus
    if (
      previous?.turn !== status?.turn ||
      previous?.startedAt !== status?.startedAt
    )
      this.turnStatus = status
  }

  /** A new snapshot object (something a consumer can see moved). */
  private publish(): ChatSnapshot {
    this.current = {
      order: this.order,
      nodes: this.store,
      running: this.turnStatus !== null,
      turnStatus: this.turnStatus,
      todos: this.todos,
      contextUsage: this.contextUsage,
      timeline: this.timeline,
      planSummary: this.plan,
    }
    return this.current
  }

  /** The previous snapshot, unless the timeline or turn status moved. */
  private republish(): ChatSnapshot {
    const current = this.current
    return current.timeline === this.timeline &&
      current.turnStatus === this.turnStatus
      ? current
      : this.publish()
  }
}

/** `chat` target factory. */
export const chatViewDefinition: ConversationViewDefinition<
  ConversationViewNode,
  ChatSnapshot
> = {
  target: 'chat',
  create: () => new ChatSnapshotBuilder(),
}

/**
 * Extension point for additional targets (M6 trajectory): extra Definitions
 * and their view builders assembled beside the chat target.
 */
export interface ConversationExtensions {
  readonly definitions?: readonly ConversationDefinition[]
  readonly views?: readonly ConversationViewDefinition[]
}

/** New per-session assembler with the chat target (plus extensions). */
export function createConversationAssembler(
  extensions: ConversationExtensions = {},
): ConversationAssembler {
  return new ConversationAssembler(
    [...CHAT_DEFINITIONS, ...(extensions.definitions ?? [])],
    [chatViewDefinition, ...(extensions.views ?? [])],
  )
}

/** Latest chat snapshot of an assembler (empty before its first flush). */
export function chatSnapshotOf(assembler: ConversationAssembler): ChatSnapshot {
  return (
    assembler.snapshot<ChatSnapshot | undefined>('chat') ?? EMPTY_CHAT_SNAPSHOT
  )
}
