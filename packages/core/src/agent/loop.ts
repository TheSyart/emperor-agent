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
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { ContextBuilder, type SkillsLoaderLike } from './context-builder'
import {
  AgentRunner,
  type AgentRunnerHookHost,
  type CompactorLike,
} from './runner'
import { buildRoutedRunner } from './runner-factory'
import { RunnerGoalRecordingService } from './runner-goal-recording'
import { dispatchControlHost, permissionOnlyControlHost } from './control-hosts'
import { loadLocalConfig, type PromptProfile } from '../config/local-config'
import type { PermissionRuleInput } from '../permissions/rules'
import { loadModelConfig } from '../config/model-config'
import { ModelConfigurationError } from '../errors'
import { ControlManager } from '../control/manager'
import type { Interaction } from '../control/models'
import { TurnPaused } from '../control/exceptions'
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
import { GoalCoordinator } from '../goals/coordinator'
import { GoalContextBuilder } from '../goals/context'
import {
  BlockGoalTool,
  CompleteGoalTool,
  DefineGoalContractTool,
  GetGoalTool,
  GoalToolHost,
  RecordGoalEvidenceTool,
} from '../goals/tools'
import { GoalRecoveryService } from '../goals/recovery'
import {
  loadBundledToolCatalog,
  type LoadedToolCatalog,
} from '../environment/catalog'
import {
  EnvironmentProbe,
  collectSkillEnvironmentRequirements,
} from '../environment/probe'
import {
  ExecutionEnvironmentService,
  type ExecutionEnvironment,
} from '../environment/snapshot'
import {
  migrateLegacyStateRoot,
  type LegacyStateMigrationResult,
} from '../runtime/migrate-state-root'
import {
  ensureRuntimeStateDirs,
  resolveRuntimePaths,
  type RuntimePaths,
} from '../runtime/paths'
import { isSkillBlocked } from '../runtime/resources'
import { SkillManager } from '../skills/manager'
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
  ensureUserProfileFile,
  PROFILE_ONBOARDING_VERSION,
  ProfileOnboardingCoordinator,
  profileOnboardingAgentPrompt,
  type ProfileOnboardingActionResult,
  type ProfileOnboardingPayload,
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
import { ManageSkillTool } from '../tools/manage-skill'
import { DispatchSubagentTool } from '../tools/dispatch'
import { EditFileTool, ReadFileTool, WriteFileTool } from '../tools/filesystem'
import { ToolRegistry } from '../tools/registry'
import { WebSearchTool } from '../tools/web-search'
import * as runtimeEvents from '../runtime/events'
import {
  GoalEvidenceLedger,
  GoalObservationRecorder,
  type GoalUserManualSource,
} from '../goals/evidence'
import { GoalStore, type GoalCommitContext } from '../goals/store'
import { goalSummary, type GoalRecord } from '../goals/models'
import { GoalPlanBridge } from '../goals/plan-bridge'
import { portableGoalWorkspace } from '../goals/scope'
import { stableEnvironmentHash } from '../environment/models'
import { GoalGateFactStore } from '../goals/gate-facts'
import {
  GoalGateCoreFactAdapters,
  type GoalCoreFactRefreshInput,
} from '../goals/gate-fact-adapters'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'
import {
  GoalReviewerCoreRiskAdapter,
  GoalReviewerLedger,
  GoalReviewerPolicy,
} from '../goals/reviewer'
import {
  GoalReviewerExecutor,
  type ExecuteGoalReviewerInput,
} from '../goals/reviewer-executor'
import {
  GoalCompletionGate,
  type GoalBlockInput,
} from '../goals/completion-gate'
import { GoalBlockerFactStore } from '../goals/blocker-facts'
import { GoalBlockerCauseLedger } from '../goals/blocker-cause-ledger'
import { createAuthorizedGoalCompletionGate } from './goal-completion-gate-internal'
import { CoreGoalBlockerFactIssuer } from './goal-blocker-fact-internal'
import {
  CoreGoalBlockerCauseWriter,
  CoreGoalBlockerControlAdapter,
} from './goal-blocker-cause-writer-internal'

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
  legacyRuntimeRoot?: string | null
  legacyRuntimeSkillsHandled?: boolean
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
  signal?: AbortSignal | null
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
  readonly profileOnboarding: ProfileOnboardingCoordinator
  readonly tokenTracker: TokenTracker
  readonly hookService: HookService
  readonly environmentCatalog: LoadedToolCatalog
  readonly environmentProbe: EnvironmentProbe
  readonly executionEnvironmentService: ExecutionEnvironmentService
  readonly taskManager: TaskManager
  readonly projectStore: ProjectStore
  readonly controlManager: ControlManager
  readonly todoStore: TodoStore
  readonly schedulerStore: SchedulerStore
  readonly schedulerService: SchedulerService
  readonly activeTasks = new ActiveTaskRegistry()
  readonly skillsLoader: FileSkillsLoader
  readonly skillManager: SkillManager
  readonly contextBuilder: ContextBuilder
  readonly subagentRegistry: SubagentRegistry
  readonly teamManager: TeamManager
  readonly mcpClient: MCPClient
  readonly goalStore: GoalStore
  readonly goalPlanBridge: GoalPlanBridge
  readonly goalObservationRecorder: GoalObservationRecorder
  readonly goalEvidenceLedger: GoalEvidenceLedger
  readonly goalGateFactStore: GoalGateFactStore
  readonly goalGateFactAdapters: GoalGateCoreFactAdapters
  readonly goalReviewerRiskAdapter: GoalReviewerCoreRiskAdapter
  readonly goalReviewerLedger: GoalReviewerLedger
  readonly goalReviewerExecutor: GoalReviewerExecutor
  private readonly goalCompletionGate: GoalCompletionGate
  readonly goalToolHost: GoalToolHost
  readonly goalCoordinator: GoalCoordinator
  readonly goalBlockerFactStore: GoalBlockerFactStore
  readonly goalBlockerCauseLedger: GoalBlockerCauseLedger
  readonly goalBlockerFactIssuer: CoreGoalBlockerFactIssuer
  private readonly goalBlockerControlAdapter: CoreGoalBlockerControlAdapter
  readonly goalRecordingService: RunnerGoalRecordingService
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
  private readonly enableFirstRunOnboarding: boolean
  private schedulerAgentTurnSubmitter:
    ((payload: SchedulerAgentTurnPayload) => Promise<string>) | null = null
  private controlPendingSessionId: string | null = null
  private readonly todosBySession = new Map<
    string,
    Array<Record<string, unknown>>
  >()
  private readonly teamManagersByProject = new Map<string, TeamManager>()
  private readonly sessionStartHooksRun = new Set<string>()
  private readonly goalGateRefreshInputs = new Map<
    string,
    Omit<GoalCoreFactRefreshInput, 'currentScope'>
  >()
  private readonly goalGateMutations: GoalGateMutationLedger

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
    this.enableFirstRunOnboarding = Boolean(opts.enableFirstRunOnboarding)
    this.sharedMemory = sharedMemory
    this.profileOnboarding = new ProfileOnboardingCoordinator({
      stateRoot: this.paths.stateRoot,
      templatesDir: this.templatesDir,
      userFile: opts.userFile ?? this.sharedMemory.userFile,
    })
    this.eventSink = opts.eventSink ?? null

    this.sessionStore = new SessionStore(this.paths.stateRoot)
    this.goalStore = new GoalStore(this.paths.stateRoot, {
      hooks: {
        afterCommit: async (context) => await this.projectGoalCommit(context),
      },
    })
    this.goalGateMutations = new GoalGateMutationLedger(this.paths.stateRoot)
    this.goalGateFactStore = new GoalGateFactStore(this.paths.stateRoot)
    this.goalBlockerFactStore = new GoalBlockerFactStore(this.paths.stateRoot)
    this.goalBlockerCauseLedger = new GoalBlockerCauseLedger(
      this.paths.stateRoot,
    )
    this.goalObservationRecorder = new GoalObservationRecorder(this.goalStore, {
      isTrustedTaskTranscriptRef: (ref) => this.isTrustedTaskTranscriptRef(ref),
    })
    this.goalEvidenceLedger = new GoalEvidenceLedger(this.goalStore, {
      factResolvers: {
        resolveIndependentReviewer: async (goalId, source) =>
          await this.goalReviewerLedger.resolveIndependentReviewerFact(
            goalId,
            source,
          ),
        resolveUserManual: async (goalId, source) => {
          const inspection = await this.goalStore.inspect(goalId)
          if (!inspection.record || inspection.issue) return null
          const current = this.controlManager.goalManualEvidence.resolve(
            inspection.record,
            source,
            { allowHistoricalReceipt: true },
          )
          if (current) return current
          const events = await this.goalStore.readEventsReadonly(goalId)
          let durableAction: unknown = null
          for (const event of events) {
            const receipt = event.payload.receipt
            if (
              !receipt ||
              typeof receipt !== 'object' ||
              Array.isArray(receipt)
            )
              continue
            const record = receipt as Record<string, unknown>
            const storedSource = record.source
            if (
              record.kind === 'user_manual' &&
              storedSource &&
              typeof storedSource === 'object' &&
              !Array.isArray(storedSource) &&
              (storedSource as Record<string, unknown>).interactionId ===
                source.interactionId &&
              (storedSource as Record<string, unknown>).criterionId ===
                source.criterionId &&
              (storedSource as Record<string, unknown>).verdict ===
                source.verdict
            )
              durableAction = record.actionReceipt
          }
          return this.controlManager.goalManualEvidence.verifyDurableAction(
            inspection.record,
            source,
            durableAction,
          )
        },
        resolvePlanVerification: async (goalId, source) => {
          const inspection = await this.goalStore.inspect(goalId)
          if (!inspection.record || inspection.issue) return null
          return this.controlManager.resolveGoalPlanVerificationFact(
            goalId,
            inspection.record,
            source,
          )
        },
      },
    })
    this.goalRecordingService = new RunnerGoalRecordingService(
      this.goalObservationRecorder,
      this.goalEvidenceLedger,
    )
    this.tokenTracker = new TokenTracker(this.paths.tokensFile)
    this.environmentCatalog = loadBundledToolCatalog()
    this.environmentProbe = new EnvironmentProbe({
      catalog: () => this.environmentCatalog,
      env: () => process.env,
    })
    this.executionEnvironmentService = new ExecutionEnvironmentService({
      probe: this.environmentProbe,
      env: () => process.env,
    })
    this.hookService = new HookService({
      stateRoot: this.paths.stateRoot,
      modelRouter: {
        routeForRole: (useCase, role, task) =>
          this.routeHookModel(useCase, role, task),
      },
      tokenTracker: this.tokenTracker,
      executionEnvironment: async ({ projectRoot, cwd }) =>
        await this.createExecutionEnvironment(projectRoot ?? cwd),
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
    this.goalBlockerControlAdapter = CoreGoalBlockerControlAdapter.create(
      CoreGoalBlockerCauseWriter.create(this.goalBlockerCauseLedger),
      this.controlManager,
    )
    this.goalBlockerFactIssuer = CoreGoalBlockerFactIssuer.create({
      store: this.goalBlockerFactStore,
      causeLedger: this.goalBlockerCauseLedger,
    })
    this.goalGateFactAdapters = new GoalGateCoreFactAdapters(
      this.goalGateFactStore,
      this.goalStore,
      this.controlManager.store,
    )
    this.goalReviewerRiskAdapter = new GoalReviewerCoreRiskAdapter(
      this.controlManager.planStore,
      this.goalStore,
      this.taskManager.store,
    )
    this.goalReviewerLedger = new GoalReviewerLedger({
      goalStore: this.goalStore,
      planStore: this.controlManager.planStore,
      taskManager: this.taskManager,
      evidenceLedger: this.goalEvidenceLedger,
      resolveRiskFact: (context) =>
        this.goalReviewerRiskAdapter.resolve(context),
      resolveWaiverAction: async (context) => {
        const goal = await this.goalStore.get(context.goalId)
        return goal
          ? this.controlManager.resolveGoalReviewerWaiverAction(goal, context)
          : null
      },
    })
    this.todoStore = new TodoStore()
    this.goalPlanBridge = new GoalPlanBridge({
      goalStore: this.goalStore,
      planStore: this.controlManager.planStore,
      taskManager: this.taskManager,
      todoStore: this.todoStore,
      resolveStepWaiver: (context, snapshot) =>
        this.controlManager.resolvePlanStepWaiverFact(
          snapshot.goal,
          context,
          snapshot.plan,
        ),
      resolveStepVerification: (context, snapshot) =>
        this.controlManager.resolvePlanStepVerificationFact(
          snapshot.goal,
          context,
          snapshot.plan,
        ),
      resolveReviewer: async (context) => {
        return await this.goalReviewerLedger.resolvePlanReviewerFact(
          context.goalId,
          context,
        )
      },
      resolveReviewerRiskFact: (context) =>
        this.goalReviewerRiskAdapter.resolve(context),
    })
    this.schedulerStore = new SchedulerStore(this.paths.stateRoot)
    this.schedulerService = new SchedulerService(this.schedulerStore, {
      eventSink: async (event) => {
        await this.emit(event)
      },
      targetSessionId: () => this.activeSessionId,
    })
    this.skillManager = new SkillManager({
      runtimeRoot: this.root,
      stateRoot: this.paths.stateRoot,
    })
    this.skillsLoader = new FileSkillsLoader(
      this.root,
      this.paths.stateRoot,
      this.skillManager,
    )
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
    this.goalReviewerExecutor = new GoalReviewerExecutor({
      ledger: this.goalReviewerLedger,
      goalStore: this.goalStore,
      taskManager: this.taskManager,
      evidenceLedger: this.goalEvidenceLedger,
      baseGoalRecording: this.goalRecordingService,
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
        goalObservationRecorder: this.goalRecordingService,
      }),
    })
    this.goalCompletionGate = createAuthorizedGoalCompletionGate({
      goalStore: this.goalStore,
      planBridge: this.goalPlanBridge,
      evidenceLedger: this.goalEvidenceLedger,
      reviewerLedger: this.goalReviewerLedger,
      factStore: this.goalGateFactStore,
      blockerFactStore: this.goalBlockerFactStore,
      inspectLiveFacts: async (goal) => {
        return await this.inspectGoalGateFactsTrusted(goal)
      },
      cleanup: {
        revokePlanTokens: (planId) => {
          this.controlManager.revokePlanPermissionTokens({
            planId,
            reason: 'Goal reached a terminal state',
          })
        },
        clearActiveRun: (_goal, runId) => {
          this.activeTasks.cancel({ taskId: runId })
        },
        clearPendingInteraction: (goal, interactionId) => {
          this.controlManager.clearPendingInteractionForGoal(interactionId)
          this.controlManager.clearPendingInteractionForGoal(goal.id)
        },
      },
    })
    this.goalToolHost = new GoalToolHost({
      goalStore: this.goalStore,
      evidenceLedger: this.goalEvidenceLedger,
      completionGate: this.goalCompletionGate,
      blockGoal: async (goal, input) => {
        const fact = this.goalBlockerFactIssuer.issue(goal, input)
        return await this.goalCompletionGate.blockGoal(
          goal.id,
          input,
          fact.version,
        )
      },
      requestPermissionBlockerResolution: (goal, reason) =>
        this.controlManager.goalBlocker.requestPermissionResolution(
          goal,
          reason,
        ),
      hasAnswerableInteraction: (goal) => {
        const pending = this.controlManager.store.load().pending
        return Boolean(
          pending &&
          this.controlPendingOwnerSessionId(pending.id) ===
            goal.scope.sessionId,
        )
      },
      enterPlanMode: (goal) => {
        this.controlManager.setRuntimeScope(goal.scope)
        this.controlManager.setActiveGoalPlanContext(goal)
        this.controlManager.setMode('plan')
      },
    })
    this.goalCoordinator = new GoalCoordinator({
      goalStore: this.goalStore,
      activeTasks: this.activeTasks,
      evaluateGate: (goalId) => this.evaluateGoal(goalId),
      prepareVerification: (goal) => this.prepareGoalVerification(goal),
      pendingInteractionId: (goal) => {
        const pending = this.controlManager.store.load().pending
        if (!pending) return null
        const owner = this.findControlPendingSessionId(pending.id)
        const goalId = interactionGoalId(pending)
        return owner === goal.scope.sessionId || goalId === goal.id
          ? pending.id
          : null
      },
      planStatus: (planId) =>
        this.controlManager.planStore.get(planId)?.status ?? null,
      validateScope: (goal) => {
        const session = this.sessionStore.get(goal.scope.sessionId)
        if (!session) return false
        const current = this.controlRuntimeScopeForSession(session)
        return (
          current.mode === goal.scope.mode &&
          current.projectId === goal.scope.projectId &&
          current.workspaceRoot === goal.scope.workspaceRoot &&
          current.projectFingerprint === goal.scope.projectFingerprint
        )
      },
      progressSnapshot: async (goal) => {
        const plan = goal.runtime.currentPlanId
          ? this.controlManager.planStore.get(goal.runtime.currentPlanId)
          : null
        const activeStep = plan?.steps.find(
          (step) => step.status === 'active' || step.status === 'blocked',
        )
        const observations = await this.goalStore.readObservationsReadonly(
          goal.id,
        )
        return {
          lastEventSeq: goal.lastEventSeq,
          planUpdatedAt: plan
            ? new Date(plan.updatedAt * 1000).toISOString()
            : null,
          activePlanStepId: activeStep?.id ?? null,
          activePlanStepStatus: activeStep?.status ?? null,
          evidenceIds: Object.values(goal.latestEvidenceByCriterion),
          observationCount: observations.records.length,
          pendingInteractionId: goal.runtime.pendingInteractionId,
        }
      },
    })
    this.teamManager = this.createTeamManager(null)
    this.mcpClient = new MCPClient(this.paths.stateRoot)

    this.controlManager.setTodoStore(this.todoStore)
    this.controlManager.setTaskManager(this.taskManager)
    this.controlManager.setAskMetaProvider(() => {
      const state = this.profileOnboarding.payload()
      const profileMeta =
        state.status !== 'in_progress' ||
        state.sessionId !== this.activeSessionId
          ? {}
          : {
              profileOnboardingVersion: PROFILE_ONBOARDING_VERSION,
              profileOnboardingMode: 'agent',
            }
      const goalHandle = this.goalCoordinator.listActive()[0]
      return {
        ...profileMeta,
        ...(goalHandle
          ? {
              goal_id: goalHandle.goalId,
              goal_session_id: goalHandle.sessionId,
            }
          : {}),
      }
    })
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
    // Signed static data must validate before startup creates or migrates state.
    loadBundledToolCatalog()
    const paths = resolveRuntimePaths(opts.root, {
      stateRoot: opts.stateRoot ?? null,
      templatesDir: opts.templatesDir ?? null,
    })
    const root = paths.runtimeRoot
    mkdirSync(root, { recursive: true })
    ensureRuntimeStateDirs(paths)
    const migrationPaths = opts.legacyRuntimeRoot
      ? resolveRuntimePaths(opts.legacyRuntimeRoot, {
          stateRoot: paths.stateRoot,
        })
      : paths
    const legacyStateMigration = migrateLegacyStateRoot(migrationPaths, {
      excludePreviousStateSkills: Boolean(
        opts.legacyRuntimeRoot && opts.legacyRuntimeSkillsHandled,
      ),
    })
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
    let modelRouter = opts.modelRouter ?? null
    if (!modelRouter) {
      const modelConfig = await loadModelConfig(paths.stateRoot, {
        create: true,
      })
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
    await loop.goalCompletionGate.recoverPostCommitCleanup()
    await loop.goalPlanBridge.recoverQuarantinedApprovals()
    const recoveredSkips = await loop.goalPlanBridge.recoverIncompleteSkips()
    await loop.goalPlanBridge.recoverIncompleteReplans()
    // Finish already-persisted Goal/Plan transactions before the generic
    // restart policy pauses orphaned execution. Pausing first would make the
    // bridge correctly reject the executing-only recovery receipts and strand
    // their durable intents halfway through replay.
    await new GoalRecoveryService(loop.goalStore, {
      hasActiveRuntime: (goal) => loop.goalCoordinator.active(goal.id) !== null,
      validateScope: (goal) => ({
        valid:
          loop.sessionStore.get(goal.scope.sessionId) !== null &&
          existsSync(goal.scope.workspaceRoot),
        reason: loop.sessionStore.get(goal.scope.sessionId)
          ? 'workspace_missing'
          : 'session_missing',
      }),
    }).recoverOnStartup()
    for (const projection of recoveredSkips.todoProjections) {
      if (!loop.sessionStore.get(projection.sessionId)) continue
      loop.todosBySession.set(
        projection.sessionId,
        cloneTodoItems(projection.todos),
      )
    }
    const session = loop.ensureActiveSession()
    if (opts.initializeMcp !== false) {
      const executionEnvironment = await loop.createExecutionEnvironment(
        loop.workspaceRootForSession(session),
      )
      await loop.mcpClient.initialize(executionEnvironment)
      loop.mcpClient.registerTools(loop.registry)
    }
    loop.activateSession(session.id)
    await loop.reconcileProfileOnboardingPendingAtStartup()
    if (opts.enableFirstRunOnboarding)
      await loop.startProfileInterview({ manual: false })
    return loop
  }

  async refreshGoalGateFacts(
    goalId: string,
    input: GoalCoreFactRefreshInput = {},
  ) {
    const inspection = await this.goalStore.inspect(goalId)
    if (!inspection.record || inspection.issue)
      throw new Error('Goal is unavailable for Gate fact refresh.')
    const goal = inspection.record
    return await this.goalGateMutations.guard.runExclusive(
      'mutation',
      async (lease) => {
        const previous = this.goalGateRefreshInputs.get(goalId) ?? {}
        const merged = {
          ...previous,
          ...(input.hardConstraintsSatisfied !== undefined
            ? { hardConstraintsSatisfied: input.hardConstraintsSatisfied }
            : {}),
          ...(input.estimatedCostUsd !== undefined
            ? { estimatedCostUsd: input.estimatedCostUsd }
            : {}),
        }
        if (JSON.stringify(previous) !== JSON.stringify(merged)) {
          this.goalGateMutations.recordUnderLease(
            lease,
            'hard_constraints',
            `goal-gate-source:${goalId}:${JSON.stringify(merged)}`,
          )
          this.goalGateRefreshInputs.set(goalId, merged)
        }
        return await this.goalGateFactAdapters.refreshUnderLease(lease, goal, {
          ...merged,
          currentScope:
            input.currentScope === undefined
              ? this.liveGoalScope(goal)
              : input.currentScope,
        })
      },
    )
  }

  private async inspectGoalGateFactsTrusted(
    goal: import('../goals/models').GoalRecord,
  ) {
    return await this.goalGateFactAdapters.inspectLiveBundle(goal, {
      ...(this.goalGateRefreshInputs.get(goal.id) ?? {}),
      currentScope: this.liveGoalScope(goal),
    })
  }

  private liveGoalScope(goal: GoalRecord) {
    const session = this.sessionStore.get(goal.scope.sessionId)
    return session ? this.controlRuntimeScopeForSession(session) : null
  }

  private async prepareGoalVerification(
    goal: GoalRecord,
  ): Promise<string | null> {
    await this.refreshGoalGateFacts(goal.id, {
      hardConstraintsSatisfied: this.goalConstraintPolicySatisfied(goal),
      currentScope: this.liveGoalScope(goal),
    })

    for (const criterion of goal.contract.acceptanceCriteria) {
      if (criterion.verification.kind !== 'manual') continue
      const latest = await this.goalEvidenceLedger.latestEvidenceForCriterion(
        goal.id,
        criterion.id,
      )
      if (latest?.verdict === 'pass') continue
      const interaction = this.controlManager.goalManualEvidence.request(
        goal,
        criterion.id,
      )
      return interaction.id
    }

    const planId = goal.runtime.currentPlanId
    const plan = planId ? this.controlManager.planStore.get(planId) : null
    if (!plan || plan.status !== 'completed') return null
    const riskFact = await this.goalReviewerRiskAdapter.resolve({
      goalId: goal.id,
      planId: plan.id,
      planEventSeq: plan.eventSeq,
      currentReviewer: null,
    })
    const requirement = new GoalReviewerPolicy().requirementFor(plan, riskFact)
    const reviewerCriterion = goal.contract.acceptanceCriteria.some(
      (criterion) => criterion.verification.kind === 'reviewer',
    )
    if (!reviewerCriterion && !requirement.required) return null
    const currentDecision =
      await this.goalReviewerLedger.latestReviewerDecision(goal.id, goal)
    if (currentDecision) return null
    await this.runGoalReviewer({
      goalId: goal.id,
      planId: plan.id,
      planEventSeq: plan.eventSeq,
      workspaceRoot: goal.scope.workspaceRoot,
      sessionId: goal.scope.sessionId,
      executionEnvironment: await this.createExecutionEnvironment(
        goal.scope.workspaceRoot,
      ),
    })
    return null
  }

  private goalConstraintPolicySatisfied(goal: GoalRecord): boolean {
    if (goal.status !== 'active' || !goal.contract.lockedAt) return false
    if (!this.liveGoalScope(goal)) return false
    if (
      goal.guardPolicy.maxCycles !== null &&
      goal.runtime.cyclesUsed >= goal.guardPolicy.maxCycles
    )
      return false
    if (
      goal.guardPolicy.deadlineAt !== null &&
      Date.now() >= Date.parse(goal.guardPolicy.deadlineAt)
    )
      return false
    return true
  }

  async evaluateGoal(goalId: string) {
    const gate = await this.goalCompletionGate.evaluate(goalId)
    const inspection = await this.goalStore.inspect(goalId)
    if (inspection.record && !inspection.issue) {
      await this.emit(
        runtimeEvents.goalGateEvaluated(
          {
            goalId: inspection.record.id,
            sessionId: inspection.record.scope.sessionId,
            lastEventSeq: inspection.record.lastEventSeq,
            updatedAt: inspection.record.updatedAt,
          },
          {
            passed: gate.pass,
            reasonCodes: gate.reasons.map((reason) => reason.code),
          },
        ),
      )
    }
    return gate
  }

  completeGoal(goalId: string) {
    return this.goalCompletionGate.complete(goalId)
  }

  async issueGoalBlockerFact(goalId: string, input: GoalBlockInput) {
    const inspection = await this.goalStore.inspect(goalId)
    if (!inspection.record || inspection.issue)
      throw new Error('Goal is unavailable for blocker fact issuance.')
    return this.goalBlockerFactIssuer.issue(inspection.record, input)
  }

  async requestGoalPermissionBlockerResolution(goalId: string, reason: string) {
    const inspection = await this.goalStore.inspect(goalId)
    if (!inspection.record || inspection.issue)
      throw new Error('Goal is unavailable for blocker resolution.')
    return this.controlManager.goalBlocker.requestPermissionResolution(
      inspection.record,
      reason,
    )
  }

  async requestGoalManualVerification(goalId: string, criterionId: string) {
    const inspection = await this.goalStore.inspect(goalId)
    if (!inspection.record || inspection.issue)
      throw new Error('Goal is unavailable for manual verification.')
    return this.controlManager.goalManualEvidence.request(
      inspection.record,
      criterionId,
    )
  }

  async recordGoalManualVerification(
    goalId: string,
    source: GoalUserManualSource,
  ) {
    const receipt = await this.goalEvidenceLedger.issueUserManualReceipt(
      goalId,
      source,
    )
    return await this.goalEvidenceLedger.record(
      goalId,
      {
        criterionId: source.criterionId,
        verdict: source.verdict,
        check: 'Explicit persisted user manual verification.',
        summary: receipt.summary,
        sourceObservationIds: [],
        sourceReceiptIds: [receipt.id],
      },
      { recorder: 'user' },
    )
  }

  async blockGoalFromControlPermissionDenial(
    goalId: string,
    input: GoalBlockInput & { readonly code: 'missing_permission' },
    interactionId: string,
  ) {
    const inspection = await this.goalStore.inspect(goalId)
    if (!inspection.record || inspection.issue)
      throw new Error('Goal is unavailable for blocker resolution.')
    this.goalBlockerControlAdapter.recordPermissionDenial(
      inspection.record,
      interactionId,
    )
    const fact = this.goalBlockerFactIssuer.issue(inspection.record, input)
    return await this.goalCompletionGate.blockGoal(goalId, input, fact.version)
  }

  async blockGoal(
    goalId: string,
    input: GoalBlockInput,
    blockerFactVersion: string,
  ) {
    return await this.goalCompletionGate.blockGoal(
      goalId,
      input,
      blockerFactVersion,
    )
  }

  runGoalReviewer(input: ExecuteGoalReviewerInput) {
    return this.goalReviewerExecutor.execute(input)
  }

  private async projectGoalCommit(context: GoalCommitContext): Promise<void> {
    const goal = context.record
    const evidence = await this.goalEvidenceLedger.listEvidence(goal.id)
    const summary = goalSummary(
      goal,
      Object.fromEntries(
        evidence.map((item) => [
          item.id,
          { verdict: item.verdict, summary: item.summary },
        ]),
      ),
    )
    const payload = context.event.payload
    const identity = {
      goalId: goal.id,
      sessionId: goal.scope.sessionId,
      lastEventSeq: goal.lastEventSeq,
      updatedAt: goal.updatedAt,
    }
    let event: Record<string, unknown>
    if (context.type === 'goal_created') {
      event = runtimeEvents.goalCreated(summary, {
        lastEventSeq: goal.lastEventSeq,
      })
    } else if (context.type === 'goal_completed') {
      event = runtimeEvents.goalCompleted(summary, {
        lastEventSeq: goal.lastEventSeq,
        summary: 'Goal Completion Gate passed.',
      })
    } else if (context.type === 'goal_blocked') {
      const blocker = isRecord(payload.blockerReceipt)
        ? payload.blockerReceipt
        : null
      event = runtimeEvents.goalBlocked(summary, {
        lastEventSeq: goal.lastEventSeq,
        reason: blocker ? String(blocker.reason ?? '') : null,
      })
    } else if (isRecord(payload.evidence)) {
      const item = payload.evidence
      event = runtimeEvents.goalEvidenceRecorded(summary, identity, {
        criterionId: String(item.criterionId ?? ''),
        verdict: item.verdict === 'pass' ? 'pass' : 'fail',
        sourceCount:
          (Array.isArray(item.sourceObservationIds)
            ? item.sourceObservationIds.length
            : 0) +
          (Array.isArray(item.sourceReceiptIds)
            ? item.sourceReceiptIds.length
            : 0),
        summary: String(item.summary ?? ''),
      })
    } else if (goal.status === 'cancelled') {
      event = runtimeEvents.goalCancelled(summary, {
        lastEventSeq: goal.lastEventSeq,
        reason: goal.runtime.pauseReason,
      })
    } else if (goal.status === 'stopped_by_policy') {
      event = runtimeEvents.goalPolicyStopped(summary, {
        lastEventSeq: goal.lastEventSeq,
        reason: goal.runtime.pauseReason,
      })
    } else if (
      goal.runtime.phase === 'paused' &&
      context.previous?.runtime.phase !== 'paused'
    ) {
      event = runtimeEvents.goalPaused(summary, {
        lastEventSeq: goal.lastEventSeq,
        reason: goal.runtime.pauseReason,
      })
    } else if (
      context.previous?.runtime.phase === 'paused' &&
      goal.runtime.phase !== 'paused'
    ) {
      event = runtimeEvents.goalResumed(summary, {
        lastEventSeq: goal.lastEventSeq,
      })
    } else {
      const plan = goal.runtime.currentPlanId
        ? this.controlManager.planStore.get(goal.runtime.currentPlanId)
        : null
      event = runtimeEvents.goalRuntimeUpdate(summary, {
        lastEventSeq: goal.lastEventSeq,
        plan: plan
          ? {
              completed: plan.steps.filter((step) => step.status === 'done')
                .length,
              failed: plan.steps.filter((step) => step.status === 'failed')
                .length,
              blocked: plan.steps.filter((step) => step.status === 'blocked')
                .length,
              total: plan.steps.length,
            }
          : null,
      })
    }
    await this.emit(event)
  }

  profileOnboardingPayload(): ProfileOnboardingPayload {
    return this.profileOnboarding.reconcileProfile()
  }

  private async reconcileProfileOnboardingPendingAtStartup(): Promise<void> {
    const state = this.profileOnboarding.payload()
    const pending = this.controlManager.store.load().pending
    const matching =
      state.status === 'in_progress' &&
      state.interactionId &&
      pending?.kind === 'ask' &&
      pending.id === state.interactionId
        ? pending
        : null
    if (
      matching &&
      matching.meta?.profileOnboardingVersion !== PROFILE_ONBOARDING_VERSION
    ) {
      const ownerSessionId = state.sessionId
      const cancelled = this.controlManager.cancel(matching.id)
      await this.emitProfileOnboardingRuntimeEvent(
        {
          ...cancelled,
          source: 'onboarding',
          session_id: ownerSessionId,
          reason: 'onboarding_schema_upgraded',
        },
        `onboarding_upgrade_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      )
      await this.deferProfileInterview(matching.id)
      return
    }
    this.profileOnboarding.reconcilePendingInteraction(matching?.id ?? null)
  }

  async startProfileInterview(
    opts: { manual?: boolean } = {},
  ): Promise<ProfileOnboardingActionResult> {
    const manual = Boolean(opts.manual)
    const reconciled = this.profileOnboarding.reconcileProfile()
    if (reconciled.status === 'completed')
      return { started: false, state: reconciled }
    if (!manual && !this.enableFirstRunOnboarding)
      return { started: false, state: reconciled }
    if (!this.modelAvailableForOnboarding())
      return { started: false, state: reconciled }
    if (
      this.activeTasks.hasActive() ||
      Boolean(this.controlManager.payload().pending)
    )
      return { started: false, state: reconciled }

    const session = this.profileOnboardingSession()
    const attempt = this.profileOnboarding.beginAttempt(session.id, { manual })
    if (!attempt.started) return attempt
    await this.emitProfileOnboardingStatus('started')

    const turnId = `onboarding_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    try {
      if (this.activeSessionId !== session.id) this.activateSession(session.id)
      await this.runUserTurn(
        profileOnboardingAgentPrompt(
          this.profileOnboarding.seedContent,
          this.sharedMemory.readUser(),
        ),
        {
          sessionId: session.id,
          turnId,
          source: 'onboarding',
          displayContent: '',
          uiHidden: true,
          memoryExtra: { ui_hidden: true, onboarding: true },
        },
      )
      const state = this.profileOnboarding.reconcileProfile()
      if (state.status === 'completed') {
        await this.emitProfileOnboardingStatus('completed')
        return { started: true, state }
      }
      const failed = this.profileOnboarding.fail(
        'profile interview ended before asking the user or saving the profile',
      )
      await this.emitProfileOnboardingStatus('failed')
      return { started: false, state: failed }
    } catch (error) {
      if (error instanceof TurnPaused) {
        const interactionId = String(error.interaction.id ?? '').trim()
        const interaction = this.tagProfileOnboardingInteraction(interactionId)
        const state = this.profileOnboarding.attachInteraction(interaction.id)
        await this.emitProfileOnboardingStatus('awaiting_answers')
        return { started: true, state }
      }
      const state = this.profileOnboarding.fail(error)
      await this.emitProfileOnboardingStatus('failed')
      return { started: false, state }
    }
  }

  async skipProfileInterview(): Promise<ProfileOnboardingActionResult> {
    const state = this.profileOnboarding.skip()
    await this.emitProfileOnboardingStatus('skipped')
    return { started: false, state }
  }

  async deferProfileInterview(
    interactionId: string,
  ): Promise<ProfileOnboardingPayload> {
    const before = this.profileOnboarding.payload()
    const state = this.profileOnboarding.defer(interactionId)
    if (
      before.status !== state.status ||
      before.interactionId !== state.interactionId
    )
      await this.emitProfileOnboardingStatus('deferred')
    return state
  }

  isProfileOnboardingInteraction(interactionId: string): boolean {
    const state = this.profileOnboarding.payload()
    if (
      state.status !== 'in_progress' ||
      state.interactionId !== String(interactionId ?? '').trim()
    )
      return false
    const pending = this.controlManager.store.load().pending
    return Boolean(
      pending?.kind === 'ask' &&
      pending.id === state.interactionId &&
      pending.meta?.profileOnboardingVersion === PROFILE_ONBOARDING_VERSION,
    )
  }

  reconcileProfileOnboarding(): ProfileOnboardingPayload {
    const before = this.profileOnboarding.payload()
    const state = this.profileOnboarding.reconcileProfile()
    if (before.status !== state.status)
      void this.emitProfileOnboardingStatus('profile_saved').catch(() => {})
    return state
  }

  async settleProfileInterviewResume(
    interactionId: string,
  ): Promise<ProfileOnboardingPayload> {
    const before = this.profileOnboarding.payload()
    if (before.interactionId !== interactionId) return before
    const reconciled = this.profileOnboarding.reconcileProfile()
    if (reconciled.status === 'completed') return reconciled
    const pending = this.controlManager.payload().pending
    if (pending?.kind === 'ask' && pending.id) {
      const interaction = this.tagProfileOnboardingInteraction(
        String(pending.id),
      )
      const state = this.profileOnboarding.attachInteraction(interaction.id)
      await this.emitProfileOnboardingStatus('awaiting_answers')
      return state
    }
    const state = this.profileOnboarding.fail(
      'profile interview ended before the profile was saved',
    )
    await this.emitProfileOnboardingStatus('failed')
    return state
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
    const projectSkillsRoot =
      session.mode === 'build' && session.project_path
        ? resolve(session.project_path)
        : null
    this.skillsLoader.setProjectSkillsDir(
      projectSkillsRoot ? join(projectSkillsRoot, '.emperor', 'skills') : null,
      projectSkillsRoot,
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

  goalScopeForSession(session: SessionEntry): {
    sessionId: string
    mode: 'chat' | 'build'
    projectId: string | null
    workspaceRoot: string
  } {
    const scope = this.controlRuntimeScopeForSession(session)
    return {
      sessionId: scope.sessionId,
      mode: scope.mode,
      projectId: scope.projectId,
      workspaceRoot: scope.workspaceRoot,
    }
  }

  async runUserTurn(
    content: string,
    opts: RunUserTurnOptions = {},
  ): Promise<string> {
    if (
      opts.source !== 'goal' &&
      (this.activeTasks.hasActiveKind('turn') ||
        this.activeTasks.hasActiveKind('goal'))
    ) {
      throw new TurnBusyError()
    }
    const targetSessionId = String(opts.sessionId ?? '').trim()
    const previousSessionId = this.activeSessionId
    if (targetSessionId && this.activeSessionId !== targetSessionId)
      this.activateSession(targetSessionId)
    const restorePreviousSession = (): void => {
      if (!opts.restoreActiveSessionAfterTurn) return
      if (!previousSessionId || previousSessionId === this.activeSessionId)
        return
      if (targetSessionId && this.activeSessionId !== targetSessionId) {
        const current = this.activeSessionId
          ? this.sessionStore.get(this.activeSessionId)
          : null
        if (current)
          this.controlManager.setRuntimeScope(
            this.controlRuntimeScopeForSession(current),
          )
        return
      }
      try {
        this.activateSession(previousSessionId)
      } catch {
        // The previous session may have been deleted while a background turn was running.
      }
    }
    try {
      assertModelAvailable(this.modelRouter.availability)
      const activeSession =
        this.activeSession ??
        (this.activeSessionId
          ? this.sessionStore.get(this.activeSessionId)
          : null)
      const activeProfile =
        this.modelRouter.route('main_agent').snapshot.profile
      const requiresTools =
        activeSession?.mode === 'build' || opts.source === 'scheduler'
      if (requiresTools && activeProfile?.toolCall === false) {
        throw new ModelConfigurationError(
          '当前激活模型不支持工具调用，无法用于 Build 或自动执行。请切换支持工具调用的模型。',
        )
      }
    } catch (error) {
      restorePreviousSession()
      throw error
    }
    const turnId = opts.turnId || randomUUID().replace(/-/g, '').slice(0, 16)
    const taskId = opts.taskId || `turn:${turnId}`
    const abortController = opts.signal ? null : new AbortController()
    const signal = opts.signal ?? abortController?.signal ?? null
    const execute = () =>
      this.runUserTurnInner(content, turnId, opts, signal).finally(() => {
        this.hookService.endTurn(turnId)
        restorePreviousSession()
      })
    if (opts.useActiveTask === false) return execute()
    return this.activeTasks.run({
      taskId,
      kind: 'turn',
      label: 'Agent turn',
      execute,
      turnId,
      sessionId: this.activeSessionId,
      abort: () => abortController?.abort(),
    })
  }

  setSchedulerAgentTurnSubmitter(
    submitter: ((payload: SchedulerAgentTurnPayload) => Promise<string>) | null,
  ): void {
    this.schedulerAgentTurnSubmitter = submitter
  }

  async close(): Promise<void> {
    await this.goalCoordinator.shutdown()
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
    const executionEnvironment = await this.createExecutionEnvironment(
      this.workspaceRootForActiveSession(),
    )
    await this.mcpClient.initialize(executionEnvironment)
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
    this.controlManager.setActiveGoalPlanContext(
      await this.goalStore.findActiveBySession(session.id),
    )
    const scope = this.turnScope(session, turnId)
    const executionEnvironment = await this.createExecutionEnvironment(
      scope.workspaceRoot,
      signal,
    )
    await this.hookService.beginTurn({
      turnId,
      sessionId,
      projectRoot:
        session.mode === 'build' ? (session.project_path ?? null) : null,
      executionEnvironment,
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
    if (opts.uiHidden) userMessage.ui_hidden = true
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
        ...(opts.uiHidden ? { ui_hidden: true } : {}),
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
          const emittedEvent =
            opts.source === 'onboarding' && !('source' in event)
              ? { ...event, source: 'onboarding' }
              : event
          await this.emit(emittedEvent, {
            turnId,
            emit: opts.emit ?? null,
            runtimeStore,
            scope,
          })
        },
        { turnId, signal, executionEnvironment },
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
    const goalContext = session
      ? new GoalContextBuilder({
          goalStore: this.goalStore,
          evidenceLedger: this.goalEvidenceLedger,
          planProvider: (goal) => {
            const planId = goal.runtime.currentPlanId
            const plan = planId
              ? this.controlManager.planStore.get(planId)
              : null
            if (!plan) return null
            const activeStep = plan.steps.find(
              (step) => step.status === 'active' || step.status === 'blocked',
            )
            return {
              id: plan.id,
              status: plan.status,
              updatedAt: plan.updatedAt,
              activeStep: activeStep
                ? `${activeStep.id} ${activeStep.title}`
                : null,
            }
          },
          gateEvaluator: (goalId) => this.goalCompletionGate.evaluate(goalId),
          pendingInteractionId: (sessionId) => {
            const pending = this.controlManager.store.load().pending
            return pending &&
              this.controlPendingOwnerSessionId(pending.id) === sessionId
              ? pending.id
              : null
          },
        })
      : null
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
      goalObservationRecorder: this.goalRecordingService,
      goalToolHost: this.goalToolHost,
      goalContextProvider: goalContext
        ? async (history) => {
            const attachment = await goalContext.build(session!.id, { history })
            return attachment
              ? { role: 'system', content: attachment.content }
              : null
          }
        : null,
      goalContextHint: goalContext ? () => goalContext.hint(session!.id) : null,
      onGoalCompacted: goalContext
        ? () => goalContext.markCompacted(session!.id)
        : null,
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

  private async createExecutionEnvironment(
    projectRoot: string,
    signal: AbortSignal | null = null,
  ): Promise<ExecutionEnvironment> {
    const probeRoot = this.environmentProbeRoot(projectRoot)
    return await this.executionEnvironmentService.create({
      projectRoot: probeRoot,
      skillRequirements: collectSkillEnvironmentRequirements(this.skillManager),
      ...(signal ? { signal } : {}),
    })
  }

  private isTrustedTaskTranscriptRef(ref: string): boolean {
    const match = /^task:(.+):transcript$/.exec(ref)
    if (!match) return false
    const task = this.taskManager.store.get(match[1]!)
    if (!task?.transcript_path) return false
    try {
      const transcript = this.taskManager.readSidechain(task.id)
      const tasksRoot = resolve(this.paths.stateRoot, 'tasks')
      const rel = relative(tasksRoot, transcript.path)
      return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    } catch {
      return false
    }
  }

  private environmentProbeRoot(projectRoot: string): string {
    try {
      const canonical = realpathSync(projectRoot)
      return lstatSync(canonical).isDirectory() ? canonical : this.root
    } catch {
      return this.root
    }
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
              modelEntryId: snapshot.modelEntryId,
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
    this.registry.register(
      new ManageSkillTool(this.skillManager, () =>
        this.refreshRuntimeContext(),
      ),
    )
    this.registry.register(new ReadFileTool(this.root))
    this.registry.register(new WriteFileTool(this.root))
    this.registry.register(new EditFileTool(this.root))
    this.registry.register(new GlobTool(this.root))
    this.registry.register(new GrepTool(this.root))
    this.registry.register(new SchedulerTool(this.schedulerService))
    this.registry.register(new AskUserTool(this.controlManager))
    this.registry.register(new ProposePlanTool(this.controlManager))
    this.registry.register(new RequestPlanModeTool(this.controlManager))
    this.registry.register(new GetGoalTool(this.goalToolHost))
    this.registry.register(new DefineGoalContractTool(this.goalToolHost))
    this.registry.register(new RecordGoalEvidenceTool(this.goalToolHost))
    this.registry.register(new CompleteGoalTool(this.goalToolHost))
    this.registry.register(new BlockGoalTool(this.goalToolHost))
    this.registry.register(new UpdateTodos(this.todoStore))
    this.registry.register(
      new SaveUserProfileTool(
        this.sharedMemory,
        () => {
          this.reconcileProfileOnboarding()
        },
        (currentContent) =>
          this.profileOnboarding.allowsSeedReplacement(
            this.activeSessionId,
            currentContent,
          ),
      ),
    )
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
          goalObservationRecorder: this.goalRecordingService,
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

  private profileOnboardingSession(): SessionEntry {
    const sessions = this.sessionStore.list({ includeArchived: false })
    return (
      sessions.find(
        (session) => session.mode === 'chat' && session.title === 'Default',
      ) ??
      sessions.find((session) => session.mode === 'chat') ??
      this.sessionStore.create('Default', { mode: 'chat' })
    )
  }

  private modelAvailableForOnboarding(): boolean {
    return this.modelRouter.availability?.usable ?? true
  }

  private tagProfileOnboardingInteraction(interactionId: string) {
    return this.controlManager.updatePendingMeta(interactionId, {
      profileOnboardingVersion: PROFILE_ONBOARDING_VERSION,
      profileOnboardingMode: 'agent',
    })
  }

  private async emitProfileOnboardingRuntimeEvent(
    event: Record<string, unknown>,
    turnId: string,
  ): Promise<void> {
    try {
      await this.emit(event, { turnId })
    } catch {
      // A renderer/event sink failure must not invalidate the persisted Ask.
    }
  }

  private async emitProfileOnboardingStatus(reason: string): Promise<void> {
    const state = this.profileOnboarding.payload()
    try {
      await this.emit(
        runtimeEvents.profileOnboardingStatusChanged({ ...state }, { reason }),
      )
    } catch {
      // Observability must not alter onboarding state or model-save success.
    }
  }

  private setActiveSessionControlPending(interaction: Interaction): void {
    const goalId = interactionGoalId(interaction)
    const sessionId =
      String(interaction.meta.goal_session_id ?? '').trim() ||
      (goalId
        ? (this.goalCoordinator.active(goalId)?.sessionId ?? null)
        : null) ||
      String(interaction.meta.control_session_id ?? '').trim() ||
      this.activeSessionId
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
    return this.modelRouter.route(useCase, null, task)
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
    mode: 'chat' | 'build'
    projectId: string | null
    workspaceRoot: string
    projectFingerprint: string
  } {
    const projectId = session.project_id ?? null
    const workspaceRoot = portableGoalWorkspace(
      this.workspaceRootForSession(session),
    )
    return {
      sessionId: session.id,
      mode: session.mode,
      projectId,
      workspaceRoot,
      projectFingerprint: stableEnvironmentHash(
        session.mode === 'chat'
          ? { mode: session.mode, workspaceRoot }
          : { mode: session.mode, projectId, workspaceRoot },
      ),
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
      toolCallingAvailable: () =>
        this.modelRouter.route('team').snapshot.profile?.toolCall !== false,
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
        const executionEnvironment =
          this.hookService.agentScope(agentId)?.executionEnvironment ?? null
        return {
          step: (history) =>
            runner.stepAsync(history, { executionEnvironment }),
          stepStream: (history, emit) =>
            runner.stepStream(history, emit, { executionEnvironment }),
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

function interactionGoalId(interaction: Interaction): string | null {
  const direct = String(interaction.meta.goal_id ?? '').trim()
  if (direct) return direct
  for (const key of [
    'goal_manual_evidence_request',
    'goal_permission_blocker_request',
    'goal_reviewer_waiver_request',
  ]) {
    const value = interaction.meta[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const goalId = String(
      (value as Record<string, unknown>).goal_id ?? '',
    ).trim()
    if (goalId) return goalId
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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
  readonly runtimeRoot: string
  readonly stateRoot: string
  readonly builtinDir: string
  readonly userDir: string
  private readonly manager: SkillManager
  private projectDir: string | null = null
  private projectRoot: string | null = null

  constructor(runtimeRoot: string, stateRoot: string, manager: SkillManager) {
    this.runtimeRoot = resolve(runtimeRoot)
    this.stateRoot = resolve(stateRoot)
    this.builtinDir = join(this.runtimeRoot, 'skills')
    this.userDir = join(this.stateRoot, 'skills')
    this.manager = manager
  }

  setProjectSkillsDir(dir: string | null, projectRoot: string | null): void {
    this.projectDir = dir
    this.projectRoot = projectRoot
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
    for (const source of this.dirsInPrecedenceOrder()) {
      if (!canonicalRegularPath(source.dir, source.boundary, 'directory'))
        continue
      const dir = source.dir
      const nestedPath = join(dir, safe)
      const nestedRoot = canonicalRegularPath(
        nestedPath,
        source.boundary,
        'directory',
      )
      if (source.kind === 'user' && nestedRoot && isSkillBlocked(nestedRoot))
        continue
      const candidates = [
        ...(nestedRoot ? [join(nestedPath, 'SKILL.md')] : []),
        join(dir, `${safe}.md`),
      ]
      for (const path of candidates) {
        const file = canonicalRegularPath(path, source.boundary, 'file')
        if (!file) continue
        if (
          nestedRoot &&
          path === join(nestedPath, 'SKILL.md') &&
          !this.manager.validateRecord({
            name: safe,
            root: nestedRoot,
            skillFile: file,
            source: source.kind,
            status: 'active',
            readOnly: source.kind !== 'user',
          }).valid
        )
          continue
        return readFileSync(file, 'utf8').replaceAll(
          '{{skill_dir}}',
          dirname(file),
        )
      }
    }
    return null
  }

  private dirsInPrecedenceOrder(): Array<{
    kind: 'project' | 'user' | 'builtin'
    dir: string
    boundary: string
  }> {
    return [
      ...(this.projectDir && this.projectRoot
        ? [
            {
              kind: 'project' as const,
              dir: this.projectDir,
              boundary: this.projectRoot,
            },
          ]
        : []),
      {
        kind: 'user' as const,
        dir: this.userDir,
        boundary: this.stateRoot,
      },
      {
        kind: 'builtin' as const,
        dir: this.builtinDir,
        boundary: this.runtimeRoot,
      },
    ]
  }

  private skillNames(): string[] {
    const names = new Set<string>()
    for (const source of this.dirsInPrecedenceOrder()) {
      if (!canonicalRegularPath(source.dir, source.boundary, 'directory'))
        continue
      const dir = source.dir
      for (const item of readdirSync(dir)) {
        if (item.startsWith('.')) continue
        const path = join(dir, item)
        const directory = canonicalRegularPath(
          path,
          source.boundary,
          'directory',
        )
        if (directory) {
          if (source.kind === 'user' && isSkillBlocked(directory)) continue
          if (
            (() => {
              const skillFile = canonicalRegularPath(
                join(path, 'SKILL.md'),
                source.boundary,
                'file',
              )
              return (
                skillFile &&
                this.manager.validateRecord({
                  name: item,
                  root: directory,
                  skillFile,
                  source: source.kind,
                  status: 'active',
                  readOnly: source.kind !== 'user',
                }).valid
              )
            })()
          )
            names.add(item)
        } else if (
          item.endsWith('.md') &&
          canonicalRegularPath(path, source.boundary, 'file')
        )
          names.add(basename(item, '.md'))
      }
    }
    return [...names].sort()
  }
}

function canonicalRegularPath(
  path: string,
  boundary: string,
  kind: 'file' | 'directory',
): string | null {
  const lexicalBoundary = resolve(boundary)
  const lexicalPath = resolve(path)
  if (!pathInside(lexicalBoundary, lexicalPath)) return null
  if (!existsSync(lexicalBoundary)) return null
  const rel = relative(lexicalBoundary, lexicalPath)
  let cursor = lexicalBoundary
  for (const part of rel ? rel.split(sep) : []) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) return null
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) return null
  }
  const canonicalBoundary = realpathSync(lexicalBoundary)
  const canonicalPath = realpathSync(lexicalPath)
  if (!pathInside(canonicalBoundary, canonicalPath)) return null
  const stat = lstatSync(lexicalPath)
  if (stat.isSymbolicLink()) return null
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return null
  return canonicalPath
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
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
