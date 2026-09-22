// Incremental `chat` target builder (ported from the dsh
// chat-snapshot-builder, without the legacy compatibility slice).
//
// Visible nodes are ordered by (anchorSeq, key). Hidden `fact:*` nodes never
// render: they carry session facts (latest todo list, request route/window)
// folded into the snapshot's scalar fields.
import type { RequestContext, TodoItem } from '@emperor/core/runtime-contract'
import {
  ConversationAssembler,
  type ConversationDefinition,
  type ConversationViewBuilder,
  type ConversationViewDefinition,
  type ConversationViewNode,
} from './assembler'
import { EMPTY_TIMELINE, type ConversationTimeline } from './locationIndex'
import { CHAT_DEFINITIONS } from './nodes'
import type { ChatNode, ChatSnapshot, ContextUsage } from './types'

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

/** Incremental keyed chat builder registered under the `chat` target. */
export class ChatSnapshotBuilder implements ConversationViewBuilder<
  ConversationViewNode,
  ChatSnapshot
> {
  readonly empty = EMPTY_CHAT_SNAPSHOT
  private readonly store = new Map<string, ChatNode>()
  private readonly facts = new Map<string, ConversationViewNode>()
  private order: readonly string[] = EMPTY_KEYS
  private todos: readonly TodoItem[] = EMPTY_TODOS
  private contextUsage: ContextUsage | null = null
  private turnStatus: ChatSnapshot['turnStatus'] = null
  private timeline: ConversationTimeline = EMPTY_TIMELINE

  replace(input: {
    readonly nodes: readonly ConversationViewNode[]
    readonly timeline: ConversationTimeline
  }): ChatSnapshot {
    this.store.clear()
    this.facts.clear()
    for (const node of input.nodes) this.put(node)
    this.reorder()
    this.refreshFacts()
    this.refreshTimeline(input.timeline)
    return this.snapshot()
  }

  apply(input: {
    readonly upserts: readonly ConversationViewNode[]
    readonly removals: readonly string[]
    readonly timeline: ConversationTimeline
  }): ChatSnapshot {
    let structural = input.removals.length > 0
    let factsChanged = false
    for (const key of input.removals) {
      if (this.facts.delete(key)) factsChanged = true
      this.store.delete(key)
    }
    for (const node of input.upserts) {
      if (isFact(node)) {
        factsChanged = true
        this.facts.set(node.key, node)
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
      if (next.kind === 'assistant') factsChanged = true
      this.store.set(node.key, next)
    }
    if (structural) this.reorder()
    if (factsChanged) this.refreshFacts()
    this.refreshTimeline(input.timeline)
    return this.snapshot()
  }

  private put(node: ConversationViewNode): void {
    if (isFact(node)) this.facts.set(node.key, node)
    else this.store.set(node.key, node as ChatNode)
  }

  private reorder(): void {
    const next = [...this.store.values()]
      .filter((node) => node.visibility === 'visible')
      .sort(compareNodes)
      .map((node) => node.key)
    if (!sameReferences(this.order, next)) this.order = next
  }

  private refreshFacts(): void {
    let todos: ConversationViewNode | undefined
    const contexts: ConversationViewNode[] = []
    for (const fact of this.facts.values()) {
      if (fact.kind === 'fact:todos') {
        if (todos === undefined || fact.anchorSeq > todos.anchorSeq)
          todos = fact
      } else if (fact.kind === 'fact:request-context') contexts.push(fact)
    }
    const nextTodos =
      (todos?.data as readonly TodoItem[] | undefined) ?? EMPTY_TODOS
    if (nextTodos !== this.todos) this.todos = nextTodos

    let latest: ChatNode | undefined
    for (const node of this.store.values()) {
      if (node.kind !== 'assistant' || node.data.usage === undefined) continue
      if (latest === undefined || node.anchorSeq > latest.anchorSeq)
        latest = node
    }
    if (latest === undefined || latest.kind !== 'assistant') {
      this.contextUsage = null
      return
    }
    const anchor = latest.anchorSeq
    let route: RequestContext | undefined
    let routeSeq = -1
    for (const fact of contexts) {
      if (fact.anchorSeq <= anchor && fact.anchorSeq > routeSeq) {
        route = fact.data as RequestContext
        routeSeq = fact.anchorSeq
      }
    }
    const usage = latest.data.usage
    if (usage === undefined) return
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

  private snapshot(): ChatSnapshot {
    return {
      order: this.order,
      nodes: this.store,
      running: this.turnStatus !== null,
      turnStatus: this.turnStatus,
      todos: this.todos,
      contextUsage: this.contextUsage,
      timeline: this.timeline,
    }
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
