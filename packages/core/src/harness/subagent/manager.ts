/**
 * In-process delegated subagents (ported from the dsh-subagent in-process
 * spawn/fork providers, the continuable-child orchestration, and the
 * control/report tools, without the multi-provider registry).
 *
 * - `spawn`: a fresh child session (it does not see the parent conversation).
 * - `fork`: a child seeded with the parent's completed turns (never the
 *   in-flight one).
 *
 * Children are durable sessions (`origin: 'subagent'`, `parentSession`,
 * `delegationDepth`). Their permission scope is fixed at creation: the
 * parent's sandbox mode is seeded with `source: 'delegation'` and approval
 * becomes `never`, so escalations are rejected automatically. Continuable
 * children stay addressable: `send_message` queues their next turn, and
 * every settled run notifies the parent (followup when idle, steer when busy).
 */

import { randomUUID } from 'node:crypto'
import {
  contextMessage,
  createUserMessage,
  messageText,
  type UserMessage,
} from '../../llm/message'
import type { Session } from '../../session-log/session'
import type { SessionLogStore } from '../../session-log/store'
import type { SessionEvent, TurnEndReason } from '../../session-log/types'
import { logger } from '../../util/log'
import type { Agent, AgentOptions } from '../agent/agent'
import type { ApprovalService } from '../approval/service'
import type { ObjectJsonSchema } from '../tools/json-schema'
import type { SandboxPolicyService } from '../sandbox/policy'

export const DEFAULT_MAX_DEPTH = 3

export type SubagentMode = 'spawn' | 'fork'

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** Log-only on the PARENT: a delegated child was established. */
    'subagent/started': {
      subagentId: string
      description: string
      mode: SubagentMode
      callId?: string
      background: boolean
    }
    /** Log-only on the PARENT: one child run settled. */
    'subagent/settled': {
      subagentId: string
      stopReason: SubagentStopReason
      text?: string
    }
    /** Log-only on the CHILD: its creation facts (first event). */
    'subagent/descriptor': {
      parentSession: string
      description: string
      mode: SubagentMode
      parentCallId?: string
    }
  }
}

export type SubagentStopReason =
  'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | 'interrupted'

export const SUBAGENT_DELEGATION_CONTEXT =
  'You are a delegated subagent: your permission scope was fixed when you were started and cannot be ' +
  'widened from inside this session — operations that require approval are rejected automatically. ' +
  'When the task needs access beyond that scope, do not retry the denied operation; state the ' +
  'limitation in your reply so the delegating agent can handle it.'

export interface SubagentRecord {
  id: string
  parentId: string
  description: string
  mode: SubagentMode
  depth: number
  createdAt: number
  status: 'running' | 'idle'
  lastStopReason?: SubagentStopReason
}

export interface SubagentSettlement {
  stopReason: SubagentStopReason
  /** The child's final assistant text of its last turn. */
  text: string | undefined
  failure?: string
  /**
   * The captured structured value, present iff the child was started with an
   * `outputSchema` and a `structured_output` call was accepted.
   */
  structured?: unknown
}

/** Object-rooted JSON schema a structured child must satisfy (see `tools/json-schema`). */
export type StructuredOutputSchema = ObjectJsonSchema

interface StructuredState {
  schema: StructuredOutputSchema
  /** Values staged by the tool body, keyed by call id, awaiting their final result. */
  staged: Map<string, unknown>
  captured?: { value: unknown }
}

export interface SubagentObserver {
  started?(child: Agent, record: SubagentRecord): void
  settled?(child: Agent, settlement: SubagentSettlement): void
}

export class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: 'DEPTH' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'FORK' | 'DISPOSED',
  ) {
    super(message)
    this.name = 'SubagentError'
  }
}

export interface SubagentManagerDeps {
  sessions: SessionLogStore
  /** Build an agent over a session with host deps (the host's factory). */
  createAgent(session: Session, options: AgentOptions): Agent
  /** Resolve a live agent by id (parents may be root agents held by the host). */
  lookupAgent(id: string): Agent | undefined
  sandbox: SandboxPolicyService
  approval: ApprovalService
  maxDepth?: number
}

function stopReasonOf(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'aborted'
    case 'error':
      return 'error'
    case 'max-tokens':
      return 'max-tokens'
    case 'blocked':
      return 'refusal'
    case 'interrupted':
      return 'interrupted'
    default:
      return 'completed'
  }
}

/** The final assistant text of the session's last turn. */
function lastTurnText(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'turn/start') return undefined
    if (event.type === 'assistant/message') {
      const text = messageText(event.data.message).trim()
      if (text.length > 0) return text
    }
  }
  return undefined
}

export function settlementSummary(
  childId: string,
  stopReason: SubagentStopReason,
): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return `${subject} finished and will do no further work unless you send it more.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`
    case 'refusal':
      return `${subject} declined the task.`
    case 'error':
      return `${subject} failed before it finished.`
    case 'interrupted':
      return `${subject} was interrupted before it finished.`
  }
}

interface ChildEntry {
  agent: Agent
  record: SubagentRecord
  /** When set, the next settlement resolves this foreground waiter instead of notifying. */
  foreground?: (settlement: SubagentSettlement) => void
  unobserve: () => void
}

export class SubagentManager {
  private readonly children = new Map<string, ChildEntry>()
  private readonly observers = new Set<SubagentObserver>()
  private readonly structured = new Map<string, StructuredState>()
  readonly maxDepth: number

  constructor(private readonly deps: SubagentManagerDeps) {
    this.maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH
  }

  observe(observer: SubagentObserver): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  get(childId: string): Agent | undefined {
    return this.children.get(childId)?.agent
  }

  record(childId: string): SubagentRecord | undefined {
    const entry = this.children.get(childId)
    return entry === undefined ? undefined : { ...entry.record }
  }

  /** Live children of one parent (direct or all descendants). */
  list(
    caller: Agent,
    scope: 'children' | 'descendants' = 'children',
  ): SubagentRecord[] {
    const out: SubagentRecord[] = []
    const visit = (parentId: string): void => {
      for (const entry of this.children.values()) {
        if (entry.record.parentId !== parentId) continue
        out.push({ ...entry.record })
        if (scope === 'descendants') visit(entry.record.id)
      }
    }
    visit(caller.id)
    return out
  }

  /** Children recorded on a parent's log (live or not), for UI listings. */
  static recorded(
    parent: Session,
  ): Array<SessionEvent<'subagent/started'>['data']> {
    return parent.events
      .filter(
        (e): e is SessionEvent<'subagent/started'> =>
          e.type === 'subagent/started',
      )
      .map((e) => e.data)
  }

  /**
   * Establish one child and deliver its first prompt. Resolves once the child
   * accepted the prompt (not when it finishes).
   */
  start(
    parent: Agent,
    request: {
      description: string
      prompt: string
      mode: SubagentMode
      callId?: string
      background: boolean
      /** Narrow the child further: tool visibility and request config. */
      agentOptions?: Pick<AgentOptions, 'toolFilter' | 'callConfig'>
      /**
       * Structured output (dsh `outputSchema`): the child gets a scoped
       * `structured_output` tool and must finish by calling it; the accepted
       * value is reported as {@link SubagentSettlement.structured}.
       */
      outputSchema?: StructuredOutputSchema
    },
  ): Agent {
    const depth = parent.depth + 1
    if (depth > this.maxDepth) {
      throw new SubagentError(
        `subagent depth limit reached (max ${this.maxDepth}); do the work yourself or report back`,
        'DEPTH',
      )
    }
    const childId = `sub-${randomUUID()}`
    const cwd = parent.session.header.cwd
    let session: Session
    if (request.mode === 'fork') {
      const boundary = lastCompletedTurnEnd(parent.session.events)
      session =
        boundary === undefined
          ? this.deps.sessions.create({
              id: childId,
              ...(cwd === undefined ? {} : { cwd }),
              parentSession: parent.id,
              origin: 'subagent',
              delegationDepth: depth,
            })
          : this.deps.sessions.fork(parent.id, childId, {
              boundary,
              origin: 'subagent',
              delegationDepth: depth,
            })
    } else {
      session = this.deps.sessions.create({
        id: childId,
        ...(cwd === undefined ? {} : { cwd }),
        parentSession: parent.id,
        origin: 'subagent',
        delegationDepth: depth,
      })
    }
    session.append('subagent/descriptor', {
      parentSession: parent.id,
      description: request.description,
      mode: request.mode,
      ...(request.callId === undefined ? {} : { parentCallId: request.callId }),
    })
    // The permission scope is fixed at delegation and can only narrow.
    this.deps.sandbox.set(
      session,
      this.deps.sandbox.resolve({ session: parent.session }).mode,
      'delegation',
    )
    this.deps.approval.record(session, 'never', 'delegation')
    if (request.outputSchema !== undefined)
      this.structured.set(childId, {
        schema: request.outputSchema,
        staged: new Map(),
      })
    const child = this.deps.createAgent(session, {
      ...request.agentOptions,
      owner: parent,
    })
    const record: SubagentRecord = {
      id: childId,
      parentId: parent.id,
      description: request.description,
      mode: request.mode,
      depth,
      createdAt: Date.now(),
      status: 'idle',
    }
    const entry: ChildEntry = { agent: child, record, unobserve: () => {} }
    entry.unobserve = child.observe({
      status: (_agent, status) => {
        entry.record.status = status
        if (status === 'idle') this.settle(entry)
      },
    })
    this.children.set(childId, entry)
    parent.session.append('subagent/started', {
      subagentId: childId,
      description: request.description,
      mode: request.mode,
      background: request.background,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
    })
    for (const observer of this.observers) {
      try {
        observer.started?.(child, { ...record })
      } catch {
        // ignore
      }
    }
    child.followup(
      createUserMessage({
        content: [{ type: 'text', text: request.prompt }],
        source: { kind: 'context', producer: 'subagent', form: 'relay' },
      }),
    )
    return child
  }

  /** Wait for the child's current work to settle (foreground delegation). */
  waitForSettlement(
    childId: string,
    signal: AbortSignal,
  ): Promise<SubagentSettlement> {
    const entry = this.children.get(childId)
    if (entry === undefined)
      return Promise.reject(
        new SubagentError(`subagent "${childId}" is not live`, 'NOT_FOUND'),
      )
    return new Promise<SubagentSettlement>((resolve) => {
      const onAbort = (): void => {
        entry.agent.cancel({ kind: 'parent' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.foreground = (settlement) => {
        signal.removeEventListener('abort', onAbort)
        resolve(settlement)
      }
    })
  }

  private settle(entry: ChildEntry): void {
    const events = entry.agent.session.events
    const lastEnd = [...events]
      .reverse()
      .find((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
    const stopReason = stopReasonOf(lastEnd?.data.reason)
    const text = lastTurnText(events)
    const failure =
      lastEnd?.data.reason.kind === 'error'
        ? lastEnd.data.reason.error.message
        : undefined
    const structured = this.structured.get(entry.record.id)
    const settlement: SubagentSettlement = {
      stopReason:
        structured !== undefined &&
        structured.captured === undefined &&
        stopReason === 'completed'
          ? 'error'
          : stopReason,
      text,
      ...(failure === undefined ? {} : { failure }),
      ...(structured?.captured === undefined
        ? {}
        : { structured: structured.captured.value }),
    }
    entry.record.lastStopReason = settlement.stopReason
    const parent = this.deps.lookupAgent(entry.record.parentId)
    try {
      parent?.session.append('subagent/settled', {
        subagentId: entry.record.id,
        stopReason: settlement.stopReason,
        ...(text === undefined ? {} : { text }),
      })
    } catch (error: unknown) {
      logger.warn('subagent settlement log failed', { error: String(error) })
    }
    for (const observer of this.observers) {
      try {
        observer.settled?.(entry.agent, settlement)
      } catch {
        // ignore
      }
    }
    const foreground = entry.foreground
    if (foreground !== undefined) {
      entry.foreground = undefined
      foreground(settlement)
      return
    }
    if (parent === undefined) return
    const summary = settlementSummary(entry.record.id, settlement.stopReason)
    const notice = createUserMessage({
      content: [
        { type: 'text', text: summary },
        ...(text === undefined
          ? [{ type: 'text' as const, text: 'It left no closing message.' }]
          : [
              { type: 'text' as const, text: 'Its closing message:' },
              { type: 'text' as const, text },
            ]),
      ],
      source: {
        kind: 'context',
        producer: 'subagent',
        form: 'notice',
        summary,
      },
    })
    try {
      if (parent.status === 'idle') parent.followup(notice)
      else parent.steer(notice)
    } catch (error: unknown) {
      logger.warn('subagent settlement notice was not delivered', {
        error: String(error),
      })
    }
  }

  /** Queue a message as the child's next turn (`send_message`). */
  followup(parent: Agent, childId: string, text: string): string {
    const entry = this.children.get(childId)
    if (entry === undefined)
      throw new SubagentError(`subagent "${childId}" is not live`, 'NOT_FOUND')
    if (entry.record.parentId !== parent.id)
      throw new SubagentError(
        `subagent "${childId}" is not a direct child of agent "${parent.id}"`,
        'UNAUTHORIZED',
      )
    const message = contextMessage('subagent-parent', text, { form: 'relay' })
    entry.agent.followup(message)
    return message.id
  }

  /** Cancel the current turn of a descendant (`interrupt_agent`) or any child for the user. */
  interrupt(
    targetId: string,
    authority: { kind: 'ancestor'; agent: Agent } | { kind: 'user' },
  ): void {
    const entry = this.children.get(targetId)
    if (entry === undefined) return
    if (authority.kind === 'ancestor') {
      let parentId: string | undefined = entry.record.parentId
      let authorized = false
      while (parentId !== undefined) {
        if (parentId === authority.agent.id) {
          authorized = true
          break
        }
        parentId = this.children.get(parentId)?.record.parentId
      }
      if (!authorized)
        throw new SubagentError(
          `agent "${targetId}" is not a live descendant of agent "${authority.agent.id}"`,
          'UNAUTHORIZED',
        )
    }
    entry.agent.cancel({ kind: 'parent' }, { keepInbox: true })
  }

  /** A child reports selected content to its direct parent (steers and wakes it). */
  report(child: Agent, text: string): string {
    const entry = this.children.get(child.id)
    if (entry === undefined)
      throw new SubagentError(
        'only a delegated subagent can report',
        'NOT_FOUND',
      )
    const parent = this.deps.lookupAgent(entry.record.parentId)
    if (parent === undefined)
      throw new SubagentError(
        'the agent that started you is no longer available; the report was not delivered',
        'NOT_FOUND',
      )
    const message: UserMessage = createUserMessage({
      content: [
        { type: 'text', text: `Background subagent ${child.id} reported:` },
        { type: 'text', text },
      ],
      source: {
        kind: 'context',
        producer: 'subagent',
        form: 'relay',
        summary: `report from ${entry.record.description}`,
      },
    })
    parent.steer(message)
    return message.id
  }

  /** Dispose every child of a parent (and their descendants). */
  disposeChildrenOf(parentId: string): void {
    for (const entry of [...this.children.values()]) {
      if (entry.record.parentId !== parentId) continue
      this.disposeEntry(entry)
    }
  }

  /** Dispose one child (and its descendants); its log stays on disk. */
  dispose(childId: string): void {
    const entry = this.children.get(childId)
    if (entry !== undefined) this.disposeEntry(entry)
  }

  private disposeEntry(entry: ChildEntry): void {
    this.disposeChildrenOf(entry.record.id)
    entry.unobserve()
    entry.agent.dispose()
    this.deps.sessions.close(entry.record.id)
    this.children.delete(entry.record.id)
    this.structured.delete(entry.record.id)
  }

  // ── structured output (dsh subagent-in-process-driver `structured.ts`) ──

  /** The output schema a structured child must satisfy, if any. */
  structuredSchema(
    agent: Agent | undefined,
  ): StructuredOutputSchema | undefined {
    return agent === undefined
      ? undefined
      : this.structured.get(agent.id)?.schema
  }

  /** Whether the child already committed its structured value (the run is complete). */
  structuredCaptured(agent: Agent | undefined): boolean {
    return (
      agent !== undefined &&
      this.structured.get(agent.id)?.captured !== undefined
    )
  }

  /** Stage a validated value; it commits only when its final tool result succeeds. */
  stageStructured(agent: Agent, callId: string, value: unknown): void {
    this.structured.get(agent.id)?.staged.set(callId, value)
  }

  /** Commit (or drop) the value staged by one call once its authoritative result exists. */
  commitStructured(agent: Agent, callId: string, isError: boolean): void {
    const state = this.structured.get(agent.id)
    if (state === undefined || !state.staged.has(callId)) return
    const value = state.staged.get(callId)
    state.staged.delete(callId)
    if (isError || state.captured !== undefined) return
    state.captured = { value }
  }
}

/** Seq of the last `turn/end` (the fork boundary), if any. */
function lastCompletedTurnEnd(
  events: readonly SessionEvent[],
): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]!.type === 'turn/end') return events[index]!.seq
  }
  return undefined
}
