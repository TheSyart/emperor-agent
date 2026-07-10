/**
 * AgentLoop 装配根 (MIG-CORE-011)。
 * 把 core 子系统组合成可执行的本地 Agent: session history、memory、tools、
 * subagents、scheduler、Team、control 和 routed AgentRunner。
 */
import { randomUUID } from 'node:crypto'
import { buildUserContent, refToJson } from '../attachments/encode'
import { AttachmentStore } from '../attachments/store'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { ContextBuilder, type SkillsLoaderLike } from './context-builder'
import {
  AgentRunner,
  type AgentRunnerHookHost,
  type CompactorLike,
} from './runner'
import { buildRoutedRunner } from './runner-factory'
import { dispatchControlHost, permissionOnlyControlHost } from './control-hosts'
import { loadLocalConfig, type PromptProfile } from '../config/local-config'
import type { PermissionRuleInput } from '../permissions/rules'
import { loadModelConfig } from '../config/model-config'
import { ControlManager } from '../control/manager'
import type { Interaction } from '../control/models'
import {
  AskUserTool,
  ProposePlanTool,
  RequestPlanModeTool,
} from '../control/tools'
import { MCPClient } from '../mcp/client'
import { MemoryStore } from '../memory/store'
import { compactSession } from '../memory/compaction-service'
import {
  CompactionCursorStore,
  CompactionLedger,
  latestAppliedCompactionRun,
} from '../memory/compaction-ledger'
import type { ActiveMemoryBinding } from '../memory/compaction-models'
import { TokenTracker } from '../memory/token-tracker'
import { todayUtc8 } from '../memory/time-utc8'
import { type ModelRoute, ModelRouter } from '../model/router'
import {
  assertModelAvailable,
  type ModelAvailability,
} from '../model/availability'
import {
  HookService,
  type HookAggregateDecision,
  type HookEventName,
  type HookRuntimeRunOptions,
  type HookSnapshot,
} from '../hooks'
import { WorkspacePolicy } from '../permissions/workspace-policy'
import { ProjectStore } from '../projects/store'
import { ActiveTaskRegistry, TurnBusyError } from '../runtime/active'
import {
  migrateLegacyStateRoot,
  type LegacyStateMigrationResult,
} from '../runtime/migrate-state-root'
import {
  ensureRuntimeStateDirs,
  resolveRuntimePaths,
  type RuntimePaths,
} from '../runtime/paths'
import { RuntimeEventStore } from '../runtime/store'
import {
  SchedulerJobExecutor,
  type SchedulerAgentTurnPayload,
} from '../scheduler/executor'
import { SchedulerService } from '../scheduler/service'
import { SchedulerStore } from '../scheduler/store'
import { SchedulerTool } from '../scheduler/tool'
import {
  ConversationStore,
  ProjectSessionMemoryStore,
  SessionMemoryStore,
} from '../sessions/conversation'
import { migrateLegacyMainlineToDefaultSession } from '../sessions/migrate'
import {
  claimProfileOnboardingTrigger,
  ensureUserProfileFile,
  onboardingTriggerContent,
} from '../sessions/onboarding'
import {
  SessionStore,
  type SessionControlPending,
  type SessionEntry,
} from '../sessions/store'
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
  LoadSkill,
  RunCommand,
  SaveUserProfileTool,
  TodoStore,
  UpdateTodos,
  WebFetch,
  type SkillsLoader as ToolSkillsLoader,
} from '../tools/builtin'
import { GlobTool, GrepTool } from '../tools/search'
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
  activeMemoryBinding: ActiveMemoryBinding
  workspaceRoot: string
  stateRoot: string
  sessionRoot: string
  projectStateRoot: string | null
}

export interface LoopModelRouter {
  route(
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ): ModelRoute
  routeForRole?(
    useCase: string,
    role: 'main' | 'secondary',
    task?: string | null,
  ): ModelRoute
  payload?(): Record<string, unknown>
  availability?: ModelAvailability
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
  /**
   * 默认关闭：显式开启才会在首次运行（用户档案仍是种子默认 + 模型已配置）时
   * 自动发起一次性偏好访谈 turn。默认关闭是为了不影响现有测试/嵌入场景——
   * 真实桌面端主进程启动（desktop/src/main/core-host.ts）显式开启它。
   */
  enableFirstRunOnboarding?: boolean
}

export interface RunUserTurnOptions {
  sessionId?: string | null
  restoreActiveSessionAfterTurn?: boolean | null
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
  attachmentIds?: string[] | null
  requestedSkills?: Array<{ name: string; source?: string }> | null
}

export interface CompactionHookScope {
  trigger: 'manual' | 'auto' | 'emergency'
  sessionId: string
  cwd: string
  projectRoot: string | null
  snapshot: HookSnapshot
  allowed: boolean
  bypassed: boolean
  reason: string
  instructions: string
}

export class AgentLoop {
  readonly root: string
  readonly paths: RuntimePaths
  readonly templatesDir: string
  readonly registry = new ToolRegistry()
  readonly sessionStore: SessionStore
  readonly sharedMemory: MemoryStore
  readonly tokenTracker: TokenTracker
  readonly hookService: HookService
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
  readonly legacyStateMigration: LegacyStateMigrationResult
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
  private schedulerAgentTurnSubmitter:
    ((payload: SchedulerAgentTurnPayload) => Promise<string>) | null = null
  private controlPendingSessionId: string | null = null
  private readonly todosBySession = new Map<
    string,
    Array<Record<string, unknown>>
  >()
  private readonly teamManagersByProject = new Map<string, TeamManager>()
  private readonly sessionStartHooksRun = new Set<string>()

  private constructor(
    opts: AgentLoopCreateOptions,
    modelRouter: LoopModelRouter,
    sharedMemory: MemoryStore,
    legacyStateMigration: LegacyStateMigrationResult,
  ) {
    this.paths = resolveRuntimePaths(opts.root, {
      stateRoot: opts.stateRoot ?? null,
      templatesDir: opts.templatesDir ?? null,
    })
    this.legacyStateMigration = legacyStateMigration
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
    this.hookService = new HookService({
      stateRoot: this.paths.stateRoot,
      modelRouter: {
        routeForRole: (useCase, role, task) =>
          this.routeHookModel(useCase, role, task),
      },
      tokenTracker: this.tokenTracker,
    })
    this.taskManager = new TaskManager(this.paths.stateRoot, {
      hooks: {
        run: async (eventName, hookOpts) => {
          const session = hookOpts.sessionId
            ? this.sessionStore.get(hookOpts.sessionId)
            : this.activeSession
          return await this.hookService.run(eventName, {
            sessionId: hookOpts.sessionId ?? session?.id ?? '',
            cwd: this.workspaceRootForSession(session),
            projectRoot:
              session?.mode === 'build' ? (session.project_path ?? null) : null,
            taskKind: hookOpts.taskKind,
            task: hookOpts.task,
          })
        },
      },
    })
    this.projectStore = new ProjectStore(this.paths.stateRoot, {
      versions: this.sharedMemory.versions,
    })
    this.controlManager = new ControlManager(this.paths.stateRoot, {
      permissionRules: opts.permissionRules ?? [],
    })
    this.todoStore = new TodoStore()
    this.schedulerStore = new SchedulerStore(this.paths.stateRoot)
    this.schedulerService = new SchedulerService(this.schedulerStore, {
      eventSink: async (event) => {
        await this.emit(event)
      },
      targetSessionId: () => this.activeSessionId,
    })
    this.skillsLoader = new FileSkillsLoader(this.root, this.paths.stateRoot)
    this.contextBuilder = new ContextBuilder(
      this.templatesDir,
      this.skillsLoader,
      {
        memory: this.sharedMemory,
        userFile: opts.userFile ?? this.sharedMemory.userFile,
        promptProfile: opts.promptProfile ?? 'technical',
      },
    )
    this.subagentRegistry = new SubagentRegistry(
      join(this.templatesDir, 'subagents'),
      this.skillsLoader,
    )
    this.contextBuilder.setSubagentRegistry(this.subagentRegistry)
    this.teamManager = this.createTeamManager(null)
    this.mcpClient = new MCPClient(this.paths.stateRoot)

    this.controlManager.setTodoStore(this.todoStore)
    this.controlManager.setTaskManager(this.taskManager)
    this.controlManager.setPendingObserver({
      setPending: (interaction) =>
        this.setActiveSessionControlPending(interaction),
      clearPending: (interaction) =>
        this.clearSessionControlPending(interaction),
    })
    this.registerBuiltinTools()
    this.schedulerService.onJob = async (job) =>
      this.schedulerExecutor().run(job)
  }

  static async create(opts: AgentLoopCreateOptions): Promise<AgentLoop> {
    const paths = resolveRuntimePaths(opts.root, {
      stateRoot: opts.stateRoot ?? null,
      templatesDir: opts.templatesDir ?? null,
    })
    const root = paths.runtimeRoot
    mkdirSync(root, { recursive: true })
    ensureRuntimeStateDirs(paths)
    const legacyStateMigration = migrateLegacyStateRoot(paths)
    migrateLegacyMainlineToDefaultSession(paths.stateRoot)
    const localConfig = await loadLocalConfig(paths.stateRoot, {
      preserveCorrupt: false,
    })
    const templatesDir = paths.templatesDir
    const userFile = ensureUserProfileFile(paths.stateRoot, templatesDir)
    const memoryTemplate = existingPath(join(templatesDir, 'init', 'MEMORY.md'))
    const sharedMemory = new MemoryStore(paths.memoryRoot, userFile, {
      memoryTemplate,
    })
    // 首次运行档案访谈的门禁需要知道模型是否已配置；外部注入 modelRouter（常见于测试/嵌入场景）
    // 本身就是"已配置"的信号，此时不必读盘、也不改变原有的 loadModelConfig 调用时机。
    let modelRouter = opts.modelRouter ?? null
    let hasConfiguredModel = Boolean(modelRouter)
    if (!modelRouter) {
      const modelConfig = await loadModelConfig(paths.stateRoot, {
        create: true,
      })
      hasConfiguredModel = modelConfig.models.length > 0
      modelRouter = new ModelRouter(
        paths.stateRoot,
        modelConfig,
        opts.modelOverride ?? null,
      )
    }
    const loop = new AgentLoop(
      {
        ...opts,
        root,
        stateRoot: paths.stateRoot,
        templatesDir,
        userFile,
        promptProfile: opts.promptProfile ?? localConfig.prompt.profile,
        permissionRules: localConfig.permissions.rules,
      },
      modelRouter,
      sharedMemory,
      legacyStateMigration,
    )
    if (opts.initializeMcp !== false) {
      await loop.mcpClient.initialize()
      loop.mcpClient.registerTools(loop.registry)
    }
    const session = loop.ensureActiveSession()
    loop.activateSession(session.id)
    if (
      opts.enableFirstRunOnboarding &&
      claimProfileOnboardingTrigger({
        stateRoot: paths.stateRoot,
        templatesDir,
        hasConfiguredModel,
      })
    ) {
      // 必须 await 而非 fire-and-forget：runUserTurn 靠 activeTasks 的 'turn' 单飞互斥防止
      // 并发回合互相践踏共享的 history/runner 状态；不 await 会让它与调用方紧接着发起的
      // 真实首条消息产生真实的竞态（TurnBusyError 或历史交错），而不只是测试假象。
      // 模型调用 ask_user 后 TurnPaused 会让这次 await 很快返回（无需真人同步作答），
      // 所以这里的等待只占用启动时的一次模型往返，不会真的卡到用户填完表单。
      try {
        await loop.runUserTurn(onboardingTriggerContent(), {
          source: 'onboarding',
          displayContent: '（初次见面）向你确认一些使用偏好',
        })
      } catch {
        // 首次访谈失败不影响启动；latch 已置位，不会在下次启动重试。
      }
    }
    return loop
  }

  activateSession(sessionId: string): SessionEntry {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    const previousSessionId = this.activeSessionId
    if (previousSessionId && previousSessionId !== session.id) {
      this.todosBySession.set(
        previousSessionId,
        cloneTodoItems(this.todoStore.todos),
      )
    }
    this.activeSession = session
    this.activeSessionId = session.id
    if (previousSessionId !== session.id) {
      this.todoStore.todos = cloneTodoItems(
        this.todosBySession.get(session.id) ?? [],
      )
    }
    this.conversationStore = new ConversationStore(
      this.sessionStore.sessionDir(session.id),
    )
    this.activeMemoryStore = this.memoryStoreForSession(
      session,
      this.conversationStore,
    )
    this.runtimeStore = new RuntimeEventStore(
      this.conversationStore.sessionDir,
      { sessionDirOverride: true },
    )
    this.history =
      this.conversationStore.readCheckpoint() ??
      this.activeMemoryStore.loadUnarchivedHistory()
    this.contextBuilder.setSessionScope(this.sessionScope(session))
    this.controlManager.setRuntimeScope(
      this.controlRuntimeScopeForSession(session),
    )
    this.skillsLoader.setProjectSkillsDir(
      session.mode === 'build' && session.project_path
        ? join(resolve(session.project_path), '.emperor', 'skills')
        : null,
    )
    this.runner = this.buildMainRunner()
    return session
  }

  reconcileSessionControlPending(): void {
    const pending = this.controlManager.store.load().pending
    const summary = pending ? this.sessionControlPending(pending) : null
    this.sessionStore.reconcileControlPending(summary, this.activeSessionId)
    if (summary) {
      this.controlPendingSessionId = this.findControlPendingSessionId(
        summary.interaction_id,
      )
    } else {
      this.controlPendingSessionId = null
    }
  }

  controlPendingOwnerSessionId(interactionId: string): string | null {
    return this.findControlPendingSessionId(interactionId)
  }

  async runUserTurn(
    content: string,
    opts: RunUserTurnOptions = {},
  ): Promise<string> {
    if (
      opts.useActiveTask !== false &&
      this.activeTasks.hasActiveKind('turn')
    ) {
      throw new TurnBusyError()
    }
    const targetSessionId = String(opts.sessionId ?? '').trim()
    const previousSessionId = this.activeSessionId
    if (targetSessionId && this.activeSessionId !== targetSessionId)
      this.activateSession(targetSessionId)
    assertModelAvailable(this.modelRouter.availability)
    const turnId = opts.turnId || randomUUID().replace(/-/g, '').slice(0, 16)
    const taskId = opts.taskId || `turn:${turnId}`
    const abortController = new AbortController()
    const awaitable = this.runUserTurnInner(
      content,
      turnId,
      opts,
      abortController.signal,
    ).finally(() => {
      this.hookService.endTurn(turnId)
      if (!opts.restoreActiveSessionAfterTurn) return
      if (!previousSessionId || previousSessionId === this.activeSessionId)
        return
      if (targetSessionId && this.activeSessionId !== targetSessionId) return
      try {
        this.activateSession(previousSessionId)
      } catch {
        // The previous session may have been deleted while a background turn was running.
      }
    })
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

  setSchedulerAgentTurnSubmitter(
    submitter: ((payload: SchedulerAgentTurnPayload) => Promise<string>) | null,
  ): void {
    this.schedulerAgentTurnSubmitter = submitter
  }

  async close(): Promise<void> {
    this.schedulerService.stop()
    const session =
      this.activeSession ??
      (this.activeSessionId
        ? this.sessionStore.get(this.activeSessionId)
        : null)
    if (session) {
      await this.hookService
        .run('SessionEnd', {
          sessionId: session.id,
          cwd: this.workspaceRootForSession(session),
          projectRoot:
            session.mode === 'build' ? (session.project_path ?? null) : null,
          reason: 'shutdown',
        })
        .catch(() => {})
    }
    await this.hookService.shutdown()
    await this.mcpClient.close()
  }

  async endSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessionStore.get(sessionId)
    if (!session) return
    await this.hookService
      .run('SessionEnd', {
        sessionId,
        cwd: this.workspaceRootForSession(session),
        projectRoot:
          session.mode === 'build' ? (session.project_path ?? null) : null,
        reason,
      })
      .catch(() => {})
    this.sessionStartHooksRun.delete(sessionId)
    this.hookService.clearSession(sessionId)
  }

  refreshRuntimeContext(): void {
    if (!this.runner) return
    if (this.activeSession)
      this.contextBuilder.setSessionScope(this.sessionScope(this.activeSession))
    const projection = this.contextBuilder.buildProjection()
    this.runner.systemPrompt = projection.prompt
    this.runner.promptSections = projection.sections
    this.runner.promptContextPlan = projection.contextPlan
    this.runner.promptSnapshotDir = this.activeSessionId
      ? join(
          this.sessionStore.sessionDir(this.activeSessionId),
          'prompt-snapshots',
        )
      : null
    this.runner.sessionId = this.activeSessionId
    if (this.activeSession)
      this.controlManager.setRuntimeScope(
        this.controlRuntimeScopeForSession(this.activeSession),
      )
  }

  workspacePolicyDiagnostics(): Record<string, unknown> {
    return new WorkspacePolicy({
      workspaceRoot: this.workspaceRootForActiveSession(),
      stateRoot: this.paths.stateRoot,
    }).describe()
  }

  async refreshModelConfig(): Promise<void> {
    if (!this.ownsModelRouter) return
    this.modelRouter = new ModelRouter(
      this.paths.stateRoot,
      await loadModelConfig(this.paths.stateRoot, { create: true }),
      this.modelOverride,
    )
    if (this.activeSessionId) this.runner = this.buildMainRunner()
  }

  async reloadMcp(): Promise<void> {
    await this.mcpClient.close()
    this.registry.unregisterWhere((name) => name.startsWith('mcp_'))
    await this.mcpClient.initialize()
    this.mcpClient.registerTools(this.registry)
  }

  async beginCompactionHooks(
    trigger: CompactionHookScope['trigger'],
    opts: { session?: SessionEntry | null; emit?: StreamEmitter | null } = {},
  ): Promise<CompactionHookScope> {
    const session =
      opts.session ??
      this.activeSession ??
      (this.activeSessionId
        ? this.sessionStore.get(this.activeSessionId)
        : null)
    if (!session)
      throw new Error('active session is required for compaction hooks')
    const cwd = this.workspaceRootForSession(session)
    const projectRoot =
      session.mode === 'build' ? (session.project_path ?? null) : null
    const snapshot =
      this.hookService.activeSnapshot(session.id) ??
      (await this.hookService.snapshot({ sessionId: session.id, projectRoot }))
    const decision = await this.hookService.run(
      'PreCompact',
      {
        sessionId: session.id,
        cwd,
        projectRoot,
        trigger,
      },
      {
        snapshot,
        emit: async (event) => {
          await this.emit(event, { emit: opts.emit ?? null })
        },
      },
    )
    const denied = decision.decision === 'deny' || decision.decision === 'ask'
    const bypassed = trigger === 'emergency' && denied
    if (bypassed) {
      await this.emit(
        {
          event: 'hook_emergency_compaction_bypass',
          event_name: 'PreCompact',
          decision: decision.decision,
          reason: decision.reason,
          snapshot_revision: snapshot.revision,
        },
        { emit: opts.emit ?? null },
      )
    }
    return {
      trigger,
      sessionId: session.id,
      cwd,
      projectRoot,
      snapshot,
      allowed: !denied || trigger === 'emergency',
      bypassed,
      reason: decision.reason,
      instructions: decision.compactInstructions ?? '',
    }
  }

  async finishCompactionHooks(
    scope: CompactionHookScope,
    result: Record<string, unknown>,
    opts: { emit?: StreamEmitter | null } = {},
  ): Promise<void> {
    await this.hookService.run(
      'PostCompact',
      {
        sessionId: scope.sessionId,
        cwd: scope.cwd,
        projectRoot: scope.projectRoot,
        trigger: scope.trigger,
        result,
      },
      {
        snapshot: scope.snapshot,
        emit: async (event) => {
          await this.emit(event, { emit: opts.emit ?? null })
        },
      },
    )
  }

  private async runUserTurnInner(
    content: string,
    turnId: string,
    opts: RunUserTurnOptions,
    signal: AbortSignal | null,
  ): Promise<string> {
    if (!this.activeSessionId)
      this.activateSession(this.ensureActiveSession().id)
    const session =
      this.activeSession ?? this.sessionStore.get(this.activeSessionId!)
    const sessionId = session?.id ?? this.activeSessionId!
    const history = this.history
    const memoryStore = this.activeMemoryStore
    const runner = this.runner
    const runtimeStore = this.runtimeStore
    if (!session || !runner || !runtimeStore)
      throw new Error('active session is not initialized')
    this.controlManager.setRuntimeScope(
      this.controlRuntimeScopeForSession(session),
    )
    const scope = this.turnScope(session, turnId)
    await this.hookService.beginTurn({
      turnId,
      sessionId,
      projectRoot:
        session.mode === 'build' ? (session.project_path ?? null) : null,
    })
    if (!this.sessionStartHooksRun.has(sessionId)) {
      this.sessionStartHooksRun.add(sessionId)
      const startDecision = await this.runLoopHook(
        'SessionStart',
        {
          sessionId,
          cwd: scope.workspaceRoot,
          source: session.mode,
        },
        { turnId, emit: opts.emit ?? null, runtimeStore, scope },
      )
      this.appendLifecycleHookContext(
        history,
        memoryStore,
        startDecision.additionalContext,
        'SessionStart',
        turnId,
      )
    }
    const promptDecision = await this.runLoopHook(
      'UserPromptSubmit',
      {
        sessionId,
        cwd: scope.workspaceRoot,
        source: opts.source ?? null,
        prompt: content,
      },
      { turnId, emit: opts.emit ?? null, runtimeStore, scope },
    )
    if (promptDecision.decision === 'deny')
      throw new Error(
        `UserPromptSubmit hook denied prompt: ${promptDecision.reason}`,
      )
    const updatedPrompt =
      promptDecision.updatedInput &&
      typeof promptDecision.updatedInput.content === 'string'
        ? promptDecision.updatedInput.content
        : content
    const attachmentIds = [...new Set(opts.attachmentIds ?? [])]
      .map((id) => String(id).trim())
      .filter(Boolean)
    const attachmentStore = new AttachmentStore(this.paths.stateRoot)
    const attachmentPayloads = attachmentIds
      .map((id) => attachmentStore.get(id))
      .filter((ref) => ref !== null)
      .map((ref) => refToJson(ref))
    const modelContent = buildUserContent(
      updatedPrompt,
      attachmentIds,
      attachmentStore,
      {
        supportsVision:
          this.modelRouter.route('main_agent').snapshot.supportsVision,
      },
    )
    const persistedContent = buildUserContent(
      updatedPrompt,
      attachmentIds,
      attachmentStore,
      { supportsVision: false },
    )
    const requestedSkillContext = this.requestedSkillContext(
      opts.requestedSkills ?? [],
    )
    this.appendLifecycleHookContext(
      history,
      memoryStore,
      promptDecision.additionalContext,
      'UserPromptSubmit',
      turnId,
    )
    if (requestedSkillContext) {
      const content = `[Requested Skill Context]\n${requestedSkillContext.content}`
      history.push({
        role: 'system',
        content,
        turn_id: turnId,
        ui_hidden: true,
      })
      memoryStore.appendHistory('system', content, {
        extra: {
          turn_id: turnId,
          ui_hidden: true,
          requestedSkills: requestedSkillContext.names.map((name) => ({
            name,
            source: 'explicit',
          })),
        },
      })
    }
    const displayContent = opts.displayContent ?? content
    const userMessage: Msg = { role: 'user', content: modelContent }
    if (turnId) userMessage.turn_id = turnId
    if (attachmentPayloads.length) userMessage.attachments = attachmentPayloads
    if (displayContent !== updatedPrompt || attachmentPayloads.length)
      userMessage.displayContent = displayContent
    history.push(userMessage)
    memoryStore.appendHistory('user', persistedContent, {
      extra: {
        ...(opts.memoryExtra ?? {}),
        turn_id: turnId,
        ...(attachmentPayloads.length
          ? { attachments: attachmentPayloads }
          : {}),
        ...(opts.requestedSkills?.length
          ? { requestedSkills: opts.requestedSkills }
          : {}),
        ...(displayContent !== updatedPrompt || attachmentPayloads.length
          ? { displayContent }
          : {}),
        ...(opts.source ? { source: opts.source } : {}),
      },
    })
    this.sessionStore.touch(sessionId, displayContent, {
      incrementMessages: true,
    })
    await this.emit(this.turnScopeEvent(scope), {
      turnId,
      emit: opts.emit ?? null,
      runtimeStore,
      scope,
    })
    await this.emit(
      runtimeEvents.userMessage({
        content: displayContent,
        attachments: attachmentPayloads,
        requestedSkills: opts.requestedSkills ?? [],
        clientMessageId: opts.clientMessageId ?? turnId,
        source: opts.source ?? null,
        scheduler: opts.scheduler ?? null,
        uiHidden: opts.uiHidden ?? false,
      }),
      { turnId, emit: opts.emit ?? null, runtimeStore, scope },
    )

    let reply: string
    try {
      reply = await runner.stepStream(
        history,
        async (event) => {
          await this.emit(event, {
            turnId,
            emit: opts.emit ?? null,
            runtimeStore,
            scope,
          })
        },
        { turnId, signal },
      )
    } catch (error) {
      if (!isBenignTurnInterruption(error)) {
        await this.runLoopHook(
          'StopFailure',
          {
            sessionId,
            cwd: scope.workspaceRoot,
            errorKind: hookErrorKind(error),
            error: error instanceof Error ? error.message : String(error),
          },
          { turnId, emit: opts.emit ?? null, runtimeStore, scope },
        ).catch(() => {})
        const safe = safeRuntimeError(error)
        await this.emit(
          runtimeEvents.error(safe.message, {
            code: safe.code,
            action: safe.action,
          }),
          { turnId, emit: opts.emit ?? null, runtimeStore, scope },
        )
      }
      throw error
    }
    this.sessionStore.touch(sessionId, reply, { incrementMessages: true })
    return reply
  }

  private buildMainRunner(): AgentRunner {
    const route = this.modelRouter.route('main_agent')
    const session =
      this.activeSession ??
      (this.activeSessionId
        ? this.sessionStore.get(this.activeSessionId)
        : null)
    if (session) this.contextBuilder.setSessionScope(this.sessionScope(session))
    const projection = this.contextBuilder.buildProjection()
    const memoryStore = this.activeMemoryStore
    return buildRoutedRunner({
      route,
      registry: this.registry,
      systemPrompt: projection.prompt,
      tokenTracker: this.tokenTracker,
      usageType: 'main_agent',
      memoryStore,
      compactor: session
        ? this.autoMemoryCompactor(session, memoryStore)
        : null,
      todoStore: this.todoStore,
      controlManager: this.controlManager,
      maxContext: route.snapshot.contextWindowTokens,
      maxTurns: 20,
      workspaceRoot: this.workspaceRootForActiveSession(),
      promptSections: projection.sections,
      promptContextPlan: projection.contextPlan,
      promptSnapshotDir: this.activeSessionId
        ? join(
            this.sessionStore.sessionDir(this.activeSessionId),
            'prompt-snapshots',
          )
        : null,
      sessionId: this.activeSessionId,
      // Wave5 灰度开关：默认关闭，行为与批式逐字节一致
      streamingToolExecution: process.env.EMPEROR_STREAMING_TOOLS === '1',
      hooks: session
        ? {
            run: async (eventName, hookOpts, emit) => {
              return this.hookService.run(
                eventName,
                {
                  ...hookOpts,
                  sessionId: hookOpts.sessionId || session.id,
                  cwd: hookOpts.cwd || this.workspaceRootForSession(session),
                  projectRoot:
                    session.mode === 'build'
                      ? (session.project_path ?? null)
                      : null,
                  stateRoot: this.paths.stateRoot,
                },
                {
                  emit: emit
                    ? async (event) => {
                        await emit(event)
                      }
                    : null,
                },
              )
            },
            mayMatch: (eventName, hookOpts) =>
              this.hookService.mayMatch(eventName, {
                ...hookOpts,
                sessionId: hookOpts.sessionId || session.id,
                cwd: hookOpts.cwd || this.workspaceRootForSession(session),
                projectRoot:
                  session.mode === 'build'
                    ? (session.project_path ?? null)
                    : null,
                stateRoot: this.paths.stateRoot,
              }),
          }
        : null,
    })
  }

  private autoMemoryCompactor(
    session: SessionEntry,
    memoryStore: SessionMemoryStore,
  ): CompactorLike {
    return {
      compactAfterTurn: async ({ currentTokens, maxContext }) => {
        const route = this.modelRouter.route('memory_compaction')
        const snapshot = route.snapshot
        const mode = session.mode === 'build' ? 'build' : 'chat'
        const projectId =
          mode === 'build' ? String(session.project_id || '') : null
        const hookScope = await this.beginCompactionHooks('auto', { session })
        if (!hookScope.allowed) {
          return {
            status: 'skipped',
            message: `Compaction deferred by hook: ${hookScope.reason}`,
            count: 0,
          }
        }
        let result: Awaited<ReturnType<typeof compactSession>>
        try {
          result = await compactSession({
            sessionId: session.id,
            mode,
            projectId,
            historyFile: memoryStore.historyFile,
            trigger: {
              kind: 'token_threshold',
              currentTokens: Number(currentTokens) || 0,
              maxContext: Number(maxContext) || 0,
            },
            memory: {
              root: this.paths.stateRoot,
              memoryDir: this.sharedMemory.memoryDir,
              userFile: this.sharedMemory.userFile,
              versions: this.sharedMemory.versions,
              readUser: () => this.sharedMemory.readUser(),
              readGlobalMemory: () => this.sharedMemory.readMemory(),
              readEpisode: () => this.sharedMemory.readTodayEpisode(),
              readProjectMemory: (id: string) =>
                this.projectStore.readManagedMemory(id),
            },
            model: {
              provider: snapshot.provider,
              model: snapshot.model,
              providerName: snapshot.providerName,
              modelRole: snapshot.modelRole,
              maxTokens: snapshot.generation.maxTokens,
              temperature: snapshot.generation.temperature,
              reasoningEffort: snapshot.generation.reasoningEffort,
              routeReason: snapshot.routeReason,
            },
            tokenTracker: this.tokenTracker,
            instructions: hookScope.instructions,
          })
        } catch (error) {
          await this.finishCompactionHooks(hookScope, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
        if (result.status === 'compacted' && result.compaction) {
          const cursorStore = new CompactionCursorStore(this.paths.stateRoot)
          const retainedHistory = activeSessionHistoryAfterSeq(
            memoryStore,
            result.compaction.range.toSeq,
          )
          memoryStore.appendCompactMarker(
            retainedHistory,
            cursorStore.archiveGate(session.id),
          )
          result.compaction.cursor = cursorStore.readOrInit(session.id)
          this.refreshRuntimeContext()
          await this.finishCompactionHooks(hookScope, {
            status: result.status,
            compaction: result.compaction,
          })
          return { ...result, retainedHistory }
        }
        await this.finishCompactionHooks(hookScope, {
          status: result.status,
          message: result.message,
          error: result.error ?? null,
        })
        return result
      },
    }
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
    this.registry.register(new SaveUserProfileTool(this.sharedMemory))
    const controlHost = dispatchControlHost(this.controlManager)
    this.registry.register(
      new DispatchSubagentTool({
        parentRegistry: this.registry,
        subagentRegistry: this.subagentRegistry,
        runnerFactory: buildDispatchRunnerFactory({
          modelRouter: this.modelRouter,
          tokenTracker: this.tokenTracker,
          memoryStore: null,
          compactor: null,
          todoStore: null,
          controlManager: permissionOnlyControlHost(this.controlManager),
          hooks: (args) =>
            args.agentId
              ? this.scopedAgentRunnerHooks(args.agentId, 'SubagentStop')
              : null,
        }),
        taskManager: this.taskManager,
        controlManager: controlHost,
        hooks: {
          begin: async ({ agentId, agentType, sessionId, cwd }) => {
            const session =
              this.sessionStore.get(sessionId) ?? this.activeSession
            await this.hookService.beginAgentScope({
              agentId,
              agentType,
              sessionId: sessionId || session?.id || '',
              cwd,
              projectRoot:
                session?.mode === 'build'
                  ? (session.project_path ?? null)
                  : null,
            })
            return await this.hookService.runAgent('SubagentStart', agentId, {})
          },
          end: (agentId) => {
            this.hookService.endAgentScope(agentId)
          },
        },
      }),
    )
    const activeTeamManager = () => this.teamManagerForActiveSession()
    this.registry.register(new TeamSpawnTool(activeTeamManager))
    this.registry.register(new TeamListTool(activeTeamManager))
    this.registry.register(new TeamSendMessageTool(activeTeamManager))
    this.registry.register(new TeamReadInboxTool(activeTeamManager))
    this.registry.register(new TeamBroadcastTool(activeTeamManager))
    this.registry.register(new TeamShutdownTool(activeTeamManager))
  }

  teamManagerForActiveSession(): TeamManager | null {
    return this.teamManagerForSession(
      this.activeSession ??
        (this.activeSessionId
          ? this.sessionStore.get(this.activeSessionId)
          : null),
    )
  }

  teamManagerForSession(
    session: SessionEntry | null | undefined,
  ): TeamManager | null {
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
    const current = this.activeSessionId
      ? this.sessionStore.get(this.activeSessionId)
      : null
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
    const sessionId =
      this.controlPendingSessionId ||
      this.findControlPendingSessionId(interaction.id)
    if (!sessionId) return
    this.sessionStore.clearControlPending(sessionId)
    if (this.controlPendingSessionId === sessionId)
      this.controlPendingSessionId = null
  }

  private findControlPendingSessionId(interactionId: string): string | null {
    return (
      this.sessionStore
        .list({ includeArchived: true })
        .find(
          (session) =>
            session.control_pending?.interaction_id === interactionId,
        )?.id ?? null
    )
  }

  private sessionControlPending(
    interaction: Interaction,
  ): SessionControlPending | null {
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

  private memoryStoreForSession(
    session: SessionEntry,
    conversation: ConversationStore,
  ): SessionMemoryStore {
    if (session.mode === 'build' && session.project_id) {
      return new ProjectSessionMemoryStore(
        this.sharedMemory,
        conversation,
        this.projectStore,
        session.project_id,
      )
    }
    return new SessionMemoryStore(this.sharedMemory, conversation)
  }

  private sessionScope(session: SessionEntry): {
    mode: string
    projectId?: string
    projectAgents?: string
    projectAgentsSource?: string
    projectPath?: string
    projectIndexSummary?: string
    compactionOmittedRanges?: Array<{
      fromSeq: number
      toSeq: number
      compactionId?: string | null
      targetScopes?: string[]
    }>
  } {
    if (session.mode !== 'build') {
      return {
        mode: 'chat',
        projectIndexSummary: this.projectStore.summaryForChat(),
        compactionOmittedRanges: this.compactionOmittedRangesForSession(
          session.id,
        ),
      }
    }
    const projectId = session.project_id ?? ''
    const project = projectId ? this.projectStore.get(projectId) : null
    return {
      mode: 'build',
      projectId,
      projectPath: session.project_path ?? '',
      projectAgents: projectId ? this.projectStore.readAgents(projectId) : '',
      projectAgentsSource: project?.agents_path ?? '',
      projectIndexSummary: this.projectStore.summaryForChat(),
      compactionOmittedRanges: this.compactionOmittedRangesForSession(
        session.id,
      ),
    }
  }

  private compactionOmittedRangesForSession(sessionId: string): Array<{
    fromSeq: number
    toSeq: number
    compactionId?: string | null
    targetScopes?: string[]
  }> {
    const cursor = new CompactionCursorStore(this.paths.stateRoot).readOrInit(
      sessionId,
    )
    if (cursor.compactedUntilSeq <= 0) return []
    const ledger = new CompactionLedger(this.paths.stateRoot)
    const latest = latestAppliedCompactionRun(
      ledger.readIndex(),
      sessionId,
      cursor.lastCompactionId ?? null,
      cursor.compactedUntilSeq,
    )
    const range =
      latest?.range && Number(latest.range.toSeq) > 0
        ? {
            fromSeq: Math.max(1, Math.trunc(Number(latest.range.fromSeq) || 1)),
            toSeq: Math.trunc(
              Number(latest.range.toSeq) || cursor.compactedUntilSeq,
            ),
          }
        : { fromSeq: 1, toSeq: cursor.compactedUntilSeq }
    const targetScopes = Array.isArray(latest?.output?.targetVersions)
      ? latest.output.targetVersions
          .map((item) => scopeLabel((item as { scope?: unknown }).scope))
          .filter((scope): scope is string => Boolean(scope))
      : []
    return [
      {
        ...range,
        compactionId: latest?.compactionId ?? null,
        targetScopes,
      },
    ]
  }

  private workspaceRootForActiveSession(): string {
    const session =
      this.activeSession ??
      (this.activeSessionId
        ? this.sessionStore.get(this.activeSessionId)
        : null)
    return this.workspaceRootForSession(session)
  }

  private routeHookModel(
    useCase: string,
    role: 'main' | 'secondary',
    task?: string | null,
  ): ModelRoute {
    if (typeof this.modelRouter.routeForRole === 'function') {
      return this.modelRouter.routeForRole(useCase, role, task)
    }
    if (role === 'secondary') return this.modelRouter.route(useCase, null, task)
    const route = this.modelRouter.route('main_agent', null, task)
    const reason = `${useCase}:explicit_main`
    return {
      ...route,
      useCase,
      reason,
      fallback: null,
      snapshot: { ...route.snapshot, routeReason: reason },
    }
  }

  private appendLifecycleHookContext(
    history: Msg[],
    memoryStore: SessionMemoryStore,
    context: string,
    eventName: HookEventName,
    turnId: string,
  ): void {
    const text = context.trim()
    if (!text) return
    const content = `[${eventName} hook context]\n${text}`
    history.push({ role: 'system', content, turn_id: turnId, ui_hidden: true })
    memoryStore.appendHistory('system', content, {
      extra: { turn_id: turnId, ui_hidden: true, hook_event_name: eventName },
    })
  }

  private requestedSkillContext(
    requestedSkills: Array<{ name: string; source?: string }>,
  ): { names: string[]; content: string } | null {
    const names = [
      ...new Set(
        requestedSkills.map((skill) => {
          const raw = String(skill.name ?? '').trim()
          const safe = safeSkillName(raw)
          if (!safe || safe !== raw)
            throw new RequestedSkillUnavailableError(raw || '(empty)')
          return safe
        }),
      ),
    ]
    if (!names.length) return null
    for (const name of names) {
      if (!this.skillsLoader.getContent(name))
        throw new RequestedSkillUnavailableError(name)
    }
    const content = this.skillsLoader.loadSkillsForContext(names).trim()
    if (!content) throw new RequestedSkillUnavailableError(names.join(', '))
    return { names, content }
  }

  private workspaceRootForSession(
    session: SessionEntry | null | undefined,
  ): string {
    if (session?.mode === 'build' && session.project_path)
      return resolve(session.project_path)
    return this.root
  }

  private workspaceRootForProject(projectId: string): string {
    const project = this.projectStore.get(projectId)
    const path = project?.workspace_path || project?.project_path || ''
    return path ? resolve(path) : this.root
  }

  private controlRuntimeScopeForSession(session: SessionEntry): {
    sessionId: string
    projectId: string | null
    workspaceRoot: string
  } {
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
      activeMemoryBinding: this.activeMemoryBindingForSession(session),
      workspaceRoot: this.workspaceRootForSession(session),
      stateRoot: this.paths.stateRoot,
      sessionRoot: this.sessionStore.sessionDir(session.id),
      projectStateRoot: projectId
        ? join(this.paths.projectsRoot, projectId)
        : null,
    }
  }

  private turnScopeEvent(scope: TurnScope): Record<string, unknown> {
    return {
      event: 'turn_scope',
      session_id: scope.sessionId,
      turn_id: scope.turnId,
      mode: scope.mode,
      project_id: scope.projectId,
      active_memory_binding: scope.activeMemoryBinding,
      workspace_root: scope.workspaceRoot,
      state_root: scope.stateRoot,
      session_root: scope.sessionRoot,
      project_state_root: scope.projectStateRoot,
    }
  }

  private async runLoopHook(
    eventName: HookEventName,
    opts: HookRuntimeRunOptions,
    ctx: {
      turnId?: string | null
      emit?: StreamEmitter | null
      runtimeStore?: RuntimeEventStore | null
      scope?: TurnScope | null
    },
  ): Promise<HookAggregateDecision> {
    const session =
      this.activeSession ??
      (this.activeSessionId
        ? this.sessionStore.get(this.activeSessionId)
        : null)
    return this.hookService.run(
      eventName,
      {
        ...opts,
        sessionId: opts.sessionId || session?.id || '',
        cwd: opts.cwd || this.workspaceRootForSession(session),
        projectRoot:
          session?.mode === 'build' ? (session.project_path ?? null) : null,
        stateRoot: this.paths.stateRoot,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      },
      {
        emit: async (event) => {
          await this.emit(event, ctx)
        },
      },
    )
  }

  private async runBackgroundHook(
    eventName: HookEventName,
    opts: HookRuntimeRunOptions,
  ): Promise<HookAggregateDecision> {
    return this.hookService.run(
      eventName,
      {
        ...opts,
        stateRoot: this.paths.stateRoot,
      },
      {
        emit: async (event) => {
          await this.emit(event)
        },
      },
    )
  }

  private activeMemoryBindingForSession(
    session: SessionEntry,
  ): ActiveMemoryBinding {
    const projectId = String(session.project_id ?? '').trim()
    const date = todayUtc8()
    return {
      profile: {
        scope: { kind: 'user_profile' },
        readable: true,
        writable: true,
        path: this.sharedMemory.userFile,
      },
      longTerm:
        session.mode === 'build'
          ? {
              scope: { kind: 'project', projectId: projectId || '(unknown)' },
              readable: Boolean(projectId),
              writable: Boolean(projectId),
              path: projectId
                ? join(this.paths.projectsRoot, projectId, 'AGENTS.local.md')
                : null,
            }
          : {
              scope: { kind: 'global' },
              readable: true,
              writable: true,
              path: this.sharedMemory.memoryFile,
            },
      episode: {
        scope: { kind: 'episode', date },
        readable: false,
        writable: true,
        path: join(this.sharedMemory.memoryDir, `${date}.md`),
      },
    }
  }

  private schedulerExecutor(): SchedulerJobExecutor {
    return new SchedulerJobExecutor({
      activeTasks: this.activeTasks,
      taskManager: this.taskManager,
      controlPending: () => Boolean(this.controlManager.payload().pending),
      teamManagerForProject: (projectId) =>
        this.teamManagerForProject(projectId),
      submitAgentTurn: async (payload: SchedulerAgentTurnPayload) => {
        if (this.schedulerAgentTurnSubmitter)
          return this.schedulerAgentTurnSubmitter(payload)
        return this.runUserTurn(payload.content, {
          turnId: payload.clientMessageId,
          displayContent: payload.displayContent,
          clientMessageId: payload.clientMessageId,
          source: payload.source,
          scheduler: payload.scheduler,
          taskId: payload.taskId ?? undefined,
          sessionId: payload.sessionId ?? null,
          restoreActiveSessionAfterTurn: Boolean(payload.sessionId),
          emit: payload.deliver ? this.eventSink : null,
        })
      },
    })
  }

  private createTeamManager(projectId: string | null): TeamManager {
    const cleanProjectId = String(projectId || '').trim() || null
    const projectStateRoot = cleanProjectId
      ? join(this.paths.projectsRoot, cleanProjectId)
      : this.paths.stateRoot
    const teamDir = cleanProjectId
      ? join(projectStateRoot, 'team')
      : this.paths.teamRoot
    return new TeamManager({
      root: projectStateRoot,
      teamDir,
      projectId: cleanProjectId,
      parentRegistry: this.registry,
      subagentRegistry: this.teamSubagentRegistry(),
      eventSink: async (event) => {
        await this.emit(event)
      },
      hooks: {
        begin: async ({ agentId, agentType }) => {
          const session = this.activeSession
          await this.hookService.beginAgentScope({
            agentId,
            agentType,
            sessionId: session?.id ?? '',
            cwd: cleanProjectId
              ? this.workspaceRootForProject(cleanProjectId)
              : this.workspaceRootForActiveSession(),
            projectRoot:
              session?.mode === 'build' ? (session.project_path ?? null) : null,
          })
          return await this.hookService.runAgent('SubagentStart', agentId, {})
        },
        end: (agentId) => {
          this.hookService.endAgentScope(agentId)
        },
      },
      runnerFactory: ({ member, spec, subRegistry, agentId }) => {
        const route = this.modelRouter.route(
          'team',
          member.agent_type,
          spec.name ?? '',
        )
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
          workspaceRoot: cleanProjectId
            ? this.workspaceRootForProject(cleanProjectId)
            : this.workspaceRootForActiveSession(),
          sessionId: this.activeSessionId,
          hooks: this.scopedAgentRunnerHooks(
            agentId,
            'TeammateIdle',
            member.name,
          ),
        })
        return {
          step: (history) => runner.stepAsync(history),
          stepStream: (history, emit) => runner.stepStream(history, emit),
        }
      },
    })
  }

  private teamPrompt(spec: { systemPrompt?: string }): string {
    return String(
      spec.systemPrompt || '你是 Agent Team 队友。请处理收到的任务并简洁回禀。',
    )
  }

  private scopedAgentRunnerHooks(
    agentId: string,
    stopEvent: 'SubagentStop' | 'TeammateIdle',
    teammateName?: string,
  ): AgentRunnerHookHost {
    return {
      run: async (eventName, opts, emit) => {
        const mapped = eventName === 'Stop' ? stopEvent : eventName
        return await this.hookService.runAgent(
          mapped,
          agentId,
          {
            ...opts,
            ...(mapped === 'TeammateIdle'
              ? { teammateName: teammateName ?? '' }
              : {}),
          },
          { emit: emit ?? null },
        )
      },
      mayMatch: (eventName, opts) => {
        const mapped = eventName === 'Stop' ? stopEvent : eventName
        return this.hookService.mayMatchAgent(mapped, agentId, {
          ...opts,
          ...(mapped === 'TeammateIdle'
            ? { teammateName: teammateName ?? '' }
            : {}),
        })
      },
    }
  }

  private teamSubagentRegistry(): TeamSubagentRegistry {
    return {
      get: (name: string) => this.subagentRegistry.get(name),
      resolveName: (name: string) => this.subagentRegistry.resolveName(name),
      names: (includeAliases?: boolean) =>
        this.subagentRegistry.names({ includeAliases }),
    }
  }

  private async emit(
    event: Record<string, unknown>,
    opts: {
      turnId?: string | null
      emit?: StreamEmitter | null
      runtimeStore?: RuntimeEventStore | null
      scope?: TurnScope | null
    } = {},
  ): Promise<void> {
    const scoped = opts.scope ? withTurnScope(event, opts.scope) : event
    const store = opts.runtimeStore ?? this.runtimeStoreForEvent(scoped)
    const payload = store
      ? store.append(scoped, { turnId: opts.turnId ?? null })
      : scoped
    const sink = opts.emit ?? this.eventSink
    if (sink) await sink(payload)
  }

  private runtimeStoreForEvent(
    event: Record<string, unknown>,
  ): RuntimeEventStore | null {
    const ownerSessionId = eventOwnerSessionId(event)
    if (
      ownerSessionId &&
      ownerSessionId !== this.activeSessionId &&
      this.sessionStore.get(ownerSessionId)
    ) {
      return new RuntimeEventStore(
        this.sessionStore.sessionDir(ownerSessionId),
        { sessionDirOverride: true },
      )
    }
    return this.runtimeStore
  }
}

function withTurnScope(
  event: Record<string, unknown>,
  scope: TurnScope,
): Record<string, unknown> {
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
    return String(
      (owner as Record<string, unknown>).session_id ??
        (owner as Record<string, unknown>).sessionId ??
        '',
    ).trim()
  }
  return ''
}

/**
 * Merges three skill sources with fixed precedence for content resolution:
 * project (`<project>/.emperor/skills`, read-only) > user-global (`stateRoot/skills`,
 * read-write via Skill API) > builtin (`runtimeRoot/skills`, read-only). `skillNames()`
 * unions all three so the summary lists everything available, even lower-precedence
 * names that aren't shadowed by a higher layer.
 */
class FileSkillsLoader implements SkillsLoaderLike, ToolSkillsLoader {
  readonly builtinDir: string
  readonly userDir: string
  private projectDir: string | null = null

  constructor(runtimeRoot: string, stateRoot: string) {
    this.builtinDir = join(runtimeRoot, 'skills')
    this.userDir = join(stateRoot, 'skills')
  }

  setProjectSkillsDir(dir: string | null): void {
    this.projectDir = dir
  }

  getAlwaysSkills(): string[] {
    return []
  }

  loadSkillsForContext(names: string[]): string {
    return names
      .map((name) => this.getContent(name))
      .filter((item): item is string => Boolean(item))
      .join('\n\n---\n\n')
  }

  buildSkillsSummary(): string {
    return this.summary()
  }

  summary(): string {
    return this.skillNames()
      .map((name) => {
        const content = this.getContent(name) ?? ''
        const first =
          content
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith('#')) ?? ''
        return `- ${name}: ${first.slice(0, 180)}`
      })
      .join('\n')
  }

  getContent(name: string): string | null {
    const safe = safeSkillName(name)
    if (!safe) return null
    for (const dir of this.dirsInPrecedenceOrder()) {
      for (const path of [
        join(dir, safe, 'SKILL.md'),
        join(dir, `${safe}.md`),
      ]) {
        if (existsSync(path) && statSync(path).isFile())
          return readFileSync(path, 'utf8')
      }
    }
    return null
  }

  private dirsInPrecedenceOrder(): string[] {
    return [this.projectDir, this.userDir, this.builtinDir].filter(
      (dir): dir is string => Boolean(dir),
    )
  }

  private skillNames(): string[] {
    const names = new Set<string>()
    for (const dir of this.dirsInPrecedenceOrder()) {
      if (!existsSync(dir)) continue
      for (const item of readdirSync(dir)) {
        if (item.startsWith('.')) continue
        const path = join(dir, item)
        if (statSync(path).isDirectory() && existsSync(join(path, 'SKILL.md')))
          names.add(item)
        else if (statSync(path).isFile() && item.endsWith('.md'))
          names.add(basename(item, '.md'))
      }
    }
    return [...names].sort()
  }
}

function existingPath(path: string): string | null {
  return existsSync(path) ? path : null
}

function isBenignTurnInterruption(error: unknown): boolean {
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name || '')
      : ''
  return (
    name === 'TurnPaused' ||
    name === 'CancelledTaskError' ||
    name === 'TurnBusyError'
  )
}

function hookErrorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  return 'unknown_error'
}

function safeRuntimeError(error: unknown): {
  code: string
  message: string
  action?: string
} {
  const safe = safeErrorFromToSafe(error)
  if (safe) return safe
  return { code: 'internal_error', message: '发生内部错误，请查看日志。' }
}

function safeErrorFromToSafe(
  error: unknown,
): { code: string; message: string; action?: string } | null {
  if (!error || typeof error !== 'object') return null
  const toSafe = (error as { toSafe?: unknown }).toSafe
  if (typeof toSafe !== 'function') return null
  const payload = toSafe.call(error)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null
  const record = payload as Record<string, unknown>
  const code = typeof record.code === 'string' && record.code ? record.code : ''
  const message =
    typeof record.message === 'string' && record.message ? record.message : ''
  if (!code || !message) return null
  return {
    code,
    message,
    ...(typeof record.action === 'string' && record.action
      ? { action: record.action }
      : {}),
  }
}

function scopeLabel(scope: unknown): string | null {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null
  const record = scope as Record<string, unknown>
  const kind = String(record.kind || '')
  if (!kind) return null
  if (kind === 'project' && record.projectId)
    return `project:${String(record.projectId)}`
  if (kind === 'episode' && record.date) return `episode:${String(record.date)}`
  return kind
}

function cloneTodoItems(
  todos: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return todos.map((todo) => ({ ...todo }))
}

function activeSessionHistoryAfterSeq(
  store: SessionMemoryStore,
  seq: number,
): Msg[] {
  const cutoff = Math.trunc(Number(seq) || 0)
  const activeRows = store.conversation.historyLog.loadActiveRows()
  const hiddenTurns = new Set<string>()
  for (const row of activeRows) {
    if (
      typeof row.turn_id === 'string' &&
      (row.hidden === true || row.schedulerHidden === true)
    ) {
      hiddenTurns.add(row.turn_id)
    }
  }
  const out: Msg[] = []
  for (const row of activeRows) {
    if ((Number(row.seq) || 0) <= cutoff) continue
    if (!('role' in row) || !('content' in row)) continue
    if (row.type === 'model_call' || row.type === 'compact_event') continue
    if (hiddenTurns.has(String(row.turn_id ?? ''))) continue
    const item: Msg = { role: row.role, content: row.content }
    if (Number.isFinite(Number(row.seq)) && Number(row.seq) > 0)
      item.seq = Math.trunc(Number(row.seq))
    if (typeof row.turn_id === 'string') item.turn_id = row.turn_id
    if (Array.isArray(row.attachments)) item.attachments = row.attachments
    if (Array.isArray(row.requestedSkills))
      item.requestedSkills = row.requestedSkills
    if (typeof row.displayContent === 'string')
      item.displayContent = row.displayContent
    out.push(item)
  }
  return out
}

function safeSkillName(name: string): string {
  const safe = String(name || '').trim()
  return /^[A-Za-z0-9_.-]+$/.test(safe) ? safe : ''
}

class RequestedSkillUnavailableError extends Error {
  readonly code = 'requested_skill_unavailable'

  constructor(readonly skillName: string) {
    super(`Requested skill is unavailable: ${skillName}`)
    this.name = 'RequestedSkillUnavailableError'
  }

  toSafe(): { code: string; message: string; action: string } {
    return {
      code: this.code,
      message: `请求的 Skill 不可用：${this.skillName}`,
      action: 'refresh_skills',
    }
  }
}
