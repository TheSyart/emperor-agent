import { ToolRegistry } from '../tools/registry'
import { MessageBus } from './bus'
import * as events from './events'
import {
  LEAD_ACTOR,
  TeamMember,
  TeamMessage,
  TeamStatus,
  newTeamId,
  validateMemberName,
  type TeamMemberPayload,
  type TeamMessagePayload,
} from './models'
import { TeamStore } from './store'
import type { TeamConfigPayload } from './store'
import { TeamReadInboxTool, TeamSendMessageTool } from './tools'
import type { HookAggregateDecision } from '../hooks/models'

const ROLE_AGENT_TYPES: Record<string, string> = {
  coder: 'neiguan_yingzao',
  reviewer: 'shangbao_dianbu',
  researcher: 'dongchang_tanshi',
  reader: 'sili_suitang',
  runner: 'xiaohuangmen',
}

export function roleToAgentType(role: string): string {
  return (
    ROLE_AGENT_TYPES[
      String(role || '')
        .trim()
        .toLowerCase()
    ] ?? 'sili_suitang'
  )
}

export interface TeamSubagentSpec {
  name?: string
  tool_names?: string[]
  toolNames?: string[]
}
export interface TeamSubagentRegistry {
  get(name: string): TeamSubagentSpec | null | undefined
  resolveName?(name: string): string
  names?(includeAliases?: boolean): string[]
}
export interface TeamRunner {
  step(history: Array<Record<string, unknown>>): string | Promise<string>
  stepStream?(
    history: Array<Record<string, unknown>>,
    emit: (event: Record<string, unknown>) => Promise<void>,
  ): Promise<string>
}
export type TeamRunnerFactory = (opts: {
  member: TeamMember
  spec: TeamSubagentSpec
  subRegistry: ToolRegistry
  agentId: string
}) => TeamRunner
export type TeamEventSink = (
  event: Record<string, unknown>,
) => Promise<void> | void
export interface TeamHookHost {
  begin(opts: {
    agentId: string
    agentType: string
    teammateName: string
  }): Promise<HookAggregateDecision>
  end(agentId: string): void
}

export interface TeamMemberSummaryPayload extends TeamMemberPayload {
  unread: number
  recent_messages: TeamMessagePayload[]
  thread_count: number
  tools: string[]
}

export interface TeamManagerPayload {
  config: TeamConfigPayload
  members: TeamMemberSummaryPayload[]
  leadUnread: number
  leadInbox: TeamMessagePayload[]
}

export class TeamManager {
  readonly projectId: string | null
  readonly store: TeamStore
  readonly bus: MessageBus
  readonly parentRegistry: ToolRegistry
  readonly subagentRegistry: TeamSubagentRegistry
  readonly runnerFactory: TeamRunnerFactory | null
  readonly eventSink: TeamEventSink | null
  readonly hooks: TeamHookHost | null
  private working = new Set<string>()

  constructor(opts: {
    root: string
    teamDir?: string | null
    projectId?: string | null
    parentRegistry?: ToolRegistry | null
    subagentRegistry: TeamSubagentRegistry
    runnerFactory?: TeamRunnerFactory | null
    eventSink?: TeamEventSink | null
    hooks?: TeamHookHost | null
  }) {
    this.projectId = opts.projectId?.trim() || null
    this.store = new TeamStore(opts.root, { teamDir: opts.teamDir ?? null })
    this.bus = new MessageBus(this.store)
    this.parentRegistry = opts.parentRegistry ?? new ToolRegistry()
    this.subagentRegistry = opts.subagentRegistry
    this.runnerFactory = opts.runnerFactory ?? null
    this.eventSink = opts.eventSink ?? null
    this.hooks = opts.hooks ?? null
  }

  payload(): TeamManagerPayload {
    const members = this.store.listMembers().map((member) => ({
      ...member.toDict(),
      unread: this.bus.unreadCount(member.name),
      recent_messages: this.bus
        .recent(member.name, { limit: 5 })
        .map((msg) => msg.toDict()),
      thread_count: this.store.readThread(member.name).length,
      tools: this.toolNamesForMember(member),
    }))
    return {
      config: this.store.loadConfig(),
      members,
      leadUnread: this.bus.unreadCount(LEAD_ACTOR),
      leadInbox: this.bus
        .recent(LEAD_ACTOR, { limit: 50 })
        .map((msg) => msg.toDict()),
    }
  }

  async spawnTeammate(opts: {
    name: string
    role: string
    task?: string | null
    agent_type?: string | null
    sender?: string
    parent_call_id?: string | null
    eventSink?: TeamEventSink | null
  }): Promise<string> {
    const safeName = validateMemberName(opts.name)
    const resolved = opts.agent_type || roleToAgentType(opts.role)
    const spec = this.subagentRegistry.get(resolved)
    if (!spec)
      return `Error: unknown agent_type '${resolved}'. Available: ${this.subagentRegistry.names?.(true) ?? []}`
    const existing = this.store.getMember(safeName)
    const agentType =
      this.subagentRegistry.resolveName?.(resolved) ?? spec.name ?? resolved
    const member = new TeamMember({
      name: safeName,
      role: opts.role,
      agent_type: agentType,
      status:
        existing && existing.status !== TeamStatus.SHUTDOWN
          ? existing.status
          : TeamStatus.IDLE,
      created_at: existing?.created_at,
      last_error: existing?.last_error ?? null,
    })
    this.store.upsertMember(member)
    await this.emit(events.memberUpdate(member), opts.eventSink)
    if (!opts.task) return JSON.stringify({ created: member.toDict() })

    const taskId = newTeamId('task')
    const msg = this.bus.send({
      from_actor: opts.sender ?? LEAD_ACTOR,
      to: member.name,
      content: opts.task,
      type: 'task',
      task_id: taskId,
    })
    await this.emit(events.messageEvent(msg), opts.eventSink)
    const result = await this.wakeTeammate(member.name, {
      parent_call_id: opts.parent_call_id ?? null,
      purpose: opts.task.slice(0, 120),
      eventSink: opts.eventSink ?? null,
    })
    return JSON.stringify({
      created: member.toDict(),
      message: msg.toDict(),
      result,
    })
  }

  listTeammates(): string {
    return JSON.stringify(this.payload(), null, 2)
  }

  readInbox(
    opts: { actor?: string; limit?: number; mark_read?: boolean } = {},
  ): string {
    const messages = this.bus.read(opts.actor ?? LEAD_ACTOR, {
      limit: opts.limit ?? 20,
      mark_read: opts.mark_read ?? true,
    })
    return JSON.stringify(
      messages.map((msg) => msg.toDict()),
      null,
      2,
    )
  }

  async sendMessage(opts: {
    to: string
    content: string
    sender?: string
    wake?: boolean
    type?: string
    parent_call_id?: string | null
    eventSink?: TeamEventSink | null
  }): Promise<string> {
    if (opts.to !== LEAD_ACTOR) this.requireMember(opts.to)
    if ((opts.sender ?? LEAD_ACTOR) !== LEAD_ACTOR)
      this.requireMember(opts.sender ?? LEAD_ACTOR)
    const msg = this.bus.send({
      from_actor: opts.sender ?? LEAD_ACTOR,
      to: opts.to,
      content: opts.content,
      type: opts.type ?? 'message',
    })
    await this.emit(events.messageEvent(msg), opts.eventSink)
    let result: string | null = null
    if ((opts.wake ?? true) && opts.to !== LEAD_ACTOR)
      result = await this.wakeTeammate(opts.to, {
        parent_call_id: opts.parent_call_id ?? null,
        purpose: opts.content.slice(0, 120),
        eventSink: opts.eventSink ?? null,
      })
    return JSON.stringify({ message: msg.toDict(), result })
  }

  async broadcast(opts: {
    content: string
    recipients?: string[] | null
    wake?: boolean
    parent_call_id?: string | null
    eventSink?: TeamEventSink | null
  }): Promise<string> {
    let members = this.store
      .listMembers()
      .filter((member) => member.status !== TeamStatus.SHUTDOWN)
    if (opts.recipients?.length) {
      const wanted = new Set(opts.recipients.map(validateMemberName))
      members = members.filter((member) => wanted.has(member.name))
    }
    const sent: Array<Record<string, unknown>> = []
    const results: Array<Record<string, unknown>> = []
    for (const member of members) {
      const msg = this.bus.send({
        from_actor: LEAD_ACTOR,
        to: member.name,
        content: opts.content,
        type: 'message',
      })
      sent.push(msg.toDict())
      await this.emit(events.messageEvent(msg), opts.eventSink)
      if (opts.wake ?? true)
        results.push({
          name: member.name,
          result: await this.wakeTeammate(member.name, {
            parent_call_id: opts.parent_call_id ?? null,
            purpose: opts.content.slice(0, 120),
            eventSink: opts.eventSink ?? null,
          }),
        })
    }
    return JSON.stringify({ sent, results }, null, 2)
  }

  async shutdownTeammate(opts: {
    name: string
    eventSink?: TeamEventSink | null
  }): Promise<string> {
    const member = this.store.updateMember(opts.name, {
      status: TeamStatus.SHUTDOWN,
      last_error: null,
    })
    await this.emit(events.memberUpdate(member), opts.eventSink)
    return JSON.stringify({ shutdown: member.toDict() })
  }

  async wakeTeammate(
    name: string,
    opts: {
      parent_call_id?: string | null
      purpose?: string
      eventSink?: TeamEventSink | null
    } = {},
  ): Promise<string> {
    const member = this.requireMember(name)
    if (member.status === TeamStatus.SHUTDOWN)
      return `Error: teammate '${member.name}' is shutdown`
    if (this.working.has(member.name))
      return `Error: teammate '${member.name}' is already working`
    this.working.add(member.name)
    try {
      return await this.wakeLocked(member, opts)
    } finally {
      this.working.delete(member.name)
    }
  }

  private async wakeLocked(
    member: TeamMember,
    opts: {
      parent_call_id?: string | null
      purpose?: string
      eventSink?: TeamEventSink | null
    },
  ): Promise<string> {
    const working = this.store.updateMember(member.name, {
      status: TeamStatus.WORKING,
      last_error: null,
    })
    await this.emit(events.memberUpdate(working), opts.eventSink)
    await this.emit(
      events.runStart({
        parent_id: opts.parent_call_id ?? null,
        member: working,
        purpose: opts.purpose ?? '',
      }),
      opts.eventSink,
    )

    const inbox = this.bus.allMessages(working.name)
    const cursorStart = Math.min(
      this.store.readCursor(working.name),
      inbox.length,
    )
    const unread = inbox.slice(cursorStart, cursorStart + 50)
    const cursorEnd = cursorStart + unread.length
    const pendingIds = unread.map((msg) => msg.id)
    const history = this.store.readThread(working.name)
    if (!unread.length) {
      const idle = this.store.updateMember(working.name, {
        status: TeamStatus.IDLE,
        last_error: null,
      })
      await this.emit(events.memberUpdate(idle), opts.eventSink)
      await this.emit(
        events.runDone({
          parent_id: opts.parent_call_id ?? null,
          member: idle,
          summary: '没有未读消息。',
        }),
        opts.eventSink,
      )
      return '没有未读消息。'
    }

    history.push({
      role: 'user',
      content: TeamManager.renderInboxForRunner(working, unread),
    })
    this.store.writeCheckpoint(working.name, history, {
      pending_cursor_start: cursorStart,
      pending_cursor_end: cursorEnd,
      pending_message_ids: pendingIds,
    })
    if (!this.runnerFactory)
      throw new Error('team runner factory is unavailable')
    const spec = this.requireSpec(working.agent_type)
    const leadBefore = new Set(
      this.bus.allMessages(LEAD_ACTOR).map((msg) => msg.id),
    )
    const agentId = newTeamId('agent')
    let hookScopeStarted = false

    try {
      if (this.hooks) {
        const start = await this.hooks.begin({
          agentId,
          agentType: working.agent_type,
          teammateName: working.name,
        })
        hookScopeStarted = true
        if (start.additionalContext.trim()) {
          history.splice(Math.max(0, history.length - 1), 0, {
            role: 'system',
            content: `[SubagentStart hook context]\n${start.additionalContext}`,
            ui_hidden: true,
          })
        }
      }
      const runner = this.runnerFactory({
        member: working,
        spec,
        subRegistry: this.registryForMember(working, spec),
        agentId,
      })
      const final = runner.stepStream
        ? await runner.stepStream(history, async (evt) => {
            await this.emit(
              this.mapRunnerEvent(evt, working, opts.parent_call_id ?? null) ??
                evt,
              opts.eventSink,
            )
          })
        : await runner.step(history)
      this.store.writeThread(working.name, history)
      this.store.clearCheckpoint(working.name)
      this.store.writeCursor(working.name, cursorEnd)
      const idle = this.store.updateMember(working.name, {
        status: TeamStatus.IDLE,
        last_error: null,
      })
      await this.emit(events.memberUpdate(idle), opts.eventSink)
      const explicitReply = this.bus
        .allMessages(LEAD_ACTOR)
        .some(
          (msg) => !leadBefore.has(msg.id) && msg.from_actor === working.name,
        )
      if (!explicitReply) {
        const reply = this.bus.send({
          from_actor: working.name,
          to: LEAD_ACTOR,
          content: final,
          type: 'result',
          in_reply_to: pendingIds.at(-1) ?? null,
          meta: { role: working.role, agent_type: working.agent_type },
        })
        await this.emit(events.messageEvent(reply), opts.eventSink)
      }
      await this.emit(
        events.runDone({
          parent_id: opts.parent_call_id ?? null,
          member: idle,
          summary: final,
        }),
        opts.eventSink,
      )
      return final
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.store.writeCheckpoint(working.name, history, {
        pending_cursor_start: cursorStart,
        pending_cursor_end: cursorEnd,
        pending_message_ids: pendingIds,
      })
      const errored = this.store.updateMember(working.name, {
        status: TeamStatus.ERROR,
        last_error: text,
      })
      await this.emit(events.memberUpdate(errored), opts.eventSink)
      await this.emit(
        events.runError({
          parent_id: opts.parent_call_id ?? null,
          member: errored,
          message: text,
        }),
        opts.eventSink,
      )
      return `Error: teammate '${working.name}' raised: ${text}`
    } finally {
      if (hookScopeStarted) this.hooks?.end(agentId)
    }
  }

  private registryForMember(
    member: TeamMember,
    spec: TeamSubagentSpec,
  ): ToolRegistry {
    const registry = new ToolRegistry()
    for (const name of toolNames(spec)) {
      const tool = this.parentRegistry.get(name)
      if (tool) registry.register(tool)
    }
    registry.register(
      new TeamSendMessageTool(this, { sender: member.name, allowWake: false }),
    )
    registry.register(new TeamReadInboxTool(this, { actor: member.name }))
    return registry
  }

  private toolNamesForMember(member: TeamMember): string[] {
    const spec = this.subagentRegistry.get(member.agent_type)
    return spec ? [...toolNames(spec), 'send_message', 'read_inbox'] : []
  }

  private requireMember(name: string): TeamMember {
    const member = this.store.getMember(name)
    if (!member) throw new Error(`unknown teammate: ${name}`)
    return member
  }

  private requireSpec(agentType: string): TeamSubagentSpec {
    const spec = this.subagentRegistry.get(agentType)
    if (!spec) throw new Error(`unknown agent_type: ${agentType}`)
    return spec
  }

  private mapRunnerEvent(
    evt: Record<string, unknown>,
    member: TeamMember,
    parentId: string | null,
  ): Record<string, unknown> | null {
    const type = evt.event
    if (type === 'message_delta')
      return events.runDelta({
        parent_id: parentId,
        member,
        delta: String(evt.delta ?? ''),
      })
    if (type === 'tool_call')
      return events.runToolCall({
        parent_id: parentId,
        member,
        id: stringOrNull(evt.id),
        name: String(evt.name ?? ''),
        arguments: isRecord(evt.arguments) ? evt.arguments : {},
      })
    if (type === 'tool_result')
      return events.runToolResult({
        parent_id: parentId,
        member,
        id: stringOrNull(evt.id),
        name: stringOrNull(evt.name),
        summary: String(evt.summary ?? ''),
      })
    if (type === 'tool_error')
      return events.runToolError({
        parent_id: parentId,
        member,
        id: stringOrNull(evt.id),
        name: stringOrNull(evt.name),
        message: String(evt.message ?? ''),
      })
    if (type === 'assistant_done')
      return events.runDone({
        parent_id: parentId,
        member,
        summary: String(evt.content ?? ''),
      })
    return null
  }

  static renderInboxForRunner(
    member: TeamMember,
    messages: TeamMessage[],
  ): string {
    const lines = [
      `你是 Agent Team 队友 ${member.name}，role=${member.role}，agent_type=${member.agent_type}。`,
      '下面是你的未读 inbox。请处理这些消息，必要时调用工具，最后用 send_message(to="lead", content="...") 回禀，随后给出简短总结。',
      '',
      '## Inbox',
    ]
    for (const msg of messages)
      lines.push(
        `- id=${msg.id} type=${msg.type} from=${msg.from_actor} task_id=${msg.task_id ?? ''}: ${msg.content}`,
      )
    return lines.join('\n')
  }

  private async emit(
    event: Record<string, unknown>,
    eventSink?: TeamEventSink | null,
  ): Promise<void> {
    const sink = eventSink ?? this.eventSink
    if (!sink) return
    const payload =
      this.projectId && String(event.event ?? '').startsWith('team_')
        ? { ...event, project_id: this.projectId }
        : event
    await sink(payload)
  }
}

function toolNames(spec: TeamSubagentSpec): string[] {
  return spec.tool_names ?? spec.toolNames ?? []
}

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
