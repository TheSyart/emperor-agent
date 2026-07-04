/**
 * AgentLoop 装配根 (MIG-CORE-011)。
 * 把 core 子系统组合成可执行的本地 Agent: session history、memory、tools、
 * subagents、scheduler、Team、control 和 routed AgentRunner。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { ContextBuilder, renderContextSections, type SkillsLoaderLike } from './context-builder'
import { AgentRunner, type ControlManagerRunnerHost } from './runner'
import { buildRoutedRunner } from './runner-factory'
import { dispatchControlHost, permissionOnlyControlHost } from './control-hosts'
import { loadLocalConfig, type PromptProfile } from '../config/local-config'
import type { PermissionRuleInput } from '../permissions/rules'
import { loadModelConfig } from '../config/model-config'
import { ControlManager } from '../control/manager'
import type { Interaction } from '../control/models'
import { AskUserTool, ProposePlanTool, RequestPlanModeTool } from '../control/tools'
import { MCPClient } from '../mcp/client'
import { MemoryStore } from '../memory/store'
import { TokenTracker } from '../memory/token-tracker'
import { type ModelRoute, ModelRouter } from '../model/router'
import { WorkspacePolicy } from '../permissions/workspace-policy'
import { ProjectStore } from '../projects/store'
import { ActiveTaskRegistry, TurnBusyError } from '../runtime/active'
import { migrateLegacyStateRoot } from '../runtime/migrate-state-root'
import { ensureRuntimeStateDirs, resolveRuntimePaths, type RuntimePaths } from '../runtime/paths'
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
import { WebSearchTool } from '../tools/web-search'
import * as runtimeEvents from '../runtime/events'

type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>
type Msg = Record<string, unknown>

export interface TurnScope {
  sessionId: string
  turnId: string
  mode: 'chat' | 'build'
  projectId: string | null
  workspaceRoot: string
  stateRoot: string
  sessionRoot: string
  projectStateRoot: string | null
}

export interface LoopModelRouter {
  route(useCase: string, agentType?: string | null, task?: string | null): ModelRoute
  payload?(): Record<string, unknown>
}

export interface AgentLoopCreateOptions {
  root: string
  stateRoot?: string | null
  templatesDir?: string
  userFile?: string | null
  promptProfile?: PromptProfile | string | null
  modelRouter?: LoopModelRouter | null
  modelOverride?: string | null
  initializeMcp?: boolean
  eventSink?: StreamEmitter | null
  permissionRules?: PermissionRuleInput[] | null
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
  readonly paths: RuntimePaths
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
  private readonly todosBySession = new Map<string, Array<Record<string, unknown>>>()
  private readonly teamManagersByProject = new Map<string, TeamManager>()

  private constructor(opts: AgentLoopCreateOptions, modelRouter: LoopModelRouter, sharedMemory: MemoryStore) {
    this.paths = resolveRuntimePaths(opts.root, { stateRoot: opts.stateRoot ?? null, templatesDir: opts.templatesDir ?? null })
    this.root = this.paths.runtimeRoot
    this.templatesDir = this.paths.templatesDir
    this.registry.setRoot(this.paths.stateRoot)
    this.modelRouter = modelRouter
    this.ownsModelRouter = !opts.modelRouter
    this.modelOverride = opts.modelOverride ?? null
    this.sharedMemory = sharedMemory
    this.eventSink = opts.eventSink ?? null

    this.sessionStore = new SessionStore(this.paths.stateRoot)
    this.tokenTracker = new TokenTracker(this.paths.tokensFile)
    this.taskManager = new TaskManager(this.paths.stateRoot)
    this.projectStore = new ProjectStore(this.paths.stateRoot, { versions: this.sharedMemory.versions })
    this.controlManager = new ControlManager(this.paths.stateRoot, { permissionRules: opts.permissionRules ?? [] })
    this.todoStore = new TodoStore()
    this.schedulerStore = new SchedulerStore(this.paths.stateRoot)
    this.schedulerService = new SchedulerService(this.schedulerStore, {
      eventSink: async (event) => { await this.emit(event) },
      targetSessionId: () => this.activeSessionId,
    })
    this.skillsLoader = new FileSkillsLoader(this.root)
    this.contextBuilder = new ContextBuilder(this.templatesDir, this.skillsLoader, {
      memory: this.sharedMemory,
      userFile: opts.userFile ?? this.sharedMemory.userFile,
      promptProfile: opts.promptProfile ?? 'technical',
    })
    this.subagentRegistry = new SubagentRegistry(join(this.templatesDir, 'subagents'), this.skillsLoader)
    this.contextBuilder.setSubagentRegistry(this.subagentRegistry)
    this.teamManager = this.createTeamManager(null)
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
    const paths = resolveRuntimePaths(opts.root, { stateRoot: opts.stateRoot ?? null, templatesDir: opts.templatesDir ?? null })
    const root = paths.runtimeRoot
    mkdirSync(root, { recursive: true })
    ensureRuntimeStateDirs(paths)
    migrateLegacyStateRoot(paths)
    migrateLegacyMainlineToDefaultSession(paths.stateRoot)
    const localConfig = await loadLocalConfig(root, { preserveCorrupt: false })
    const templatesDir = paths.templatesDir
    const userFile = ensureUserFile(paths.stateRoot, templatesDir)
    const memoryTemplate = existingPath(join(templatesDir, 'init', 'MEMORY.md'))
    const sharedMemory = new MemoryStore(paths.memoryRoot, userFile, { memoryTemplate })
    const modelRouter = opts.modelRouter ?? new ModelRouter(root, await loadModelConfig(root, { create: true }), opts.modelOverride ?? null)
    const loop = new AgentLoop({
      ...opts,
      root,
      stateRoot: paths.stateRoot,
      templatesDir,
      userFile,
      promptProfile: opts.promptProfile ?? localConfig.prompt.profile,
      permissionRules: localConfig.permissions.rules,
    }, modelRouter, sharedMemory)
    if (opts.initializeMcp !== false) {
      await loop.mcpClient.initialize()
      loop.mcpClient.registerTools(loop.registry)
    }
    const session = loop.ensureActiveSession()
    loop.activateSession(session.id)
    return loop
  }

  activateSession(sessionId: string): SessionEntry {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    const previousSessionId = this.activeSessionId
    if (previousSessionId && previousSessionId !== session.id) {
      this.todosBySession.set(previousSessionId, cloneTodoItems(this.todoStore.todos))
    }
    this.activeSession = session
    this.activeSessionId = session.id
    if (previousSessionId !== session.id) {
      this.todoStore.todos = cloneTodoItems(this.todosBySession.get(session.id) ?? [])
    }
    this.conversationStore = new ConversationStore(this.sessionStore.sessionDir(session.id))
    this.activeMemoryStore = this.memoryStoreForSession(session, this.conversationStore)
    this.runtimeStore = new RuntimeEventStore(this.conversationStore.sessionDir, { sessionDirOverride: true })
    this.history = this.conversationStore.readCheckpoint() ?? this.activeMemoryStore.loadUnarchivedHistory()
    this.contextBuilder.setSessionScope(this.sessionScope(session))
    this.controlManager.setRuntimeScope(this.controlRuntimeScopeForSession(session))
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
    if (opts.useActiveTask !== false && this.activeTasks.hasActiveKind('turn')) {
      throw new TurnBusyError()
    }
    const turnId = opts.turnId || randomUUID().replace(/-/g, '').slice(0, 16)
    const taskId = opts.taskId || `turn:${turnId}`
    const abortController = new AbortController()
    const awaitable = this.runUserTurnInner(content, turnId, opts, abortController.signal)
    if (opts.useActiveTask === false) return awaitable
    return this.activeTasks.run({
      taskId,
      kind: 'turn',
      label: 'Agent turn',
      awaitable,
      turnId,
      sessionId: this.activeSessionId,
      abort: () => abortController.abort(),
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
    if (!this.runner) return
    const sections = this.contextBuilder.buildSections()
    this.runner.systemPrompt = renderContextSections(sections)
    this.runner.promptSections = sections
    this.runner.promptSnapshotDir = this.activeSessionId ? join(this.sessionStore.sessionDir(this.activeSessionId), 'prompt-snapshots') : null
    this.runner.sessionId = this.activeSessionId
    if (this.activeSession) this.controlManager.setRuntimeScope(this.controlRuntimeScopeForSession(this.activeSession))
  }

  workspacePolicyDiagnostics(): Record<string, unknown> {
    return new WorkspacePolicy({
      workspaceRoot: this.workspaceRootForActiveSession(),
      stateRoot: this.paths.stateRoot,
    }).describe()
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

  private async runUserTurnInner(content: string, turnId: string, opts: RunUserTurnOptions, signal: AbortSignal | null): Promise<string> {
    if (!this.activeSessionId) this.activateSession(this.ensureActiveSession().id)
    const session = this.activeSession ?? this.sessionStore.get(this.activeSessionId!)
    const sessionId = session?.id ?? this.activeSessionId!
    const history = this.history
    const memoryStore = this.activeMemoryStore
    const runner = this.runner
    const runtimeStore = this.runtimeStore
    if (!session || !runner || !runtimeStore) throw new Error('active session is not initialized')
    this.controlManager.setRuntimeScope(this.controlRuntimeScopeForSession(session))
    const scope = this.turnScope(session, turnId)
    const displayContent = opts.displayContent ?? content
    const userMessage: Msg = { role: 'user', content }
    if (turnId) userMessage.turn_id = turnId
    if (displayContent !== content) userMessage.displayContent = displayContent
    history.push(userMessage)
    memoryStore.appendHistory('user', content, {
      extra: {
        ...(opts.memoryExtra ?? {}),
        turn_id: turnId,
        ...(displayContent !== content ? { displayContent } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      },
    })
    this.sessionStore.touch(sessionId, displayContent, { incrementMessages: true })
    await this.emit(this.turnScopeEvent(scope), { turnId, emit: opts.emit ?? null, runtimeStore, scope })
    await this.emit(
      runtimeEvents.userMessage({
        content: displayContent,
        attachments: [],
        clientMessageId: opts.clientMessageId ?? turnId,
        source: opts.source ?? null,
        scheduler: opts.scheduler ?? null,
        uiHidden: opts.uiHidden ?? false,
      }),
      { turnId, emit: opts.emit ?? null, runtimeStore, scope },
    )

    const reply = await runner.stepStream(history, async (event) => {
      await this.emit(event, { turnId, emit: opts.emit ?? null, runtimeStore, scope })
    }, { turnId, signal })
    this.sessionStore.touch(sessionId, reply, { incrementMessages: true })
    return reply
  }

  private buildMainRunner(): AgentRunner {
    const route = this.modelRouter.route('main_agent')
    const promptSections = this.contextBuilder.buildSections()
    return buildRoutedRunner({
      route,
      registry: this.registry,
      systemPrompt: renderContextSections(promptSections),
      tokenTracker: this.tokenTracker,
      usageType: 'main_agent',
      memoryStore: this.activeMemoryStore,
      compactor: null,
      todoStore: this.todoStore,
      controlManager: this.controlManager,
      maxContext: route.snapshot.contextWindowTokens,
      maxTurns: 20,
      workspaceRoot: this.workspaceRootForActiveSession(),
      promptSections,
      promptSnapshotDir: this.activeSessionId ? join(this.sessionStore.sessionDir(this.activeSessionId), 'prompt-snapshots') : null,
      sessionId: this.activeSessionId,
      // Wave5 灰度开关：默认关闭，行为与批式逐字节一致
      streamingToolExecution: process.env.EMPEROR_STREAMING_TOOLS === '1',
    })
  }

  private registerBuiltinTools(): void {
    this.registry.register(new RunCommand(this.root))
    this.registry.register(new WebSearchTool())
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
    this.registry.register(new RequestPlanModeTool(this.controlManager))
    this.registry.register(new UpdateTodos(this.todoStore))
    const controlHost = dispatchControlHost(this.controlManager)
    this.registry.register(new DispatchSubagentTool({
      parentRegistry: this.registry,
      subagentRegistry: this.subagentRegistry,
      runnerFactory: buildDispatchRunnerFactory({
        modelRouter: this.modelRouter,
        tokenTracker: this.tokenTracker,
        memoryStore: null,
        compactor: null,
        todoStore: null,
        controlManager: permissionOnlyControlHost(this.controlManager),
      }),
      taskManager: this.taskManager,
      controlManager: controlHost,
    }))
    const activeTeamManager = () => this.teamManagerForActiveSession()
    this.registry.register(new TeamSpawnTool(activeTeamManager))
    this.registry.register(new TeamListTool(activeTeamManager))
    this.registry.register(new TeamSendMessageTool(activeTeamManager))
    this.registry.register(new TeamReadInboxTool(activeTeamManager))
    this.registry.register(new TeamBroadcastTool(activeTeamManager))
    this.registry.register(new TeamShutdownTool(activeTeamManager))
  }

  teamManagerForActiveSession(): TeamManager | null {
    return this.teamManagerForSession(this.activeSession ?? (this.activeSessionId ? this.sessionStore.get(this.activeSessionId) : null))
  }

  teamManagerForSession(session: SessionEntry | null | undefined): TeamManager | null {
    if (session?.mode !== 'build' || !session.project_id) return null
    return this.teamManagerForProject(session.project_id)
  }

  teamManagerForProject(projectId: string): TeamManager {
    const cleanProjectId = String(projectId || '').trim()
    if (!cleanProjectId) throw new Error('project_id is required for Team')
    const project = this.projectStore.get(cleanProjectId)
    if (!project) throw new Error(`unknown project: ${cleanProjectId}`)
    const existing = this.teamManagersByProject.get(cleanProjectId)
    if (existing) return existing
    const manager = this.createTeamManager(cleanProjectId)
    this.teamManagersByProject.set(cleanProjectId, manager)
    return manager
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

  private sessionScope(session: SessionEntry): { mode: string; projectAgents?: string; projectAgentsSource?: string; projectPath?: string; projectIndexSummary?: string } {
    if (session.mode !== 'build') {
      return { mode: 'chat', projectIndexSummary: this.projectStore.summaryForChat() }
    }
    const projectId = session.project_id ?? ''
    const project = projectId ? this.projectStore.get(projectId) : null
    return {
      mode: 'build',
      projectPath: session.project_path ?? '',
      projectAgents: projectId ? this.projectStore.readAgents(projectId) : '',
      projectAgentsSource: project?.agents_path ?? '',
      projectIndexSummary: this.projectStore.summaryForChat(),
    }
  }

  private workspaceRootForActiveSession(): string {
    const session = this.activeSession ?? (this.activeSessionId ? this.sessionStore.get(this.activeSessionId) : null)
    return this.workspaceRootForSession(session)
  }

  private workspaceRootForSession(session: SessionEntry | null | undefined): string {
    if (session?.mode === 'build' && session.project_path) return resolve(session.project_path)
    return this.root
  }

  private workspaceRootForProject(projectId: string): string {
    const project = this.projectStore.get(projectId)
    const path = project?.workspace_path || project?.project_path || ''
    return path ? resolve(path) : this.root
  }

  private controlRuntimeScopeForSession(session: SessionEntry): { sessionId: string; projectId: string | null; workspaceRoot: string } {
    return {
      sessionId: session.id,
      projectId: session.project_id ?? null,
      workspaceRoot: this.workspaceRootForSession(session),
    }
  }

  private turnScope(session: SessionEntry, turnId: string): TurnScope {
    const projectId = session.project_id ?? null
    return {
      sessionId: session.id,
      turnId,
      mode: session.mode,
      projectId,
      workspaceRoot: this.workspaceRootForSession(session),
      stateRoot: this.paths.stateRoot,
      sessionRoot: this.sessionStore.sessionDir(session.id),
      projectStateRoot: projectId ? join(this.paths.projectsRoot, projectId) : null,
    }
  }

  private turnScopeEvent(scope: TurnScope): Record<string, unknown> {
    return {
      event: 'turn_scope',
      session_id: scope.sessionId,
      turn_id: scope.turnId,
      mode: scope.mode,
      project_id: scope.projectId,
      workspace_root: scope.workspaceRoot,
      state_root: scope.stateRoot,
      session_root: scope.sessionRoot,
      project_state_root: scope.projectStateRoot,
    }
  }

  private schedulerExecutor(): SchedulerJobExecutor {
    return new SchedulerJobExecutor({
      activeTasks: this.activeTasks,
      taskManager: this.taskManager,
      controlPending: () => Boolean(this.controlManager.payload().pending),
      teamManagerForProject: (projectId) => this.teamManagerForProject(projectId),
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

  private createTeamManager(projectId: string | null): TeamManager {
    const cleanProjectId = String(projectId || '').trim() || null
    const projectStateRoot = cleanProjectId ? join(this.paths.projectsRoot, cleanProjectId) : this.paths.stateRoot
    const teamDir = cleanProjectId ? join(projectStateRoot, 'team') : this.paths.teamRoot
    return new TeamManager({
      root: projectStateRoot,
      teamDir,
      projectId: cleanProjectId,
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
          usageType: `team:${cleanProjectId ?? 'global'}:${member.name}:${member.agent_type}`,
          memoryStore: null,
          compactor: null,
          todoStore: null,
          controlManager: permissionOnlyControlHost(this.controlManager),
          maxContext: route.snapshot.contextWindowTokens,
          maxTurns: 12,
          workspaceRoot: cleanProjectId ? this.workspaceRootForProject(cleanProjectId) : this.workspaceRootForActiveSession(),
        })
        return {
          step: (history) => runner.stepAsync(history),
          stepStream: (history, emit) => runner.stepStream(history, emit),
        }
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



  private async emit(
    event: Record<string, unknown>,
    opts: { turnId?: string | null; emit?: StreamEmitter | null; runtimeStore?: RuntimeEventStore | null; scope?: TurnScope | null } = {},
  ): Promise<void> {
    const scoped = opts.scope ? withTurnScope(event, opts.scope) : event
    const store = opts.runtimeStore ?? this.runtimeStoreForEvent(scoped)
    const payload = store ? store.append(scoped, { turnId: opts.turnId ?? null }) : scoped
    const sink = opts.emit ?? this.eventSink
    if (sink) await sink(payload)
  }

  private runtimeStoreForEvent(event: Record<string, unknown>): RuntimeEventStore | null {
    const ownerSessionId = eventOwnerSessionId(event)
    if (ownerSessionId && ownerSessionId !== this.activeSessionId && this.sessionStore.get(ownerSessionId)) {
      return new RuntimeEventStore(this.sessionStore.sessionDir(ownerSessionId), { sessionDirOverride: true })
    }
    return this.runtimeStore
  }

}

function withTurnScope(event: Record<string, unknown>, scope: TurnScope): Record<string, unknown> {
  return {
    ...event,
    session_id: event.session_id ?? scope.sessionId,
    turn_id: event.turn_id ?? scope.turnId,
    workspace_root: event.workspace_root ?? scope.workspaceRoot,
    state_root: event.state_root ?? scope.stateRoot,
    session_root: event.session_root ?? scope.sessionRoot,
    project_id: event.project_id ?? scope.projectId,
    project_state_root: event.project_state_root ?? scope.projectStateRoot,
  }
}

function eventOwnerSessionId(event: Record<string, unknown>): string {
  const direct = String(event.session_id ?? event.sessionId ?? '').trim()
  if (direct) return direct
  const owner = event.owner
  if (owner && typeof owner === 'object' && !Array.isArray(owner)) {
    return String((owner as Record<string, unknown>).session_id ?? (owner as Record<string, unknown>).sessionId ?? '').trim()
  }
  return ''
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

function cloneTodoItems(todos: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return todos.map((todo) => ({ ...todo }))
}

function safeSkillName(name: string): string {
  const safe = String(name || '').trim()
  return /^[A-Za-z0-9_.-]+$/.test(safe) ? safe : ''
}
