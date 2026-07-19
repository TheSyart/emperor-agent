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
import {
  TEAM_CHECKPOINT_VERSION,
  TeamStore,
  teamThreadRevision,
  type TeamCheckpointPayload,
  type TeamEffectReceipt,
} from './store'
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
export type TeamCheckpointRecovery = 'auto' | 'retry'
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

interface ValidatedTeamCheckpoint {
  payload: TeamCheckpointPayload
  history: Array<Record<string, unknown>>
  turnId: string
  cursorStart: number
  cursorEnd: number
  pendingIds: string[]
  baseThreadRevision: string
  leadBefore: Set<string>
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
      recovery?: TeamCheckpointRecovery
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
      recovery?: TeamCheckpointRecovery
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
    const storedCheckpoint = this.store.readCheckpointPayload(working.name)
    if (!storedCheckpoint && this.store.hasCheckpoint(working.name))
      return this.failCheckpointRecovery(
        working,
        'checkpoint is corrupt or cannot be decoded; refusing an unsafe automatic replay',
        opts,
      )
    let run: ValidatedTeamCheckpoint
    if (storedCheckpoint) {
      const recovered = this.validateCheckpoint(
        working,
        storedCheckpoint,
        inbox,
      )
      if (typeof recovered === 'string')
        return this.failCheckpointRecovery(working, recovered, opts)
      run = recovered
      if (storedCheckpoint.phase === 'terminal_pending')
        return this.finalizeCheckpoint(
          working,
          run,
          storedCheckpoint.last_effect_receipt as TeamEffectReceipt,
          opts,
        )
      if (
        storedCheckpoint.phase === 'running' &&
        (opts.recovery ?? 'auto') !== 'retry'
      ) {
        return this.failCheckpointRecovery(
          working,
          `ambiguous running checkpoint '${run.turnId}'; automatic replay is disabled to avoid duplicate side effects. Retry explicitly with recovery='retry'`,
          opts,
        )
      }
    } else {
      const cursorStart = Math.min(
        this.store.readCursor(working.name),
        inbox.length,
      )
      const unread = inbox.slice(cursorStart, cursorStart + 50)
      if (!unread.length) {
        const current = this.requireMember(working.name)
        const idle =
          current.status === TeamStatus.SHUTDOWN
            ? current
            : this.store.updateMember(working.name, {
                status: TeamStatus.IDLE,
                last_error: null,
              })
        if (idle.status !== TeamStatus.SHUTDOWN)
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

      const history = this.store.readThread(working.name)
      const baseThreadRevision = teamThreadRevision(history)
      history.push({
        role: 'user',
        content: TeamManager.renderInboxForRunner(working, unread),
      })
      const pendingIds = unread.map((msg) => msg.id)
      const turnId = newTeamId('turn')
      const leadBefore = new Set(
        this.bus.allMessages(LEAD_ACTOR).map((msg) => msg.id),
      )
      run = {
        payload: {
          version: 1,
          member: working.name,
          messages: history,
          checkpoint_version: TEAM_CHECKPOINT_VERSION,
          turn_id: turnId,
          phase: 'prepared',
          base_thread_revision: baseThreadRevision,
          pending_cursor_start: cursorStart,
          pending_cursor_end: cursorStart + unread.length,
          pending_message_ids: pendingIds,
          lead_message_ids_before: [...leadBefore],
        },
        history,
        turnId,
        cursorStart,
        cursorEnd: cursorStart + unread.length,
        pendingIds,
        baseThreadRevision,
        leadBefore,
      }
      this.writeRunCheckpoint(working.name, run, 'prepared')
    }

    if (!this.runnerFactory)
      return this.failCheckpointRecovery(
        working,
        'team runner factory is unavailable',
        opts,
      )
    const agentId = newTeamId('agent')
    let hookScopeStarted = false
    let executionStarted = false

    try {
      // An explicit retry acknowledges that a previous `running` attempt may
      // already have produced effects. Re-enter `prepared` before any await so
      // a second crash before model execution remains safely resumable.
      this.writeRunCheckpoint(working.name, run, 'prepared')
      const spec = this.requireSpec(working.agent_type)
      if (this.hooks) {
        const start = await this.hooks.begin({
          agentId,
          agentType: working.agent_type,
          teammateName: working.name,
        })
        hookScopeStarted = true
        const hookContext = start.additionalContext.trim()
        if (
          hookContext &&
          !run.history.some(
            (message) =>
              message.content ===
              `[SubagentStart hook context]\n${hookContext}`,
          )
        ) {
          run.history.splice(Math.max(0, run.history.length - 1), 0, {
            role: 'system',
            content: `[SubagentStart hook context]\n${hookContext}`,
            ui_hidden: true,
          })
        }
        this.writeRunCheckpoint(working.name, run, 'prepared')
      }
      const runner = this.runnerFactory({
        member: working,
        spec,
        subRegistry: this.registryForMember(working, spec),
        agentId,
      })
      this.writeRunCheckpoint(working.name, run, 'running')
      executionStarted = true
      const final = runner.stepStream
        ? await runner.stepStream(run.history, async (evt) => {
            await this.emit(
              this.mapRunnerEvent(evt, working, opts.parent_call_id ?? null) ??
                evt,
              opts.eventSink,
            )
          })
        : await runner.step(run.history)
      const explicitReply = this.bus
        .allMessages(LEAD_ACTOR)
        .some(
          (msg) =>
            !run.leadBefore.has(msg.id) && msg.from_actor === working.name,
        )
      const receipt: TeamEffectReceipt = {
        kind: 'runner_result',
        result: final,
        reply_required: !explicitReply,
        reply_message_id: null,
      }
      this.writeRunCheckpoint(working.name, run, 'terminal_pending', receipt)
      return this.finalizeCheckpoint(working, run, receipt, opts)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.writeRunCheckpoint(
        working.name,
        run,
        executionStarted ? 'running' : 'prepared',
      )
      return this.failCheckpointRecovery(working, text, opts, true)
    } finally {
      if (hookScopeStarted) this.hooks?.end(agentId)
    }
  }

  private validateCheckpoint(
    member: TeamMember,
    checkpoint: TeamCheckpointPayload,
    inbox: TeamMessage[],
  ): ValidatedTeamCheckpoint | string {
    if (checkpoint.checkpoint_version !== TEAM_CHECKPOINT_VERSION)
      return 'legacy or unsupported checkpoint version; refusing an unsafe automatic replay'
    if (!checkpoint.turn_id?.trim()) return 'checkpoint turn_id is missing'
    if (!checkpoint.phase) return 'checkpoint phase is missing or invalid'
    if (!checkpoint.base_thread_revision)
      return 'checkpoint base thread revision is missing'
    const cursorStart = checkpoint.pending_cursor_start
    const cursorEnd = checkpoint.pending_cursor_end
    if (
      !Number.isInteger(cursorStart) ||
      !Number.isInteger(cursorEnd) ||
      (cursorStart as number) < 0 ||
      (cursorEnd as number) < (cursorStart as number) ||
      (cursorEnd as number) > inbox.length
    )
      return 'checkpoint message cursor is invalid for the current inbox'

    const start = cursorStart as number
    const end = cursorEnd as number
    const pendingIds = checkpoint.pending_message_ids ?? []
    const actualIds = inbox.slice(start, end).map((message) => message.id)
    if (
      pendingIds.length !== end - start ||
      pendingIds.some((id, index) => actualIds[index] !== id)
    )
      return 'checkpoint message ids no longer match the inbox cursor range'

    const durableThreadRevision = teamThreadRevision(
      this.store.readThread(member.name),
    )
    if (checkpoint.phase === 'terminal_pending') {
      if (!checkpoint.last_effect_receipt)
        return 'terminal checkpoint is missing its last effect receipt'
      if (
        !checkpoint.final_thread_revision ||
        checkpoint.final_thread_revision !==
          teamThreadRevision(checkpoint.messages)
      )
        return 'terminal checkpoint final thread revision is invalid'
      if (
        durableThreadRevision !== checkpoint.base_thread_revision &&
        durableThreadRevision !== checkpoint.final_thread_revision
      )
        return 'durable thread revision diverged from the terminal checkpoint'
    } else if (durableThreadRevision !== checkpoint.base_thread_revision) {
      return 'durable thread revision diverged from the resumable checkpoint'
    }

    const currentCursor = this.store.readCursor(member.name)
    if (currentCursor < start)
      return 'durable inbox cursor is behind the checkpoint start'
    if (checkpoint.phase === 'prepared' && currentCursor !== start)
      return 'prepared checkpoint cursor already advanced; refusing an unsafe replay'

    return {
      payload: checkpoint,
      history: checkpoint.messages,
      turnId: checkpoint.turn_id,
      cursorStart: start,
      cursorEnd: end,
      pendingIds,
      baseThreadRevision: checkpoint.base_thread_revision,
      leadBefore: new Set(
        checkpoint.lead_message_ids_before ??
          this.bus.allMessages(LEAD_ACTOR).map((message) => message.id),
      ),
    }
  }

  private writeRunCheckpoint(
    memberName: string,
    run: ValidatedTeamCheckpoint,
    phase: 'prepared' | 'running' | 'terminal_pending',
    receipt: TeamEffectReceipt | null = null,
  ): void {
    const finalRevision =
      phase === 'terminal_pending' ? teamThreadRevision(run.history) : undefined
    run.payload.phase = phase
    run.payload.final_thread_revision = finalRevision
    run.payload.last_effect_receipt = receipt ?? undefined
    this.store.writeCheckpoint(memberName, run.history, {
      checkpoint_version: TEAM_CHECKPOINT_VERSION,
      turn_id: run.turnId,
      phase,
      base_thread_revision: run.baseThreadRevision,
      final_thread_revision: finalRevision,
      pending_cursor_start: run.cursorStart,
      pending_cursor_end: run.cursorEnd,
      pending_message_ids: run.pendingIds,
      lead_message_ids_before: [...run.leadBefore],
      last_effect_receipt: receipt,
    })
  }

  private async finalizeCheckpoint(
    member: TeamMember,
    run: ValidatedTeamCheckpoint,
    receipt: TeamEffectReceipt,
    opts: {
      parent_call_id?: string | null
      eventSink?: TeamEventSink | null
    },
  ): Promise<string> {
    const finalRevision = teamThreadRevision(run.history)
    if (
      teamThreadRevision(this.store.readThread(member.name)) !== finalRevision
    )
      this.store.writeThread(member.name, run.history)

    if (receipt.reply_required) {
      let reply = this.bus
        .allMessages(LEAD_ACTOR)
        .find((message) => message.meta.team_turn_id === run.turnId)
      if (!reply) {
        reply = this.bus.send({
          from_actor: member.name,
          to: LEAD_ACTOR,
          content: receipt.result,
          type: 'result',
          in_reply_to: run.pendingIds.at(-1) ?? null,
          meta: {
            role: member.role,
            agent_type: member.agent_type,
            team_turn_id: run.turnId,
          },
        })
        await this.emit(events.messageEvent(reply), opts.eventSink)
      }
      if (receipt.reply_message_id !== reply.id) {
        receipt = { ...receipt, reply_message_id: reply.id }
        this.writeRunCheckpoint(member.name, run, 'terminal_pending', receipt)
      }
    }

    const cursor = this.store.readCursor(member.name)
    if (cursor < run.cursorEnd)
      this.store.writeCursor(member.name, run.cursorEnd)
    const current = this.requireMember(member.name)
    const terminal =
      current.status === TeamStatus.SHUTDOWN
        ? current
        : this.store.updateMember(member.name, {
            status: TeamStatus.IDLE,
            last_error: null,
          })
    if (terminal.status !== TeamStatus.SHUTDOWN)
      await this.emit(events.memberUpdate(terminal), opts.eventSink)
    this.store.clearCheckpoint(member.name)
    await this.emit(
      events.runDone({
        parent_id: opts.parent_call_id ?? null,
        member: terminal,
        summary: receipt.result,
      }),
      opts.eventSink,
    )
    return receipt.result
  }

  private async failCheckpointRecovery(
    member: TeamMember,
    message: string,
    opts: {
      parent_call_id?: string | null
      eventSink?: TeamEventSink | null
    },
    runnerRaised = false,
  ): Promise<string> {
    const current = this.requireMember(member.name)
    const terminal =
      current.status === TeamStatus.SHUTDOWN
        ? current
        : this.store.updateMember(member.name, {
            status: TeamStatus.ERROR,
            last_error: message,
          })
    if (terminal.status !== TeamStatus.SHUTDOWN)
      await this.emit(events.memberUpdate(terminal), opts.eventSink)
    await this.emit(
      events.runError({
        parent_id: opts.parent_call_id ?? null,
        member: terminal,
        message,
      }),
      opts.eventSink,
    )
    const reason = runnerRaised ? 'raised' : 'checkpoint recovery failed'
    return `Error: teammate '${member.name}' ${reason}: ${message}`
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
