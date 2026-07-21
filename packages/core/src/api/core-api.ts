/**
 * CoreApi (MIG-IPC-001)。
 * 进程内核心 API 门面，替代 aiohttp routes；Electron main 进程持有此单例，
 * renderer 后续通过 IPC 调用这些方法。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DRAFT_SESSION_PREFIX } from '../sessions/constants'
import { dirname, join, resolve } from 'node:path'
import { AttachmentStore } from '../attachments/store'
import type { ControlResume } from '../control/manager'
import {
  GOAL_MANUAL_EVIDENCE_DECLINE_LABEL,
  GOAL_MANUAL_EVIDENCE_FAIL_LABEL,
  GOAL_MANUAL_EVIDENCE_PASS_LABEL,
  GOAL_MANUAL_EVIDENCE_QUESTION_ID,
} from '../control/goal-manual-evidence'
import {
  GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
  GOAL_PERMISSION_BLOCKER_QUESTION_ID,
} from '../control/goal-blocker'
import { ExternalBridgeService } from '../external/service'
import { ExternalAuditStore } from '../external/audit'
import {
  loadExternalConfig,
  type LoadedExternalConfig,
} from '../external/config'
import { SignedWebhookAdapter } from '../external/signed-webhook'
import {
  AgentLoop,
  type AgentLoopCreateOptions,
  type LoopModelRouter,
} from '../agent/loop'
import type { RuntimePaths } from '../runtime/paths'
import type { EventEnvelopeV2 } from '../runtime/envelope'
import { LifecycleSupervisor } from '../runtime/lifecycle'
import { RuntimeEventStore } from '../runtime/store'
import {
  assertCoreMutationAllowed,
  CoreMutationGuardError,
} from './mutation-guard'
import {
  ChatService,
  InvalidSessionError,
  MainlineTurnService,
  type DraftSessionInput,
} from './chat-service'
import {
  CoreConfigService,
  type UserConfigPayload,
} from './services/config-service'
import { CoreDiagnosticsService } from './services/diagnostics-service'
import { CoreEffectiveConfigService } from './services/effective-config-service'
import { CoreDesktopPetService } from './services/desktop-pet-service'
import { CoreEnvironmentService } from './services/environment-service'
import { CoreFileCheckpointService } from './services/file-checkpoint-service'
import { CoreHooksService } from './services/hooks-service'
import { CoreMemoryService } from './services/memory-service'
import { CoreModelService } from './services/model-service'
import { CoreSkillService } from './services/skill-service'
import { CoreTeamService } from './services/team-service'
import { GoalService } from './services/goal-service'
import { goalSummary, type GoalRecord } from '../goals/models'
import { planToDict } from '../plans/models'
import { SidechainTranscript } from '../tasks/sidechain'
import { ToolResultStore } from '../context/tool-results'
import { WatchlistService } from '../watchlist/service'
import {
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerSchedule,
  schedulerJobPublicPayload,
} from '../scheduler/models'
import type { CoreOperationKey } from './operations'
import { missingSkillRequirementsFromStatus } from '../environment/probe'
import type { SkillRequirements } from '../skills/manager'

type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>
type Dict = Record<string, unknown>

export interface CoreApiCreateOptions extends AgentLoopCreateOptions {
  loop?: AgentLoop | null
  appVersion?: string
  runtimeRevision?: string
}

export interface RouteOperation {
  key: CoreOperationKey
  method: string
  route: string
}

export interface CoreRuntimeEventPayload {
  event: string
  [key: string]: unknown
}

export type CoreRuntimeReplayFormat = 'projection' | 'envelope_v2'

export interface CoreRuntimeReplayPayload<
  TFormat extends CoreRuntimeReplayFormat = 'projection',
> {
  sessionId: string
  afterSeq: number
  latestSeq: number
  format: TFormat
  events: Array<
    TFormat extends 'envelope_v2' ? EventEnvelopeV2 : CoreRuntimeEventPayload
  >
  [key: string]: unknown
}

const CORE_API_ROUTE_OPERATION_LIST = [
  op('chat.submit', 'IPC', 'chat.submit'),
  op('chat.listQueuedPrompts', 'IPC', 'chat.listQueuedPrompts'),
  op('chat.manageQueuedPrompt', 'IPC', 'chat.manageQueuedPrompt'),
  op('bootstrap', 'GET', '/api/bootstrap'),
  op('chat.stopRuntime', 'POST', '/api/runtime/stop'),
  op('config.effective', 'GET', '/api/config/effective'),
  op('config.get', 'GET', '/api/config'),
  op('config.save', 'POST', '/api/config'),
  op('attachments.save', 'POST', '/api/attachments'),
  op('attachments.rawPath', 'GET', '/api/attachments/{id}/raw'),
  op('mcp.getConfig', 'GET', '/api/mcp-config'),
  op('mcp.status', 'GET', '/api/mcp-status'),
  op('mcp.saveConfig', 'POST', '/api/mcp-config'),
  op('model.discoverModels', 'IPC', 'model.discoverModels'),
  op('model.getConfig', 'GET', '/api/model-config'),
  op('model.resolveProfile', 'IPC', 'model.resolveProfile'),
  op('model.saveEntry', 'POST', '/api/models'),
  op('model.savePolicy', 'PATCH', '/api/model-policy'),
  op('model.deleteEntry', 'DELETE', '/api/models/{entryId}'),
  op('model.activate', 'POST', '/api/models/{entryId}/activate'),
  op(
    'model.setReasoningEffort',
    'PATCH',
    '/api/models/{entryId}/reasoning-effort',
  ),
  op('model.test', 'POST', '/api/model-test'),
  op('onboarding.getProfileStatus', 'GET', '/api/onboarding/profile'),
  op(
    'onboarding.startProfileInterview',
    'POST',
    '/api/onboarding/profile/start',
  ),
  op('onboarding.skipProfileInterview', 'POST', '/api/onboarding/profile/skip'),
  op('control.get', 'GET', '/api/control'),
  op('control.setPermissionMode', 'IPC', 'control.setPermissionMode'),
  op('control.setMode', 'POST', '/api/control/mode'),
  op('control.answerInteraction', 'IPC', 'control.answerInteraction'),
  op('control.commentPlan', 'IPC', 'control.commentPlan'),
  op('control.approvePlan', 'IPC', 'control.approvePlan'),
  op(
    'control.cancelInteraction',
    'POST',
    '/api/control/interactions/{id}/cancel',
  ),
  op('goals.start', 'IPC', 'goals.start'),
  op('goals.list', 'IPC', 'goals.list'),
  op('goals.get', 'IPC', 'goals.get'),
  op('goals.pause', 'IPC', 'goals.pause'),
  op('goals.resume', 'IPC', 'goals.resume'),
  op('goals.replace', 'IPC', 'goals.replace'),
  op('goals.cancel', 'IPC', 'goals.cancel'),
  op('plans.list', 'GET', '/api/plans'),
  op('plans.get', 'GET', '/api/plans/{plan_id}'),
  op('scheduler.get', 'GET', '/api/scheduler'),
  op('scheduler.createJob', 'POST', '/api/scheduler/jobs'),
  op('scheduler.updateJob', 'PATCH', '/api/scheduler/jobs/{id}'),
  op('scheduler.runJob', 'POST', '/api/scheduler/jobs/{id}/run'),
  op('scheduler.pauseJob', 'POST', '/api/scheduler/jobs/{id}/pause'),
  op('scheduler.resumeJob', 'POST', '/api/scheduler/jobs/{id}/resume'),
  op('scheduler.deleteJob', 'DELETE', '/api/scheduler/jobs/{id}'),
  op('sessions.list', 'GET', '/api/sessions'),
  op('sessions.create', 'POST', '/api/sessions'),
  op('sessions.rename', 'PATCH', '/api/sessions/{id}'),
  op('sessions.delete', 'DELETE', '/api/sessions/{id}'),
  op('sessions.activate', 'POST', '/api/sessions/{id}/activate'),
  op('team.get', 'GET', '/api/team'),
  op('team.spawnMember', 'POST', '/api/team/members'),
  op('team.getMember', 'GET', '/api/team/members/{name}'),
  op('team.sendMessage', 'POST', '/api/team/messages'),
  op('team.wakeMember', 'POST', '/api/team/members/{name}/wake'),
  op('team.shutdownMember', 'POST', '/api/team/members/{name}/shutdown'),
  op('external.get', 'GET', '/api/external'),
  op('fileCheckpoints.list', 'IPC', 'fileCheckpoints.list'),
  op('fileCheckpoints.preview', 'IPC', 'fileCheckpoints.preview'),
  op('fileCheckpoints.rewind', 'IPC', 'fileCheckpoints.rewind'),
  op('fileCheckpoints.rewindGit', 'IPC', 'fileCheckpoints.rewindGit'),
  op('hooks.getConfig', 'GET', '/api/hooks'),
  op('hooks.saveConfig', 'POST', '/api/hooks'),
  op('hooks.getAudit', 'GET', '/api/hooks/audit'),
  op('hooks.getMetadata', 'GET', '/api/hooks/metadata'),
  op('hooks.validateConfig', 'POST', '/api/hooks/validate'),
  op('hooks.setProjectTrust', 'POST', '/api/hooks/project-trust'),
  op('hooks.testMatch', 'POST', '/api/hooks/test-match'),
  op('hooks.testRun', 'POST', '/api/hooks/test-run'),
  op('hooks.cancelRun', 'POST', '/api/hooks/cancel-run'),
  op('tasks.list', 'GET', '/api/tasks'),
  op('tasks.get', 'GET', '/api/tasks/{task_id}'),
  op('tasks.transcript', 'GET', '/api/tasks/{task_id}/transcript'),
  op('tasks.wait', 'IPC', 'tasks.wait'),
  op('tasks.readOutput', 'GET', '/api/tasks/{task_id}/output'),
  op('tasks.cancel', 'POST', '/api/tasks/{task_id}/cancel'),
  op('tasks.resume', 'POST', '/api/tasks/{task_id}/resume'),
  op('processes.list', 'GET', '/api/processes'),
  op('processes.cancel', 'POST', '/api/processes/{process_id}/cancel'),
  op('processes.reparent', 'POST', '/api/processes/{process_id}/reparent'),
  op('tools.readResult', 'GET', '/api/tools/results/{ref}'),
  op('memory.get', 'GET', '/api/memory'),
  op('memory.save', 'POST', '/api/memory'),
  op('memory.getEpisode', 'GET', '/api/memory/episode'),
  op('memory.saveEpisode', 'POST', '/api/memory/episode'),
  op('memory.listVersions', 'GET', '/api/memory/versions'),
  op('memory.getVersion', 'GET', '/api/memory/versions/{id}'),
  op('memory.restoreVersion', 'POST', '/api/memory/versions/{id}/restore'),
  op('memory.getWatchlist', 'GET', '/api/watchlist'),
  op('memory.saveWatchlist', 'POST', '/api/watchlist'),
  op('memory.checkWatchlist', 'POST', '/api/watchlist/check'),
  op('memory.tokens', 'GET', '/api/tokens'),
  op('memory.compact', 'POST', '/api/compact'),
  op('memory.explainContext', 'GET', '/api/memory/explain-context'),
  op('projects.list', 'GET', '/api/projects'),
  op('projects.resolve', 'POST', '/api/projects/resolve'),
  op('runtime.replay', 'GET', '/api/runtime/replay'),
  op('skills.tools', 'GET', '/api/tools'),
  op('skills.list', 'GET', '/api/skills'),
  op('skills.get', 'GET', '/api/skill'),
  op('skills.create', 'POST', '/api/skills/create'),
  op('skills.validate', 'POST', '/api/skills/validate'),
  op('skills.package', 'POST', '/api/skills/package'),
  op('skills.save', 'POST', '/api/skill'),
  op('skills.delete', 'DELETE', '/api/skill'),
  op('skills.previewInstall', 'POST', '/api/skills/install/preview'),
  op('skills.confirmInstall', 'POST', '/api/skills/install/confirm'),
  op('sidebar.get', 'GET', '/api/sidebar-state'),
  op('sidebar.patch', 'PATCH', '/api/sidebar-state'),
  op('diagnostics.get', 'GET', '/api/diagnostics'),
  op('desktopPet.get', 'GET', '/api/desktop-pet'),
  op('desktopPet.setEnabled', 'POST', '/api/desktop-pet'),
  op('environment.getStatus', 'GET', '/api/environment'),
  op('environment.createInstallPlan', 'POST', '/api/environment/plans'),
  op('environment.install', 'POST', '/api/environment/install'),
  op('environment.cancelInstall', 'POST', '/api/environment/cancel'),
  op('environment.getInstallLog', 'GET', '/api/environment/install-log'),
] as const

type MissingRouteOperation = Exclude<
  CoreOperationKey,
  (typeof CORE_API_ROUTE_OPERATION_LIST)[number]['key']
>
const _coreApiRouteCoverage: [MissingRouteOperation] extends [never]
  ? true
  : never = true

export const CORE_API_ROUTE_OPERATIONS: RouteOperation[] = [
  ...CORE_API_ROUTE_OPERATION_LIST,
].sort((a, b) => a.key.localeCompare(b.key))

export class CoreApi {
  readonly root: string
  readonly paths: RuntimePaths
  readonly loop: AgentLoop
  readonly attachmentStore: AttachmentStore
  readonly watchlist: WatchlistService
  readonly externalBridge: ExternalBridgeService
  readonly externalLifecycle: LifecycleSupervisor
  readonly mainline: MainlineTurnService
  readonly chatService: ChatService
  readonly configService: CoreConfigService
  readonly effectiveConfigService: CoreEffectiveConfigService
  readonly desktopPetService: CoreDesktopPetService
  readonly diagnosticsService: CoreDiagnosticsService
  readonly environmentService: CoreEnvironmentService
  readonly fileCheckpointService: CoreFileCheckpointService
  readonly hooksService: CoreHooksService
  readonly memoryService: CoreMemoryService
  readonly modelService: CoreModelService
  readonly skillService: CoreSkillService
  readonly teamService: CoreTeamService
  readonly goalService: GoalService

  private constructor(
    root: string,
    loop: AgentLoop,
    externalConfig: LoadedExternalConfig,
    opts: Pick<CoreApiCreateOptions, 'appVersion' | 'runtimeRevision'> = {},
  ) {
    this.root = resolve(root)
    this.loop = loop
    this.paths = loop.paths
    this.attachmentStore = new AttachmentStore(this.paths.stateRoot)
    this.watchlist = new WatchlistService(this.paths.stateRoot, {
      tokenTracker: this.loop.tokenTracker,
    })
    this.configService = new CoreConfigService(
      this.paths.stateRoot,
      {
        refreshRuntimeContext: () => {
          this.loop.refreshRuntimeContext()
        },
        reconcileProfileOnboarding: () => {
          this.loop.reconcileProfileOnboarding()
        },
        reloadMcp: () => this.loop.reloadMcp(),
      },
      { templatesDir: this.loop.templatesDir },
    )
    this.effectiveConfigService = new CoreEffectiveConfigService(
      this.paths.stateRoot,
      {
        skillManager: this.loop.skillManager,
        skillResolutions: () => this.loop.effectiveSkillConfigResolutions(),
        agentDefinitions: () => this.loop.subagentRegistry.snapshot(),
      },
    )
    this.desktopPetService = new CoreDesktopPetService(this.root, {
      stateRoot: this.paths.stateRoot,
      assertMutation: (area, action) => this.assertMutation(area, action),
    })
    this.modelService = new CoreModelService(this.paths.stateRoot, {
      router: () => this.loop.modelRouter,
      refreshModelConfig: () => this.loop.refreshModelConfig(),
      afterConfigSaved: () =>
        this.loop.startProfileInterview({ manual: false }),
    })
    this.hooksService = new CoreHooksService(this.paths.stateRoot, {
      service: this.loop.hookService,
      activeSessionId: () => this.loop.activeSessionId,
      activeWorkspaceRoot: () =>
        (this.loop.workspacePolicyDiagnostics().workspaceRoot as string) ||
        this.root,
      activeProjectRoot: () =>
        this.loop.activeSession?.mode === 'build'
          ? (this.loop.activeSession.project_path ?? null)
          : null,
      assertMutation: (area, action) => this.assertMutation(area, action),
    })
    this.memoryService = new CoreMemoryService(this.paths.stateRoot, {
      loop: this.loop,
      watchlist: this.watchlist,
      refreshRuntimeContext: () => {
        this.loop.refreshRuntimeContext()
      },
    })
    this.skillService = new CoreSkillService(this.paths.stateRoot, {
      runtimeRoot: this.paths.runtimeRoot,
      manager: this.loop.skillManager,
      registry: this.loop.registry,
      refreshRuntimeContext: () => {
        this.loop.refreshRuntimeContext()
      },
      resolveMissing: async (requirements: SkillRequirements) => {
        const skillName = 'install-candidate'
        const projectRoot =
          this.loop.activeSession?.mode === 'build'
            ? (this.loop.activeSession.project_path ?? this.root)
            : this.root
        const status = await this.loop.environmentProbe.getStatus({
          projectRoot,
          forceRefresh: true,
          skillRequirements: [
            { skillName, skillStatus: 'active', requirements },
          ],
        })
        return missingSkillRequirementsFromStatus(
          status,
          skillName,
          requirements,
        )
      },
    })
    this.environmentService = new CoreEnvironmentService({
      stateRoot: this.paths.stateRoot,
      catalog: this.loop.environmentCatalog,
      probe: this.loop.environmentProbe,
      skillManager: this.loop.skillManager,
      projectRoot: () =>
        this.loop.activeSession?.mode === 'build'
          ? (this.loop.activeSession.project_path ?? this.root)
          : this.root,
      appVersion: opts.appVersion ?? '0.0.0-dev',
      runtimeRevision:
        opts.runtimeRevision ?? this.loop.environmentCatalog.revision,
      emitRuntime: async (event) => {
        await this.emitRuntime(event, {
          sessionId: this.loop.activeSessionId,
        })
      },
      reconcileBlockedSkills: async () =>
        await this.skillService.reconcileBlocked(),
    })
    this.teamService = new CoreTeamService({
      teamManager: () => this.loop.teamManagerForActiveSession(),
      activeSession: () => this.loop.activeSession,
      assertMutation: (area, action) => this.assertMutation(area, action),
    })
    this.fileCheckpointService = new CoreFileCheckpointService({
      checkpoints: this.loop.fileCheckpoints,
      softGitRewind: this.loop.softGitRewind,
      applicationRoot: this.root,
      activeSessionId: () => this.loop.activeSessionId,
      requireReadableSession: (sessionId, operation) =>
        this.requireReadableSession(sessionId, operation) as never,
      assertMutation: (area, action) => this.assertMutation(area, action),
    })
    this.mainline = new MainlineTurnService(this.loop)
    this.chatService = new ChatService(this.mainline)
    this.goalService = new GoalService({
      goalStore: this.loop.goalStore,
      coordinator: this.loop.goalCoordinator,
      activeTasks: this.loop.activeTasks,
      materializeSession: async (input) =>
        (
          await this.mainline.materializeSession(
            { ...input, emit: null },
            'goals.start',
          )
        ).session,
      requireReadableSession: (sessionId, operation) =>
        this.requireReadableSession(sessionId, operation) as never,
      scopeForSession: (session) =>
        this.loop.goalScopeForSession(session as never),
      activeSessionId: () => this.loop.activeSessionId,
      summarize: async (goal) => await this.goalSummary(goal),
      clearPendingInteraction: (goal) => {
        if (goal.runtime.pendingInteractionId)
          this.loop.controlManager.clearPendingInteractionForGoal(
            goal.runtime.pendingInteractionId,
          )
        this.loop.controlManager.clearPendingInteractionForGoal(goal.id)
      },
    })
    this.loop.setSchedulerAgentTurnSubmitter((payload) =>
      this.mainline.submitSchedulerTurn(payload),
    )
    this.externalBridge = new ExternalBridgeService({
      root: this.paths.stateRoot,
      canAcceptTurn: () =>
        !this.loop.activeTasks.hasActiveKind('goal') &&
        !this.loop.activeTasks.hasActiveForSession(this.loop.activeSessionId) &&
        !this.loop.controlManager.payload().pending,
      targetSessionId: () => this.loop.activeSessionId,
      eventSink: async (event) => {
        await this.emitRuntime(event, {
          sessionId: runtimeEventSessionId(event) || this.loop.activeSessionId,
        })
      },
      submitTurn: async (payload, context) => {
        const turnId = String(
          payload.client_message_id ?? payload.clientMessageId ?? '',
        )
        const result = await this.mainline.submit({
          content: String(payload.content ?? ''),
          turnId: turnId || null,
          displayContent: String(
            payload.display_content ??
              payload.displayContent ??
              payload.content ??
              '',
          ),
          source: 'external',
          sessionId:
            String(payload.session_id ?? payload.sessionId ?? '').trim() ||
            null,
          memoryExtra: isRecord(payload.memory_extra)
            ? payload.memory_extra
            : isRecord(payload.memoryExtra)
              ? payload.memoryExtra
              : null,
          signal: context?.signal ?? null,
        })
        return { turnId: result.turnId, content: result.content }
      },
    })
    const signedWebhookConfig = externalConfig.config.signedWebhook
    const externalAudit = new ExternalAuditStore(this.paths.stateRoot)
    this.externalBridge.registerAdapter(
      new SignedWebhookAdapter({
        config: signedWebhookConfig,
        secret: signedWebhookConfig.secretEnv
          ? (process.env[signedWebhookConfig.secretEnv] ?? '')
          : '',
        auditStore: externalAudit,
        configDiagnostics: {
          path: externalConfig.diagnostics.path,
          status: externalConfig.diagnostics.status,
        },
        preflight: () => {
          if (signedWebhookConfig.mode === 'off') return null
          const session = this.loop.sessionStore.get(
            signedWebhookConfig.sessionId,
          )
          return session && !session.archived_at ? null : 'session_unavailable'
        },
        ingest: async (message, context) =>
          await this.externalBridge.ingest(message, context),
      }),
    )
    this.externalLifecycle = new LifecycleSupervisor(
      [
        {
          id: 'external-bridge',
          required: false,
          dependsOn: [],
          reconcile: () => undefined,
          start: async () => await this.externalBridge.start(),
          ready: () => undefined,
          stop: async () => await this.externalBridge.stop(),
        },
      ],
      { startTimeoutMs: 30_000, stopTimeoutMs: 5_000 },
    )
    this.diagnosticsService = new CoreDiagnosticsService(this.root, {
      runtimePaths: this.paths,
      legacyStateMigration: this.loop.legacyStateMigration,
      activeProjectLegacyPrivateData: () => {
        const projectPath = this.loop.activeSession?.project_path
        if (!projectPath) return null
        const detected =
          this.loop.projectStore.detectLegacyPrivateData(projectPath)
        return { projectPath, ...detected }
      },
      schedulerDiagnostics: () => this.loop.schedulerStore.diagnostics(),
      runtimeStats: () =>
        this.loop.runtimeStore.stats({
          activeTurnIds: this.loop.activeMemoryStore.loadUnarchivedTurnIds(),
        }),
      workspacePolicy: () => this.loop.workspacePolicyDiagnostics() as Dict,
      sandboxCapability: () => ({ ...this.loop.processSandbox.capability() }),
      processRuntime: () => this.loop.processRuntime.capabilityReport(),
      lifecycle: () => this.loop.lifecycleSupervisor.snapshot(),
      subagents: () => this.loop.subagentSupervisor.snapshot(),
      agentDefinitions: () => this.loop.subagentRegistry.snapshot(),
      effectiveConfig: () => this.effectiveConfigService.payload(),
      hybridMemory: () => this.loop.hybridMemory.diagnostics(),
      codeIntelligence: () => this.loop.codeIntelligence.diagnostics(),
      mcp: () => this.loop.mcpClient.snapshot(),
      externalPayload: () => this.externalPayload(),
      activeTasks: () => this.loop.activeTasks.list(),
      sessionRuntimes: () => this.loop.sessionRuntimes.snapshot(),
      desktopPetPayload: () => this.desktopPet.get(),
      environmentSummary: () => this.environmentService.diagnosticsSummary(),
    })
  }

  static async create(opts: CoreApiCreateOptions): Promise<CoreApi> {
    const root = resolve(opts.root)
    const loop = opts.loop ?? (await AgentLoop.create(opts))
    let api: CoreApi | null = null
    try {
      const externalConfig = await loadExternalConfig(loop.paths.stateRoot)
      api = new CoreApi(root, loop, externalConfig, opts)
      await api.environmentService.initialize()
      await api.externalLifecycle.start()
      return api
    } catch (error) {
      if (api) await api.close().catch(() => {})
      else await loop.close().catch(() => {})
      throw error
    }
  }

  async close(): Promise<void> {
    await this.externalLifecycle.stop('shutdown')
    await this.loop.close()
  }

  async bootstrap(opts: { sessionId?: string | null } = {}) {
    const sessionId = String(opts.sessionId ?? '').trim()
    if (sessionId) this.activateBootstrapSession(sessionId)
    this.loop.reconcileSessionControlPending()
    const sessionDiagnostics = this.loop.sessionStore.diagnostics()
    const route = this.loop.modelRouter.route('main_agent')
    const activeTurnIds = this.loop.activeMemoryStore.loadUnarchivedTurnIds()
    const runtimeReplay = this.runtime.replay({
      sessionId: this.loop.activeSessionId,
      afterSeq: 0,
      limit: 5000,
    })
    const goals = await this.goalService.bootstrap(this.loop.activeSessionId)
    return {
      app: 'Emperor Agent',
      sessionIndexSource: sessionDiagnostics.sessionIndexSource,
      repairedSessions: sessionDiagnostics.repairedSessions,
      model: route.snapshot.model,
      provider: route.snapshot.providerName,
      providerLabel: route.snapshot.providerLabel,
      tools: this.skills.tools(),
      skills: this.skills.list(),
      memory: this.memory.get(),
      modelConfig: await this.model.getConfig(),
      profileOnboarding: this.onboarding.getProfileStatus(),
      team: this.team.get(),
      scheduler: this.scheduler.get(),
      control: this.control.get(),
      goals,
      hooks: await this.hooks.getConfig(),
      desktopPet: await this.desktopPet.get(),
      context_used: this.loop.tokenTracker.lastInputTokensValue(),
      unarchivedHistory: this.memoryService.historyPayload(),
      runtime: {
        events: runtimeReplay.events,
        latestSeq: runtimeReplay.latestSeq,
        busy: this.loop.activeTasks.hasActiveForSession(
          this.loop.activeSessionId,
        ),
        active_tasks: this.loop.activeTasks.list(),
        stats: this.loop.runtimeStore.stats({ activeTurnIds }),
      },
      mcp: this.mcp.status(),
      projects: this.projects.list(),
      diagnostics: await this.diagnostics.get(),
    }
  }

  readonly chat = {
    submit: async (opts: {
      content: string
      turnId?: string | null
      emit?: StreamEmitter | null
      displayContent?: string | null
      clientMessageId?: string | null
      sessionId?: string | null
      uiHidden?: boolean | null
      delivery?: 'queue' | 'interject' | null
      clientDraftId?: string | null
      draftSession?: DraftSessionInput | null
      attachments?: string[] | null
      requestedSkills?: Array<{ name: string; source?: string }> | null
      /** In-process adapters only; IPC validation never accepts AbortSignal objects. */
      signal?: AbortSignal | null
      /** Trusted in-process adapter provenance. Browser IPC remains `chat`. */
      source?: string | null
    }) => {
      const result = await this.chatService.submit({
        content: String(opts.content ?? ''),
        turnId: opts.turnId ?? null,
        emit: opts.emit ?? null,
        displayContent: opts.displayContent ?? null,
        clientMessageId: opts.clientMessageId ?? null,
        sessionId: opts.sessionId ?? null,
        uiHidden: opts.uiHidden ?? false,
        delivery: opts.delivery ?? 'queue',
        clientDraftId: opts.clientDraftId ?? null,
        draftSession: opts.draftSession ?? null,
        attachmentIds: opts.attachments ?? null,
        requestedSkills: opts.requestedSkills ?? null,
        signal: opts.signal ?? null,
        source: opts.source ?? 'chat',
      })
      return result
    },
    listQueuedPrompts: (opts: { sessionId: string }) =>
      this.chatService.listQueuedPrompts(opts),
    manageQueuedPrompt: (opts: {
      sessionId: string
      promptId: string
      action: 'cancel' | 'interject'
    }) => this.chatService.manageQueuedPrompt(opts),
    stopRuntime: async (
      opts: {
        taskId?: string | null
        kind?: 'turn' | 'scheduler' | 'team' | 'watchlist' | 'goal' | null
      } = {},
    ) => {
      const goalTasks = this.loop.activeTasks
        .list()
        .filter(
          (task) =>
            task.kind === 'goal' &&
            (!opts.taskId || task.id === opts.taskId) &&
            (!opts.kind || opts.kind === 'goal'),
        )
      for (const task of goalTasks) {
        await this.goalService.pause(
          task.id.replace(/^goal:/, ''),
          task.session_id,
          'user_stop',
        )
      }
      const cancelled = this.loop.activeTasks.cancel({
        taskId: opts.taskId ?? null,
        kind: opts.kind ?? null,
      })
      return { cancelled, active: this.loop.activeTasks.list() }
    },
  }

  readonly runtime = {
    replay: <TFormat extends CoreRuntimeReplayFormat = 'projection'>(
      opts: {
        sessionId?: string | null
        afterSeq?: number | string | null
        after_seq?: number | string | null
        limit?: number | string | null
        includeArchive?: boolean | string | null
        include_archive?: boolean | string | null
        compact?: boolean | string | null
        format?: TFormat | null
      } = {},
    ): CoreRuntimeReplayPayload<TFormat> => {
      const sessionId = this.requireReadableSessionId(
        opts.sessionId ?? this.loop.activeSessionId ?? null,
        'runtime.replay',
      )
      const afterSeq = normalizedNonNegativeNumber(
        opts.afterSeq ?? opts.after_seq ?? 0,
      )
      const limit = normalizedPositiveNumber(opts.limit ?? null)
      const includeArchive = normalizedBoolean(
        opts.includeArchive ?? opts.include_archive ?? false,
      )
      // P1-5：回放默认读取侧压缩（磁盘不变）；传 compact:false 取原始流
      const compact =
        opts.compact === undefined ? true : normalizedBoolean(opts.compact)
      const format = opts.format ?? 'projection'
      const store = new RuntimeEventStore(
        this.loop.sessionStore.sessionDir(sessionId),
        { sessionDirOverride: true },
      )
      return {
        sessionId,
        afterSeq,
        latestSeq: store.latestSeq,
        format,
        events:
          format === 'envelope_v2'
            ? store.replayEnvelopesAfter(afterSeq, {
                sessionId,
                limit,
                includeArchive,
              })
            : store
                .replayAfter(afterSeq, {
                  sessionId,
                  limit,
                  includeArchive,
                  compact,
                })
                .map((event) => ({
                  ...event,
                  event: String(event.event ?? ''),
                })),
      } as CoreRuntimeReplayPayload<TFormat>
    },
  }

  readonly fileCheckpoints = {
    list: (input: { sessionId?: string | null } = {}) =>
      this.fileCheckpointService.list(input),
    preview: (input: { sessionId: string; checkpointId: string }) =>
      this.fileCheckpointService.preview(input),
    rewind: (input: {
      sessionId: string
      checkpointId: string
      confirmed: boolean
    }) => this.fileCheckpointService.rewind(input),
    rewindGit: (input: {
      sessionId: string
      checkpointId: string
      confirmed: boolean
      confirmedGitRisk: boolean
      previewRevision: string
      dirtyStrategy: 'abort' | 'stash'
    }) => this.fileCheckpointService.rewindGit(input),
  }

  readonly config = {
    effective: () => this.effectiveConfigService.payload(),
    get: (): UserConfigPayload => this.configService.getUserConfig(),
    save: (
      body: { content?: unknown } | string = {},
    ): Promise<UserConfigPayload> => {
      this.assertMutation('config', 'save')
      const content =
        typeof body === 'string' ? body : String(body.content ?? '')
      return (async () => {
        await this.hooksService.authorizeConfigChange('config.save', {
          content,
        })
        return this.configService.saveUserConfig(content)
      })()
    },
  }

  readonly attachments = {
    save: (opts: { raw: Buffer | Uint8Array; name: string; mime: string }) =>
      this.attachmentStore.save(opts),
    rawPath: (attachmentId: string) => {
      const ref = this.attachmentStore.get(attachmentId)
      return ref
        ? { path: join(this.attachmentStore.root, ref.rel_path), ref }
        : null
    },
  }

  readonly mcp = {
    getConfig: () => this.configService.getMcpConfig(),
    status: () => this.loop.mcpClient.snapshot(),
    saveConfig: async (raw: Dict) => {
      // mcp.saveConfig 落盘后会经 MCPClient 以 servers.*.command 起子进程（stdio transport）；
      // 未经审批就能被 renderer 一条 IPC 写任意 command/args 是一条进程执行 pivot（审计 P0-5）。
      this.assertMutation('mcp', 'saveConfig')
      await this.hooksService.authorizeConfigChange('mcp.saveConfig', raw)
      return this.configService.saveMcpConfig(raw)
    },
  }

  readonly hooks = {
    getConfig: async (opts: Dict = {}) => this.hooksService.getConfig(opts),
    saveConfig: async (raw: unknown) => this.hooksService.saveConfig(raw),
    getAudit: async (
      opts: {
        cursor?: string | number | null
        limit?: number | string | null
        eventName?: string | null
        outcome?: string | null
        sourceId?: string | null
        runId?: string | null
      } = {},
    ) => this.hooksService.getAudit(opts),
    getMetadata: () => this.hooksService.getMetadata(),
    validateConfig: (input: Dict) => this.hooksService.validateConfig(input),
    setProjectTrust: async (input: Dict) =>
      this.hooksService.setProjectTrust(input),
    testMatch: async (input: Dict) => this.hooksService.testMatch(input),
    testRun: async (input: Dict): Promise<Dict> =>
      this.hooksService.testRun(input),
    cancelRun: async (input: Dict) => this.hooksService.cancelRun(input),
  }

  readonly model = {
    getConfig: async () => this.modelService.getConfig(),
    resolveProfile: (
      input: Parameters<CoreModelService['resolveProfile']>[0],
    ) => this.modelService.resolveProfile(input),
    saveEntry: async (entry: Parameters<CoreModelService['saveEntry']>[0]) => {
      this.assertMutation('model', 'saveEntry')
      await this.hooksService.authorizeConfigChange('model.saveEntry', entry)
      return this.modelService.saveEntry(entry)
    },
    savePolicy: async (
      policy: Parameters<CoreModelService['savePolicy']>[0],
    ) => {
      this.assertMutation('model', 'savePolicy')
      await this.hooksService.authorizeConfigChange('model.savePolicy', policy)
      return this.modelService.savePolicy(policy)
    },
    deleteEntry: async ({ entryId }: { entryId: string }) => {
      this.assertMutation('model', 'deleteEntry')
      await this.hooksService.authorizeConfigChange('model.deleteEntry', {
        entryId,
      })
      return this.modelService.deleteEntry(entryId)
    },
    activate: async ({ entryId }: { entryId: string }) => {
      this.assertMutation('model', 'activate')
      await this.hooksService.authorizeConfigChange('model.activate', {
        entryId,
      })
      return this.modelService.activate(entryId)
    },
    setReasoningEffort: async ({
      entryId,
      reasoningEffort,
    }: {
      entryId: string
      reasoningEffort: string | null
    }) => {
      this.assertMutation('model', 'setReasoningEffort')
      await this.hooksService.authorizeConfigChange(
        'model.setReasoningEffort',
        { entryId, reasoningEffort },
      )
      return this.modelService.setReasoningEffort(entryId, reasoningEffort)
    },
    discoverModels: async (body: Dict) =>
      this.modelService.discoverModels(body),
    test: async (body: Dict): Promise<Dict> => this.modelService.test(body),
  }

  readonly onboarding = {
    getProfileStatus: () => this.loop.profileOnboardingPayload(),
    startProfileInterview: () =>
      this.loop.startProfileInterview({ manual: true }),
    skipProfileInterview: async () => {
      const state = this.loop.profileOnboardingPayload()
      if (state.interactionId) {
        const pending = this.loop.controlManager.payload().pending
        if (pending?.id === state.interactionId)
          await this.control.cancelInteraction(state.interactionId)
      }
      return this.loop.skipProfileInterview()
    },
  }

  readonly control = {
    get: () => this.loop.controlManager.payload(),
    setPermissionMode: (mode: string) =>
      this.loop.controlManager.setPermissionMode(mode),
    setMode: (mode: string) => this.loop.controlManager.setMode(mode),
    answerInteraction: async (
      id: string,
      answers: Dict,
      opts: ControlResumeOptions = {},
    ): Promise<Dict> => {
      const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
      const isProfileOnboarding = this.loop.isProfileOnboardingInteraction(id)
      const pending = this.loop.controlManager.store.load().pending
      const resume = this.loop.controlManager.answer(id, answers)
      const answered = this.loop.controlManager.store.load().lastInteraction
      const manualRequest =
        pending?.id === id &&
        isRecord(pending.meta.goal_manual_evidence_request)
          ? pending.meta.goal_manual_evidence_request
          : null
      const permissionRequest =
        pending?.id === id &&
        isRecord(pending.meta.goal_permission_blocker_request)
          ? pending.meta.goal_permission_blocker_request
          : null

      if (manualRequest) {
        const goalId = String(manualRequest.goal_id ?? '').trim()
        const criterionId = String(manualRequest.criterion_id ?? '').trim()
        const choice = interactionAnswerChoice(
          answered,
          GOAL_MANUAL_EVIDENCE_QUESTION_ID,
        )
        const verdict =
          choice === GOAL_MANUAL_EVIDENCE_PASS_LABEL
            ? 'pass'
            : choice === GOAL_MANUAL_EVIDENCE_FAIL_LABEL
              ? 'fail'
              : null
        if (goalId && criterionId && verdict) {
          await this.loop.recordGoalManualVerification(goalId, {
            interactionId: id,
            criterionId,
            verdict,
          })
        } else if (goalId && choice === GOAL_MANUAL_EVIDENCE_DECLINE_LABEL) {
          await this.loop.goalCoordinator.pause(
            goalId,
            'manual_verification_declined',
          )
          return await this.resumeControl(
            { ...resume, resume: false },
            opts,
            ownerSessionId,
          )
        }
      }

      if (permissionRequest) {
        const goalId = String(permissionRequest.goal_id ?? '').trim()
        const choice = interactionAnswerChoice(
          answered,
          GOAL_PERMISSION_BLOCKER_QUESTION_ID,
        )
        if (goalId && choice === GOAL_PERMISSION_BLOCKER_DENIED_LABEL) {
          await this.loop.goalCoordinator.settleControl(goalId, id)
          await this.loop.blockGoalFromControlPermissionDenial(
            goalId,
            {
              code: 'missing_permission',
              reason: String(pending?.context ?? 'Required permission denied.'),
            },
            id,
          )
          return await this.resumeControl(
            { ...resume, resume: false },
            opts,
            ownerSessionId,
          )
        }
      }
      const result = await this.resumeControl(resume, opts, ownerSessionId)
      if (isProfileOnboarding) {
        return {
          ...result,
          profileOnboarding: this.loop.profileOnboardingPayload(),
        }
      }
      return result
    },
    commentPlan: (
      id: string,
      comment: string,
      opts: ControlResumeOptions = {},
    ): Promise<Dict> => {
      const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
      return this.resumeControl(
        this.loop.controlManager.comment(id, comment),
        opts,
        ownerSessionId,
      )
    },
    approvePlan: async (
      id: string,
      opts: ControlResumeOptions = {},
    ): Promise<Dict> => {
      const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
      const pending = this.loop.controlManager.payload().pending
      const pendingMeta =
        isRecord(pending) && isRecord(pending.meta) ? pending.meta : null
      const pendingPlanId = String(pendingMeta?.plan_id ?? '').trim()
      const pendingPlan = pendingPlanId
        ? this.loop.controlManager.planStore.get(pendingPlanId)
        : null
      if (pendingPlan?.goalId) {
        const approvalInput = {
          goalId: pendingPlan.goalId,
          planId: pendingPlan.id,
          interactionId: id,
          approvalGeneration: Number(
            pendingMeta?.approval_generation ?? Number.NaN,
          ),
        }
        await this.loop.goalPlanBridge.preflightApproval(approvalInput)
        await this.loop.goalPlanBridge.prepareApproval(approvalInput)
      }
      const resume = await (async () => {
        try {
          const approval = this.loop.controlManager.approve(id)
          const planPayload = isRecord(approval.event.plan)
            ? approval.event.plan
            : null
          const planId = String(planPayload?.id ?? '').trim()
          if (planId) {
            const plan = this.loop.controlManager.planStore.get(planId)
            if (plan?.goalId) {
              await this.loop.goalPlanBridge.bindApprovedPlan({
                goalId: plan.goalId,
                planId,
              })
              const rebound = this.loop.controlManager.planStore.get(planId)
              if (rebound) approval.event.plan = planToDict(rebound)
            }
          }
          return approval
        } catch (cause) {
          if (pendingPlan?.goalId)
            this.loop.goalPlanBridge.abortFailedApproval({
              goalId: pendingPlan.goalId,
              planId: pendingPlan.id,
            })
          throw cause
        }
      })()
      return this.resumeControl(resume, opts, ownerSessionId)
    },
    cancelInteraction: async (id: string): Promise<Dict> => {
      const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
      const result = this.loop.controlManager.cancel(id)
      const event = { ...result, control: this.loop.controlManager.payload() }
      await this.emitRuntime(event, { sessionId: ownerSessionId })
      await this.loop.deferProfileInterview(id)
      return event
    },
  }

  readonly plans = {
    list: (): Dict[] =>
      this.loop.controlManager.planStore.list().map(planToDict),
    get: (planId: string): Dict | null => {
      const plan = this.loop.controlManager.planStore.get(planId)
      return plan ? planToDict(plan) : null
    },
  }

  readonly goals = {
    start: (input: Parameters<GoalService['start']>[0]) =>
      this.goalService.start(input),
    list: (input: { sessionId?: string | null } = {}) =>
      this.goalService.list(input),
    get: (goalId: string) => this.goalService.get(goalId),
    pause: (goalId: string) => this.goalService.pause(goalId),
    resume: (goalId: string) => this.goalService.resume(goalId),
    replace: (input: Parameters<GoalService['replace']>[0]) =>
      this.goalService.replace(input),
    cancel: (goalId: string, reason?: string | null) =>
      this.goalService.cancel(goalId, reason),
  }

  readonly scheduler = {
    get: () => ({
      status: this.loop.schedulerService.status(),
      jobs: this.loop.schedulerService
        .listJobs({ includeDisabled: true })
        .map(schedulerJobPublicPayload),
      diagnostics: this.loop.schedulerStore.diagnostics(),
    }),
    createJob: (args: Dict) => {
      this.assertMutation('scheduler', 'create')
      const schedule = SchedulerSchedule.fromDict(
        requiredRecord(args.schedule, 'schedule'),
      )
      const payload = schedulerPayloadFromApi(
        requiredRecord(args.payload, 'payload'),
      )
      const job = this.loop.schedulerService.addJob({
        name: String(args.name ?? '').trim() || 'Scheduled job',
        schedule,
        payload,
        deleteAfterRun: Boolean(
          args.deleteAfterRun ?? args.delete_after_run ?? false,
        ),
        misfirePolicy: schedulerMisfirePolicyFromApi(args.misfirePolicy),
      })
      return {
        job: schedulerJobPublicPayload(job),
        scheduler: this.scheduler.get(),
      }
    },
    updateJob: (jobId: string, args: Dict) => {
      this.assertMutation('scheduler', 'update')
      const current = this.loop.schedulerService.getJob(jobId)
      if (!current) throw new Error(`scheduler job not found: ${jobId}`)
      if (current.protected)
        throw new Error(`scheduler job is protected: ${jobId}`)
      const result = this.loop.schedulerService.updateJob(jobId, {
        name:
          args.name === undefined || args.name === null
            ? undefined
            : String(args.name),
        schedule: isRecord(args.schedule)
          ? SchedulerSchedule.fromDict(args.schedule)
          : undefined,
        payload: isRecord(args.payload)
          ? schedulerPayloadFromApi(args.payload, current.payload)
          : undefined,
        deleteAfterRun:
          args.deleteAfterRun === undefined &&
          args.delete_after_run === undefined
            ? undefined
            : Boolean(args.deleteAfterRun ?? args.delete_after_run),
        misfirePolicy:
          args.misfirePolicy === undefined
            ? undefined
            : schedulerMisfirePolicyFromApi(args.misfirePolicy),
      })
      if (result === 'not_found')
        throw new Error(`scheduler job not found: ${jobId}`)
      if (result === 'protected')
        throw new Error(`scheduler job is protected: ${jobId}`)
      return {
        job: schedulerJobPublicPayload(result),
        scheduler: this.scheduler.get(),
      }
    },
    runJob: async (jobId: string) => {
      this.assertMutation('scheduler', 'run')
      const ran = await this.loop.schedulerService.runJob(jobId, {
        force: true,
      })
      if (!ran) throw new Error(`scheduler job not found: ${jobId}`)
      return { scheduler: this.scheduler.get() }
    },
    pauseJob: (jobId: string) => {
      this.assertMutation('scheduler', 'pause')
      const job = this.loop.schedulerService.enableJob(jobId, false)
      if (job === 'not_found')
        throw new Error(`scheduler job not found: ${jobId}`)
      return {
        job: schedulerJobPublicPayload(job),
        scheduler: this.scheduler.get(),
      }
    },
    resumeJob: (jobId: string) => {
      this.assertMutation('scheduler', 'resume')
      const job = this.loop.schedulerService.enableJob(jobId, true)
      if (job === 'not_found')
        throw new Error(`scheduler job not found: ${jobId}`)
      return {
        job: schedulerJobPublicPayload(job),
        scheduler: this.scheduler.get(),
      }
    },
    deleteJob: (jobId: string) => {
      this.assertMutation('scheduler', 'delete')
      const result = this.loop.schedulerService.removeJob(jobId)
      if (result === 'not_found')
        throw new Error(`scheduler job not found: ${jobId}`)
      if (result === 'protected')
        throw new Error(`scheduler job is protected: ${jobId}`)
      if (result === 'active')
        throw new Error(`scheduler job is active: ${jobId}`)
      return { deleted: jobId, scheduler: this.scheduler.get() }
    },
  }

  readonly sessions = {
    list: (opts: { includeArchived?: boolean } = {}) => {
      this.loop.reconcileSessionControlPending()
      return this.loop.sessionStore.list({
        includeArchived: opts.includeArchived ?? false,
      })
    },
    create: (
      opts: {
        title?: string
        mode?: string
        project?: Dict | null
        project_path?: string | null
      } = {},
    ) => {
      let project = opts.project ?? null
      const mode = opts.mode === 'build' ? 'build' : 'chat'
      if (mode === 'build' && !project) {
        const projectPath = String(opts.project_path || '').trim()
        if (!projectPath) throw new Error('Build session requires project_path')
        project = this.loop.projectStore.resolve(projectPath) as unknown as Dict
      }
      return this.loop.sessionStore.create(opts.title ?? 'Untitled', {
        mode,
        project,
      })
    },
    rename: async (
      sessionId: string,
      patch: string | { title?: string | null; archived?: boolean | null },
    ) => {
      if (typeof patch === 'object' && patch !== null && 'archived' in patch) {
        if (patch.archived)
          await this.goalService.pauseBySession(sessionId, 'session_archived')
        const entry = patch.archived
          ? this.loop.sessionStore.archive(sessionId)
          : this.loop.sessionStore.restore(sessionId)
        if (!entry) throw new Error('session not found')
        return entry
      }
      const title =
        typeof patch === 'string' ? patch : String(patch?.title ?? '').trim()
      if (!title) throw new Error('title is required')
      if (!this.loop.sessionStore.rename(sessionId, title))
        throw new Error('session not found')
      const entry = this.loop.sessionStore.get(sessionId)
      if (!entry) throw new Error('session not found')
      return entry
    },
    delete: async (sessionId: string): Promise<Dict> => {
      if (!this.loop.sessionStore.get(sessionId))
        throw new Error('cannot delete session')
      if (this.loop.sessionStore.list({ includeArchived: true }).length <= 1)
        throw new CoreMutationGuardError(
          409,
          'Cannot delete the last persisted session.',
        )
      const pausedGoal = await this.goalService.pauseBySession(
        sessionId,
        'session_delete_pending',
      )
      const activeGoal = pausedGoal
        ? this.loop.goalCoordinator.active(pausedGoal.id)
        : null
      if (activeGoal) await activeGoal.promise
      await this.loop.endSession(sessionId, 'deleted')
      if (!this.loop.sessionStore.delete(sessionId))
        throw new Error('cannot delete session')
      await this.goalService.cancelAndSettleBySession(
        sessionId,
        'session_deleted',
      )
      const removedGoals = await this.loop.goalStore.deleteBySession(sessionId)
      const removedTasks =
        this.loop.taskManager.store.deleteBySession(sessionId)
      const removedPlans =
        this.loop.controlManager.planStore.deleteBySession(sessionId)
      return { deleted: true, removedGoals, removedTasks, removedPlans }
    },
    activate: (sessionId: string) => {
      this.loop.activateSession(sessionId)
      return { active: sessionId, complete: true }
    },
  }

  private externalPayload(): Dict {
    return {
      ...this.externalBridge.payload(),
      lifecycle: this.externalLifecycle.snapshot(),
    }
  }

  readonly team = {
    get: () => this.teamService.get(),
    getMember: (name: string) => this.teamService.getMember(name),
    spawnMember: (opts: {
      name: string
      role: string
      task?: string | null
      agent_type?: string | null
    }) => this.teamService.spawnMember(opts),
    sendMessage: (opts: { to: string; content: string; wake?: boolean }) =>
      this.teamService.sendMessage(opts),
    wakeMember: (
      name: string,
      opts: { purpose?: string; recovery?: 'auto' | 'retry' } = {},
    ) => this.teamService.wakeMember(name, opts),
    shutdownMember: (name: string) => this.teamService.shutdownMember(name),
  }

  readonly external = {
    get: (): Dict => this.externalPayload(),
  }

  readonly processes = {
    list: (opts: { activeOnly?: boolean } = {}): Dict[] =>
      this.loop.processRuntime
        .list({
          activeOnly: opts.activeOnly,
          sessionId: this.loop.activeSessionId,
        })
        .map((receipt) => receipt as unknown as Dict),
    cancel: (
      processId: string,
      opts: { leaseId: string; reason?: string },
    ): Dict => {
      this.assertMutation('processes', 'cancel')
      this.assertProcessOwner(processId)
      return this.loop.processRuntime.cancel(
        processId,
        opts.leaseId,
        opts.reason,
      ) as unknown as Dict
    },
    reparent: (
      processId: string,
      opts: {
        leaseId: string
        ownerKind: 'session' | 'task' | 'terminal'
        ownerId: string
      },
    ): Dict => {
      this.assertMutation('processes', 'reparent')
      this.assertProcessOwner(processId)
      return this.loop.processRuntime.reparent(processId, opts.leaseId, {
        kind: opts.ownerKind,
        id: opts.ownerId,
        sessionId: this.loop.activeSessionId,
      }) as unknown as Dict
    },
  }

  readonly tasks = {
    list: (opts: { sessionId?: string | null } = {}): Dict[] => {
      const sessionId = String(opts.sessionId ?? '').trim()
      const records = this.loop.taskManager.store.list()
      const filtered = sessionId
        ? records.filter((task) => task.session_id === sessionId)
        : records
      return filtered.map((task) => task.toDict() as unknown as Dict)
    },
    get: (taskId: string): Dict | null =>
      (this.loop.taskManager.store.get(taskId)?.toDict() as unknown as Dict) ??
      null,
    transcript: (
      taskId: string,
      opts: { offset?: number; limit?: number } = {},
    ) => new SidechainTranscript(this.paths.stateRoot, taskId).read(opts),
    wait: async (
      taskId: string,
      opts: { timeoutMs?: number } = {},
    ): Promise<Dict | null> => {
      this.loop.subagentSupervisor.assertOwner(
        taskId,
        this.loop.activeSessionId,
      )
      const terminal = await this.loop.subagentSupervisor.wait(taskId, opts)
      if (!terminal) return null
      return {
        status: terminal.status,
        task: terminal.record.toDict(),
        ...(terminal.reason ? { reason: terminal.reason } : {}),
        ...(terminal.error ? { error: terminal.error } : {}),
      }
    },
    readOutput: async (taskId: string, opts: { cursor?: string } = {}) => {
      this.loop.subagentSupervisor.assertOwner(
        taskId,
        this.loop.activeSessionId,
      )
      const output = await this.loop.subagentSupervisor.readOutput(
        taskId,
        opts.cursor,
      )
      return {
        content: output.content,
        nextCursor: output.nextCursor,
        eof: output.eof,
        truncated: output.truncated,
        truncation: output.truncation,
      }
    },
    cancel: async (
      taskId: string,
      opts: { reason?: string } = {},
    ): Promise<Dict> => {
      this.assertMutation('tasks', 'cancel')
      this.loop.subagentSupervisor.assertOwner(
        taskId,
        this.loop.activeSessionId,
      )
      const task = await this.loop.subagentSupervisor.cancel(
        taskId,
        opts.reason,
      )
      return task.toDict() as unknown as Dict
    },
    resume: async (
      taskId: string,
      opts: {
        mode?: 'foreground' | 'background'
        ttlMs?: number
      } = {},
    ): Promise<Dict> => {
      this.assertMutation('tasks', 'resume')
      this.loop.subagentSupervisor.assertOwner(
        taskId,
        this.loop.activeSessionId,
      )
      const launched = await this.loop.subagentSupervisor.resume(taskId, opts)
      return {
        task: launched.task.toDict(),
        mode: launched.mode,
      }
    },
  }

  readonly tools = {
    readResult: (opts: { ref: string }) => {
      const content = new ToolResultStore(this.paths.stateRoot).readArtifact(
        String(opts?.ref ?? ''),
      )
      return { content }
    },
  }

  readonly memory = {
    get: () => this.memoryService.getMemory(),
    save: (content: string) => this.memoryService.saveMemory(content),
    getEpisode: (date?: string | null) =>
      this.memoryService.getEpisode(String(date ?? '')),
    saveEpisode: (content: string, date?: string | null) =>
      this.memoryService.saveEpisode(content, String(date ?? '')),
    listVersions: (opts: { limit?: number; target?: string | null } = {}) =>
      this.memoryService.listVersions(opts),
    getVersion: (versionId: string) => this.memoryService.getVersion(versionId),
    restoreVersion: (versionId: string) =>
      this.memoryService.restoreVersion(versionId),
    getWatchlist: () => this.memoryService.getWatchlist(),
    saveWatchlist: (content: string) =>
      this.memoryService.saveWatchlist(content),
    checkWatchlist: async () => this.memoryService.checkWatchlist(),
    tokens: () => this.memoryService.tokens(),
    compact: (opts: { force?: boolean } = {}) =>
      this.memoryService.compact(opts),
    explainContext: (
      opts: { sessionId?: string | null; turnId?: string | null } = {},
    ) => this.memoryService.explainContext(opts),
  }

  readonly projects = {
    list: () => this.loop.projectStore.list(),
    resolve: (path: string) => this.loop.projectStore.resolve(path),
  }

  readonly skills = {
    tools: () => this.skillService.tools(),
    list: () => this.skillService.list(),
    get: (name: string) => this.skillService.get(name),
    create: (input: Parameters<CoreSkillService['create']>[0]) => {
      this.assertMutation('skills', 'create')
      return this.skillService.create(input)
    },
    validate: (input: Parameters<CoreSkillService['validate']>[0]) =>
      this.skillService.validate(input),
    package: (input: Parameters<CoreSkillService['package']>[0]) => {
      this.assertMutation('skills', 'package')
      return this.skillService.package(input)
    },
    save: (name: string, content: string) => {
      this.assertMutation('skills', 'save')
      return this.skillService.save(name, content)
    },
    delete: (name: string) => {
      this.assertMutation('skills', 'delete')
      return this.skillService.delete(name)
    },
    previewInstall: (
      input: Parameters<CoreSkillService['previewInstall']>[0],
    ) => this.skillService.previewInstall(input),
    confirmInstall: (
      input: Parameters<CoreSkillService['confirmInstall']>[0],
    ) => {
      this.assertMutation('skills', 'confirm install')
      return this.skillService.confirmInstall(input)
    },
  }

  readonly environment = {
    getStatus: (
      input: Parameters<CoreEnvironmentService['getStatus']>[0] = {},
    ) => this.environmentService.getStatus(input),
    createInstallPlan: (
      input: Parameters<CoreEnvironmentService['createInstallPlan']>[0],
    ) => this.environmentService.createInstallPlan(input),
    install: (input: Parameters<CoreEnvironmentService['install']>[0]) => {
      this.assertMutation('environment', 'install')
      return this.environmentService.install(input)
    },
    cancelInstall: (
      input: Parameters<CoreEnvironmentService['cancelInstall']>[0],
    ) => {
      this.assertMutation('environment', 'cancel install')
      return this.environmentService.cancelInstall(input)
    },
    getInstallLog: (
      input: Parameters<CoreEnvironmentService['getInstallLog']>[0],
    ) => this.environmentService.getInstallLog(input),
  }

  readonly sidebar = {
    get: (): Dict =>
      normalizeSidebarState(
        readJson(
          join(this.paths.memoryRoot, 'sidebar_state.json'),
          readJson(join(this.root, 'memory', 'sidebar_state.json'), {}),
        ),
      ),
    patch: (patch: Dict): Dict => {
      const path = join(this.paths.memoryRoot, 'sidebar_state.json')
      const next = normalizeSidebarState({ ...readJson(path, {}), ...patch })
      atomicWriteText(path, JSON.stringify(next, null, 2) + '\n')
      return next
    },
  }

  readonly diagnostics = {
    get: async () => this.diagnosticsService.payload(),
  }

  readonly desktopPet = {
    get: async () => this.desktopPetService.get(),
    setEnabled: (enabled: boolean) =>
      this.desktopPetService.setEnabled(enabled),
  }

  private async goalSummary(goal: GoalRecord) {
    const evidence = await this.loop.goalEvidenceLedger.listEvidence(goal.id)
    return goalSummary(
      goal,
      Object.fromEntries(
        evidence.map((item) => [
          item.id,
          { verdict: item.verdict, summary: item.summary },
        ]),
      ),
    )
  }

  private assertMutation(area: string, action: string): void {
    assertCoreMutationAllowed(this.loop.controlManager.payload(), {
      area,
      action,
    })
  }

  private assertProcessOwner(processId: string): void {
    const receipt = this.loop.processRuntime.get(processId)
    if (!receipt || receipt.owner.sessionId !== this.loop.activeSessionId)
      throw new CoreMutationGuardError(
        403,
        `Process is not owned by the active session: ${processId}`,
      )
  }

  private async resumeControl(
    resume: ControlResume,
    opts: ControlResumeOptions,
    ownerSessionId: string | null,
  ): Promise<Dict> {
    const event: Dict | null = isRecord(resume.event)
      ? { ...resume.event, control: this.loop.controlManager.payload() }
      : null
    if (event)
      await this.emitRuntime(event, {
        emit: opts.emit ?? null,
        sessionId: ownerSessionId,
      })
    if (event?.event === 'plan_approved' && isRecord(event.plan)) {
      const planId = String(event.plan.id ?? '').trim()
      const steps = Array.isArray(event.plan.steps) ? event.plan.steps : []
      for (const step of steps) {
        if (!isRecord(step) || String(step.status ?? '') !== 'active') continue
        await this.emitRuntime(
          { event: 'plan_step_update', plan_id: planId, step: { ...step } },
          { emit: opts.emit ?? null, sessionId: ownerSessionId },
        )
      }
    }
    let result: Dict | null = null
    if (resume.resume === true) {
      const interactionId = String(resume.interaction.id ?? '')
      const explicitGoalId =
        this.loop.controlManager.goalIdForInteraction(interactionId)
      const sessionGoal = ownerSessionId
        ? await this.loop.goalStore.findActiveBySession(ownerSessionId)
        : null
      const goal = explicitGoalId
        ? await this.loop.goalStore.get(explicitGoalId)
        : sessionGoal
      if (
        goal?.runtime.phase === 'awaiting_user' &&
        goal.runtime.pendingInteractionId === interactionId
      ) {
        await this.loop.goalCoordinator.resumeAfterControl(
          goal.id,
          interactionId,
        )
        return {
          ...(resume as unknown as Dict),
          event: event ?? resume.event,
          result: null,
        }
      }
      const uiHidden = opts.uiHidden ?? false
      try {
        result = (await this.mainline.submit({
          content: String(resume.message ?? ''),
          displayContent: uiHidden
            ? ''
            : (opts.displayContent ?? String(resume.message ?? '')),
          clientMessageId: opts.clientMessageId ?? null,
          turnId: opts.turnId ?? null,
          source: 'control',
          sessionId: ownerSessionId,
          uiHidden,
          emit: opts.emit ?? null,
        })) as unknown as Dict
      } finally {
        await this.loop.settleProfileInterviewResume(resume.interaction.id)
      }
    }
    return {
      ...(resume as unknown as Dict),
      event: event ?? resume.event,
      result,
    }
  }

  private async emitRuntime(
    event: Dict,
    opts: { emit?: StreamEmitter | null; sessionId?: string | null } = {},
  ): Promise<Dict> {
    const targetSessionId = String(opts.sessionId ?? '').trim()
    const store =
      targetSessionId && targetSessionId !== this.loop.activeSessionId
        ? new RuntimeEventStore(
            this.loop.sessionStore.sessionDir(targetSessionId),
            { sessionDirOverride: true },
          )
        : this.loop.runtimeStore
    const payload = store.append(event, { sessionId: targetSessionId || null })
    const sink = opts.emit ?? this.loop.eventSink
    if (sink) await sink(payload)
    return payload
  }

  private activateBootstrapSession(sessionId: string): void {
    const session = this.requireReadableSession(sessionId, 'bootstrap')
    this.loop.activateSession(session.id)
  }

  private requireReadableSessionId(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    return this.requireReadableSession(
      String(sessionId ?? '').trim(),
      operation,
    ).id
  }

  private requireReadableSession(
    sessionId: string,
    operation: string,
  ): { id: string; archived_at?: string | null } {
    if (!sessionId) {
      throw new InvalidSessionError(
        `${operation} requires a real sessionId`,
        null,
      )
    }
    if (sessionId.startsWith(DRAFT_SESSION_PREFIX)) {
      throw new InvalidSessionError(
        `${operation} cannot read draft session ${sessionId}`,
        sessionId,
      )
    }
    const session = this.loop.sessionStore.get(sessionId)
    if (!session || session.archived_at) {
      throw new InvalidSessionError(
        `${operation} received unknown session ${sessionId}`,
        sessionId,
      )
    }
    return session
  }
}

interface ControlResumeOptions {
  clientMessageId?: string | null
  turnId?: string | null
  displayContent?: string | null
  uiHidden?: boolean | null
  emit?: StreamEmitter | null
}

function op<const Key extends CoreOperationKey>(
  key: Key,
  method: string,
  route: string,
): RouteOperation & { key: Key } {
  return { key, method, route }
}

function readJson(path: string, fallback: Dict): Dict {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Dict)
      : fallback
  } catch {
    return fallback
  }
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

const DEFAULT_SIDEBAR_STATE: Dict = {
  section_order: ['projects', 'chats'],
  project_sort: 'updated_at',
  chat_sort: 'updated_at',
  project_order: [],
  chat_order: [],
  project_session_order: {},
  collapsed_project_ids: [],
}

function normalizeSidebarState(value: unknown): Dict {
  const raw = isRecord(value) ? value : {}
  return {
    section_order: normalizeSidebarSectionOrder(raw.section_order),
    project_sort: normalizeSidebarSort(raw.project_sort),
    chat_sort: normalizeSidebarSort(raw.chat_sort),
    project_order: stringList(raw.project_order),
    chat_order: stringList(raw.chat_order),
    project_session_order: normalizeSidebarProjectSessionOrder(
      raw.project_session_order,
    ),
    collapsed_project_ids: stringList(raw.collapsed_project_ids),
  }
}

function normalizeSidebarSort(value: unknown): string {
  return value === 'manual' || value === 'created_at' || value === 'updated_at'
    ? value
    : String(DEFAULT_SIDEBAR_STATE.project_sort)
}

function normalizeSidebarSectionOrder(value: unknown): string[] {
  const allowed = new Set(['projects', 'chats'])
  const out = stringList(value).filter((item) => allowed.has(item))
  for (const item of DEFAULT_SIDEBAR_STATE.section_order as string[]) {
    if (!out.includes(item)) out.push(item)
  }
  return out.slice(0, 2)
}

function normalizeSidebarProjectSessionOrder(
  value: unknown,
): Record<string, string[]> {
  if (!isRecord(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(value)) out[key] = stringList(ids)
  return out
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item)).filter(Boolean)
}

function normalizedNonNegativeNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function normalizedPositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

function normalizedBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1
}

function runtimeEventSessionId(event: unknown): string {
  if (!isRecord(event)) return ''
  const direct = String(event.session_id ?? event.sessionId ?? '').trim()
  if (direct) return direct
  const owner = event.owner
  return isRecord(owner)
    ? String(owner.session_id ?? owner.sessionId ?? '').trim()
    : ''
}

function interactionAnswerChoice(
  interaction: unknown,
  questionId: string,
): string {
  if (!isRecord(interaction) || !isRecord(interaction.answers)) return ''
  const answer = interaction.answers[questionId]
  return isRecord(answer) ? String(answer.choice ?? '') : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredRecord(value: unknown, label: string): Dict {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function schedulerPayloadFromApi(
  raw: Dict,
  current?: SchedulerPayload,
): SchedulerPayload {
  const merged = current ? { ...current.toDict(), ...raw } : raw
  const kind = String(merged.kind ?? 'agent_turn')
  if (kind === 'system_event')
    throw new Error('system_event jobs are internal and cannot be configured')
  if (kind !== 'agent_turn' && kind !== 'team_wake')
    throw new Error('scheduler payload kind must be agent_turn or team_wake')
  const payload = SchedulerPayload.fromDict({ ...merged, kind })
  if (!payload.message.trim())
    throw new Error('message is required for scheduler jobs')
  if (kind === 'team_wake' && !payload.target)
    throw new Error('target is required for team_wake scheduler jobs')
  if (kind === 'team_wake' && !payload.project_id)
    throw new Error('projectId is required for team_wake scheduler jobs')
  return payload
}

function schedulerMisfirePolicyFromApi(value: unknown): SchedulerMisfirePolicy {
  if (value === undefined || value === null) return SchedulerMisfirePolicy.SKIP
  if (value === SchedulerMisfirePolicy.SKIP) return SchedulerMisfirePolicy.SKIP
  if (value === SchedulerMisfirePolicy.LATEST)
    return SchedulerMisfirePolicy.LATEST
  if (value === SchedulerMisfirePolicy.CATCH_UP_ONE)
    return SchedulerMisfirePolicy.CATCH_UP_ONE
  throw new Error(
    'scheduler misfirePolicy must be skip, latest, or catch-up-one',
  )
}

export type { LoopModelRouter }
