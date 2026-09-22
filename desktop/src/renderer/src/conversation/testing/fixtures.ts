// Test-only fixture loaders (node fs). Imported by `*.test.ts` only.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  SessionHistoryPage,
  WireSessionEvent,
} from '@emperor/core/runtime-contract'
import type { ConversationAssembler } from '../assembler'
import { chatSnapshotOf, createConversationAssembler } from '../chatSnapshot'
import type { ChatNode, ChatNodeKind, ChatNodeOf, ChatSnapshot } from '../types'

/** Raw kernel log recorded by core `raw-golden.test.ts`. */
export interface KernelLogFixture {
  readonly root: SessionHistoryPage
  readonly children: readonly SessionHistoryPage[]
}

const KERNEL_LOG = resolve(
  __dirname,
  '../../../../../../packages/core/src/harness/projection/__golden__/kernel-turn.log.json',
)

export function loadKernelLog(): KernelLogFixture {
  return JSON.parse(readFileSync(KERNEL_LOG, 'utf8')) as KernelLogFixture
}

/** Assemble a complete event list in one replace + flush. */
export function replay(events: readonly WireSessionEvent[]): {
  assembler: ConversationAssembler
  snapshot: ChatSnapshot
} {
  const assembler = createConversationAssembler()
  assembler.replaceWindow(events, false)
  assembler.flush()
  return { assembler, snapshot: chatSnapshotOf(assembler) }
}

/** Append events one by one (live path), flushing after each. */
export function stream(
  events: readonly WireSessionEvent[],
  assembler = createConversationAssembler(),
): { assembler: ConversationAssembler; snapshot: ChatSnapshot } {
  assembler.replaceWindow([], false)
  assembler.flush()
  for (const event of events) {
    assembler.append(event)
    assembler.flush()
  }
  return { assembler, snapshot: chatSnapshotOf(assembler) }
}

/** Visible nodes in render order. */
export function visibleNodes(snapshot: ChatSnapshot): ChatNode[] {
  return snapshot.order.map((key) => {
    const node = snapshot.nodes.get(key)
    if (node === undefined) throw new Error(`missing node ${key}`)
    return node
  })
}

/** The index-th visible node of one kind (throws when absent). */
export function nodeOf<Kind extends ChatNodeKind>(
  snapshot: ChatSnapshot,
  kind: Kind,
  index = 0,
): ChatNodeOf<Kind> {
  const node = visibleNodes(snapshot).filter((item) => item.kind === kind)[
    index
  ]
  if (node === undefined) throw new Error(`no ${kind} #${index}`)
  return node as ChatNodeOf<Kind>
}

/** Identity-free view of a snapshot for convergence checks. */
export function structural(snapshot: ChatSnapshot): unknown {
  return {
    order: snapshot.order,
    nodes: [...snapshot.nodes.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    running: snapshot.running,
    turnStatus: snapshot.turnStatus,
    todos: snapshot.todos,
    contextUsage: snapshot.contextUsage,
  }
}

/** Compact one-line description per visible node (for readable asserts). */
export function describeNodes(snapshot: ChatSnapshot): string[] {
  return visibleNodes(snapshot).map(describeNode)
}

export function describeNode(node: ChatNode): string {
  switch (node.kind) {
    case 'user':
      return `user${node.data.steering ? '(steering)' : ''}: ${node.data.text}`
    case 'assistant':
      return `assistant[${node.data.status}]: ${node.data.blocks
        .map((block) =>
          block.kind === 'text' || block.kind === 'reasoning'
            ? `${block.kind}=${block.text}`
            : block.kind === 'tool-call'
              ? `call=${block.name}`
              : block.kind,
        )
        .join(' | ')}`
    case 'tool':
      return `tool[${node.data.status}]: ${node.data.name}${
        node.data.subagent === undefined
          ? ''
          : ` subagent=${node.data.subagent.status}`
      }${node.data.job === undefined ? '' : ` job=${node.data.job.status}`}${
        node.data.question?.outcome === undefined
          ? ''
          : ` question=${node.data.question.outcome}`
      }${
        node.data.approvals.length === 0
          ? ''
          : ` approvals=${node.data.approvals.map((a) => a.outcome ?? 'pending').join(',')}`
      }`
    case 'retry':
      return `retry: ${node.data.attempts.map((a) => `${a.retry}:${a.state}`).join(',')}`
    case 'context':
      return node.data.origin === 'message'
        ? `context: ${node.data.producer}`
        : `context: instructions ${node.data.files.join(',')}`
    case 'compaction':
      return `compaction[${node.data.status}]: ${node.data.summary ?? ''}`
    case 'turnTail':
      return `turnTail: turn ${node.data.turn} steps=${node.data.steps}`
    case 'turnError':
      return `turnError: ${node.data.message}`
    case 'turnMaxTokens':
      return `turnMaxTokens: turn ${node.data.turn}`
    case 'goal':
      return `goal: ${node.data.operation} ${node.data.phase ?? ''}`.trim()
    case 'hook':
      return `hook[${node.data.status}]: ${node.data.point}`
    case 'fallback':
      return `fallback: ${node.data.from} -> ${node.data.to}`
    case 'costCap':
      return `costCap: turn ${node.data.turn}`
    case 'workflowRun':
      return `workflowRun[${node.data.status}]: ${node.data.name}`
  }
}

/** Sequential raw-log builder for synthetic scenarios. */
export class LogBuilder {
  readonly events: WireSessionEvent[] = []
  private time = 1_750_000_000_000

  constructor(private nextSeq = 0) {}

  add(
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ): WireSessionEvent {
    this.time += 100
    const event = {
      type,
      seq: this.nextSeq++,
      time: this.time,
      data,
      ...extra,
    } as unknown as WireSessionEvent
    this.events.push(event)
    return event
  }

  user(id: string, text: string): WireSessionEvent {
    return this.add(
      'user/message',
      {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    )
  }

  chunk(turn: number, step: number, chunk: unknown): WireSessionEvent {
    return this.add('assistant/chunk', { turn, step, chunk })
  }

  message(
    turn: number,
    step: number,
    content: unknown[],
    extra: Record<string, unknown> = {},
  ): WireSessionEvent {
    return this.add(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: `msg-${turn}-${step}`,
          role: 'assistant',
          content,
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        usage: { inputTokens: 10, outputTokens: 20 },
        ...extra,
      },
      { surfaceOp: 'append' },
    )
  }

  call(
    turn: number,
    step: number,
    callId: string,
    name: string,
    args: unknown = {},
  ): WireSessionEvent {
    return this.add('tool/call', {
      turn,
      step,
      callId,
      name,
      arguments: JSON.stringify(args),
    })
  }

  result(
    turn: number,
    step: number,
    callId: string,
    text: string,
    extra: { isError?: boolean; meta?: unknown } = {},
  ): WireSessionEvent {
    return this.add(
      'tool/result',
      {
        turn,
        step,
        message: {
          id: `result-${callId}`,
          role: 'user',
          source: { kind: 'tool', callId },
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              content: [{ type: 'text', text }],
              ...(extra.isError === undefined
                ? {}
                : { isError: extra.isError }),
            },
          ],
        },
        ...(extra.meta === undefined ? {} : { meta: extra.meta }),
      },
      { surfaceOp: 'append' },
    )
  }
}

/**
 * In-memory history transport over a growing log. Pages cut by event count
 * (`maxMessages` events) — enough to exercise window mechanics. `hold()`
 * makes the next requests wait until `release()`.
 */
export class FakeHistoryApi {
  readonly calls: Array<{ beforeSeq?: number; maxMessages?: number }> = []
  private held: Array<() => void> = []
  private holding = false
  failNext: Error | null = null

  constructor(
    public log: WireSessionEvent[],
    readonly header: SessionHistoryPage['header'] = {
      version: 0,
      id: 's1',
      createdAt: 0,
    },
  ) {}

  hold(): void {
    this.holding = true
  }

  release(): void {
    this.holding = false
    const held = this.held
    this.held = []
    for (const resume of held) resume()
  }

  async history(query: {
    sessionId: string
    beforeSeq?: number
    maxMessages?: number
  }): Promise<SessionHistoryPage> {
    this.calls.push({
      ...(query.beforeSeq === undefined ? {} : { beforeSeq: query.beforeSeq }),
      ...(query.maxMessages === undefined
        ? {}
        : { maxMessages: query.maxMessages }),
    })
    if (this.holding)
      await new Promise<void>((resume) => this.held.push(resume))
    if (this.failNext !== null) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    // Snapshot the log when the page is cut (after any hold).
    const log = [...this.log]
    const limit = query.maxMessages ?? 50
    const eligible = log.filter(
      (event) => query.beforeSeq === undefined || event.seq < query.beforeSeq,
    )
    const events = eligible.slice(Math.max(0, eligible.length - limit))
    return {
      header: this.header,
      events,
      hasMore: eligible.length > events.length,
      lastSeq: log.at(-1)?.seq ?? -1,
    }
  }
}

/** Resolve pending promise callbacks (microtasks) a few times. */
export async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve()
}
