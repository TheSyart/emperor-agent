import {
  Tool,
  type ToolExecutionContext,
  type ToolResult,
  okResult,
} from '../tools/base'
import { B, I, S, toolParamsSchema } from '../tools/schema'
import { LEAD_ACTOR } from './models'

type TeamToolEventSink =
  ((event: Record<string, unknown>) => Promise<void> | void) | null

export interface TeamToolHost {
  spawnTeammate(opts: {
    name: string
    role: string
    task?: string | null
    agent_type?: string | null
    sender?: string
    parent_call_id?: string | null
    eventSink?: TeamToolEventSink
  }): Promise<string>
  listTeammates(): string
  readInbox(opts?: {
    actor?: string
    limit?: number
    mark_read?: boolean
  }): string
  sendMessage(opts: {
    to: string
    content: string
    sender?: string
    wake?: boolean
    type?: string
    parent_call_id?: string | null
    eventSink?: TeamToolEventSink
  }): Promise<string>
  broadcast(opts: {
    content: string
    recipients?: string[] | null
    wake?: boolean
    parent_call_id?: string | null
    eventSink?: TeamToolEventSink
  }): Promise<string>
  shutdownTeammate(opts: {
    name: string
    eventSink?: TeamToolEventSink
  }): Promise<string>
}

type TeamManagerProvider =
  TeamToolHost | ((sessionId: string | null) => TeamToolHost | null)

export class TeamTool extends Tool {
  override requiresRuntimeContext = true
  override evidencePolicy = 'forbidden' as const
  protected readonly managerProvider: TeamManagerProvider
  protected readonly sender: string
  protected readonly actor: string
  protected readonly allowWake: boolean
  override name = 'team_tool'
  override description = 'team tool'
  override parameters = toolParamsSchema({})

  constructor(
    manager: TeamManagerProvider,
    opts: { sender?: string; actor?: string; allowWake?: boolean } = {},
  ) {
    super()
    this.managerProvider = manager
    this.sender = opts.sender ?? LEAD_ACTOR
    this.actor = opts.actor ?? LEAD_ACTOR
    this.allowWake = opts.allowWake ?? true
  }

  execute(_args: Record<string, unknown>): string | Promise<string> {
    return ''
  }

  override mapResult(raw: string, _ctx: ToolExecutionContext): ToolResult {
    return okResult(raw, { meta: { tool: this.name, team: true } })
  }

  protected manager(ctx?: ToolExecutionContext): TeamToolHost {
    const manager =
      typeof this.managerProvider === 'function'
        ? this.managerProvider(String(ctx?.sessionId ?? '').trim() || null)
        : this.managerProvider
    if (!manager)
      throw new Error('Team is only available inside Build project sessions')
    return manager
  }
}

export class TeamSpawnTool extends TeamTool {
  override name = 'spawn_teammate'
  override domainStateMutation = true
  override description =
    '创建或唤回一个持久队友。队友会写入 .team/config.json，并拥有独立收件箱和会话；仅当用户需要长期协作角色时使用，短期探索优先 dispatch_subagent。'
  override exclusive = true
  override parameters = toolParamsSchema(
    {
      name: S('队友名称，例如 alice'),
      role: S('队友角色，例如 coder/reviewer/researcher'),
      task: { type: 'string', description: '初始任务；为空则只创建队友' },
      agent_type: { type: 'string', description: '可选子代理身份覆盖' },
    },
    ['name', 'role'],
  )

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    return this.manager(ctx).spawnTeammate({
      name: String(args.name ?? ''),
      role: String(args.role ?? ''),
      task: nullableString(args.task),
      agent_type: nullableString(args.agent_type),
      sender: this.sender,
      parent_call_id: ctx?.parentCallId ?? null,
      eventSink: ctx?.emit ?? null,
    })
  }
}

export class TeamListTool extends TeamTool {
  override name = 'list_teammates'
  override description =
    '列出当前队友成员、运行状态、未读消息与最近回禀。只用于查看持久队友状态，不会唤醒或修改队友。'
  override readOnly = true
  override parameters = toolParamsSchema({})

  override execute(
    _args?: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): string {
    return this.manager(ctx).listTeammates()
  }
}

export class TeamSendMessageTool extends TeamTool {
  override name = 'send_message'
  override domainStateMutation = true
  override description =
    '向主控或队友发送一条收件箱消息。主控可设置 wake=true 立即唤醒目标队友；队友发送消息时不会递归唤醒其他队友。仅用于持久 Team 协作，不要替代普通用户回复。'
  override exclusive = true
  override parameters = toolParamsSchema(
    {
      to: S('接收者：lead 或队友名称'),
      content: S('消息内容'),
      wake: B('是否立即唤醒目标队友执行'),
    },
    ['to', 'content'],
  )

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    return this.manager(ctx).sendMessage({
      to: String(args.to ?? ''),
      content: String(args.content ?? ''),
      sender: this.sender,
      wake: Boolean((args.wake ?? true) && this.allowWake),
      parent_call_id: ctx?.parentCallId ?? null,
      eventSink: ctx?.emit ?? null,
    })
  }
}

export class TeamReadInboxTool extends TeamTool {
  override name = 'read_inbox'
  override domainStateMutation = true
  override description =
    '读取当前角色的队友收件箱。主控读取主控收件箱，队友读取自己的收件箱；只读查看消息，不应代替 send_message 发送回复。'
  override exclusive = true
  override parameters = toolParamsSchema({
    limit: I('最多读取多少条未读消息，默认 20；0 表示读取全部未读'),
    mark_read: B('是否把读取到的消息标记为已读，默认 true'),
  })

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): string {
    return this.manager(ctx).readInbox({
      actor: this.actor,
      limit: Number(args.limit ?? 20),
      mark_read: Boolean(args.mark_read ?? true),
    })
  }
}

export class TeamBroadcastTool extends TeamTool {
  override name = 'broadcast'
  override domainStateMutation = true
  override description =
    '向多个队友广播消息；默认发送给所有未停用队友，并可逐个唤醒执行。仅用于需要多名持久队友同步上下文的任务，不要代替普通子代理派遣。'
  override exclusive = true
  override parameters = toolParamsSchema(
    {
      content: S('广播内容'),
      recipients: {
        type: 'array',
        items: S('队友名称'),
        description: '队友名称列表；为空则发给所有可用队友',
      },
      wake: B('是否立即唤醒目标队友执行'),
    },
    ['content'],
  )

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    return this.manager(ctx).broadcast({
      content: String(args.content ?? ''),
      recipients: Array.isArray(args.recipients)
        ? args.recipients.map(String)
        : null,
      wake: Boolean(args.wake ?? true),
      parent_call_id: ctx?.parentCallId ?? null,
      eventSink: ctx?.emit ?? null,
    })
  }
}

export class TeamShutdownTool extends TeamTool {
  override name = 'shutdown_teammate'
  override domainStateMutation = true
  override description =
    '停用一个队友。记录会保留，但该队友不再接收新任务；属于持久状态变更，除非用户明确要求或计划批准，不要随意调用。'
  override exclusive = true
  override parameters = toolParamsSchema({ name: S('队友名称') }, ['name'])

  override execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    return this.manager(ctx).shutdownTeammate({
      name: String(args.name ?? ''),
      eventSink: ctx?.emit ?? null,
    })
  }
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}
