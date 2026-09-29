/**
 * CoreApi: the in-process core facade Electron main owns and the renderer
 * reaches through IPC. The agent kernel behind it is `HarnessHost`; CoreApi
 * adds the operation surface (sessions, config, workspace, git, terminals,
 * scheduler, plugins, environment, diagnostics) on top of it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DRAFT_SESSION_PREFIX } from '../sessions/constants'
import type { AttachmentStore } from '../attachments/store'
import type { RuntimePaths } from '../runtime/paths'
import { HarnessHost, type HarnessHostOptions } from '../harness/host/host'
import type { UiAnswers } from '../harness/host/interactions'
import { runGoalCommand } from '../harness/goal'
import type { Agent } from '../harness/agent/agent'
import type {
  SitePermission,
  SitePermissionKind,
} from '../harness/computer-use/site-permissions'
import type {
  BrowserProfileView,
  ComputerUseStatusView,
  DriverKind,
  UiActionClass,
  UiGrantView,
  UiTargetView,
} from '../harness/computer-use/types'
import type { JobSnapshot } from '../harness/jobs/registry'
import type { SubagentRecord } from '../harness/subagent/manager'
import {
  WorkflowRunFold,
  workflowTaskView,
  type WorkflowRunRecord,
} from '../harness/workflow/records'
import type { Session } from '../session-log/session'
import type { SessionEvent } from '../session-log/types'
import {
  sanitizeForWire,
  type SessionHistoryPage,
} from '../session-log/history'
import type {
  SessionLineage,
  SubagentChildView,
} from '../harness/host/session-views'
import { messageText } from '../llm/message'
import { collectSkillEnvironmentRequirements } from '../environment/probe'
import {
  assertCoreMutationAllowed,
  CoreMutationGuardError,
} from './mutation-guard'
import {
  ChatService,
  InvalidSessionError,
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
import { CoreHooksService } from './services/hooks-service'
import { CoreMemoryService } from './services/memory-service'
import { CoreModelService } from './services/model-service'
import { CoreSkillService } from './services/skill-service'
import { OnboardingService } from './services/onboarding-service'
import { PluginApplicationService } from '../plugins/service'
import { OperationRetiredError } from '../errors'
import { CoreSessionApplicationService } from './services/session-application-service'
import { CoreWorkspaceApplicationService } from './services/workspace-application-service'
import {
  CoreCommandApplicationService,
  type CommandPlanSwitchOutcome,
} from './services/command-application-service'
import { GoalService, type GoalStartInput } from './services/goal-service'
import type { WebFetchClient } from '../network/web-fetch-client'
import {
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerSchedule,
  schedulerJobPublicPayload,
} from '../scheduler/models'
import { NodeEnvironmentProcessRunner } from '../environment/process-runner'
import {
  WorkspaceFilesService,
  type WorkspaceFileListResult,
  type WorkspaceFileReadResult,
} from '../workspace/files'
import { WorkspaceGitService } from '../workspace/git'
import { GH_ENV_ALLOWLIST } from '../workspace/git-pull-requests'
import {
  createGhCommandRunner,
  PullRequestBrowserService,
  type GhRuntime,
} from '../workspace/pull-request-browser'
import { WorkspaceBindingStore } from '../workspace/git-worktrees'
import { GitOperationReceiptStore } from '../workspace/git-receipts'
import { WorkspaceMutationCoordinator } from '../workspace/mutation-coordinator'
import {
  TerminalService,
  type PtyHost,
  type TerminalEvent,
} from '../workspace/terminal'
import { WorkspaceOperationError } from '../workspace/common'
import { WorkspaceReferenceService } from '../workspace/references'
import type { WorkspaceSnapshot } from '../workspace/snapshot'
import { CommandPlatform } from '../commands/platform'
import { SessionTransitionService } from '../commands/session-transition'
import { startSkillFork } from '../harness/subagent/skill-fork'
import type {
  CommandCompletion,
  CommandInvocationResult,
  CommandInvocationSource,
} from '../commands/types'

type Dict = Record<string, unknown>

export interface CoreApiCreateOptions extends HarnessHostOptions {
  /** Test hook: use an existing host instead of creating one. */
  host?: HarnessHost | null
  appVersion?: string
  runtimeRevision?: string
  terminalHost?: PtyHost | null
  terminalEventSink?: ((event: TerminalEvent) => void) | null
  /** Host HTTP client used by plugin installs. */
  webFetchClient?: WebFetchClient | null
  /** Start the first-run profile interview after a model is configured. */
  enableFirstRunOnboarding?: boolean
}

export interface CoreRuntimeEventPayload {
  event: string
  [key: string]: unknown
}

export interface CoreRuntimeReplayPayload {
  sessionId: string
  afterSeq: number
  latestSeq: number
  format: 'projection'
  events: CoreRuntimeEventPayload[]
  [key: string]: unknown
}

/** A Task-panel row: a background job, a subagent session, or a workflow run. */
export interface CoreTaskRecord {
  id: string
  kind: 'job' | 'subagent' | 'workflow'
  job_kind?: string
  label: string
  description: string
  status: string
  session_id: string
  owner_id: string | null
  started_at: number
  finished_at: number | null
  exit_code?: number | null
  detail?: string | null
  depth?: number
  mode?: string
  last_stop_reason?: string | null
  /** Workflow runs: which tool started the run. */
  workflow_tool?: 'workflow' | 'ralph'
  /** Workflow runs: accepted `agent()` calls (Ralph: rounds started). */
  rounds?: number
  current_phase?: string | null
  call_id?: string | null
  agents?: Array<{
    seq: number
    label: string
    phase: string | null
    child_id: string
    outcome: string | null
  }>
  result?: string | null
}

export class CoreApi {
  readonly root: string
  readonly paths: RuntimePaths
  readonly host: HarnessHost
  readonly attachmentStore: AttachmentStore
  readonly chatService: ChatService
  readonly configService: CoreConfigService
  readonly effectiveConfigService: CoreEffectiveConfigService
  readonly desktopPetService: CoreDesktopPetService
  readonly diagnosticsService: CoreDiagnosticsService
  readonly environmentService: CoreEnvironmentService
  readonly hooksService: CoreHooksService
  readonly memoryService: CoreMemoryService
  readonly modelService: CoreModelService
  readonly skillService: CoreSkillService
  readonly pluginService: PluginApplicationService
  readonly goalService: GoalService
  readonly onboardingService: OnboardingService
  readonly workspaceFilesService: WorkspaceFilesService
  readonly workspaceGitService: WorkspaceGitService
  readonly pullRequestBrowser: PullRequestBrowserService
  readonly workspaceReferenceService: WorkspaceReferenceService
  readonly workspaceBindings: WorkspaceBindingStore
  readonly workspaceMutations = new WorkspaceMutationCoordinator()
  readonly gitReceipts: GitOperationReceiptStore
  readonly terminalService: TerminalService
  readonly sessionApplicationService: CoreSessionApplicationService
  readonly workspaceApplicationService: CoreWorkspaceApplicationService
  readonly commandApplicationService: CoreCommandApplicationService
  readonly sessionTransitionService: SessionTransitionService
  readonly commandPlatform: CommandPlatform

  private constructor(
    root: string,
    host: HarnessHost,
    opts: CoreApiCreateOptions,
  ) {
    this.root = resolve(root)
    this.host = host
    const kept = host.kept
    this.paths = kept.paths
    this.attachmentStore = host.attachments
    this.chatService = new ChatService(host)
    this.onboardingService = new OnboardingService({
      stateRoot: this.paths.stateRoot,
      templatesDir: kept.templatesDir,
      userFile: kept.sharedMemory.userFile,
      enabled: opts.enableFirstRunOnboarding === true,
      readUserProfile: () => kept.sharedMemory.readUser(),
      modelAvailable: () => host.llm.activeRoute() !== undefined,
      anyBusy: () => host.busySessions().length > 0,
      hasPending: (sessionId) => host.pending.hasPending(sessionId),
      pendingInteractionId: (sessionId) => {
        const pending = host.controlPayload(sessionId).pending
        return isRecord(pending) && typeof pending.id === 'string'
          ? pending.id
          : null
      },
      onPendingChange: (listener) => host.pending.onChange(listener),
      sessions: kept.sessionStore,
      submitHidden: async (sessionId, content) =>
        await host.submit({
          sessionId,
          content,
          displayContent: '',
          source: 'onboarding',
          uiHidden: true,
        }),
      cancelInteraction: (id) => host.cancelInteraction(id),
      emit: (event) => host.emitHost(event),
    })
    this.configService = new CoreConfigService(
      this.paths.stateRoot,
      {
        refreshRuntimeContext: () => {},
        reconcileProfileOnboarding: () => {
          this.onboardingService.reconcile()
        },
        reloadMcp: () => host.reloadMcp(),
      },
      { templatesDir: kept.templatesDir },
    )
    this.effectiveConfigService = new CoreEffectiveConfigService(
      this.paths.stateRoot,
      {
        skillManager: kept.skillManager,
        skillResolutions: () => kept.skillsLoader.configResolutions(),
      },
    )
    this.desktopPetService = new CoreDesktopPetService(this.root, {
      stateRoot: this.paths.stateRoot,
      assertMutation: (area, action) => this.assertMutation(area, action),
    })
    this.modelService = new CoreModelService(this.paths.stateRoot, {
      refreshModelConfig: () => host.refreshModelConfig(),
      afterConfigSaved: () => this.onboardingService.start({ manual: false }),
    })
    this.hooksService = new CoreHooksService({
      stateRoot: this.paths.stateRoot,
      hooks: host.hooks,
      activeProjectRoot: () => this.activeProjectRoot(),
      assertMutation: (area, action) => this.assertMutation(area, action),
      sessionEvents: () => {
        const sessionId = host.activeSessionId
        return sessionId === null
          ? []
          : (host.sessionLog(sessionId)?.events ?? [])
      },
    })
    this.memoryService = new CoreMemoryService({
      stateRoot: this.paths.stateRoot,
      sharedMemory: kept.sharedMemory,
      projectStore: kept.projectStore,
      tokenTracker: kept.tokenTracker,
      watchlist: host.watchlist,
      sessionStore: kept.sessionStore,
      activeSessionId: () => host.activeSessionId,
      sessionLog: (sessionId) => host.sessionLog(sessionId),
      compactNow: (sessionId) => host.compactNow(sessionId),
      measureContext: (sessionId) => host.measureContext(sessionId),
      refreshRuntimeContext: () => {},
      schedulerService: kept.schedulerService,
    })
    this.pluginService = new PluginApplicationService({
      emperorHome: this.paths.stateRoot,
      webFetchClient: opts.webFetchClient ?? null,
      activeWorkspaceRoot: () => this.activeProjectRoot(),
      onChanged: () => {
        kept.skillLoaders.setPluginSkillsRoots(
          this.pluginService.enabledSkillRoots(),
        )
        kept.skillChangeDetector.notify()
      },
    })
    kept.skillLoaders.setPluginSkillsRoots(
      this.pluginService.enabledSkillRoots(),
    )
    this.skillService = new CoreSkillService(this.paths.stateRoot, {
      runtimeRoot: this.paths.runtimeRoot,
      manager: kept.skillManager,
      installService: kept.skillInstallService,
      toolNames: () => {
        const servers = new Map(
          kept.mcpClient
            .getTools()
            .map((tool) => [tool.name, tool.mcpServerName] as const),
        )
        return host.tools.schemas().map((schema) => {
          const mcpServer = servers.get(schema.name)
          return mcpServer === undefined ? schema : { ...schema, mcpServer }
        })
      },
      library: kept.skillLibrary,
      // `undefined` = the active session; `null` = chat (no project Skills).
      projectRootFor: (sessionId) =>
        host.projectRootForSession(
          sessionId === undefined ? host.activeSessionId : sessionId,
        ),
      refreshRuntimeContext: () => {},
    })
    this.environmentService = new CoreEnvironmentService({
      stateRoot: this.paths.stateRoot,
      catalog: kept.environmentCatalog,
      probe: kept.environmentProbe,
      skillManager: kept.skillManager,
      projectRoot: () => this.activeProjectRoot() ?? this.root,
      appVersion: opts.appVersion ?? '0.0.0-dev',
      runtimeRevision: opts.runtimeRevision ?? kept.environmentCatalog.revision,
      emitRuntime: async (event) => {
        host.emitHost({ ...event, session_id: host.activeSessionId })
      },
      reconcileBlockedSkills: async () =>
        await this.skillService.reconcileBlocked(),
      managedEnvironment: kept.managedEnvironmentService,
    })
    this.workspaceBindings = new WorkspaceBindingStore(this.paths.stateRoot)
    this.gitReceipts = new GitOperationReceiptStore(this.paths.stateRoot)
    const resolveWorkspaceProject = (sessionId: string) => {
      const session = this.requireReadableSession(sessionId, 'workspace') as {
        id: string
        mode?: string | null
        project_path?: string | null
        project_name?: string | null
        title?: string | null
      }
      if (session.mode !== 'build' || !session.project_path)
        throw new WorkspaceOperationError(
          'workspace_project_required',
          '当前会话没有绑定 Build 项目。',
        )
      return {
        sessionId: session.id,
        projectRoot: this.workspaceBindings.resolve(
          session.id,
          resolve(session.project_path),
        ),
        projectName:
          String(session.project_name ?? session.title ?? '').trim() ||
          session.project_path.split(/[\\/]/).pop() ||
          '项目',
      }
    }
    const gitProcessRunner = new NodeEnvironmentProcessRunner()
    const runGh = createGhCommandRunner(new NodeEnvironmentProcessRunner())
    this.workspaceGitService = new WorkspaceGitService({
      resolveProject: resolveWorkspaceProject,
      resolveRuntime: async (projectRoot) => {
        const runtime = await this.resolveGitRuntime(projectRoot)
        if (!runtime)
          throw new WorkspaceOperationError(
            'git_unavailable',
            '当前签名执行环境中没有可用 Git。',
          )
        return runtime
      },
      run: async (request) => {
        const result = await gitProcessRunner.run({
          ...request,
          timeoutMs: 120_000,
          maxOutputBytes: 4 * 1024 * 1024,
          outputPolicy: 'truncate_tail',
          outputQuotaScope: 'per_stream',
        })
        return {
          exitCode: result.exitCode ?? (result.status === 'completed' ? 0 : 1),
          stdout: result.stdout,
          stderr: result.stderr || result.error || '',
          stdoutTruncated: result.stdoutTruncated === true,
          stderrTruncated: result.stderrTruncated === true,
        }
      },
      hasActiveWriter: (sessionId) => host.isBusy(sessionId),
      stateRoot: this.paths.stateRoot,
      bindings: this.workspaceBindings,
      receipts: this.gitReceipts,
      emitReceipt: async (sessionId, receipt) => {
        host.emitHost({
          event: 'git_operation_completed',
          session_id: sessionId,
          ...receipt,
        })
      },
      resolveGhRuntime: (projectRoot) => this.resolveGhRuntime(projectRoot),
      runGh,
    })
    this.pullRequestBrowser = new PullRequestBrowserService({
      cwd: this.paths.stateRoot,
      resolveRuntime: () => this.resolveGhRuntime(this.paths.stateRoot),
      run: runGh,
    })
    this.workspaceFilesService = new WorkspaceFilesService({
      resolveProject: resolveWorkspaceProject,
      filterIgnored: async (sessionId, _projectRoot, paths) =>
        await this.workspaceGitService.ignoredPaths({ sessionId, paths }),
    })
    this.workspaceReferenceService = new WorkspaceReferenceService({
      resolveProject: resolveWorkspaceProject,
    })
    this.terminalService = new TerminalService({
      host: opts.terminalHost ?? unavailablePtyHost(),
      resolveProject: resolveWorkspaceProject,
      shell: defaultSystemShell,
      env: terminalEnvironment,
      emit: opts.terminalEventSink ?? undefined,
    })
    this.goalService = new GoalService({
      goals: host.goals,
      agentFor: (sessionId) => host.agentFor(sessionId),
      goalView: (sessionId) => host.goalView(sessionId),
      activeSessionId: () => host.activeSessionId,
      materializeSession: async (input) =>
        (
          await this.chatService.materializeSession(
            {
              sessionId: input.sessionId,
              clientDraftId: input.clientDraftId ?? null,
              draftSession: (input.draftSession ??
                null) as DraftSessionInput | null,
            },
            'goals.start',
          )
        ).session,
    })
    this.sessionApplicationService = new CoreSessionApplicationService({
      sessions: kept.sessionStore,
      resolveProject: (projectPath) =>
        kept.projectStore.resolve(projectPath) as unknown as Dict,
      endSession: async (sessionId) => {
        host.deleteSession(sessionId)
      },
      stopSession: (sessionId) => {
        host.stop(sessionId)
      },
      closeTerminals: (sessionId) =>
        this.terminalService.closeSession(sessionId),
      activateSession: (sessionId) => host.activateSession(sessionId),
      deleteSessionLog: (sessionId) => host.sessions.delete(sessionId),
      sessionLeftList: (sessionId) => this.unpinSidebarSession(sessionId),
    })
    this.workspaceApplicationService = new CoreWorkspaceApplicationService({
      requireReadableSession: (sessionId, operation) =>
        this.requireReadableSession(sessionId, operation),
      workspaceGit: this.workspaceGitService,
      goalForSession: (sessionId) => host.goalView(sessionId),
      jobsForSession: (sessionId) => this.sessionJobs(sessionId),
      bindings: this.workspaceBindings,
      gitReceipts: this.gitReceipts,
      terminals: this.terminalService,
    })
    this.sessionTransitionService = new SessionTransitionService({
      stateRoot: this.paths.stateRoot,
      sessions: kept.sessionStore,
      assertBoundary: (sessionId) => this.assertClearBoundary(sessionId),
      runSessionEnd: async (sessionId) => {
        host.stop(sessionId)
      },
      activate: (sessionId) => host.activateSession(sessionId),
      inheritWorkspaceBinding: (sourceSessionId, targetSessionId) =>
        this.workspaceBindings.inherit(sourceSessionId, targetSessionId),
      permissionPresetOf: (sessionId) => {
        const session = host.sessionLog(sessionId)
        if (session === undefined) return null
        const preset = host.presets.current(session.events)
        return host.presets.names.includes(preset) ? preset : null
      },
      applyPermissionPreset: (sessionId, preset) => {
        host.setPermissionPreset(sessionId, preset)
      },
    })
    this.commandApplicationService = new CoreCommandApplicationService({
      models: this.modelService,
      sessionTransitions: this.sessionTransitionService,
      getSession: (sessionId) => kept.sessionStore.get(sessionId),
      skillsForSession: (sessionId) =>
        this.skillService.list({ sessionId }).skills,
      sessionBusy: (sessionId) =>
        host.isBusy(sessionId) || host.queuedPrompts(sessionId).length > 0,
      compact: (sessionId) => host.compactNow(sessionId),
      stop: (sessionId) => host.stop(sessionId),
      activateModel: async (entryId) => await this.model.activate({ entryId }),
      setReasoningEffort: async (entryId, reasoningEffort) =>
        await this.model.setReasoningEffort({ entryId, reasoningEffort }),
      setPermissionPreset: (sessionId, preset) =>
        host.setPermissionPreset(sessionId, preset),
      presets: () => host.presets.options(),
      controlPayload: (sessionId) => host.controlPayload(sessionId),
      setPlanMode: (sessionId, active) =>
        host.setPlanMode(sessionId, active) as CommandPlanSwitchOutcome,
      runGoalCommand: (sessionId, rawInput) =>
        runGoalCommand(host.goals, host.agentFor(sessionId), rawInput),
      submitPrompt: async (input) =>
        await this.chat.submit({ ...input, attachments: input.attachmentIds }),
      forkSkill: ({ sessionId, skillName, task, allowedTools, effort }) => {
        const parent = host.agentFor(sessionId)
        const skill = host.skillsLoaderFor(parent).resolve(skillName)
        if (skill === null || skill.status !== 'active')
          throw Object.assign(new Error(`Skill ${skillName} 不可用。`), {
            code: 'skill_unavailable',
          })
        const child = startSkillFork(host, parent, {
          skill,
          task,
          allowedTools,
          effort,
        })
        return { subagentId: child.id }
      },
    })
    this.commandPlatform = new CommandPlatform({
      stateRoot: this.paths.stateRoot,
      listSkills: (sessionId) =>
        this.commandApplicationService.skillsForSession(sessionId),
      sessionContext: async (sessionId) =>
        await this.commandApplicationService.sessionContext(sessionId),
      isBusy: (sessionId) =>
        this.commandApplicationService.sessionBusy(sessionId),
      executeBuiltin: async (context) =>
        await this.commandApplicationService.executeBuiltin(context),
      submitSkill: async (context) =>
        await this.commandApplicationService.submitSkill(context),
      queueAfterTurn: async ({ sessionId, requestId, run }) => {
        // After-turn commands wait for the session's agent to go idle.
        const agent = host.agentFor(sessionId)
        void agent
          .whenIdle()
          .then(run)
          .catch(() => undefined)
        return requestId
      },
      completeDynamic: async (descriptor, rawArgs, cursor, sessionId) =>
        await this.commandApplicationService.complete(
          descriptor.name,
          rawArgs,
          cursor,
          sessionId,
        ),
    })
    this.diagnosticsService = new CoreDiagnosticsService(this.root, {
      runtimePaths: this.paths,
      legacyStateMigration: kept.legacyStateMigration,
      activeProjectLegacyPrivateData: () => {
        const projectPath = host.activeSession()?.project_path
        if (!projectPath) return null
        return {
          projectPath,
          ...kept.projectStore.detectLegacyPrivateData(projectPath),
        }
      },
      schedulerDiagnostics: () => kept.schedulerStore.diagnostics(),
      runtimeStats: () => this.runtimeStats(host.activeSessionId),
      workspacePolicy: () => ({
        workspaceRoot: host.activeWorkspaceRoot(),
        sandbox: host.controlPayload(host.activeSessionId).sandbox,
      }),
      sandboxCapability: () => ({ ...kept.processSandbox.capability() }),
      processRuntime: () => kept.processRuntime.capabilityReport(),
      subagents: () => this.allSubagents(),
      kernel: () => ({
        activeSessionId: host.activeSessionId,
        busySessions: host.busySessions(),
        activeRoute: host.llm.activeRoute()?.id ?? null,
        tools: host.tools.schemas().map((tool) => tool.name),
        archivedLegacySessions: kept.archivedLegacySessions,
        lifecycle: this.lifecyclePayload(),
      }),
      effectiveConfig: () => this.effectiveConfigService.payload(),
      commandCatalog: () => {
        const sessionId = host.activeSessionId
        return sessionId
          ? this.commandPlatform.diagnostics(sessionId)
          : { status: 'ok', registeredSkills: 0, conflicts: [], warnings: [] }
      },
      mcp: () => kept.mcpClient.snapshot(),
      activeTasks: () => this.activeTaskInfos(),
      desktopPetPayload: () => this.desktopPet.get(),
      computerUse: async () =>
        computerUseDiagnostics(await this.computerUse.status()),
      environmentSummary: () => this.environmentService.diagnosticsSummary(),
      externalToolConfig: () => {
        const projectPath = host.activeSession()?.project_path
        const workspaceConfig = projectPath
          ? join(projectPath, 'config', 'mcporter.json')
          : null
        return {
          mcporter: {
            managedPath: join(
              this.paths.environmentDataRoot,
              'mcporter',
              'mcporter.json',
            ),
            workspacePath: workspaceConfig,
            workspacePathExists: Boolean(
              workspaceConfig && existsSync(workspaceConfig),
            ),
            workspacePathOwnedByEmperor: false,
            autoCleanupAllowed: false,
          },
        }
      },
    })
  }

  static async create(opts: CoreApiCreateOptions): Promise<CoreApi> {
    const root = resolve(opts.root)
    const host = opts.host ?? (await HarnessHost.create(opts))
    let api: CoreApi | null = null
    try {
      api = new CoreApi(root, host, opts)
      await api.environmentService.initialize()
      await api.sessionTransitionService.recover()
      return api
    } catch (error) {
      if (api) await api.close().catch(() => {})
      else await host.close().catch(() => {})
      throw error
    }
  }

  async close(): Promise<void> {
    this.terminalService.closeAll()
    this.onboardingService.dispose()
    await this.host.close()
  }

  async bootstrap(opts: { sessionId?: string | null } = {}) {
    const sessionId = String(opts.sessionId ?? '').trim()
    if (sessionId)
      this.host.activateSession(
        this.requireReadableSession(sessionId, 'bootstrap').id,
      )
    const kept = this.host.kept
    const activeSessionId = this.host.activeSessionId
    const sessionDiagnostics = kept.sessionStore.diagnostics()
    const route = this.host.llm.activeRoute()
    const replay =
      activeSessionId && kept.sessionStore.get(activeSessionId)
        ? this.runtime.replay({ sessionId: activeSessionId })
        : { events: [], latestSeq: 0 }
    return {
      app: 'Emperor Agent',
      sessionIndexSource: sessionDiagnostics.sessionIndexSource,
      repairedSessions: sessionDiagnostics.repairedSessions,
      model: route?.modelId ?? '',
      provider: route?.catalogProvider ?? '',
      providerLabel: route?.displayName ?? '',
      tools: this.skills.tools(),
      ...(() => {
        const catalog = this.skills.list({ sessionId: activeSessionId })
        return { skills: catalog.skills, invalidSkills: catalog.invalid }
      })(),
      plugins: this.plugins.list(),
      memory: this.memory.get(),
      modelConfig: await this.model.getConfig(),
      profileOnboarding: this.onboarding.getProfileStatus(),
      scheduler: this.scheduler.get(),
      control: this.control.get(),
      goals: await this.goalService.bootstrap(activeSessionId),
      hooks: await this.hooks.getConfig(),
      desktopPet: await this.desktopPet.get(),
      context_used: kept.tokenTracker.lastInputTokensValue(),
      unarchivedHistory: this.memoryService.historyPayload(),
      runtime: {
        events: replay.events,
        latestSeq: replay.latestSeq,
        busy: this.host.isBusy(activeSessionId),
        active_tasks: this.activeTaskInfos(),
        stats: this.runtimeStats(activeSessionId),
      },
      mcp: this.mcp.status(),
      projects: this.projects.list(),
      diagnostics: await this.diagnostics.get(),
    }
  }

  readonly chat = {
    submit: async (opts: {
      content: string
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
      /** In-process adapters only: this session's UI events during the submit. */
      emit?: ((event: Record<string, unknown>) => void | Promise<void>) | null
      /** Accepted for adapter compatibility; turn ids are assigned by the kernel. */
      turnId?: string | null
    }) =>
      await this.chatService.submit({
        content: String(opts.content ?? ''),
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
        emit: opts.emit ?? null,
      }),
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
        kind?: string | null
        sessionId?: string | null
      } = {},
    ) => {
      const taskId = String(opts.taskId ?? '').trim()
      let cancelled = 0
      if (taskId) {
        cancelled = this.cancelTask(taskId) ? 1 : 0
      } else {
        const sessionId =
          String(opts.sessionId ?? '').trim() || this.host.activeSessionId
        if (sessionId && this.host.stop(sessionId)) cancelled = 1
      }
      return { cancelled, active: this.activeTaskInfos() }
    },
  }

  readonly commands = {
    list: (input: {
      sessionId: string
      includeUnavailable?: boolean
      invocationSource?: CommandInvocationSource
    }) => this.commandPlatform.list(input),
    complete: (input: {
      sessionId: string
      commandId: string
      rawArgs: string
      cursor: number
      invocationSource: CommandInvocationSource
    }): Promise<CommandCompletion[]> => this.commandPlatform.complete(input),
    invoke: (input: {
      sessionId: string
      commandId: string
      rawInput: string
      invocationId: string
      invocationSource: CommandInvocationSource
      attachments?: string[]
    }): Promise<CommandInvocationResult> => this.commandPlatform.invoke(input),
  }

  readonly runtime = {
    replay: (
      opts: {
        sessionId?: string | null
        afterSeq?: number | string | null
        after_seq?: number | string | null
        limit?: number | string | null
        /** Accepted for compatibility; the session log has no archive or compaction split. */
        includeArchive?: boolean | string | null
        compact?: boolean | string | null
        format?: 'projection' | null
      } = {},
    ): CoreRuntimeReplayPayload => {
      const sessionId = this.requireReadableSessionId(
        opts.sessionId ?? this.host.activeSessionId ?? null,
        'runtime.replay',
      )
      const afterSeq = normalizedNonNegativeNumber(
        opts.afterSeq ?? opts.after_seq ?? 0,
      )
      const limit = normalizedPositiveNumber(opts.limit ?? null)
      const replay = this.host.replay(sessionId, afterSeq)
      const events =
        limit === null ? replay.events : replay.events.slice(-limit)
      return {
        sessionId,
        afterSeq,
        latestSeq: replay.latestSeq,
        format: 'projection',
        events: events as CoreRuntimeEventPayload[],
      }
    },
  }

  readonly config = {
    effective: () => this.effectiveConfigService.payload(),
    get: (): UserConfigPayload => this.configService.getUserConfig(),
    save: async (
      body: { content?: unknown } | string = {},
    ): Promise<UserConfigPayload> => {
      this.assertMutation('config', 'save')
      const content =
        typeof body === 'string' ? body : String(body.content ?? '')
      await this.hooksService.authorizeConfigChange('config.save', { content })
      return this.configService.saveUserConfig(content)
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
    status: () => this.host.kept.mcpClient.snapshot(),
    saveConfig: async (raw: Dict) => {
      // Saving MCP config lets MCPClient spawn servers.*.command; guard it like any mutation.
      this.assertMutation('mcp', 'saveConfig')
      await this.hooksService.authorizeConfigChange('mcp.saveConfig', raw)
      return this.configService.saveMcpConfig(raw)
    },
    /** Merge pasted servers (Claude/Cursor/VS Code/Emperor formats) by name; `dryRun` previews. */
    importServers: async (input: {
      raw: unknown
      overwrite?: boolean | string[]
      dryRun?: boolean
    }) => {
      if (input.dryRun !== true) {
        this.assertMutation('mcp', 'importServers')
        await this.hooksService.authorizeConfigChange(
          'mcp.importServers',
          input,
        )
      }
      const result = await this.configService.importMcpServers(input)
      return { ...result, status: this.host.kept.mcpClient.snapshot() }
    },
    setServerEnabled: async (input: { name: string; enabled: boolean }) => {
      this.assertMutation('mcp', 'setServerEnabled')
      await this.hooksService.authorizeConfigChange(
        'mcp.setServerEnabled',
        input,
      )
      const result = await this.configService.setMcpServerEnabled(input)
      return { ...result, status: this.host.kept.mcpClient.snapshot() }
    },
    removeServer: async (input: { name: string }) => {
      this.assertMutation('mcp', 'removeServer')
      await this.hooksService.authorizeConfigChange('mcp.removeServer', input)
      const result = await this.configService.removeMcpServer(input)
      return { ...result, status: this.host.kept.mcpClient.snapshot() }
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
    getProfileStatus: () => this.onboardingService.payload(),
    startProfileInterview: async () =>
      this.onboardingService.start({ manual: true }),
    skipProfileInterview: async () => this.onboardingService.skip(),
  }

  readonly control = {
    get: (sessionId?: string | null) =>
      this.host.controlPayload(this.controlSessionId(sessionId)),
    /** Switch the permission preset (`read-only` | `workspace-write` | `danger-full-access`). */
    setPermissionMode: (preset: string, sessionId?: string | null) =>
      this.host.setPermissionPreset(
        this.requireControlSession(sessionId, 'control.setPermissionMode'),
        preset,
      ),
    /** `plan` enters plan mode, anything else leaves it. */
    setMode: (mode: string, sessionId?: string | null) => {
      const id = this.requireControlSession(sessionId, 'control.setMode')
      const outcome = this.host.setPlanMode(id, mode === 'plan')
      return { outcome, control: this.host.controlPayload(id) }
    },
    answerInteraction: async (
      id: string,
      answers: Dict,
      _opts: Dict = {},
    ): Promise<Dict> =>
      this.settleInteraction(id, () =>
        this.host.answerInteraction(id, answers as UiAnswers),
      ),
    commentPlan: async (
      id: string,
      comment: string,
      _opts: Dict = {},
    ): Promise<Dict> =>
      this.settleInteraction(id, () => this.host.commentPlan(id, comment)),
    approvePlan: async (id: string, _opts: Dict = {}): Promise<Dict> =>
      this.settleInteraction(id, () => this.host.approvePlan(id)),
    cancelInteraction: async (id: string): Promise<Dict> =>
      this.settleInteraction(id, () => this.host.cancelInteraction(id)),
  }

  readonly goals = {
    start: (input: GoalStartInput) => this.goalService.start(input),
    list: (input: { sessionId?: string | null } = {}) =>
      this.goalService.list(input),
    get: (goalId: string) => this.goalService.get(goalId),
    pause: (goalId: string) => this.goalService.pause(goalId),
    resume: (goalId: string) => this.goalService.resume(goalId),
    cancel: (goalId: string, reason?: string | null) =>
      this.goalService.cancel(goalId, reason),
  }

  readonly scheduler = {
    get: () => ({
      status: this.host.kept.schedulerService.status(),
      jobs: this.host.kept.schedulerService
        .listJobs({ includeDisabled: true })
        .map(schedulerJobPublicPayload),
      diagnostics: this.host.kept.schedulerStore.diagnostics(),
    }),
    createJob: (args: Dict) => {
      this.assertMutation('scheduler', 'create')
      const schedule = SchedulerSchedule.fromDict(
        requiredRecord(args.schedule, 'schedule'),
      )
      const payload = schedulerPayloadFromApi(
        requiredRecord(args.payload, 'payload'),
      )
      const job = this.host.kept.schedulerService.addJob({
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
      const current = this.host.kept.schedulerService.getJob(jobId)
      if (!current) throw new Error(`scheduler job not found: ${jobId}`)
      if (current.protected)
        throw new Error(`scheduler job is protected: ${jobId}`)
      const result = this.host.kept.schedulerService.updateJob(jobId, {
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
      const ran = await this.host.kept.schedulerService.runJob(jobId, {
        force: true,
      })
      if (!ran) throw new Error(`scheduler job not found: ${jobId}`)
      return { scheduler: this.scheduler.get() }
    },
    pauseJob: (jobId: string) => {
      this.assertMutation('scheduler', 'pause')
      const job = this.host.kept.schedulerService.enableJob(jobId, false)
      if (job === 'not_found')
        throw new Error(`scheduler job not found: ${jobId}`)
      return {
        job: schedulerJobPublicPayload(job),
        scheduler: this.scheduler.get(),
      }
    },
    resumeJob: (jobId: string) => {
      this.assertMutation('scheduler', 'resume')
      const job = this.host.kept.schedulerService.enableJob(jobId, true)
      if (job === 'not_found')
        throw new Error(`scheduler job not found: ${jobId}`)
      return {
        job: schedulerJobPublicPayload(job),
        scheduler: this.scheduler.get(),
      }
    },
    deleteJob: (jobId: string) => {
      this.assertMutation('scheduler', 'delete')
      const result = this.host.kept.schedulerService.removeJob(jobId)
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
    list: (opts: { includeArchived?: boolean } = {}) =>
      this.sessionApplicationService.list(opts),
    create: (
      opts: {
        title?: string
        mode?: string
        project?: Dict | null
        project_path?: string | null
      } = {},
    ) => this.sessionApplicationService.create(opts),
    rename: async (
      sessionId: string,
      patch: string | { title?: string | null; archived?: boolean | null },
    ) => this.sessionApplicationService.rename(sessionId, patch),
    delete: (sessionId: string): Promise<Dict> =>
      this.sessionApplicationService.delete(sessionId),
    activate: (sessionId: string) =>
      this.sessionApplicationService.activate(sessionId),
    /** One message-boundary page of a session's raw log, sanitized for the wire. */
    history: (input: {
      sessionId: string
      beforeSeq?: number
      maxMessages?: number
    }): SessionHistoryPage => {
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'sessions.history',
      )
      const page = this.host.history(sessionId, {
        ...(input.beforeSeq === undefined
          ? {}
          : { beforeSeq: input.beforeSeq }),
        ...(input.maxMessages === undefined
          ? {}
          : { maxMessages: input.maxMessages }),
      })
      if (page === undefined)
        throw new InvalidSessionError(
          `sessions.history received unknown session ${sessionId}`,
          sessionId,
        )
      return { ...page, events: page.events.map(sanitizeForWire) }
    },
    /**
     * One raw log event by seq, NOT sanitized: the inspector loads the full
     * payload of an event the history page truncated (`wire` marker).
     */
    event: (input: { sessionId: string; seq: number }): SessionEvent => {
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'sessions.event',
      )
      const event = this.host.event(sessionId, input.seq)
      if (event === undefined)
        throw new InvalidSessionError(
          `sessions.event found no event ${input.seq} in session ${sessionId}`,
          sessionId,
        )
      return event
    },
    /** Ancestor chain of a (child) session, root first. */
    lineage: (input: { sessionId: string }): SessionLineage => {
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'sessions.lineage',
      )
      return this.host.lineage(sessionId) ?? { chain: [{ sessionId }] }
    },
    /** Delegated children of a session with their live status. */
    children: (input: { sessionId: string }): SubagentChildView[] => {
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'sessions.children',
      )
      return this.host.children(sessionId)
    },
    /**
     * Replace the set of sessions whose raw log events the desktop bridge
     * streams to the renderer. Unreadable ids are dropped.
     */
    watch: (input: { sessionIds: string[] }): { watching: string[] } => {
      const next = new Set<string>()
      for (const raw of input.sessionIds) {
        try {
          next.add(this.requireReadableLogSession(raw, 'sessions.watch'))
        } catch {
          // A deleted or unknown session is simply not watched.
        }
      }
      this.watchedSessions = next
      return { watching: [...next] }
    },
  }

  private watchedSessions = new Set<string>()

  /** Whether the renderer asked for this session's raw events (`sessions.watch`). */
  isSessionWatched(sessionId: string): boolean {
    return this.watchedSessions.has(sessionId)
  }

  readonly references = {
    resolve: (input: Parameters<WorkspaceReferenceService['resolve']>[0]) =>
      this.workspaceReferenceService.resolve(input),
    /** Electron main-only capability; returns a path only after reference ownership checks. */
    revealPath: (input: { sessionId: string; referenceId: string }) =>
      this.workspaceReferenceService.revealPath(
        input.referenceId,
        input.sessionId,
      ),
  }

  readonly processes = {
    list: (opts: { activeOnly?: boolean } = {}): Dict[] =>
      this.host.kept.processRuntime
        .list({
          activeOnly: opts.activeOnly,
          sessionId: this.host.activeSessionId,
        })
        .map((receipt) => receipt as unknown as Dict),
    cancel: (
      processId: string,
      opts: { leaseId: string; reason?: string },
    ): Dict => {
      this.assertMutation('processes', 'cancel')
      this.assertProcessOwner(processId)
      return this.host.kept.processRuntime.cancel(
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
      return this.host.kept.processRuntime.reparent(processId, opts.leaseId, {
        kind: opts.ownerKind,
        id: opts.ownerId,
        sessionId: this.host.activeSessionId,
      }) as unknown as Dict
    },
  }

  readonly workspace = {
    snapshot: (input: { sessionId: string }): Promise<WorkspaceSnapshot> =>
      this.workspaceApplicationService.snapshot(input),
  }

  readonly git = {
    status: (input: Parameters<WorkspaceGitService['status']>[0]) =>
      this.workspaceGitService.status(input),
    repository: (input: Parameters<WorkspaceGitService['repository']>[0]) =>
      this.workspaceGitService.repository(input),
    remote: (input: Parameters<WorkspaceGitService['remote']>[0]) =>
      this.workspaceGitService.remote(input),
    log: (input: Parameters<WorkspaceGitService['log']>[0]) =>
      this.workspaceGitService.log(input),
    worktrees: (input: Parameters<WorkspaceGitService['worktrees']>[0]) =>
      this.workspaceGitService.worktrees(input),
    enterWorktree: (
      input: Parameters<WorkspaceGitService['enterWorktree']>[0],
    ) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.enterWorktree(input),
      ),
    exitWorktree: (input: Parameters<WorkspaceGitService['exitWorktree']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.exitWorktree(input),
      ),
    pullRequest: (input: Parameters<WorkspaceGitService['pullRequest']>[0]) =>
      this.workspaceGitService.pullRequest(input),
    publishPreview: (
      input: Parameters<WorkspaceGitService['publishPreview']>[0],
    ) => this.workspaceGitService.publishPreview(input),
    publishPullRequest: (
      input: Parameters<WorkspaceGitService['publishPullRequest']>[0],
    ) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.publishPullRequest(input),
      ),
    readyPullRequest: (
      input: Parameters<WorkspaceGitService['readyPullRequest']>[0],
    ) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.readyPullRequest(input),
      ),
    mergePullRequest: (
      input: Parameters<WorkspaceGitService['mergePullRequest']>[0],
    ) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.mergePullRequest(input),
      ),
    closePullRequest: (
      input: Parameters<WorkspaceGitService['closePullRequest']>[0],
    ) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.closePullRequest(input),
      ),
    diff: (input: Parameters<WorkspaceGitService['diff']>[0]) =>
      this.workspaceGitService.diff(input),
    branches: (input: Parameters<WorkspaceGitService['branches']>[0]) =>
      this.workspaceGitService.branches(input),
    compare: (input: Parameters<WorkspaceGitService['compare']>[0]) =>
      this.workspaceGitService.compare(input),
    stage: (input: Parameters<WorkspaceGitService['stage']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.stage(input),
      ),
    unstage: (input: Parameters<WorkspaceGitService['unstage']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.unstage(input),
      ),
    discard: (input: Parameters<WorkspaceGitService['discard']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.discard(input),
      ),
    commit: (input: Parameters<WorkspaceGitService['commit']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.commit(input),
      ),
    fetch: (input: Parameters<WorkspaceGitService['fetch']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.fetch(input),
      ),
    pull: (input: Parameters<WorkspaceGitService['pull']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.pull(input),
      ),
    push: (input: Parameters<WorkspaceGitService['push']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.push(input),
      ),
    createBranch: (input: Parameters<WorkspaceGitService['createBranch']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.createBranch(input),
      ),
    switchBranch: (input: Parameters<WorkspaceGitService['switchBranch']>[0]) =>
      this.withWorkspaceGitMutation(input.sessionId, () =>
        this.workspaceGitService.switchBranch(input),
      ),
  }

  /** Global read-only Pull Request browsing (signed gh; not session-scoped). */
  readonly pullRequests = {
    status: () => this.pullRequestBrowser.status(),
    list: (input: Parameters<PullRequestBrowserService['list']>[0] = {}) =>
      this.pullRequestBrowser.list(input),
    view: (input: Parameters<PullRequestBrowserService['view']>[0]) =>
      this.pullRequestBrowser.view(input),
    diff: (input: Parameters<PullRequestBrowserService['diff']>[0]) =>
      this.pullRequestBrowser.diff(input),
  }

  readonly files = {
    list: (
      input: Parameters<WorkspaceFilesService['list']>[0],
    ): Promise<WorkspaceFileListResult> =>
      this.workspaceFilesService.list(input),
    search: (
      input: Parameters<WorkspaceFilesService['search']>[0],
    ): Promise<WorkspaceFileListResult> =>
      this.workspaceFilesService.search(input),
    read: (
      input: Parameters<WorkspaceFilesService['read']>[0],
    ): Promise<WorkspaceFileReadResult> =>
      this.workspaceFilesService.read(input),
  }

  readonly terminals = {
    list: (input: Parameters<TerminalService['list']>[0]) =>
      this.terminalService.list(input),
    create: (input: Parameters<TerminalService['create']>[0]) =>
      this.terminalService.create(input),
    read: (input: Parameters<TerminalService['read']>[0]) =>
      this.terminalService.read(input),
    write: (input: Parameters<TerminalService['write']>[0]) => {
      this.terminalService.write(input)
      return { written: true }
    },
    resize: (input: Parameters<TerminalService['resize']>[0]) => {
      this.terminalService.resize(input)
      return { resized: true }
    },
    close: (input: Parameters<TerminalService['close']>[0]) => {
      this.terminalService.close(input)
      return { closed: true }
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
    list: () => this.host.kept.projectStore.list(),
    resolve: (path: string) => this.host.kept.projectStore.resolve(path),
  }

  readonly skills = {
    tools: () => this.skillService.tools(),
    /** Effective Skills of a session (default: the active one) plus invalid Skills with reasons. */
    list: (opts: { sessionId?: string | null } = {}) =>
      this.skillService.list(opts),
    get: (name: string, opts: { sessionId?: string | null } = {}) =>
      this.skillService.get(name, opts),
    create: (input: Parameters<CoreSkillService['create']>[0]) => {
      this.assertMutation('skills', 'create')
      return this.skillService.create(input)
    },
    validate: (input: Parameters<CoreSkillService['validate']>[0]) =>
      this.skillService.validate(input),
    save: (
      name: string,
      content: string,
      opts: { sessionId?: string | null } = {},
    ) => {
      this.assertMutation('skills', 'save')
      return this.skillService.save(name, content, opts)
    },
    delete: (
      name: string,
      opts: {
        sessionId?: string | null
        scope?: 'user' | 'project' | null
      } = {},
    ) => {
      this.assertMutation('skills', 'delete')
      return this.skillService.delete(name, opts)
    },
    import: async (input: Parameters<CoreSkillService['import']>[0]) => {
      this.assertMutation('skills', 'import')
      return await this.skillService.import(input)
    },
    copyToUser: (input: Parameters<CoreSkillService['copyToUser']>[0]) => {
      this.assertMutation('skills', 'copyToUser')
      return this.skillService.copyToUser(input)
    },
    /** Electron main-only capability: the Skills folder of a scope (created when missing). */
    folderPath: (input: Parameters<CoreSkillService['folderPath']>[0]) =>
      this.skillService.folderPath(input),
  }

  readonly plugins = {
    list: () => this.pluginService.list(),
    inspect: (input: Parameters<PluginApplicationService['inspect']>[0]) =>
      this.pluginService.inspect(input),
    install: (input: Parameters<PluginApplicationService['install']>[0]) => {
      this.assertMutation('plugins', 'install')
      return this.pluginService.install(input)
    },
    uninstall: (
      input: Parameters<PluginApplicationService['uninstall']>[0],
    ) => {
      this.assertMutation('plugins', 'uninstall')
      return this.pluginService.uninstall(input)
    },
    setEnabled: (
      input: Parameters<PluginApplicationService['setEnabled']>[0],
    ) => {
      this.assertMutation('plugins', input.enabled ? 'enable' : 'disable')
      return this.pluginService.setEnabled(input)
    },
  }

  readonly environment = {
    getStatus: (
      input: Parameters<CoreEnvironmentService['getStatus']>[0] = {},
    ) => this.environmentService.getStatus(input),
    createInstallPlan: (
      _input: Parameters<CoreEnvironmentService['createInstallPlan']>[0],
    ): Promise<never> =>
      Promise.reject(
        new OperationRetiredError(
          '环境配方安装接口已退役。请在普通命令权限下安装依赖，并使用独立命令验证结果。',
          'review_environment',
        ),
      ),
    install: (
      _input: Parameters<CoreEnvironmentService['install']>[0],
    ): Promise<never> =>
      Promise.reject(
        new OperationRetiredError(
          '环境配方安装接口已退役。请在普通命令权限下安装依赖，并使用独立命令验证结果。',
          'review_environment',
        ),
      ),
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

  /**
   * Drop a session that left the sidebar list (deleted or archived) from the
   * pinned list. Best effort: the session change already succeeded.
   */
  private unpinSidebarSession(sessionId: string): void {
    try {
      const current = this.sidebar.get()
      const pinned = current.pinned_session_ids as string[]
      if (!pinned.includes(sessionId)) return
      const next = normalizeSidebarState({
        ...current,
        pinned_session_ids: pinned.filter((id) => id !== sessionId),
      })
      atomicWriteText(
        join(this.paths.memoryRoot, 'sidebar_state.json'),
        JSON.stringify(next, null, 2) + '\n',
      )
    } catch {
      // A stale pin is harmless: the renderer ignores ids it cannot list.
    }
  }

  readonly diagnostics = {
    get: async () => this.diagnosticsService.payload(),
  }

  /**
   * Computer Use (GUI control). Stop, revoke and resume never call
   * `assertMutation`: narrowing capability must work while a grant card or
   * plan mode is pending.
   */
  readonly computerUse = {
    status: async (): Promise<ComputerUseStatusView> =>
      (await this.host.computerUse?.service.status()) ??
      unsupportedComputerUseStatus(),
    stop: async (): Promise<ComputerUseStatusView> => {
      await this.host.computerUse?.service.emergencyStop()
      return await this.computerUse.status()
    },
    resume: async (): Promise<ComputerUseStatusView> => {
      this.host.computerUse?.service.resume()
      return await this.computerUse.status()
    },
    listGrants: (): UiGrantView[] =>
      this.host.computerUse?.service.statusView().grants.slice() ?? [],
    revokeGrant: (grantId: string): { revoked: boolean } => ({
      revoked: this.host.computerUse?.service.revokeGrant(grantId) ?? false,
    }),
    /**
     * Drop actions or origins from a grant (never guarded: it only takes
     * access away). Removing everything revokes it.
     */
    narrowGrant: (input: {
      grantId: string
      allowedActions?: UiActionClass[]
      origins?: string[]
    }): { found: boolean; revoked: boolean } => {
      const service = this.host.computerUse?.service
      const before = service
        ?.statusView()
        .grants.some((grant) => grant.grantId === input.grantId)
      if (service === undefined || before !== true)
        return { found: false, revoked: false }
      const after = service.narrowGrant(input.grantId, {
        ...(input.allowedActions === undefined
          ? {}
          : { allowedActions: input.allowedActions }),
        ...(input.origins === undefined ? {} : { origins: input.origins }),
      })
      return { found: true, revoked: after === undefined }
    },
    /** One driver's switch. Turning on is guarded; turning off never is. */
    setDriverEnabled: async (input: {
      driver: DriverKind
      enabled: boolean
    }): Promise<ComputerUseStatusView> => {
      if (input.enabled) this.assertMutation('computerUse', 'enable')
      this.host.setComputerUseDriverEnabled(input.driver, input.enabled)
      return await this.computerUse.status()
    },
    /**
     * Delete saved screenshots of one conversation, or all (spec 00 §8.5).
     * Never guarded: it only removes data.
     */
    clearScreenshots: (
      input: { sessionId?: string } = {},
    ): { removed: number; bytes: number } =>
      this.host.computerUse?.service.clearScreenshots(input.sessionId) ?? {
        removed: 0,
        bytes: 0,
      },
    /**
     * Replace the user's protected / high-risk / sensitive app lists.
     * Removing an entry widens access, so any removal is guarded; adding
     * never is.
     */
    setAppLists: async (
      input: Partial<Record<'protected' | 'highRisk' | 'sensitive', string[]>>,
    ): Promise<ComputerUseStatusView> => {
      const current = this.host.computerUse?.service.statusView().appLists
      const widened = (Object.keys(input) as Array<keyof typeof input>).some(
        (kind) =>
          (current?.[kind] ?? []).some((id) => !input[kind]!.includes(id)),
      )
      if (widened) this.assertMutation('computerUse', 'app-lists')
      this.host.setComputerUseAppLists(input)
      return await this.computerUse.status()
    },
    /** Download inbox retention (never guarded: it only deletes sooner). */
    setDownloadRetention: async (input: {
      days: 0 | 7 | 30 | 90
    }): Promise<ComputerUseStatusView> => {
      this.host.setComputerUseDownloadRetention(input.days)
      return await this.computerUse.status()
    },
    /** The emergency-stop shortcut (`null` restores the platform default). */
    setKillSwitch: async (input: {
      accelerator: string | null
    }): Promise<ComputerUseStatusView> => {
      this.host.setComputerUseKillSwitch(input.accelerator)
      return await this.computerUse.status()
    },
    /** Master switch. Turning on is a guarded mutation; turning off never is. */
    setEnabled: async (enabled: boolean): Promise<ComputerUseStatusView> => {
      if (enabled) this.assertMutation('computerUse', 'enable')
      this.host.setComputerUseEnabled(enabled)
      return await this.computerUse.status()
    },
    setAuthorizationMode: async (
      mode: 'unrestricted' | 'scoped',
    ): Promise<ComputerUseStatusView> => {
      this.host.setComputerUseAuthorizationMode(mode)
      return await this.computerUse.status()
    },
    /** Browser profiles: the temporary one and every persistent one. */
    listProfiles: (): BrowserProfileView[] =>
      this.host.computerUse?.service.listProfiles() ?? [],
    /**
     * Create or rename a persistent profile (guarded mutations), or wipe /
     * delete one (never guarded: it only removes data and grants).
     */
    manageProfile: async (input: {
      action: 'create' | 'rename' | 'clear' | 'delete'
      profileId?: string
      name?: string
    }): Promise<{ profile?: BrowserProfileView; revokedGrants?: number }> => {
      const service = this.host.computerUse?.service
      if (service === undefined)
        throw new Error('computer use is not available on this host')
      if (input.action === 'create' || input.action === 'rename') {
        this.assertMutation('computerUse', `${input.action}Profile`)
        if (input.name === undefined)
          throw new Error('a profile name is required')
        if (input.action === 'create')
          return { profile: service.createProfile(input.name) }
        if (input.profileId === undefined)
          throw new Error('profileId is required')
        return { profile: service.renameProfile(input.profileId, input.name) }
      }
      if (input.profileId === undefined)
        throw new Error('profileId is required')
      const result = await service.clearProfile(input.profileId, {
        remove: input.action === 'delete',
      })
      return { revokedGrants: result.revokedGrants }
    },
    /** Site permissions the user allowed (camera, location, …). */
    listSitePermissions: (): SitePermission[] =>
      this.host.computerUse?.service.listSitePermissions() ?? [],
    /** Allow (guarded mutation) or revoke (never guarded) a site permission. */
    setSitePermission: (input: {
      profileId: string
      origin: string
      kind: SitePermissionKind
      allow: boolean
      minutes?: number
    }): { permissions: SitePermission[] } => {
      const service = this.host.computerUse?.service
      if (service === undefined)
        throw new Error('computer use is not available on this host')
      if (input.allow) {
        this.assertMutation('computerUse', 'allowSitePermission')
        service.allowSitePermission({
          profileId: input.profileId,
          origin: input.origin,
          kind: input.kind,
          ...(input.minutes === undefined ? {} : { minutes: input.minutes }),
        })
      } else
        service.revokeSitePermission({
          profileId: input.profileId,
          origin: input.origin,
          kind: input.kind,
        })
      return { permissions: service.listSitePermissions() }
    },
    /** User control of one target: pause, resume, take over, hand back, close. */
    controlTarget: async (input: {
      targetId: string
      action: 'pause' | 'resume' | 'takeover' | 'handback' | 'close'
    }): Promise<UiTargetView | null> =>
      (await this.host.computerUse?.service.controlTarget(
        input.targetId,
        input.action,
      )) ?? null,
  }

  readonly desktopPet = {
    get: async () => this.desktopPetService.get(),
    setEnabled: (enabled: boolean) =>
      this.desktopPetService.setEnabled(enabled),
  }

  /** Task panel: background jobs and subagent sessions of a session tree. */
  readonly tasks = {
    list: (opts: { sessionId?: string | null } = {}): CoreTaskRecord[] => {
      const sessionId =
        String(opts.sessionId ?? '').trim() || this.host.activeSessionId
      return sessionId ? this.sessionTasks(sessionId) : []
    },
    get: (taskId: string): CoreTaskRecord | null => this.findTask(taskId),
    transcript: (
      taskId: string,
      opts: { offset?: number; limit?: number } = {},
    ) => {
      const task = this.requireTask(taskId)
      const offset = Math.max(0, Math.floor(Number(opts.offset ?? 0)) || 0)
      const limit = Math.max(
        1,
        Math.min(500, Math.floor(Number(opts.limit ?? 200)) || 200),
      )
      const entries =
        task.kind === 'workflow'
          ? this.workflowTranscript(task.id)
          : task.kind === 'subagent'
            ? this.subagentTranscript(task.id)
            : [
                {
                  role: 'output',
                  content: this.host.jobs.peek(task.id, this.jobOwner(task))
                    .text,
                },
              ]
      return {
        taskId: task.id,
        entries: entries.slice(offset, offset + limit),
        offset,
        total: entries.length,
        eof: offset + limit >= entries.length,
      }
    },
    wait: async (
      taskId: string,
      opts: { timeoutMs?: number } = {},
    ): Promise<Dict | null> => {
      const task = this.requireTask(taskId)
      const timeoutMs = Math.max(
        0,
        Math.min(600_000, Number(opts.timeoutMs ?? 30_000) || 30_000),
      )
      if (task.kind === 'workflow') {
        const deadline = Date.now() + timeoutMs
        let current = this.findTask(task.id)
        while (current?.status === 'running' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          current = this.findTask(task.id)
        }
        return current === null || current.status === 'running'
          ? null
          : { status: current.status, task: current }
      }
      if (task.kind === 'job') {
        const snapshot = await this.host.jobs
          .wait(task.id, timeoutMs, this.jobOwner(task))
          .catch(() => null)
        return snapshot === null
          ? null
          : { status: snapshot.status, task: this.findTask(task.id) }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const settled = await this.host.subagents.waitForSettlement(
          task.id,
          controller.signal,
        )
        return { status: settled.stopReason, task: this.findTask(task.id) }
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
    readOutput: async (taskId: string, _opts: { cursor?: string } = {}) => {
      const task = this.requireTask(taskId)
      const content =
        task.kind === 'job'
          ? this.host.jobs.peek(task.id, this.jobOwner(task)).text
          : (task.kind === 'workflow'
              ? this.workflowTranscript(task.id)
              : this.subagentTranscript(task.id)
            )
              .map((entry) => `${entry.role}: ${entry.content}`)
              .join('\n\n')
      return {
        content,
        nextCursor: null,
        eof: true,
        truncated: false,
        truncation: null,
      }
    },
    cancel: async (
      taskId: string,
      _opts: { reason?: string } = {},
    ): Promise<Dict> => {
      this.assertMutation('tasks', 'cancel')
      this.requireTask(taskId)
      this.cancelTask(taskId)
      return { ...this.findTask(taskId) }
    },
    resume: async (_taskId: string, _opts: Dict = {}): Promise<never> => {
      throw new OperationRetiredError(
        '子代理任务不再支持从面板恢复；请在对话中让主代理用 send_message 继续该子代理。',
        'use_send_message',
      )
    },
  }

  readonly tools = {
    /** Full text of a spilled tool result (`ref` is the spill file path). */
    readResult: (opts: { ref: string }) => {
      const spillRoot = resolve(this.paths.stateRoot, 'spill')
      const target = resolve(String(opts?.ref ?? ''))
      const rel = relative(spillRoot, target)
      if (
        !rel ||
        rel.startsWith('..') ||
        isAbsolute(rel) ||
        !existsSync(target)
      )
        throw new CoreMutationGuardError(
          403,
          'tool result ref is outside the spill store',
        )
      return { content: readFileSync(target, 'utf8') }
    },
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private activeProjectRoot(): string | null {
    const session = this.host.activeSession()
    return session?.mode === 'build' ? (session.project_path ?? null) : null
  }

  private controlSessionId(sessionId?: string | null): string | null {
    const id = String(sessionId ?? '').trim()
    return id || this.host.activeSessionId
  }

  private requireControlSession(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    const id =
      this.controlSessionId(sessionId) ?? this.host.ensureDefaultSession().id
    return this.requireReadableSession(id, operation).id
  }

  /** Resolve a pending interaction; the blocked turn continues on its own. */
  private settleInteraction(id: string, action: () => void): Dict {
    const sessionId = this.host.pending.sessionOf(id) ?? null
    if (sessionId === null)
      throw new CoreMutationGuardError(409, `interaction ${id} is not pending`)
    const wasInterview = this.onboardingService.isInterviewInteraction(id)
    action()
    const result: Dict = {
      interactionId: id,
      sessionId,
      control: this.host.controlPayload(sessionId),
    }
    if (wasInterview)
      result.profileOnboarding = this.onboardingService.payload()
    return result
  }

  private rootAgentOf(sessionId: string): Agent | null {
    if (!this.host.kept.sessionStore.get(sessionId)) return null
    return this.host.agentFor(sessionId)
  }

  private sessionJobs(sessionId: string): JobSnapshot[] {
    const root = this.rootAgentOf(sessionId)
    if (root === null) return []
    const owners = [
      root,
      ...this.host.subagents.list(root, 'descendants').flatMap((record) => {
        const child = this.host.subagents.get(record.id)
        return child === undefined ? [] : [child]
      }),
    ]
    // The job registry fences owned jobs by their exact owner agent.
    return owners.flatMap((owner) =>
      this.host.jobs.list(owner).filter((job) => job.ownerId === owner.id),
    )
  }

  /** The agent that owns a job task (the registry's access fence). */
  private jobOwner(task: CoreTaskRecord): Agent | undefined {
    const ownerId = task.owner_id
    if (ownerId === null) return undefined
    return (
      this.host.subagents.get(ownerId) ?? this.rootAgentOf(ownerId) ?? undefined
    )
  }

  private sessionTasks(sessionId: string): CoreTaskRecord[] {
    const root = this.rootAgentOf(sessionId)
    if (root === null) return []
    const jobs = this.sessionJobs(sessionId).map((job) =>
      jobTask(job, sessionId),
    )
    const children = this.host.subagents
      .list(root, 'descendants')
      .map((record) => subagentTask(record, sessionId))
    const workflows = this.sessionWorkflowRuns(sessionId).map(
      ({ record, ownerId }) =>
        workflowTaskView(record, sessionId, {
          ownerId,
          live: this.host.workflowRuns.isLive(record.runId),
        }) as CoreTaskRecord,
    )
    return [...workflows, ...children, ...jobs].sort(
      (left, right) => right.started_at - left.started_at,
    )
  }

  private allSubagents(): SubagentRecord[] {
    const sessionId = this.host.activeSessionId
    const root = sessionId === null ? null : this.rootAgentOf(sessionId)
    return root === null ? [] : this.host.subagents.list(root, 'descendants')
  }

  private findTask(taskId: string): CoreTaskRecord | null {
    const id = String(taskId ?? '').trim()
    if (!id) return null
    for (const entry of this.host.kept.sessionStore.list({
      includeArchived: false,
    })) {
      const found = this.sessionTasks(entry.id).find((task) => task.id === id)
      if (found) return found
    }
    return null
  }

  private requireTask(taskId: string): CoreTaskRecord {
    const task = this.findTask(taskId)
    if (task === null)
      throw new CoreMutationGuardError(
        403,
        `task not found or not owned by an open session: ${taskId}`,
      )
    return task
  }

  private cancelTask(taskId: string): boolean {
    const task = this.findTask(taskId)
    if (task === null) return false
    if (task.kind === 'workflow')
      return this.host.workflowRuns.cancel(
        task.id,
        'cancelled from the task panel',
      )
    if (task.kind === 'job')
      return (
        this.host.jobs.kill(task.id, this.jobOwner(task), 'user') ===
        'requested'
      )
    try {
      this.host.subagents.interrupt(task.id, { kind: 'user' })
      return true
    } catch {
      return false
    }
  }

  /** Workflow runs recorded on a session tree's logs (root + live descendants). */
  private sessionWorkflowRuns(
    sessionId: string,
  ): Array<{ record: WorkflowRunRecord; ownerId: string; session: Session }> {
    const root = this.rootAgentOf(sessionId)
    if (root === null) return []
    const owners: Agent[] = [
      root,
      ...this.host.subagents.list(root, 'descendants').flatMap((record) => {
        const child = this.host.subagents.get(record.id)
        return child === undefined ? [] : [child]
      }),
    ]
    return owners.flatMap((owner) =>
      WorkflowRunFold.fold(owner.session.events).map((record) => ({
        record,
        ownerId: owner.id,
        session: owner.session,
      })),
    )
  }

  /** Chronological transcript of one workflow run: narration, members, outcome. */
  private workflowTranscript(
    runId: string,
  ): Array<{ role: string; content: string }> {
    for (const entry of this.host.kept.sessionStore.list({
      includeArchived: false,
    })) {
      const found = this.sessionWorkflowRuns(entry.id).find(
        (run) => run.record.runId === runId,
      )
      if (found === undefined) continue
      const out: Array<{ role: string; content: string }> = []
      for (const event of found.session.events) {
        if (!event.type.startsWith('tool-workflow/')) continue
        const data = event.data as Record<string, unknown>
        if (data.runId !== runId) continue
        switch (event.type) {
          case 'tool-workflow/run-start':
            out.push({
              role: 'workflow',
              content: `${found.record.tool} ${found.record.name}: ${found.record.description}`,
            })
            break
          case 'tool-workflow/phase':
            out.push({ role: 'phase', content: String(data.title ?? '') })
            break
          case 'tool-workflow/log':
            out.push({ role: 'log', content: String(data.message ?? '') })
            break
          case 'tool-workflow/agent-start':
            out.push({
              role: 'agent',
              content: `#${String(data.seq)} ${String(data.label ?? '')} started (${String(data.childId ?? '')})`,
            })
            break
          case 'tool-workflow/agent-end':
            out.push({
              role: 'agent',
              content: `#${String(data.seq)} ${String(data.outcome ?? '')}`,
            })
            break
          case 'tool-workflow/run-end':
            out.push({
              role: data.stopReason === 'completed' ? 'result' : 'error',
              content: String(
                data.result ?? data.error ?? `run ${String(data.stopReason)}`,
              ),
            })
            break
        }
      }
      return out
    }
    return []
  }

  private subagentTranscript(
    childId: string,
  ): Array<{ role: string; content: string }> {
    const session =
      this.host.subagents.get(childId)?.session ?? this.host.sessionLog(childId)
    if (session === undefined) return []
    return session.deriveMessages().map((message) => ({
      role:
        message.role === 'user' && message.source.kind === 'tool'
          ? 'tool'
          : message.role,
      content: messageText(message),
    }))
  }

  private activeTaskInfos(): Dict[] {
    return this.host.busySessions().map((sessionId) => ({
      id: `turn:${sessionId}`,
      kind: 'turn',
      session_id: sessionId,
      status: 'running',
    }))
  }

  /** Required host services and whether each finished starting. */
  private lifecyclePayload(): {
    state: 'ready' | 'degraded'
    services: Array<{
      id: string
      required: true
      state: 'ready' | 'unavailable'
      detail?: string
    }>
  } {
    const kept = this.host.kept
    const check = (
      id: string,
      ready: () => boolean,
      detail?: () => string,
    ): {
      id: string
      required: true
      state: 'ready' | 'unavailable'
      detail?: string
    } => {
      try {
        if (ready()) return { id, required: true, state: 'ready' }
        return {
          id,
          required: true,
          state: 'unavailable',
          ...(detail === undefined ? {} : { detail: detail() }),
        }
      } catch (error) {
        return {
          id,
          required: true,
          state: 'unavailable',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const services = [
      check('process-runtime', () =>
        Boolean(kept.processRuntime.capabilityReport()),
      ),
      check('harness-kernel', () => this.host.tools.schemas().length > 0),
      check(
        'mcp',
        () => kept.mcpClient.snapshot().initialized === true,
        () => 'MCP client did not initialize',
      ),
      check(
        'scheduler',
        () => kept.schedulerService.status().running,
        () =>
          kept.schedulerService.status().lastError ?? 'scheduler not running',
      ),
    ]
    return {
      state: services.every((service) => service.state === 'ready')
        ? 'ready'
        : 'degraded',
      services,
    }
  }

  private runtimeStats(sessionId: string | null): Dict {
    const session =
      sessionId === null ? undefined : this.host.sessionLog(sessionId)
    return {
      events: session?.events.length ?? 0,
      latestSeq: session === undefined ? 0 : session.seq - 1,
      busy: this.host.isBusy(sessionId),
    }
  }

  private async resolveGitRuntime(projectRoot: string): Promise<{
    executable: string
    gitVersion: string
    env: Record<string, string>
  } | null> {
    const kept = this.host.kept
    const environment = await kept.executionEnvironmentService.create({
      projectRoot,
    })
    const executable = environment.toolPaths.git
    if (!executable) return null
    const status = await kept.environmentProbe.getStatus({
      projectRoot,
      skillRequirements: collectSkillEnvironmentRequirements(kept.skillManager),
    })
    const git = status.tools.find(
      (tool) => tool.id === 'git' && tool.status === 'ready',
    )
    if (!git?.detectedVersion || git.executablePath !== executable) return null
    return {
      executable,
      gitVersion: git.detectedVersion,
      env: {
        ...environment.selectEnv([
          'PATH',
          'HOME',
          'USERPROFILE',
          'SystemRoot',
          'TEMP',
          'TMP',
          'TMPDIR',
          'LANG',
          'LC_ALL',
        ]),
      },
    }
  }

  /**
   * The signed-catalog GitHub CLI: the executable the execution environment
   * resolved for `gh`, accepted only when the ToolCatalog probe reports it
   * `ready` at that same path. The env carries only the gh allowlist
   * (process basics plus gh's config-location variables, never tokens).
   */
  private async resolveGhRuntime(
    projectRoot: string,
  ): Promise<GhRuntime | null> {
    const kept = this.host.kept
    const environment = await kept.executionEnvironmentService.create({
      projectRoot,
    })
    const executable = environment.toolPaths.gh
    if (!executable) return null
    const status = await kept.environmentProbe.getStatus({
      projectRoot,
      skillRequirements: collectSkillEnvironmentRequirements(kept.skillManager),
    })
    const gh = status.tools.find(
      (tool) => tool.id === 'gh' && tool.status === 'ready',
    )
    if (!gh?.detectedVersion || gh.executablePath !== executable) return null
    return {
      executable,
      version: gh.detectedVersion,
      env: { ...environment.selectEnv(GH_ENV_ALLOWLIST) },
    }
  }

  private assertClearBoundary(sessionId: string): void {
    this.requireReadableSession(sessionId, 'commands.clear')
    if (this.host.pending.hasPending(sessionId))
      throw new CoreMutationGuardError(
        409,
        '请先处理当前 Ask、Permission 或 Plan 审批，再创建新上下文。',
      )
    if (this.host.queuedPrompts(sessionId).length)
      throw new CoreMutationGuardError(
        409,
        '请先处理当前会话中的排队消息，再创建新上下文。',
      )
  }

  private assertMutation(area: string, action: string): void {
    const control = this.host.controlPayload(this.host.activeSessionId)
    assertCoreMutationAllowed(
      {
        pending: control.pending,
        mode: control.plan === true ? 'plan' : control.preset,
      },
      { area, action },
    )
  }

  private async withWorkspaceGitMutation<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const session = this.requireReadableSession(sessionId, 'workspace.git') as {
      mode?: string | null
      project_path?: string | null
    }
    if (session.mode !== 'build' || !session.project_path)
      throw new WorkspaceOperationError(
        'workspace_project_required',
        '当前会话没有绑定 Build 项目。',
      )
    return await this.workspaceMutations.runExclusive(
      this.workspaceBindings.resolve(sessionId, resolve(session.project_path)),
      'renderer_git',
      action,
    )
  }

  private assertProcessOwner(processId: string): void {
    const receipt = this.host.kept.processRuntime.get(processId)
    if (!receipt || receipt.owner.sessionId !== this.host.activeSessionId)
      throw new CoreMutationGuardError(
        403,
        `Process is not owned by the active session: ${processId}`,
      )
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

  /**
   * A readable raw-log session: a sidebar session, or a delegated child
   * session (not in the SessionStore) whose lineage root is one.
   */
  private requireReadableLogSession(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    const id = String(sessionId ?? '').trim()
    if (id && !id.startsWith(DRAFT_SESSION_PREFIX)) {
      const indexed = this.host.kept.sessionStore.get(id)
      if (indexed === null && this.host.sessions.has(id)) {
        const root = this.host.lineage(id)?.chain[0]?.sessionId
        if (root !== undefined && root !== id) {
          this.requireReadableSession(root, operation)
          return id
        }
      }
    }
    return this.requireReadableSession(id, operation).id
  }

  private requireReadableSession(
    sessionId: string,
    operation: string,
  ): { id: string; archived_at?: string | null } {
    if (!sessionId)
      throw new InvalidSessionError(
        `${operation} requires a real sessionId`,
        null,
      )
    if (sessionId.startsWith(DRAFT_SESSION_PREFIX))
      throw new InvalidSessionError(
        `${operation} cannot read draft session ${sessionId}`,
        sessionId,
      )
    const session = this.host.kept.sessionStore.get(sessionId)
    if (!session || session.archived_at)
      throw new InvalidSessionError(
        `${operation} received unknown session ${sessionId}`,
        sessionId,
      )
    return session
  }
}

function unsupportedComputerUseStatus(): ComputerUseStatusView {
  return {
    supported: false,
    enabled: false,
    authorizationMode: 'unrestricted',
    platform: null,
    stopped: false,
    drivers: [],
    targets: [],
    grants: [],
    killSwitch: { accelerator: '', registered: false },
  }
}

function jobTask(job: JobSnapshot, sessionId: string): CoreTaskRecord {
  return {
    id: job.id,
    kind: 'job',
    job_kind: String(job.kind),
    label: job.label,
    description: job.label,
    status: job.status,
    session_id: sessionId,
    owner_id: job.ownerId ?? null,
    started_at: job.startedAt,
    finished_at: job.finishedAt ?? null,
    exit_code: job.exitCode ?? null,
    detail: job.detail ?? null,
  }
}

function subagentTask(
  record: SubagentRecord,
  sessionId: string,
): CoreTaskRecord {
  return {
    id: record.id,
    kind: 'subagent',
    label: record.description,
    description: record.description,
    status: record.status,
    session_id: sessionId,
    owner_id: record.parentId,
    started_at: record.createdAt,
    finished_at: null,
    depth: record.depth,
    mode: record.mode,
    last_stop_reason: record.lastStopReason ?? null,
  }
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
  pinned_session_ids: [],
  right_workspace: {
    version: 3,
    workbenchOpen: false,
    width: 840,
    filesTreeWidth: 280,
    pane: 'launcher',
  },
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
    pinned_session_ids: normalizePinnedSessionIds(raw.pinned_session_ids),
    right_workspace: normalizeRightWorkspace(raw.right_workspace),
  }
}

/** Max pinned sessions kept in `sidebar_state.json`. */
const MAX_PINNED_SESSIONS = 50

/**
 * Pinned session ids in pin order: strings only, trimmed, first occurrence
 * wins, capped at {@link MAX_PINNED_SESSIONS} (the first ones are kept).
 */
function normalizePinnedSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || id.length > 256 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_PINNED_SESSIONS) break
  }
  return out
}

function normalizeRightWorkspace(value: unknown): Dict {
  const raw = isRecord(value) ? value : {}
  const width = Number(raw.width)
  const filesTreeWidth = Number(raw.filesTreeWidth)
  const pane = String(raw.pane ?? '')
  if (Number(raw.version) === 3) {
    return {
      version: 3,
      workbenchOpen: raw.workbenchOpen === true,
      width: Number.isFinite(width)
        ? Math.max(520, Math.min(960, Math.round(width)))
        : 840,
      filesTreeWidth: Number.isFinite(filesTreeWidth)
        ? Math.max(240, Math.min(320, Math.round(filesTreeWidth)))
        : 280,
      pane: ['review', 'terminal', 'files'].includes(pane) ? pane : 'launcher',
    }
  }
  if (Number(raw.version) === 2) {
    return {
      version: 3,
      workbenchOpen: raw.workbenchOpen === true,
      width: Number.isFinite(width)
        ? Math.max(520, Math.min(960, Math.round(width)))
        : 840,
      filesTreeWidth: Number.isFinite(filesTreeWidth)
        ? Math.max(240, Math.min(320, Math.round(filesTreeWidth)))
        : 280,
      pane: ['review', 'terminal', 'files'].includes(pane) ? pane : 'launcher',
    }
  }
  const open = raw.open === undefined ? true : raw.open === true
  const migratedPane = ['review', 'terminal', 'files'].includes(pane)
    ? pane
    : 'launcher'
  return {
    version: 3,
    workbenchOpen: open && migratedPane !== 'launcher',
    width:
      Number.isFinite(width) && width >= 520
        ? Math.max(520, Math.min(960, Math.round(width)))
        : 840,
    filesTreeWidth: 280,
    pane: migratedPane,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredRecord(value: unknown, label: string): Dict {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function unavailablePtyHost(): PtyHost {
  return {
    spawn: () => {
      throw new WorkspaceOperationError(
        'terminal_unavailable',
        '当前宿主没有提供 PTY 终端能力。',
      )
    },
  }
}

function defaultSystemShell(): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR
    return {
      executable: windowsRoot
        ? join(
            windowsRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          )
        : 'powershell.exe',
      args: ['-NoLogo'],
    }
  }
  return { executable: process.env.SHELL || '/bin/sh', args: [] }
}

function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TERM ||= 'xterm-256color'
  env.COLORTERM ||= 'truecolor'
  return env
}

function schedulerPayloadFromApi(
  raw: Dict,
  current?: SchedulerPayload,
): SchedulerPayload {
  const merged = current ? { ...current.toDict(), ...raw } : raw
  const kind = String(merged.kind ?? 'agent_turn')
  if (kind === 'system_event')
    throw new Error('system_event jobs are internal and cannot be configured')
  if (kind !== 'agent_turn')
    throw new Error('scheduler payload kind must be agent_turn')
  const payload = SchedulerPayload.fromDict({ ...merged, kind })
  if (!payload.message.trim())
    throw new Error('message is required for scheduler jobs')
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

/** Diagnostics view of computer use: states and counts, never URLs or grants. */
function computerUseDiagnostics(status: ComputerUseStatusView): Dict {
  return {
    supported: status.supported,
    enabled: status.enabled,
    platform: status.platform,
    stopped: status.stopped,
    drivers: status.drivers.map((driver) => ({
      driver: driver.driver,
      stage: driver.stage,
      label: driver.label,
      enabled: driver.enabled,
      available: driver.available,
      ...(driver.reason === undefined ? {} : { reason: driver.reason }),
    })),
    targets: status.targets.length,
    grants: status.grants.length,
    killSwitch: {
      accelerator: status.killSwitch.accelerator,
      registered: status.killSwitch.registered,
      ...(status.killSwitch.error === undefined
        ? {}
        : { error: status.killSwitch.error }),
    },
  }
}
