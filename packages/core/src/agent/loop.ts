/**
 * AgentLoop 装配根 (MIG-CORE-011)。
 * 把 core 子系统组合成可执行的本地 Agent: session history、memory、tools、
 * subagents、scheduler、Team、control 和 routed AgentRunner。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { ContextBuilder, type SkillsLoaderLike } from './context-builder'
import { AgentRunner, type ControlManagerRunnerHost } from './runner'
import { buildRoutedRunner } from './runner-factory'
import { loadModelConfig } from '../config/model-config'
import { ControlManager } from '../control/manager'
import type { Interaction } from '../control/models'
import { AskUserTool, ProposePlanTool } from '../control/tools'
import { MCPClient } from '../mcp/client'
import { MemoryStore } from '../memory/store'
import { TokenTracker } from '../memory/token-tracker'
import { type ModelRoute, ModelRouter } from '../model/router'
import { ProjectStore } from '../projects/store'
import { ActiveTaskRegistry } from '../runtime/active'
import { RuntimeEventStore } from '../runtime/store'
import { SchedulerJobExecutor, type SchedulerAgentTurnPayload } from '../scheduler/executor'
import { SchedulerService } from '../scheduler/service'
import { SchedulerStore } from '../scheduler/store'
import { SchedulerTool } from '../scheduler/tool'
import { ConversationStore, ProjectSessionMemoryStore, SessionMemoryStore } from '../sessions/conversation'
import { migrateLegacyMainlineToDefaultSession } from '../sessions/migrate'
import { SessionStore, type SessionControlPending, type SessionEntry } from '../sessions/store'
import { buildDispatchRunnerFactory } from '../subagents/dispatch-runner'
import { SubagentRegistry } from '../subagents/registry'
import { TaskManager } from '../tasks/manager'
import {
  TeamBroadcastTool,
  TeamListTool,
  TeamReadInboxTool,
  TeamSendMessageTool,
  TeamShutdownTool,
  TeamSpawnTool,
} from '../team/tools'
import { TeamManager } from '../team/manager'
import type { TeamSubagentRegistry } from '../team/manager'
import {
  GlobTool,
  GrepTool,
  LoadSkill,
  RunCommand,
  TodoStore,
  UpdateTodos,
  WebFetch,
  type SkillsLoader as ToolSkillsLoader,
} from '../tools/builtin'
import { DispatchSubagentTool } from '../tools/dispatch'
import { EditFileTool, ReadFileTool, WriteFileTool } from '../tools/filesystem'
import { ToolRegistry } from '../tools/registry'
import * as runtimeEvents from '../runtime/events'

type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>
type Msg = Record<string, unknown>

export interface LoopModelRouter {
  route(useCase: string, agentType?: string | null, task?: string | null): ModelRoute
  payload?(): Record<string, unknown>
}

export interface AgentLoopCreateOptions {
  root: string
  templatesDir?: string
  modelRouter?: LoopModelRouter | null
  modelOverride?: string | null
  startupCompaction?: boolean
  initializeMcp?: boolean
  eventSink?: StreamEmitter | null
}

export interface RunUserTurnOptions {
  turnId?: string | null
  emit?: StreamEmitter | null
  displayContent?: string | null
  clientMessageId?: string | null
  source?: string | null
  scheduler?: Record<string, unknown> | null
  uiHidden?: boolean | null
  taskId?: string | null
  useActiveTask?: boolean
  memoryExtra?: Record<string, unknown> | null
}

export class AgentLoop {
  readonly root: string
  readonly templatesDir: string
  readonly registry = new ToolRegistry()
  readonly sessionStore: SessionStore
  readonly sharedMemory: MemoryStore
  readonly tokenTracker: TokenTracker
  readonly taskManager: TaskManager
  readonly projectStore: ProjectStore
  readonly controlManager: ControlManager
  readonly todoStore: TodoStore
  readonly schedulerStore: SchedulerStore
  readonly schedulerService: SchedulerService
  readonly activeTasks = new ActiveTaskRegistry()
  readonly skillsLoader: FileSkillsLoader
  readonly contextBuilder: ContextBuilder
  readonly subagentRegistry: SubagentRegistry
  readonly teamManager: TeamManager
  readonly mcpClient: MCPClient
  modelRouter: LoopModelRouter
  readonly eventSink: StreamEmitter | null

  activeSessionId: string | null = null
  activeSession: SessionEntry | null = null
  conversationStore!: ConversationStore
  activeMemoryStore!: SessionMemoryStore
  runtimeStore!: RuntimeEventStore
  runner!: AgentRunner
  history: Msg[] = []
  private readonly ownsModelRouter: boolean
  private readonly modelOverride: string | null
  private schedulerAgentTurnSubmitter: ((payload: SchedulerAgentTurnPayload) => Promise<string>) | null = null
  private controlPendingSessionId: string | null = null

  private constructor(opts: AgentLoopCreateOptions, modelRouter: LoopModelRouter, sharedMemory: MemoryStore) {
    this.root = resolve(opts.root)
    this.templatesDir = resolve(opts.templatesDir ?? join(this.root, 'templates'))
    this.registry.setRoot(this.root)
    this.modelRouter = modelRouter
    this.ownsModelRouter = !opts.modelRouter
    this.modelOverride = opts.modelOverride ?? null
    this.sharedMemory = sharedMemory
    this.eventSink = opts.eventSink ?? null

    this.sessionStore = new SessionStore(this.root)
    this.tokenTracker = new TokenTracker(join(this.root, 'memory', 'tokens.jsonl'))
    this.taskManager = new TaskManager(this.root)
    this.projectStore = new ProjectStore(this.root)
    this.controlManager = new ControlManager(this.root)
    this.todoStore = new TodoStore()
    this.schedulerStore = new SchedulerStore(this.root)
    this.schedulerService = new SchedulerService(this.schedulerStore, {
      eventSink: async (event) => { await this.emit(event) },
    })
    this.skillsLoader = new FileSkillsLoader(this.root)
    this.contextBuilder = new ContextBuilder(this.templatesDir, this.skillsLoader, { memory: this.sharedMemory })
    this.subagentRegistry = new SubagentRegistry(join(this.templatesDir, 'subagents'), this.skillsLoader)
    this.contextBuilder.setSubagentRegistry(this.subagentRegistry)
    this.teamManager = new TeamManager({
      root: this.root,
      parentRegistry: this.registry,
      subagentRegistry: this.teamSubagentRegistry(),
      eventSink: async (event) => { await this.emit(event) },
      runnerFactory: ({ member, spec, subRegistry }) => {
        const route = this.modelRouter.route('team', member.agent_type, spec.name ?? '')
        const runner = buildRoutedRunner({
          route,
          registry: subRegistry,
          systemPrompt: this.teamPrompt(spec as { systemPrompt?: string }),
          tokenTracker: this.tokenTracker,
          usageType: `team:${member.name}:${member.agent_type}`,
          memoryStore: null,
          compactor: null,
          todoStore: null,
          controlManager: this.permissionOnlyControlHost(),
          maxContext: route.snapshot.contextWindowTokens,
          maxTurns: 12,
        })
        return {
          step: (history) => runner.stepAsync(history),
          stepStream: (history, emit) => runner.stepStream(history, emit),
        }
      },
    })
    this.mcpClient = new MCPClient(this.root)

    this.controlManager.setTodoStore(this.todoStore)
    this.controlManager.setTaskManager(this.taskManager)
    this.controlManager.setPendingObserver({
      setPending: (interaction) => this.setActiveSessionControlPending(interaction),
      clearPending: (interaction) => this.clearSessionControlPending(interaction),
    })
    this.registerBuiltinTools()
    this.schedulerService.onJob = async (job) => this.schedulerExecutor().run(job)
  }

  static async create(opts: AgentLoopCreateOptions): Promise<AgentLoop> {
    const root = resolve(opts.root)
    mkdirSync(root, { recursive: true })
    migrateLegacyMainlineToDefaultSession(root)
    const templatesDir = resolve(opts.templatesDir ?? join(root, 'templates'))
    const userFile = ensureUserFile(root, templatesDir)
    const memoryTemplate = existingPath(join(templatesDir, 'init', 'MEMORY.md'))
    const sharedMemory = new MemoryStore(join(root, 'memory'), userFile, { memoryTemplate })
    const modelRouter = opts.modelRouter ?? new ModelRouter(root, await loadModelConfig(root, { create: true }), opts.modelOverride ?? null)
    const loop = new AgentLoop({ ...opts, root, templatesDir }, modelRouter, sharedMemory)
    if (opts.initializeMcp !== false) {
      await loop.mcpClient.initialize()
      loop.mcpClient.registerTools(loop.registry)
    }
    const session = loop.ensureActiveSession()
    loop.activateSession(session.id)
    if (opts.startupCompaction) {
      await loop.maybeCompactStartup()
    }
    return loop
  }

  activateSession(sessionId: string): SessionEntry {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    this.activeSession = session
    this.activeSessionId = session.id
    this.conversationStore = new ConversationStore(this.sessionStore.sessionDir(session.id))
    this.activeMemoryStore = this.memoryStoreForSession(session, this.conversationStore)
    this.runtimeStore = new RuntimeEventStore(this.conversationStore.sessionDir, { sessionDirOverride: true })
    this.history = this.conversationStore.readCheckpoint() ?? this.activeMemoryStore.loadUnarchivedHistory()
    this.contextBuilder.setSessionScope(this.sessionScope(session))
    this.runner = this.buildMainRunner()
    return session
  }

  reconcileSessionControlPending(): void {
    const pending = this.controlManager.store.load().pending
    const summary = pending ? this.sessionControlPending(pending) : null
    this.sessionStore.reconcileControlPending(summary, this.activeSessionId)
    if (summary) {
      this.controlPendingSessionId = this.findControlPendingSessionId(summary.interaction_id)
    } else {
      this.controlPendingSessionId = null
    }
  }

  controlPendingOwnerSessionId(interactionId: string): string | null {
    return this.findControlPendingSessionId(interactionId)
  }

  async runUserTurn(content: string, opts: RunUserTurnOptions = {}): Promise<string> {
    const turnId = opts.turnId || randomUUID().replace(/-/g, '').slice(0, 16)
    const taskId = opts.taskId || `turn:${turnId}`
    const awaitable = this.runUserTurnInner(content, turnId, opts)
    if (opts.useActiveTask === false) return awaitable
    return this.activeTasks.run({
      taskId,
      kind: 'turn',
      label: 'Agent turn',
      awaitable,
      turnId,
    })
  }

  setSchedulerAgentTurnSubmitter(submitter: ((payload: SchedulerAgentTurnPayload) => Promise<string>) | null): void {
    this.schedulerAgentTurnSubmitter = submitter
  }

  async close(): Promise<void> {
    this.schedulerService.stop()
    await this.mcpClient.close()
  }

  refreshRuntimeContext(): void {
    if (this.runner) this.runner.systemPrompt = this.contextBuilder.buildSystemPrompt()
  }

  async refreshModelConfig(): Promise<void> {
    if (!this.ownsModelRouter) return
    this.modelRouter = new ModelRouter(this.root, await loadModelConfig(this.root, { create: true }), this.modelOverride)
    if (this.activeSessionId) this.runner = this.buildMainRunner()
  }

  async reloadMcp(): Promise<void> {
    await this.mcpClient.close()
    this.registry.unregisterWhere((name) => name.startsWith('mcp_'))
    await this.mcpClient.initialize()
    this.mcpClient.registerTools(this.registry)
  }

  private async runUserTurnInner(content: string, turnId: string, opts: RunUserTurnOptions): Promise<string> {
    if (!this.activeSessionId) this.activateSession(this.ensureActiveSession().id)
    const displayContent = opts.displayContent ?? content
    const userMessage: Msg = { role: 'user', content }
    if (turnId) userMessage.turn_id = turnId
    if (displayContent !== content) userMessage.displayContent = displayContent
    this.history.push(userMessage)
    this.activeMemoryStore.appendHistory('user', content, {
      extra: {
        ...(opts.memoryExtra ?? {}),
        turn_id: turnId,
        ...(displayContent !== content ? { displayContent } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      },
    })
    this.sessionStore.touch(this.activeSessionId!, displayContent, { incrementMessages: true })
    await this.emit(
      runtimeEvents.userMessage({
        content: displayContent,
        attachments: [],
        clientMessageId: opts.clientMessageId ?? turnId,
        source: opts.source ?? null,
        scheduler: opts.scheduler ?? null,
        uiHidden: opts.uiHidden ?? false,
      }),
      { turnId, emit: opts.emit ?? null },
    )

    const reply = await this.runner.stepStream(this.history, async (event) => {
      await this.emit(event, { turnId, emit: opts.emit ?? null })
    }, { turnId })
    this.sessionStore.touch(this.activeSessionId!, reply, { incrementMessages: true })
    return reply
  }

  private buildMainRunner(): AgentRunner {
    const route = this.modelRouter.route('main_agent')
    return buildRoutedRunner({
      route,
      registry: this.registry,
      systemPrompt: this.contextBuilder.buildSystemPrompt(),
      tokenTracker: this.tokenTracker,
      usageType: 'main_agent',
      memoryStore: this.activeMemoryStore,
      compactor: null,
      todoStore: this.todoStore,
      controlManager: this.controlManager,
      maxContext: route.snapshot.contextWindowTokens,
      maxTurns: 20,
    })
  }

  private registerBuiltinTools(): void {
    this.registry.register(new RunCommand(this.root))
    this.registry.register(new WebFetch())
    this.registry.register(new LoadSkill(this.skillsLoader))
    this.registry.register(new ReadFileTool(this.root))
    this.registry.register(new WriteFileTool(this.root))
    this.registry.register(new EditFileTool(this.root))
    this.registry.register(new GlobTool(this.root))
    this.registry.register(new GrepTool(this.root))
    this.registry.register(new SchedulerTool(this.schedulerService))
    this.registry.register(new AskUserTool(this.controlManager))
    this.registry.register(new ProposePlanTool(this.controlManager))
    this.registry.register(new UpdateTodos(this.todoStore))
    const controlHost = this.dispatchControlHost()
    this.registry.register(new DispatchSubagentTool({
      parentRegistry: this.registry,
      subagentRegistry: this.subagentRegistry,
      runnerFactory: buildDispatchRunnerFactory({
        modelRouter: this.modelRouter,
        tokenTracker: this.tokenTracker,
        memoryStore: null,
        compactor: null,
        todoStore: null,
        controlManager: this.permissionOnlyControlHost(),
      }),
      taskManager: this.taskManager,
      controlManager: controlHost,
    }))
    this.registry.register(new TeamSpawnTool(this.teamManager))
    this.registry.register(new TeamListTool(this.teamManager))
    this.registry.register(new TeamSendMessageTool(this.teamManager))
    this.registry.register(new TeamReadInboxTool(this.teamManager))
    this.registry.register(new TeamBroadcastTool(this.teamManager))
    this.registry.register(new TeamShutdownTool(this.teamManager))
  }

  private ensureActiveSession(): SessionEntry {
    const current = this.activeSessionId ? this.sessionStore.get(this.activeSessionId) : null
    if (current) return current
    const existing = this.sessionStore.list({ includeArchived: false })[0]
    return existing ?? this.sessionStore.create('Default')
  }

  private setActiveSessionControlPending(interaction: Interaction): void {
    const sessionId = this.activeSessionId
    if (!sessionId) return
    const pending = this.sessionControlPending(interaction)
    if (!pending) return
    const updated = this.sessionStore.setControlPending(sessionId, pending)
    if (updated) this.controlPendingSessionId = sessionId
  }

  private clearSessionControlPending(interaction: Interaction): void {
    const sessionId = this.controlPendingSessionId || this.findControlPendingSessionId(interaction.id)
    if (!sessionId) return
    this.sessionStore.clearControlPending(sessionId)
    if (this.controlPendingSessionId === sessionId) this.controlPendingSessionId = null
  }

  private findControlPendingSessionId(interactionId: string): string | null {
    return this.sessionStore
      .list({ includeArchived: true })
      .find((session) => session.control_pending?.interaction_id === interactionId)
      ?.id ?? null
  }

  private sessionControlPending(interaction: Interaction): SessionControlPending | null {
    if (interaction.status !== 'waiting') return null
    if (interaction.kind === 'ask') {
      return {
        kind: 'ask',
        label: '需要用户输入',
        tone: 'blue',
        interaction_id: interaction.id,
        updated_at: interaction.updatedAt,
      }
    }
    if (interaction.kind === 'plan') {
      return {
        kind: 'plan',
        label: '计划需要用户确认',
        tone: 'green',
        interaction_id: interaction.id,
        updated_at: interaction.updatedAt,
      }
    }
    return null
  }

  private memoryStoreForSession(session: SessionEntry, conversation: ConversationStore): SessionMemoryStore {
    if (session.mode === 'build' && session.project_id) {
      return new ProjectSessionMemoryStore(this.sharedMemory, conversation, this.projectStore, session.project_id)
    }
    return new SessionMemoryStore(this.sharedMemory, conversation)
  }

  private sessionScope(session: SessionEntry): { mode: string; projectAgents?: string; projectPath?: string; projectIndexSummary?: string } {
    if (session.mode !== 'build') {
      return { mode: 'chat', projectIndexSummary: this.projectStore.summaryForChat() }
    }
    const projectId = session.project_id ?? ''
    return {
      mode: 'build',
      projectPath: session.project_path ?? '',
      projectAgents: projectId ? this.projectStore.readAgents(projectId) : '',
      projectIndexSummary: this.projectStore.summaryForChat(),
    }
  }

  private schedulerExecutor(): SchedulerJobExecutor {
    return new SchedulerJobExecutor({
      activeTasks: this.activeTasks,
      taskManager: this.taskManager,
      controlPending: () => Boolean(this.controlManager.payload().pending),
      teamManagerForProject: () => this.teamManager,
      submitAgentTurn: async (payload: SchedulerAgentTurnPayload) => {
        if (this.schedulerAgentTurnSubmitter) return this.schedulerAgentTurnSubmitter(payload)
        return this.runUserTurn(payload.content, {
          turnId: payload.clientMessageId,
          displayContent: payload.displayContent,
          clientMessageId: payload.clientMessageId,
          source: payload.source,
          scheduler: payload.scheduler,
          taskId: payload.taskId ?? undefined,
          emit: payload.deliver ? this.eventSink : null,
        })
      },
    })
  }

  private teamPrompt(spec: { systemPrompt?: string }): string {
    return String(spec.systemPrompt || '你是 Agent Team 队友。请处理收到的任务并简洁回禀。')
  }

  private teamSubagentRegistry(): TeamSubagentRegistry {
    return {
      get: (name: string) => this.subagentRegistry.get(name),
      resolveName: (name: string) => this.subagentRegistry.resolveName(name),
      names: (includeAliases?: boolean) => this.subagentRegistry.names({ includeAliases }),
    }
  }

  private dispatchControlHost(): { mode?: string; [key: string]: unknown } {
    const control = this.controlManager
    return {
      get mode(): string {
        return control.mode
      },
    } as { mode?: string; [key: string]: unknown }
  }

  /**
   * 子代理/Team 成员的 AgentRunner 控件宿主：只透传权限评估（工具审批闸门必须
   * 覆盖子进程，否则 dispatch_subagent/Team 成为审批系统的旁路），不透传
   * Ask-Guard/Plan 起草——那些是面向主对话的交互式功能，子代理"独立上下文、
   * 只回传总结"的设计不应把用户拉进子代理内部的澄清/计划流程。
   */
  private permissionOnlyControlHost(): ControlManagerRunnerHost {
    const control = this.controlManager
    return {
      systemPrompt: () => '',
      toolDefinitions: (registry) => control.toolDefinitions(registry),
      assessPermission: (name, args, registry) => control.assessPermission(name, args, registry),
      permissionApprovalResult: (decision, opts) => control.permissionApprovalResult(decision as never, opts),
      assessClarification: () => ({ required: false, reason: '', questions: [], categories: [] }),
      shouldEnforcePlanFinal: () => false,
      createAsk: (opts) => control.createAsk(opts),
      createPlanFromText: (text) => control.createPlanFromText(text),
    }
  }

  private async emit(
    event: Record<string, unknown>,
    opts: { turnId?: string | null; emit?: StreamEmitter | null } = {},
  ): Promise<void> {
    const payload = this.runtimeStore ? this.runtimeStore.append(event, { turnId: opts.turnId ?? null }) : event
    const sink = opts.emit ?? this.eventSink
    if (sink) await sink(payload)
  }

  private async maybeCompactStartup(): Promise<void> {
    // Startup compaction needs a session-aware compactor. Keep the hook explicit for
    // callers while avoiding accidental cross-session history rewrites.
    return Promise.resolve()
  }
}

class FileSkillsLoader implements SkillsLoaderLike, ToolSkillsLoader {
  readonly skillsDir: string

  constructor(root: string) {
    this.skillsDir = join(root, 'skills')
  }

  getAlwaysSkills(): string[] {
    return []
  }

  loadSkillsForContext(names: string[]): string {
    return names.map((name) => this.getContent(name)).filter((item): item is string => Boolean(item)).join('\n\n---\n\n')
  }

  buildSkillsSummary(): string {
    return this.summary()
  }

  summary(): string {
    return this.skillNames().map((name) => {
      const content = this.getContent(name) ?? ''
      const first = content.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? ''
      return `- ${name}: ${first.slice(0, 180)}`
    }).join('\n')
  }

  getContent(name: string): string | null {
    const safe = safeSkillName(name)
    if (!safe) return null
    for (const path of [
      join(this.skillsDir, safe, 'SKILL.md'),
      join(this.skillsDir, `${safe}.md`),
    ]) {
      if (existsSync(path) && statSync(path).isFile()) return readFileSync(path, 'utf8')
    }
    return null
  }

  private skillNames(): string[] {
    if (!existsSync(this.skillsDir)) return []
    const names: string[] = []
    for (const item of readdirSync(this.skillsDir)) {
      if (item.startsWith('.')) continue
      const path = join(this.skillsDir, item)
      if (statSync(path).isDirectory() && existsSync(join(path, 'SKILL.md'))) names.push(item)
      else if (statSync(path).isFile() && item.endsWith('.md')) names.push(basename(item, '.md'))
    }
    return names.sort()
  }
}

function ensureUserFile(root: string, templatesDir: string): string {
  const dir = join(root, 'templates')
  mkdirSync(dir, { recursive: true })
  const userFile = join(dir, 'USER.local.md')
  if (!existsSync(userFile)) {
    const initUser = existingPath(join(templatesDir, 'init', 'USER.md'))
    writeFileSync(userFile, initUser ? readFileSync(initUser, 'utf8') : '# 用户偏好\n\n', 'utf8')
  }
  return userFile
}

function existingPath(path: string): string | null {
  return existsSync(path) ? path : null
}

function safeSkillName(name: string): string {
  const safe = String(name || '').trim()
  return /^[A-Za-z0-9_.-]+$/.test(safe) ? safe : ''
}
