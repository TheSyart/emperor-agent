import type {
  TeamCheckpointRecovery,
  TeamManager,
  TeamManagerPayload,
} from '../../team/manager'
import type { TeamMemberPayload, TeamMessagePayload } from '../../team/models'

type Dict = Record<string, any>
type TeamManagerProvider = TeamManager | (() => TeamManager | null) | null

export interface CoreTeamServiceDeps {
  teamManager: TeamManagerProvider
  activeSession?: () => {
    mode?: string | null
    project_id?: string | null
  } | null
  assertMutation?: (area: string, action: string) => void
}

export interface CoreTeamPayload extends TeamManagerPayload {
  managed: boolean
  scope: string
  project_id: string | null
}

export interface CoreTeamMemberPayload {
  member: TeamMemberPayload & { unread: number; tools: string[] }
  inbox: TeamMessagePayload[]
  leadInbox: TeamMessagePayload[]
  thread: Array<{ role?: string; content: string }>
}

export interface CoreTeamMutationPayload {
  result: string
  team: CoreTeamPayload
}

export class CoreTeamService {
  private readonly deps: CoreTeamServiceDeps

  constructor(deps: CoreTeamServiceDeps) {
    this.deps = deps
  }

  get(): CoreTeamPayload {
    const manager = this.managerOrNull()
    if (!manager) return fallbackPayload()
    return {
      ...manager.payload(),
      managed: true,
      scope: this.scope(),
      project_id: this.projectId(),
    }
  }

  getMember(name: string): CoreTeamMemberPayload {
    const manager = this.requireManager()
    const member = manager.store.getMember(name)
    if (!member) throw new Error(`unknown teammate: ${name}`)
    return {
      member: {
        ...member.toDict(),
        unread: manager.bus.unreadCount(member.name),
        tools: this.toolNamesForMember(member.agent_type),
      },
      inbox: manager.bus
        .recent(member.name, { limit: 100 })
        .map((msg) => msg.toDict()),
      leadInbox: manager.bus
        .recent('lead', { limit: 100 })
        .map((msg) => msg.toDict()),
      thread: this.threadSummary(member.name),
    }
  }

  spawnMember(opts: {
    name: string
    role: string
    task?: string | null
    agent_type?: string | null
  }): Promise<CoreTeamMutationPayload> {
    this.assertMutation('team', 'spawn teammate')
    return this.requireManager()
      .spawnTeammate(opts)
      .then((result) => ({ result, team: this.get() }))
  }

  sendMessage(opts: {
    to: string
    content: string
    wake?: boolean
  }): Promise<CoreTeamMutationPayload> {
    this.assertMutation('team', 'send message')
    return this.requireManager()
      .sendMessage(opts)
      .then((result) => ({ result, team: this.get() }))
  }

  wakeMember(
    name: string,
    opts: { purpose?: string; recovery?: TeamCheckpointRecovery } = {},
  ): Promise<CoreTeamMutationPayload> {
    this.assertMutation('team', 'wake teammate')
    return this.requireManager()
      .wakeTeammate(name, opts)
      .then((result) => ({ result, team: this.get() }))
  }

  shutdownMember(name: string): Promise<CoreTeamMutationPayload> {
    this.assertMutation('team', 'shutdown teammate')
    return this.requireManager()
      .shutdownTeammate({ name })
      .then((result) => ({ result, team: this.get() }))
  }

  private requireManager(): TeamManager {
    const manager = this.managerOrNull()
    if (!manager)
      throw new Error('Team is only available inside Build project sessions')
    return manager
  }

  private managerOrNull(): TeamManager | null {
    const provider = this.deps.teamManager
    if (!provider) return null
    return typeof provider === 'function' ? provider() : provider
  }

  private assertMutation(area: string, action: string): void {
    this.deps.assertMutation?.(area, action)
  }

  private scope(): string {
    return this.deps.activeSession?.()?.mode === 'build' ? 'project' : 'chat'
  }

  private projectId(): string | null {
    const session = this.deps.activeSession?.()
    return session?.mode === 'build'
      ? String(session.project_id || '') || null
      : null
  }

  private toolNamesForMember(agentType: string): string[] {
    const manager = this.requireManager()
    const spec = manager.subagentRegistry.get(agentType)
    const raw = spec?.tool_names ?? spec?.toolNames ?? []
    return spec ? [...raw, 'send_message', 'read_inbox'] : []
  }

  private threadSummary(
    name: string,
  ): Array<{ role?: string; content: string }> {
    return this.requireManager()
      .store.readThread(name)
      .slice(-20)
      .map((item) => ({
        ...(typeof item.role === 'string' ? { role: item.role } : {}),
        content: extractTextContent(item.content).slice(0, 2000),
      }))
  }
}

function fallbackPayload(): CoreTeamPayload {
  return {
    managed: true,
    scope: 'chat',
    project_id: null,
    config: { team_name: 'none', members: [] },
    members: [],
    leadUnread: 0,
    leadInbox: [],
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        (block as Dict).type === 'text'
          ? String((block as Dict).text ?? '')
          : '',
      )
      .join('')
  }
  return String(content ?? '')
}
