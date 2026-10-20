/**
 * CoreApi: the in-process core facade Electron main owns and the renderer
 * reaches through IPC. The agent kernel behind it is `HarnessHost`; CoreApi
 * adds the operation surface (sessions, config, workspace, git, terminals,
 * scheduler, plugins, environment, diagnostics) on top of it.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mergeExternalTranscript } from '../runtime/external-transcript'
import { DRAFT_SESSION_PREFIX } from '../sessions/constants'
import type { MessageReference } from '../harness/host/message-references'
import type { AttachmentStore } from '../attachments/store'
import {
  filePreviewResult,
  previewCanonicalFile,
  type FilePreviewInput,
  type FilePreviewResult,
  type FileStatInput,
  type FileStatResult,
} from '../workspace/file-preview'
import type { RuntimePaths } from '../runtime/paths'
import { HarnessHost, type HarnessHostOptions } from '../harness/host/host'
import {
  SessionRequiredError,
  type BackgroundTurnOptions,
  type BackgroundTurnOutcome,
  type ViewScope,
} from '../harness/host/scope'
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
} from '../harness/computer-use/types'
import { GUI_TOOL_CATALOG } from '../harness/computer-use/tools/catalog'
import { listGuiTools } from '../harness/computer-use/tools/listing'
import {
  DEFAULT_EXTERNAL_BROWSER_SETTINGS,
  applyExternalBrowserSettingsPatch,
  externalBrowserSettingsView,
  widensExternalBrowserSettings,
  type ExternalBrowserSettingsPatch,
  type ExternalBrowserSettingsView,
} from '../harness/computer-use/external-site-rules'
import type { JobSnapshot } from '../harness/jobs/registry'
import type { SubagentRecord } from '../harness/subagent/manager'
import {
  WorkflowRunFold,
  workflowTaskView,
  type WorkflowRunRecord,
} from '../harness/workflow/records'
import type { Session } from '../session-log/session'
import { LOG_FILE } from '../session-log/store'
import { readUtf8Page, type ResultPage } from '../harness/tools/spill'
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
import { CoreAgentService } from './services/agent-service'
import { CoreDiagnosticsService } from './services/diagnostics-service'
import { CoreEffectiveConfigService } from './services/effective-config-service'
import type { BrowserPreferences } from '../config/local-config'
import { CoreBrowserPreferencesService } from './services/browser-preferences-service'
import { CoreWebToolsService } from './services/web-tools-service'
import { CoreTaskBudgetService } from './services/task-budget-service'
import {
  CoreSessionDefaultsService,
  type SessionDefaults,
} from './services/session-defaults-service'
import type { SessionPermission } from '../config/local-config'
import type { WebToolsStatus } from '../harness/host/web-tools'
import type {
  TaskBudgetSettings,
  WebToolPreferences,
} from '../config/local-config'
import { CoreDesktopPetService } from './services/desktop-pet-service'
import { CoreEnvironmentService } from './services/environment-service'
import { CoreHooksService } from './services/hooks-service'
import { CoreMemoryService } from './services/memory-service'
import {
  CoreModelService,
  type ModelConnectionInput,
  type ModelDiscoveryInput,
} from './services/model-service'
import { CoreSkillService } from './services/skill-service'
import { OnboardingService } from './services/onboarding-service'
import { PluginActivationController } from '../plugins/activation'
import {
  AppConnectionRegistry,
  appConnectionKey,
  type AppConnectionState,
} from '../plugins/connections'
import type {
  PluginReference,
  PluginReferenceMember,
} from '../harness/host/plugin-references'
import {
  COMPUTER_USE_PLUGIN_ID,
  PluginApplicationService,
} from '../plugins/service'
import { loadMcpConfig } from '../mcp/config'
import { logger } from '../util/log'
import { EmperorError, OperationRetiredError } from '../errors'
import {
  CoreSessionApplicationService,
  SESSION_TRASH_RETENTION_MS,
} from './services/session-application-service'
import {
  RetentionService,
  type RetentionReport,
  type StorageUsage,
} from '../storage/retention'
import { searchSessionLogs, type SessionSearchHit } from '../sessions/search'
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
import { WorkspaceGitService, type GitCommandRequest } from '../workspace/git'
import { GH_ENV_ALLOWLIST } from '../workspace/git-pull-requests'
import {
  createGhCommandRunner,
  PullRequestBrowserService,
  type GhRuntime,
} from '../workspace/pull-request-browser'
import { WorkspaceBindingStore } from '../workspace/git-worktrees'
import { GitOperationReceiptStore } from '../workspace/git-receipts'
import {
  WorkspaceMutationCoordinator,
  workspaceMutationDomain,
} from '../workspace/mutation-coordinator'
import { HardenedGitRunner } from '../workspace/git-runner'
import { TurnSnapshots } from '../workspace/turn-snapshots'
import { DelegationWorkspaceService } from '../workspace/delegation-workspaces'
import { SnapshotService } from '../workspace/delegation-snapshot'
import { ExecutorConfigStore } from '../harness/delegation/config'
import { ExecutorFactsStore } from '../harness/delegation/facts'
import { CoreExecutorService } from './services/executor-service'
import {
  CoreDelegationService,
  externalTask,
} from './services/delegation-service'
import {
  DelegationReceipts,
  requiresArtifactAcceptance,
} from '../harness/delegation/receipts'
import { DelegationAcceptance } from '../harness/delegation/acceptance'
import { DelegationIntegration } from '../workspace/delegation-integration'
import type {
  DelegationState,
  DelegationEvent,
} from '../harness/delegation/fold'
import type { DelegationProjection } from '../harness/delegation/events'

import { ExecutorRegistry } from '../harness/delegation/registry'
import { DelegationService } from '../harness/delegation/service'
import { ExecutorRuntimeService } from '../harness/delegation/runtime'
import { ExecutorConsentStore } from '../harness/delegation/consent'
import { createLoginShellEnvironment } from '../harness/delegation/login-shell'
import { ExecutorModelCatalogService } from '../harness/delegation/models'
import { nativeGeneratedImageRoot } from '../harness/delegation/image-proof'
import { ClaudeExecutorAdapter } from '../harness/delegation/adapters/claude'
import { CodexExecutorAdapter } from '../harness/delegation/adapters/codex'
import {
  DelegationError,
  type ExecutorAdapter,
} from '../harness/delegation/types'
import { ManagedAgentProcess } from '../harness/delegation/process'
import { loadModelConfig } from '../config/model-config'
import {
  TurnFileRecorder,
  mayWriteFiles,
  type TurnFilesReverted,
} from '../harness/host/turn-files'
import {
  TerminalService,
  type PtyHost,
  type TerminalEvent,
} from '../workspace/terminal'
import { WorkspaceOperationError } from '../workspace/common'
import { WorkspaceReferenceService } from '../workspace/references'
import type {
  GitHubPreviewTarget,
  ReferencePreview,
} from '../workspace/reference-preview'
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
  /** Host decoder validates native image deliverables after path/size checks. */
  verifyGeneratedImage?: (bytes: Uint8Array) => boolean
  /** Test hook: use an existing host instead of creating one. */
  host?: HarnessHost | null
  appVersion?: string
  runtimeRevision?: string
  terminalHost?: PtyHost | null
  terminalEventSink?: ((event: TerminalEvent) => void) | null
  /** Host public HTTP client used by plugin installs and lazy reference previews. */
  webFetchClient?: WebFetchClient | null
  /** Start the first-run profile interview after a model is configured. */
  enableFirstRunOnboarding?: boolean
  /** Test hook: the GitHub CLI seen by Pull Request, Issue and CI reads. */
  github?: Partial<
    Pick<
      ConstructorParameters<typeof PullRequestBrowserService>[0],
      'resolveRuntime' | 'run'
    >
  > | null
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
  kind: 'job' | 'subagent' | 'workflow' | 'external-agent'
  delegation_id?: string
  backend?: string
  model?: string
  capabilities?: import('../harness/delegation/types').ExecutorCapabilities
  acceptance?: import('../harness/delegation/types').DelegationRunRecord['acceptance']
  receipt_id?: string
  usage?: import('../harness/delegation/types').DelegationRunRecord['usage']
  workspace_summary?: string
  recoverable?: boolean
  revision?: number
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
  readonly browserPreferencesService: CoreBrowserPreferencesService
  readonly webToolsService: CoreWebToolsService
  readonly taskBudgetService: CoreTaskBudgetService
  readonly sessionDefaultsService: CoreSessionDefaultsService
  readonly diagnosticsService: CoreDiagnosticsService
  readonly environmentService: CoreEnvironmentService
  readonly hooksService: CoreHooksService
  readonly memoryService: CoreMemoryService
  readonly modelService: CoreModelService
  readonly skillService: CoreSkillService
  readonly pluginService: PluginApplicationService
  /** Runs what active plugins contribute: MCP servers and hooks. */
  readonly pluginActivation: PluginActivationController
  /** App members Emperor can connect (the GitHub plugin's local gh). */
  readonly appConnections: AppConnectionRegistry
  readonly goalService: GoalService
  readonly onboardingService: OnboardingService
  readonly workspaceFilesService: WorkspaceFilesService
  readonly workspaceGitService: WorkspaceGitService
  readonly pullRequestBrowser: PullRequestBrowserService
  readonly workspaceReferenceService: WorkspaceReferenceService
  readonly workspaceBindings: WorkspaceBindingStore
  readonly workspaceMutations = new WorkspaceMutationCoordinator()
  readonly executorConfig: ExecutorConfigStore
  readonly executorFacts: ExecutorFactsStore
  readonly executorRegistry = new ExecutorRegistry()
  readonly delegationRuntime: DelegationService
  readonly delegationService: CoreDelegationService
  readonly delegations: CoreDelegationService
  private readonly agentService: CoreAgentService
  private readonly agentIndexSubscriptions: Array<() => void> = []
  private readonly delegationStates = new Map<string, DelegationState>()
  readonly executors: CoreExecutorService
  readonly delegationReceipts: DelegationReceipts
  readonly delegationAcceptance: DelegationAcceptance
  readonly delegationIntegration: DelegationIntegration
  private closePromise?: Promise<void>
  private readonly delegationOutput = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>
      output: { role: string; content: string }[]
    }
  >()
  /** Per-turn file records of Build projects (E-track contract §5). */
  readonly turnFiles: TurnFileRecorder
  readonly gitReceipts: GitOperationReceiptStore
  readonly terminalService: TerminalService
  readonly sessionApplicationService: CoreSessionApplicationService
  /** Retention sweep and 设置 › 高级 › 存储 (KRN-12). */
  readonly retention: RetentionService
  private retentionAtStartup: Promise<void> | null = null
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
      // The interview runs as a background turn in its own session; the
      // user answers its questions in that session (policy `wait`).
      submitHidden: async (sessionId, content) =>
        await host.runBackgroundTurn(host.scopeFor(sessionId), content, {
          source: 'onboarding',
          displayContent: '',
          uiHidden: true,
          // A hidden prompt cannot wait in the user's queue.
          unconsumed: 'withdraw',
          interactionPolicy: 'wait',
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
      { templatesDir: kept.templatesDir, sealer: kept.secretSealer },
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
      assertMutation: (area, action, view) =>
        this.assertMutation(area, action, view),
    })
    this.browserPreferencesService = new CoreBrowserPreferencesService(
      this.root,
      {
        stateRoot: this.paths.stateRoot,
        assertMutation: (area, action, view) =>
          this.assertMutation(area, action, view),
        changed: (preferences) =>
          host.emitHost({ event: 'browser_preferences_changed', preferences }),
      },
    )
    this.sessionDefaultsService = new CoreSessionDefaultsService(this.root, {
      stateRoot: this.paths.stateRoot,
      host,
      assertMutation: (area, action, view) =>
        this.assertMutation(area, action, view),
    })
    this.taskBudgetService = new CoreTaskBudgetService(this.root, {
      stateRoot: this.paths.stateRoot,
      host,
      assertMutation: (area, action, view) =>
        this.assertMutation(area, action, view),
    })
    this.webToolsService = new CoreWebToolsService(this.root, {
      stateRoot: this.paths.stateRoot,
      tools: host.webTools,
      assertMutation: (area, action, view) =>
        this.assertMutation(area, action, view),
      changed: (status) =>
        host.emitHost({ event: 'web_tools_changed', settings: status }),
    })
    this.modelService = new CoreModelService(this.paths.stateRoot, {
      sealer: kept.secretSealer,
      refreshModelConfig: () => host.refreshModelConfig(),
      afterConfigSaved: () => this.onboardingService.start({ manual: false }),
    })
    this.hooksService = new CoreHooksService({
      stateRoot: this.paths.stateRoot,
      hooks: host.hooks,
      projectRoot: (view) => this.viewProjectRoot(view),
      assertMutation: (area, action, view) =>
        this.assertMutation(area, action, view),
      sessionEvents: (view) => {
        const sessionId = this.viewedSession(view)?.id ?? null
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
      sessionLog: (sessionId) => host.sessionLog(sessionId),
      compactNow: (sessionId) => host.compactNow(sessionId),
      measureContext: (sessionId) => host.measureContext(sessionId),
      refreshRuntimeContext: () => {},
      schedulerService: kept.schedulerService,
    })
    this.pluginService = new PluginApplicationService({
      emperorHome: this.paths.stateRoot,
      // Packaged: <Resources>/runtime-defaults/bundled-plugins; dev: the repo's packages/core.
      bundledPluginRoots: [
        join(this.paths.runtimeRoot, 'bundled-plugins'),
        join(this.paths.runtimeRoot, 'packages', 'core', 'bundled-plugins'),
      ],
      computerUse: {
        enabled: () => host.computerUse?.enabled ?? null,
        setEnabled: (enabled) => host.setComputerUseEnabled(enabled),
      },
      webFetchClient: opts.webFetchClient ?? null,
      runtime: {
        mcpServer: (pluginId, scope, server, projectRoot) =>
          this.pluginActivation.mcpServer(
            pluginId,
            scope,
            server,
            projectRoot ?? null,
          ),
        // The detail's 工具: what a running server registered, and the GUI
        // tools' own definitions (never run to list them).
        mcpTools: (pluginId, scope, server, projectRoot) => {
          const key = this.pluginActivation.mcpServerKey(
            pluginId,
            scope,
            server,
            projectRoot ?? null,
          )
          const running =
            scope === 'project' || scope === 'local'
              ? projectRoot
                ? host.projectMcp.tools(projectRoot)
                : []
              : kept.mcpClient.getTools()
          return key === null
            ? []
            : running
                .filter(
                  (tool) =>
                    tool.mcpServerName === key && tool.pluginId === pluginId,
                )
                .map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: { ...tool.parameters },
                  readOnly: tool.readOnly,
                }))
        },
        computerUseTools: () => listGuiTools(),
        hookFailure: (pluginId, hookId) =>
          host.pluginHookHealth.failure(pluginId, hookId),
        appConnection: (pluginId, scope, appId) =>
          this.appConnections.state(
            appConnectionKey({ scope, pluginId, appId }),
          ),
        effectiveSkills: (projectRoot) =>
          new Map(
            kept.skillLoaders
              .forProject(projectRoot)
              .resolvedSkills()
              .map((skill) => [
                skill.name,
                { source: skill.source, skillFile: skill.skillFile },
              ]),
          ),
      },
      onChanged: () => this.pluginsChanged(),
      // Pre-0.2 project choices move to stateRoot once (SEC-07).
      knownProjects: () =>
        kept.projectStore.list().map((project) => project.project_path),
    })
    // A plugin hook starting or stopping to fail re-reads its detail.
    host.pluginHookHealth.onChange(() => this.emitPluginsChanged('hooks'))
    // Plugins apply per session scope (KRN-01): user-wide and shipped ones
    // everywhere, a project's own only in that project's sessions.
    this.pluginActivation = new PluginActivationController({
      packages: (projectRoot) =>
        this.pluginService.effectivePackages(projectRoot),
      userServerNames: async () =>
        Object.keys((await loadMcpConfig(this.paths.stateRoot)).servers),
      emperorHome: this.paths.stateRoot,
      env: () => process.env,
      mcp: {
        setPluginServers: (servers) => kept.mcpClient.setPluginServers(servers),
        reload: () => host.reloadMcp(),
        pluginServerSnapshot: (key) => kept.mcpClient.pluginServerSnapshot(key),
        pluginSkippedTools: (key) => kept.mcpClient.pluginSkippedTools(key),
      },
      projectMcp: host.projectMcp,
      hooks: host.hooks,
      projectOf: (agent) => host.projectRootOfAgent(agent),
    })
    host.setProjectPluginOverrides((projectRoot) =>
      this.pluginActivation.replacedIn(projectRoot),
    )
    kept.skillLoaders.setPluginSkillsResolver((projectRoot) =>
      this.pluginService.enabledSkillRoots(projectRoot),
    )
    // `@plugin` gestures read the plugin service (E-track contract §3).
    host.setPluginReferenceResolver((id, agent) =>
      this.pluginReference(id, host.projectRootOfAgent(agent)),
    )
    this.skillService = new CoreSkillService(this.paths.stateRoot, {
      runtimeRoot: this.paths.runtimeRoot,
      manager: kept.skillManager,
      installService: kept.skillInstallService,
      // The tools a session of that scope sees (KRN-01: its project's MCP).
      toolNames: (sessionId) => {
        const scope =
          sessionId === null ? null : host.scopeFor(sessionId, 'skills.tools')
        const adapters = new Map(
          host.mcpTools
            .adaptersFor(scope?.projectRoot ?? null)
            .map((tool) => [tool.name, tool] as const),
        )
        return host.toolSchemasFor(scope).map((schema) => {
          const adapter = adapters.get(schema.name)
          if (adapter === undefined) {
            // The GUI tools come with the Computer Use plugin (its detail
            // lists them); every other builtin names its category.
            if (Object.hasOwn(GUI_TOOL_CATALOG, schema.name))
              return { ...schema, pluginId: COMPUTER_USE_PLUGIN_ID }
            const category = host.tools.get(schema.name)?.category
            return category === undefined ? schema : { ...schema, category }
          }
          return {
            ...schema,
            mcpServer: adapter.mcpServerName,
            ...(adapter.pluginId ? { pluginId: adapter.pluginId } : {}),
          }
        })
      },
      library: kept.skillLibrary,
      // `null` = chat (no project Skills); callers always name the session.
      projectRootFor: (sessionId) => host.projectRootForSession(sessionId),
      refreshRuntimeContext: () => {},
    })
    this.environmentService = new CoreEnvironmentService({
      stateRoot: this.paths.stateRoot,
      catalog: kept.environmentCatalog,
      probe: kept.environmentProbe,
      skillManager: kept.skillManager,
      // Status without a session in view reads the runtime root.
      projectRoot: () => this.root,
      appVersion: opts.appVersion ?? '0.0.0-dev',
      runtimeRevision: opts.runtimeRevision ?? kept.environmentCatalog.revision,
      // Environment events are app-wide, not about any one session.
      emitRuntime: async (event) => {
        host.emitHost(event)
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
    const resolveGit = async (projectRoot: string) => {
      const runtime = await this.resolveGitRuntime(projectRoot)
      if (!runtime)
        throw new WorkspaceOperationError(
          'git_unavailable',
          '当前签名执行环境中没有可用 Git。',
        )
      return runtime
    }
    const runGit = async (request: GitCommandRequest) => {
      const result = await gitProcessRunner.run({
        ...request,
        timeoutMs: request.timeoutMs ?? 120_000,
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
    }
    this.workspaceGitService = new WorkspaceGitService({
      resolveProject: resolveWorkspaceProject,
      resolveRuntime: resolveGit,
      run: runGit,
      hasActiveWriter: (sessionId) =>
        host.isBusy(sessionId) ||
        this.workspaceMutations.hasActiveWriter(
          resolveWorkspaceProject(sessionId).projectRoot,
          'renderer_git',
        ),
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
    const turnGit = new HardenedGitRunner({
      resolveRuntime: resolveGit,
      run: runGit,
      privateHome: resolve(this.paths.stateRoot, 'git', 'runtime-home'),
    })
    this.executorConfig = new ExecutorConfigStore(this.paths.delegationsRoot)
    const executorConsent = new ExecutorConsentStore(this.paths.delegationsRoot)
    host.delegationConsent.store = executorConsent
    this.executorFacts = new ExecutorFactsStore(
      this.paths.delegationsRoot,
      opts.verifyGeneratedImage,
    )
    const executorRuntime = new ExecutorRuntimeService({
      root: this.paths.delegationsRoot,
      loginShell: createLoginShellEnvironment(),
      resolveRoute: async (id, backend) => {
        const config = await loadModelConfig(this.paths.modelConfigFile, {
          sealer: kept.secretSealer,
        })
        const entry = config.raw.models.find((entry) => entry.entryId === id)
        if (!entry?.apiKey)
          throw new DelegationError(
            'AUTH_REQUIRED',
            'selected model credential route is missing',
          )
        if (
          entry.protocol !==
          (backend === 'claude-code' ? 'anthropic' : 'openai')
        )
          throw new DelegationError(
            'AUTH_ROUTE_INVALID',
            'credential route protocol does not match the external executor',
          )
        if (
          (entry.legacy?.extraBody &&
            Object.keys(entry.legacy.extraBody).length) ||
          (entry.legacy?.extraHeaders &&
            Object.keys(entry.legacy.extraHeaders).length)
        )
          throw new DelegationError(
            'AUTH_ROUTE_UNSUPPORTED',
            'external executors require a credential route without custom legacy headers/body',
          )
        return { apiKey: entry.apiKey, baseUrl: entry.apiBase }
      },
    })
    const executorProcesses = new ManagedAgentProcess({
      sandbox: host.sandboxBackend,
      // 诊断模式: boundary markers and the native scanner (AGT-04).
      diagnostics: () => this.executorConfig.read().diagnosticsMode === true,
    })
    const checkExecutorAuth = async (
      profile: Parameters<typeof executorRuntime.prepare>[0],
    ) => {
      const runtime = await executorRuntime.probe(profile)
      this.executorFacts.bind(profile, runtime.environment)
    }
    const externalWorkspaces = new DelegationWorkspaceService({
      root: this.paths.delegationsRoot,
      runner: turnGit,
      mutations: this.workspaceMutations,
      snapshots: new SnapshotService({
        runner: turnGit,
        tempRoot: join(this.paths.delegationsRoot, 'indexes'),
        resources: this.workspaceMutations.resources,
      }),
    })
    this.delegationRuntime = new DelegationService({
      facts: this.executorFacts,
      root: this.paths.delegationsRoot,
      config: () => this.executorConfig.read(),
      registry: this.executorRegistry,
      adapters: new Map<string, ExecutorAdapter>([
        [
          'claude-code',
          new ClaudeExecutorAdapter({ processes: executorProcesses }),
        ],
        ['codex', new CodexExecutorAdapter({ processes: executorProcesses })],
      ]),
      parent: (owner) => host.delegationParent(owner),
      workspaces: externalWorkspaces,
      mutations: this.workspaceMutations,
      runtime: (profile, id) => executorRuntime.prepare(profile, id),
      notices: {
        parent: (owner) => host.delegationNoticeParent(owner),
        canWake: (owner) => host.delegationNoticeParent(owner) !== undefined,
        flush: (sessionId) => host.sessions.flush(sessionId),
      },
      acceptanceCurrent: (id) => this.delegationAcceptance.current(id),
      deliveryRequiresAcceptance: (id, record) => {
        const receipt = this.delegationReceipts.get(id)
        return requiresArtifactAcceptance(record, receipt)
      },
      onState: (state, event) => this.projectDelegation(state, event),
      onEvent: (event) => {
        if (
          event.type !== 'text_delta' &&
          event.type !== 'tool_started' &&
          event.type !== 'tool_finished'
        )
          return
        const key = event.runId,
          pending = this.delegationOutput.get(key)
        const item = {
          role: event.type === 'text_delta' ? 'assistant' : 'tool',
          content:
            event.type === 'text_delta'
              ? event.text
              : JSON.stringify({
                  type: event.type,
                  id: event.id,
                  ...('name' in event ? { name: event.name } : {}),
                  ...('status' in event ? { status: event.status } : {}),
                  ...('detail' in event ? { detail: event.detail } : {}),
                }),
        }
        if (pending) pending.output.push(item)
        else
          this.delegationOutput.set(key, {
            output: [item],
            timer: setTimeout(() => this.flushDelegationOutput(key), 100),
          })
      },
      onSettled: async (id, runId) => {
        this.flushDelegationOutput(runId)
        const receipt = await this.delegationReceipts.collect(runId)
        await this.delegationRuntime.bindReceipt(
          id,
          runId,
          receipt.id,
          'unverified',
        )
      },
      onStopRoot: (id) => this.delegationAcceptance.stopRoot(id),
      onQuestion: (question, signal) =>
        host.delegationInteractions.ask(question, signal),
      consent: (owner, profile, spec, signal) =>
        host.delegationConsent.decide({
          owner,
          profile,
          description: spec.description,
          ...(owner.parentCallId ? { callId: owner.parentCallId } : {}),
          ...(signal ? { signal } : {}),
        }),
    })
    host.delegations = this.delegationRuntime
    this.agentService = new CoreAgentService({
      sessions: host.sessions,
      roots: () =>
        host.kept.sessionStore.list({ includeArchived: true }).map((s) => s.id),
      external: () => this.delegationRuntime.list(),
      live: (id) => host.subagents.record(id),
      waiting: (id) => host.pending.hasPending(id),
      changed: (event) =>
        host.emitHost({
          event: 'agent_tree_changed',
          ...event,
          session_id: event.rootSessionId,
        }),
    })
    this.agentService.list([])
    this.agentIndexSubscriptions.push(
      host.rawTap((id, event) => this.agentService.sessionChanged(id, event)),
      host.pending.onChange((id) => this.agentService.sessionChanged(id)),
    )
    const facts = (runId: string) => {
      const state = this.delegationRuntime.list().find((s) => s.runs[runId])
      if (!state?.record)
        throw new DelegationError('RUN_NOT_FOUND', 'external run not found')
      return {
        record: state.record,
        run: state.runs[runId]!,
        lease: externalWorkspaces.get(state.record.workspaceLeaseId),
      }
    }
    this.delegationReceipts = new DelegationReceipts({
      root: this.paths.delegationsRoot,
      runner: turnGit,
      mutations: this.workspaceMutations,
      resolve: facts,
    })
    this.delegationAcceptance = new DelegationAcceptance({
      root: this.paths.delegationsRoot,
      receipts: this.delegationReceipts,
      mutations: this.workspaceMutations,
      processes: executorProcesses,
      scope: (runId) => {
        const { record, run } = facts(runId),
          parent = host.delegationParent(record.owner)
        return {
          taskScopeId: record.owner.taskScopeId,
          permission: parent.planMode ? 'read-only' : parent.policy.mode,
          rootSessionId: record.owner.rootSessionId,
          generation: run.generation,
        }
      },
    })
    this.delegationIntegration = new DelegationIntegration({
      root: this.paths.delegationsRoot,
      receipts: this.delegationReceipts,
      acceptance: this.delegationAcceptance,
      mutations: this.workspaceMutations,
      runner: turnGit,
      scope: (runId) => facts(runId).record.owner.taskScopeId,
      canApply: (runId) => {
        const { record } = facts(runId),
          entry = host.kept.sessionStore.get(record.owner.rootSessionId)
        if (!entry || entry.archived_at) return false
        const parent = host.delegationParent(record.owner)
        return !parent.planMode && parent.policy.mode !== 'read-only'
      },
    })
    this.delegationService = new CoreDelegationService({
      root: this.paths.delegationsRoot,
      service: this.delegationRuntime,
      cachedState: (id) => this.delegationStates.get(id),
      receipts: this.delegationReceipts,
      acceptance: this.delegationAcceptance,
      integration: this.delegationIntegration,
      session: (id) => host.kept.sessionStore.get(id),
      // Guarded by the owning chat itself, named by the caller (KRN-01).
      assertMutation: (id, action) => {
        if (action !== 'control')
          this.assertMutation('delegations', action, { sessionId: id })
      },
    })
    this.delegations = this.delegationService
    this.executors = new CoreExecutorService({
      modelCatalog: new ExecutorModelCatalogService({
        root: this.paths.delegationsRoot,
        runtime: executorRuntime,
        processes: executorProcesses,
        onPrepared: (profile, runtime) =>
          this.executorFacts.bind(profile, runtime.environment),
      }),
      facts: this.executorFacts,
      store: this.executorConfig,
      registry: this.executorRegistry,
      assertConfigure: (view) =>
        this.assertMutation('executors', 'configure', view),
      refresh: () => this.delegationRuntime.probeProfiles(),
      checkAuth: checkExecutorAuth,
      consent: executorConsent,
    })
    host.delegationQuestionTimeoutMs = () => {
      try {
        return this.executorConfig.read().limits.questionTimeoutMs
      } catch {
        return 15 * 60_000
      }
    }
    const projectRootOf = (sessionId: string): string | null => {
      try {
        return resolveWorkspaceProject(sessionId).projectRoot
      } catch {
        return null
      }
    }
    host.tools.setWorkspaceAccessLeaseProvider({
      acquire: async (call) => {
        if (!mayWriteFiles(call.name)) return undefined
        const root = host.sandbox.resolve({
          session: call.agent?.session,
        }).workspaceRoot
        const args = call.arguments as {
          workdir?: unknown
          file_path?: unknown
        } | null
        const extra = args?.workdir ?? args?.file_path
        const keys = [workspaceMutationDomain(root)]
        if (typeof extra === 'string')
          keys.push(workspaceMutationDomain(resolve(root, extra)))
        return this.workspaceMutations.resources.acquire(
          { keys, mode: 'shared', owner: call.callId },
          call.signal,
        )
      },
    })
    this.turnFiles = new TurnFileRecorder({
      snapshots: new TurnSnapshots({
        exec: (cwd, args, options) => turnGit.execute(cwd, args, options),
        tempDir: resolve(this.paths.stateRoot, 'git', 'turn-index'),
      }),
      projectRoot: projectRootOf,
      workspaceRoot: (sessionId) => host.sessionWorkspaceRoot(sessionId),
      rootOf: (agent) => host.rootOf(agent),
      sessionLog: (sessionId) => host.sessionLog(sessionId),
      workspaceBusy: (projectRoot) => {
        if (this.workspaceMutations.hasActiveWriter(projectRoot)) return true
        const domain = workspaceMutationDomain(projectRoot)
        return host
          .busySessions()
          .some(
            (sessionId) =>
              workspaceMutationDomain(host.sessionWorkspaceRoot(sessionId)) ===
              domain,
          )
      },
      othersRunning: (sessionId) => {
        const projectRoot = projectRootOf(sessionId)
        if (projectRoot === null) return false
        const domain = workspaceMutationDomain(projectRoot)
        return host
          .busySessions()
          .some(
            (other) =>
              other !== sessionId &&
              workspaceMutationDomain(host.sessionWorkspaceRoot(other)) ===
                domain,
          )
      },
      runExclusive: (workspaceRoot, owner, action) =>
        this.workspaceMutations.runExclusive(workspaceRoot, owner, action),
    })
    this.turnFiles.install(host)
    this.appConnections = new AppConnectionRegistry({
      [appConnectionKey(GITHUB_APP)]: {
        check: async () =>
          githubConnectionState(await this.pullRequestBrowser.status()),
      },
      // The Computer Use package's drivers: local and cheap, read fresh.
      ...Object.fromEntries(
        COMPUTER_USE_DRIVERS.map((driver) => [
          appConnectionKey({
            scope: 'managed',
            pluginId: COMPUTER_USE_PLUGIN_ID,
            appId: driver,
          }),
          {
            ttlMs: 0,
            check: async () =>
              computerUseDriverState(
                await this.computerUseStatusOnce(),
                driver,
              ),
          },
        ]),
      ),
    })
    this.pullRequestBrowser = new PullRequestBrowserService({
      cwd: this.paths.stateRoot,
      resolveRuntime:
        opts.github?.resolveRuntime ??
        (() => this.resolveGhRuntime(this.paths.stateRoot)),
      run: opts.github?.run ?? runGh,
    })
    this.workspaceFilesService = new WorkspaceFilesService({
      resolveProject: resolveWorkspaceProject,
      filterIgnored: async (sessionId, _projectRoot, paths) =>
        await this.workspaceGitService.ignoredPaths({ sessionId, paths }),
    })
    this.workspaceReferenceService = new WorkspaceReferenceService({
      delegatedImageRoots: (sessionId, delegationId) =>
        this.delegationImageRoots(
          this.delegationService.get({ id: delegationId, sessionId }).record!,
        ),
      delegatedRoot: (sessionId, delegationId) => {
        this.requireReadableSession(sessionId, 'references.resolve')
        return this.delegationService.get({ id: delegationId, sessionId })
          .record!.cwd
      },
      resolveProject: resolveWorkspaceProject,
      resolveFileRoot: (sessionId) =>
        this.host.sessionWorkspaceRoot(
          this.requireReadableLogSession(sessionId, 'references.resolve'),
        ),
      authorizeSession: (sessionId) => {
        this.requireReadableLogSession(sessionId, 'references.preview')
      },
      webFetchClient: opts.webFetchClient ?? null,
      resolveAttachment: (attachmentId) => {
        const attachment = this.attachmentStore.get(attachmentId)
        return attachment
          ? {
              root: this.attachmentStore.base,
              relativePath: relative(
                this.attachmentStore.base,
                resolve(this.attachmentStore.root, attachment.rel_path),
              ),
              label: attachment.name,
            }
          : null
      },
      githubPreview: (target, signal) =>
        this.readGitHubReferencePreview(target, signal),
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
      unloadSession: (sessionId) => host.unloadSession(sessionId),
      forgetSessionTree: (sessionId, dir) =>
        host.forgetSessionTree(sessionId, join(dir, LOG_FILE)),
      forgetTurnFiles: (sessionId, projectRoot) =>
        this.turnFiles.forgetSession(sessionId, projectRoot),
      stopSession: (sessionId) => {
        host.stop(sessionId)
      },
      closeTerminals: (sessionId) =>
        this.terminalService.closeSession(sessionId),
      activateSession: (sessionId) => this.activateSession(sessionId),
      sessionLeftList: (sessionId) => this.unpinSidebarSession(sessionId),
    })
    this.retention = new RetentionService({
      paths: this.paths,
      memoryVersions: kept.sharedMemory.versions,
      delegations: () =>
        this.delegationRuntime.list().flatMap((state) =>
          state.record
            ? [
                {
                  id: state.record.id,
                  rootSessionId: state.record.owner.rootSessionId,
                  availability: state.record.availability,
                },
              ]
            : [],
        ),
      sessions: {
        expired: () =>
          kept.sessionStore.trashedBefore(
            Date.now() - SESSION_TRASH_RETENTION_MS,
          ),
        purgeExpired: () =>
          this.sessionApplicationService.purgeExpiredDeleted(),
      },
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
      activate: (sessionId) => this.activateSession(sessionId),
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
      // Prompts held after a failed or stopped turn wait for the user; they
      // do not make the session busy.
      sessionBusy: (sessionId) =>
        host.isBusy(sessionId) ||
        host
          .queuedPrompts(sessionId)
          .some((prompt) => prompt.state === 'queued'),
      compact: (sessionId) => host.compactNow(sessionId),
      stop: (sessionId) => host.stop(sessionId),
      activateModel: async (entryId, sessionId) =>
        await this.model.activate({ entryId }, { sessionId }),
      setReasoningEffort: async (entryId, reasoningEffort, sessionId) =>
        await this.model.setReasoningEffort(
          { entryId, reasoningEffort },
          { sessionId },
        ),
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
      projectLegacyPrivateData: (view) => {
        const projectPath = this.viewProjectRoot(view)
        if (!projectPath) return null
        return {
          projectPath,
          ...kept.projectStore.detectLegacyPrivateData(projectPath),
        }
      },
      schedulerDiagnostics: () => ({
        ...kept.schedulerStore.diagnostics(),
        startError: kept.schedulerService.startFailure(),
      }),
      runtimeStats: (view) =>
        this.runtimeStats(this.viewedSession(view)?.id ?? null),
      workspacePolicy: (view) => {
        const entry = this.viewedSession(view)
        return {
          workspaceRoot: host.workspaceRootFor(entry),
          sandbox: host.controlPayload(entry?.id ?? null).sandbox,
        }
      },
      sandboxCapability: () => ({ ...kept.processSandbox.capability() }),
      processRuntime: () => kept.processRuntime.capabilityReport(),
      subagents: (view) => this.allSubagents(view),
      kernel: (view) => ({
        // The session the page was opened from (the UI's, never a focus).
        activeSessionId: this.viewedSession(view)?.id ?? null,
        busySessions: host.busySessions(),
        activeRoute: host.llm.activeRoute()?.id ?? null,
        tools: host
          .toolSchemasFor(this.viewScopeOf(view))
          .map((tool) => tool.name),
        projectMcp: host.projectMcp.snapshot().map((instance) => ({
          projectRoot: instance.projectRoot,
          holders: instance.holders,
          state: instance.state,
        })),
        archivedLegacySessions: kept.archivedLegacySessions,
        lifecycle: this.lifecyclePayload(),
      }),
      effectiveConfig: () => this.effectiveConfigService.payload(),
      commandCatalog: (view) => {
        const sessionId = this.viewedSession(view)?.id ?? null
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
      externalToolConfig: (view) => {
        const projectPath = this.viewProjectRoot(view)
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
    const host =
      opts.host ??
      (await HarnessHost.create({ ...opts, startScheduler: false }))
    let api: CoreApi | null = null
    try {
      api = new CoreApi(root, host, opts)
      await api.delegationRuntime.reconcile()
      api.agentService.rebuild()
      await api.delegationAcceptance.reconcile()
      api.delegationIntegration.reconcile()
      await api.environmentService.initialize()
      await api.delegationRuntime.probeProfiles()
      await api.sessionTransitionService.recover()
      await api.syncPlugins()
      // After the plugins: a run caught up on at launch needs their Hooks.
      await host.startScheduler()
      // 最近删除 keeps a deleted session for 30 days (FIX-01).
      await api.sessionApplicationService
        .purgeExpiredDeleted()
        .catch((error: unknown) =>
          logger.warn('purging expired deleted sessions failed', {
            error: String(error),
          }),
        )
      api.startRetention()
      return api
    } catch (error) {
      if (api) await api.close().catch(() => {})
      else await host.close().catch(() => {})
      throw error
    }
  }

  /**
   * Write and sync every session's pending log events now. Synchronous, so
   * quit can call it before anything that might hang or be cut short.
   */
  flushAll(): void {
    this.host.sessions.flush(undefined, { sync: true })
  }

  /**
   * Quit overran its deadline: kill every child process tree and terminal
   * now, synchronously, so nothing outlives the app (FIX-07).
   */
  forceStop(): void {
    this.host.kept.processRuntime.terminateAll('app quit timeout')
    this.terminalService.closeAll()
  }

  /**
   * The retention sweep after startup (KRN-12): in the background, so it
   * never holds up or fails startup; what it could not do is only logged.
   */
  private startRetention(): void {
    this.retentionAtStartup = this.retention.sweep().then(
      (report) => {
        if (report.errors.length > 0)
          logger.warn('retention sweep incomplete', { errors: report.errors })
        else if (report.freedBytes > 0)
          logger.info('retention sweep freed space', {
            bytes: report.freedBytes,
          })
      },
      (error: unknown) =>
        logger.warn('retention sweep failed', { error: String(error) }),
    )
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      // A sweep still running gets a moment; quit never waits on it longer.
      if (this.retentionAtStartup)
        await Promise.race([
          this.retentionAtStartup,
          new Promise<void>((done) => setTimeout(done, 2000).unref()),
        ])
      this.flushAll()
      await this.executors.close()
      this.terminalService.closeAll()
      this.onboardingService.dispose()
      for (const unsubscribe of this.agentIndexSubscriptions) unsubscribe()
      try {
        await this.delegationAcceptance.stopRoot()
        await this.delegationRuntime.shutdown()
      } finally {
        for (const key of this.delegationOutput.keys())
          this.flushDelegationOutput(key)
        await this.host.close()
      }
    })()
    return this.closePromise
  }

  private flushDelegationOutput(runId: string): void {
    const pending = this.delegationOutput.get(runId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.delegationOutput.delete(runId)
    const state = [...this.delegationStates.values()].find((s) => s.runs[runId])
    if (!state?.record) return
    this.appendDelegationProjection(state, {
      event: 'delegation_output',
      delegation_id: state.record.id,
      run_id: runId,
      journal_seq: state.lastSeq,
      output: pending.output,
    })
  }
  private appendDelegationProjection(
    state: DelegationState,
    projection: DelegationProjection,
  ): void {
    if (
      !state.record ||
      !this.host.kept.sessionStore.get(state.record.owner.rootSessionId)
    )
      return
    const owner = state.record.owner
    const payload = JSON.parse(
      JSON.stringify({
        ...projection,
        parent_call_id: owner.parentCallId,
        current_run_id: state.record.currentRunId,
        backend: state.record.backend,
      }),
    ) as DelegationProjection
    // The log, not the agent: projecting a state change must not open a
    // historical conversation or run its SessionStart hooks (AGT-04).
    const parent = this.host.sessionLog(owner.parentAgentId)
    if (parent) {
      parent.append('delegation/projection', payload)
      this.host.sessions.flush(parent.id)
    }
    // Child log projection streams raw events to its own timeline. Its
    // legacy projector does not forward delegation events to the root UI.
    if (owner.parentAgentId !== owner.rootSessionId)
      this.host.emitHost({ ...payload, session_id: owner.rootSessionId })
  }
  private projectDelegation(
    state: DelegationState,
    event: DelegationEvent,
  ): void {
    const record = state.record
    if (!record) return
    this.delegationStates.set(record.id, state)
    this.agentService.externalChanged(state)
    const name =
      event.type === 'created'
        ? 'delegation_created'
        : event.type === 'interaction'
          ? 'delegation_interaction'
          : event.type === 'receipt'
            ? 'delegation_receipt'
            : 'delegation_run_changed'
    const runId =
      'runId' in event
        ? event.runId
        : event.type === 'run-created'
          ? event.run.id
          : record.currentRunId
    const run = runId ? state.runs[runId] : undefined
    this.appendDelegationProjection(state, {
      event: name,
      delegation_id: record.id,
      run_id: runId,
      journal_seq: state.lastSeq,
      ...(run ? { task: externalTask(state, run) } : {}),
    })
  }

  async bootstrap(opts: { sessionId?: string | null } = {}) {
    const sessionId = String(opts.sessionId ?? '').trim()
    if (sessionId)
      this.activateSession(
        this.requireReadableSession(sessionId, 'bootstrap').id,
      )
    const kept = this.host.kept
    // The UI's starting state is the session it shows (KRN-01: besides
    // activateSession, the only reader of it).
    const focused = this.focusedSessionId
    const activeSessionId =
      focused !== null && kept.sessionStore.get(focused) ? focused : null
    const view: ViewScope = { sessionId: activeSessionId }
    const sessionDiagnostics = kept.sessionStore.diagnostics()
    const route = this.host.llm.activeRoute()
    const replay =
      activeSessionId && kept.sessionStore.get(activeSessionId)
        ? this.runtime.replay({ sessionId: activeSessionId })
        : { events: [], latestSeq: 0 }
    return {
      app: 'Emperor Agent',
      /** The session this bootstrap describes: the one the UI shows (null: none). */
      sessionId: activeSessionId,
      sessionIndexSource: sessionDiagnostics.sessionIndexSource,
      repairedSessions: sessionDiagnostics.repairedSessions,
      model: route?.modelId ?? '',
      provider: route?.catalogProvider ?? '',
      providerLabel: route?.displayName ?? '',
      tools: this.skills.tools(view),
      ...(() => {
        const catalog = this.skills.list({ sessionId: activeSessionId })
        return { skills: catalog.skills, invalidSkills: catalog.invalid }
      })(),
      plugins: this.plugins.list(view),
      memory: this.memory.get(view),
      modelConfig: await this.model.getConfig(),
      profileOnboarding: this.onboarding.getProfileStatus(),
      scheduler: this.scheduler.get(),
      control: this.control.get(activeSessionId),
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
      diagnostics: await this.diagnostics.get(view),
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
      references?: MessageReference[] | null
      /** In-process adapters only; IPC validation never accepts AbortSignal objects. */
      signal?: AbortSignal | null
      /** Trusted in-process adapter provenance. Browser IPC remains `chat`. */
      source?: string | null
      /** In-process adapters only: this session's UI events during the submit. */
      emit?: ((event: Record<string, unknown>) => void | Promise<void>) | null
      /** In-process adapters only: discard the prompt if no turn takes it. */
      unconsumed?: 'keep' | 'withdraw' | null
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
        references: opts.references ?? null,
        signal: opts.signal ?? null,
        source: opts.source ?? 'chat',
        emit: opts.emit ?? null,
        unconsumed: opts.unconsumed ?? null,
      }),
    listQueuedPrompts: (opts: { sessionId: string }) =>
      this.chatService.listQueuedPrompts(opts),
    manageQueuedPrompt: (opts: {
      sessionId: string
      promptId: string
      action: 'cancel' | 'interject' | 'send'
    }) => this.chatService.manageQueuedPrompt(opts),
    /** Stop a task, or the turn of the named session (KRN-01: never a default). */
    stopRuntime: async (
      opts: {
        taskId?: string | null
        kind?: string | null
        sessionId?: string | null
      } = {},
    ) => {
      const taskId = String(opts.taskId ?? '').trim()
      const sessionId = String(opts.sessionId ?? '').trim()
      let cancelled = 0
      if (taskId) {
        cancelled = this.cancelTask(taskId, sessionId || null) ? 1 : 0
      } else {
        if (!sessionId) throw new SessionRequiredError('chat.stopRuntime')
        if (this.host.stop(sessionId)) cancelled = 1
      }
      return { cancelled, active: this.activeTaskInfos() }
    },
    /**
     * In-process adapters (ACP): one background turn in the named session,
     * which keeps its own scope and never moves the session in view.
     */
    runBackground: async (
      input: { sessionId: string; content: string } & BackgroundTurnOptions,
    ): Promise<BackgroundTurnOutcome> => {
      const session = this.requireReadableSession(
        String(input.sessionId ?? '').trim(),
        `${input.source}.runBackground`,
      ) as { id: string; transitioned_to_session_id?: string | null }
      if (session.transitioned_to_session_id)
        throw new InvalidSessionError(
          `${input.source}.runBackground cannot append to transitioned session ${session.id}`,
          session.id,
        )
      return await this.host.runBackgroundTurn(
        this.host.scopeFor(session.id),
        String(input.content ?? ''),
        input,
      )
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
      references?: MessageReference[]
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
      if (!String(opts.sessionId ?? '').trim())
        throw new SessionRequiredError('runtime.replay')
      const sessionId = this.requireReadableSessionId(
        opts.sessionId,
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
      body: { content?: unknown } | string | undefined,
      view: ViewScope,
    ): Promise<UserConfigPayload> => {
      this.assertMutation('config', 'save', view)
      const content =
        typeof body === 'string' ? body : String(body?.content ?? '')
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
    saveConfig: async (raw: Dict, view: ViewScope) => {
      // Saving MCP config lets MCPClient spawn servers.*.command; guard it like any mutation.
      this.assertMutation('mcp', 'saveConfig', view)
      await this.hooksService.authorizeConfigChange('mcp.saveConfig', raw)
      return this.configService.saveMcpConfig(raw)
    },
    /** Merge pasted servers (Claude/Cursor/VS Code/Emperor formats) by name; `dryRun` previews. */
    importServers: async (
      input: {
        raw: unknown
        overwrite?: boolean | string[]
        dryRun?: boolean
      },
      view?: ViewScope,
    ) => {
      if (input.dryRun !== true) {
        this.assertMutation('mcp', 'importServers', view)
        await this.hooksService.authorizeConfigChange(
          'mcp.importServers',
          input,
        )
      }
      const result = await this.configService.importMcpServers(input)
      return { ...result, status: this.host.kept.mcpClient.snapshot() }
    },
    setServerEnabled: async (
      input: { name: string; enabled: boolean },
      view: ViewScope,
    ) => {
      this.assertMutation('mcp', 'setServerEnabled', view)
      await this.hooksService.authorizeConfigChange(
        'mcp.setServerEnabled',
        input,
      )
      const result = await this.configService.setMcpServerEnabled(input)
      return { ...result, status: this.host.kept.mcpClient.snapshot() }
    },
    removeServer: async (input: { name: string }, view: ViewScope) => {
      this.assertMutation('mcp', 'removeServer', view)
      await this.hooksService.authorizeConfigChange('mcp.removeServer', input)
      const result = await this.configService.removeMcpServer(input)
      return { ...result, status: this.host.kept.mcpClient.snapshot() }
    },
  }

  readonly hooks = {
    getConfig: async (opts: Dict = {}) => this.hooksService.getConfig(opts),
    saveConfig: async (raw: unknown, view: ViewScope) =>
      this.hooksService.saveConfig(raw, view),
    /** `hook/*` audit of the session in view. */
    getAudit: async (
      opts: {
        cursor?: string | number | null
        limit?: number | string | null
        eventName?: string | null
        outcome?: string | null
        sourceId?: string | null
        runId?: string | null
      },
      view: ViewScope,
    ) => this.hooksService.getAudit(opts, view),
    getMetadata: () => this.hooksService.getMetadata(),
    validateConfig: (input: Dict, view?: ViewScope) =>
      this.hooksService.validateConfig(input, view),
    setProjectTrust: async (input: Dict) =>
      this.hooksService.setProjectTrust(input),
    testMatch: async (input: Dict, view?: ViewScope) =>
      this.hooksService.testMatch(input, view),
    testRun: async (input: Dict, view: ViewScope): Promise<Dict> =>
      this.hooksService.testRun(input, view),
    cancelRun: async (input: Dict) => this.hooksService.cancelRun(input),
  }

  readonly model = {
    getConfig: async () => this.modelService.getConfig(),
    resolveProfile: (
      input: Parameters<CoreModelService['resolveProfile']>[0],
    ) => this.modelService.resolveProfile(input),
    saveEntry: async (
      entry: Parameters<CoreModelService['saveEntry']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('model', 'saveEntry', view)
      await this.hooksService.authorizeConfigChange('model.saveEntry', entry)
      return this.modelService.saveEntry(entry)
    },
    saveEntries: async (
      input: Parameters<CoreModelService['saveEntries']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('model', 'saveEntries', view)
      await this.hooksService.authorizeConfigChange('model.saveEntries', input)
      return this.modelService.saveEntries(input)
    },
    updateConnection: async (
      input: Parameters<CoreModelService['updateConnection']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('model', 'updateConnection', view)
      await this.hooksService.authorizeConfigChange('model.updateConnection', {
        ...input,
        apiKey: input.apiKey ? '***' : input.apiKey,
      })
      return this.modelService.updateConnection(input)
    },
    refreshMetadata: async (
      input: Parameters<CoreModelService['refreshMetadata']>[0],
      view: ViewScope,
    ) => {
      // A preview only reads; applying writes the file.
      if (input.apply) {
        this.assertMutation('model', 'refreshMetadata', view)
        await this.hooksService.authorizeConfigChange(
          'model.refreshMetadata',
          input,
        )
      }
      return this.modelService.refreshMetadata(input)
    },
    replaceEntry: async (
      input: Parameters<CoreModelService['replaceEntry']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('model', 'replaceEntry', view)
      await this.hooksService.authorizeConfigChange('model.replaceEntry', input)
      return this.modelService.replaceEntry(input)
    },
    lookupDefaults: (
      input: Parameters<CoreModelService['lookupDefaults']>[0],
    ) => this.modelService.lookupDefaults(input),
    discardRejected: async ({ key }: { key: string }, view: ViewScope) => {
      this.assertMutation('model', 'discardRejected', view)
      await this.hooksService.authorizeConfigChange('model.discardRejected', {
        key,
      })
      return this.modelService.discardRejected(key)
    },
    savePolicy: async (
      policy: Parameters<CoreModelService['savePolicy']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('model', 'savePolicy', view)
      await this.hooksService.authorizeConfigChange('model.savePolicy', policy)
      return this.modelService.savePolicy(policy)
    },
    deleteEntry: async ({ entryId }: { entryId: string }, view: ViewScope) => {
      this.assertMutation('model', 'deleteEntry', view)
      await this.hooksService.authorizeConfigChange('model.deleteEntry', {
        entryId,
      })
      return this.modelService.deleteEntry(entryId)
    },
    activate: async ({ entryId }: { entryId: string }, view: ViewScope) => {
      this.assertMutation('model', 'activate', view)
      await this.hooksService.authorizeConfigChange('model.activate', {
        entryId,
      })
      return this.modelService.activate(entryId)
    },
    setReasoningEffort: async (
      {
        entryId,
        reasoningEffort,
      }: {
        entryId: string
        reasoningEffort: string | null
      },
      view: ViewScope,
    ) => {
      this.assertMutation('model', 'setReasoningEffort', view)
      await this.hooksService.authorizeConfigChange(
        'model.setReasoningEffort',
        { entryId, reasoningEffort },
      )
      return this.modelService.setReasoningEffort(entryId, reasoningEffort)
    },
    /** Read-only: the vendor's model list for a draft connection. */
    discoverModels: async (body: ModelDiscoveryInput) =>
      this.modelService.discoverModels(body),
    /** Read-only: check a draft connection's key and address (UI-29). */
    probeConnection: async (body: ModelConnectionInput) =>
      this.modelService.probeConnection(body),
    test: async (body: Dict): Promise<Dict> => this.modelService.test(body),
  }

  readonly onboarding = {
    getProfileStatus: () => this.onboardingService.payload(),
    startProfileInterview: async () =>
      this.onboardingService.start({ manual: true }),
    skipProfileInterview: async () => this.onboardingService.skip(),
  }

  readonly control = {
    /** The control state of a session (null: none, e.g. a draft: the defaults). */
    get: (sessionId: string | null) =>
      this.host.controlPayload(this.controlSessionId(sessionId)),
    /** Switch the permission preset (`read-only` | `workspace-write` | `danger-full-access`). */
    setPermissionMode: (preset: string, sessionId: string) =>
      this.host.setPermissionPreset(
        this.requireControlSession(sessionId, 'control.setPermissionMode'),
        preset,
      ),
    /** `plan` enters plan mode, anything else leaves it. */
    setMode: (mode: string, sessionId: string) => {
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

  /** Goals of a named session (KRN-01: never the one in view by default). */
  readonly goals = {
    start: (input: GoalStartInput) => this.goalService.start(input),
    list: (input: { sessionId: string | null }) => this.goalService.list(input),
    get: (goalId: string, sessionId: string) =>
      this.goalService.get(goalId, sessionId),
    pause: (goalId: string, sessionId: string) =>
      this.goalService.pause(goalId, sessionId),
    resume: (goalId: string, sessionId: string) =>
      this.goalService.resume(goalId, sessionId),
    cancel: (goalId: string, reason: string | null, sessionId: string) =>
      this.goalService.cancel(goalId, reason, sessionId),
  }

  readonly scheduler = {
    get: () => ({
      status: this.host.kept.schedulerService.status(),
      jobs: this.host.kept.schedulerService
        .listJobs({ includeDisabled: true })
        .map(schedulerJobPublicPayload),
      diagnostics: this.host.kept.schedulerStore.diagnostics(),
    }),
    /** A job without a session runs in the one the creator shows (`view`). */
    createJob: (args: Dict, view: ViewScope) => {
      this.assertMutation('scheduler', 'create', view)
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
        targetSessionId: this.viewedSession(view)?.id ?? null,
      })
      return {
        job: schedulerJobPublicPayload(job),
        scheduler: this.scheduler.get(),
      }
    },
    updateJob: (jobId: string, args: Dict, view: ViewScope) => {
      this.assertMutation('scheduler', 'update', view)
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
        targetSessionId: this.viewedSession(view)?.id ?? null,
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
    runJob: async (jobId: string, view: ViewScope) => {
      this.assertMutation('scheduler', 'run', view)
      const ran = await this.host.kept.schedulerService.runJob(jobId, {
        force: true,
      })
      if (!ran) throw new Error(`scheduler job not found: ${jobId}`)
      return { scheduler: this.scheduler.get() }
    },
    pauseJob: (jobId: string, view: ViewScope) => {
      this.assertMutation('scheduler', 'pause', view)
      const job = this.host.kept.schedulerService.enableJob(jobId, false)
      if (job === 'not_found')
        throw new Error(`scheduler job not found: ${jobId}`)
      return {
        job: schedulerJobPublicPayload(job),
        scheduler: this.scheduler.get(),
      }
    },
    resumeJob: (jobId: string, view: ViewScope) => {
      this.assertMutation('scheduler', 'resume', view)
      const job = this.host.kept.schedulerService.enableJob(jobId, true)
      if (job === 'not_found')
        throw new Error(`scheduler job not found: ${jobId}`)
      return {
        job: schedulerJobPublicPayload(job),
        scheduler: this.scheduler.get(),
      }
    },
    deleteJob: (jobId: string, view: ViewScope) => {
      this.assertMutation('scheduler', 'delete', view)
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

  /** Read-only children of existing owning roots; archived roots remain inspectable. */
  readonly agents = {
    list: (input: { rootSessionIds: string[] }) => {
      const roots = [
        ...new Set(input.rootSessionIds.map((id) => String(id).trim())),
      ]
      for (const id of roots) {
        if (
          !id ||
          id.startsWith(DRAFT_SESSION_PREFIX) ||
          !this.host.kept.sessionStore.get(id)
        )
          throw new InvalidSessionError(
            'agents.list requires a readable owning root session',
            id,
          )
      }
      return this.agentService.list(roots)
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
    /** Soft delete: the session goes to 最近删除 and can be restored. */
    delete: (sessionId: string): Promise<Dict> =>
      this.sessionApplicationService.delete(sessionId),
    listDeleted: () => this.sessionApplicationService.listDeleted(),
    /** 设置 › 常规 › 会话: the permission preset a new session starts in. */
    defaults: (): SessionDefaults => this.sessionDefaultsService.get(),
    setDefaults: (
      change: { permission: SessionPermission },
      view: ViewScope,
    ): Promise<SessionDefaults> =>
      this.sessionDefaultsService.update(change, view),
    restoreDeleted: (sessionId: string) =>
      this.sessionApplicationService.restoreDeleted(sessionId),
    purgeDeleted: (sessionId: string) =>
      this.sessionApplicationService.purgeDeleted(sessionId),
    purgeExpiredDeleted: (now?: number) =>
      this.sessionApplicationService.purgeExpiredDeleted(now),
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
    /**
     * 命令面板 (UI-S02): sessions whose own messages or replies contain the
     * query, newest first, one snippet each. Archived sessions are included.
     */
    search: async (input: {
      query: string
      limit?: number
    }): Promise<{ hits: SessionSearchHit[] }> => {
      this.host.sessions.flush(undefined, { sync: true })
      const hits = await searchSessionLogs({
        root: this.host.sessions.root,
        sessions: this.sessionApplicationService.list({
          includeArchived: true,
        }),
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      return { hits }
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
  /**
   * The session the UI shows (KRN-01): written by `activateSession`, read by
   * `bootstrap`, never used to pick what runs where.
   */
  private focusedSessionId: string | null = null
  private statusRead: Promise<ComputerUseStatusView> | null = null

  /** One Computer Use status read, shared by the driver checks of one refresh. */
  private computerUseStatusOnce(): Promise<ComputerUseStatusView> {
    this.statusRead ??= this.computerUse.status().finally(() => {
      this.statusRead = null
    })
    return this.statusRead
  }

  /** Whether the renderer asked for this session's raw events (`sessions.watch`). */
  isSessionWatched(sessionId: string): boolean {
    return this.watchedSessions.has(sessionId)
  }

  private delegationImageRoots(record: {
    id: string
    backend: string
    profileId: string
  }): string[] {
    if (record.backend !== 'codex') return []
    try {
      const profile = this.executorConfig
        .read()
        .profiles.find((p) => p.id === record.profileId)
      if (!profile) return []
      const root = nativeGeneratedImageRoot(
        join(
          this.paths.delegationsRoot,
          'runtime',
          profile.stateDirectoryId,
          record.id,
        ),
        this.paths.delegationsRoot,
      )
      return root ? [root] : []
    } catch {
      return []
    }
  }

  readonly references = {
    siteIcon: (input: Parameters<WorkspaceReferenceService['siteIcon']>[0]) =>
      this.workspaceReferenceService.siteIcon(input),
    preview: (input: Parameters<WorkspaceReferenceService['preview']>[0]) =>
      this.workspaceReferenceService.preview(input),
    image: async (input: { sessionId: string; referenceId: string }) => {
      this.requireReadableSession(input.sessionId, 'references.image')
      const descriptor = this.workspaceReferenceService.authorize(
        input.referenceId,
        input.sessionId,
      )
      const target = this.workspaceReferenceService.previewPath(
        input.referenceId,
        input.sessionId,
      )
      if (!/\.(png|jpe?g|gif|webp)$/i.test(target))
        throw new WorkspaceOperationError(
          'reference_image_unsupported',
          '该文件不支持图片预览。',
        )
      if (descriptor.kind === 'project_file')
        // Same path as files.preview: works for Build projects and for the
        // workspace of an ordinary chat.
        return this.workspaceReferenceService.previewFile(input)
      const delegationId = this.workspaceReferenceService.delegationScope(
        input.referenceId,
        input.sessionId,
      )
      const ownedRecord = delegationId
        ? this.delegationService.get({
            id: delegationId,
            sessionId: input.sessionId,
          }).record!
        : undefined
      const ownedRoots = ownedRecord
        ? [ownedRecord.cwd, ...this.delegationImageRoots(ownedRecord)]
        : [
            this.host.sessionWorkspaceRoot(input.sessionId),
            ...this.delegationRuntime
              .list()
              .flatMap((state) =>
                state.record?.owner.rootSessionId === input.sessionId
                  ? [
                      state.record.cwd,
                      ...this.delegationImageRoots(state.record),
                    ]
                  : [],
              ),
          ]
      for (const root of ownedRoots) {
        let cwd: string
        try {
          cwd = realpathSync(root)
        } catch {
          continue
        }
        const path = relative(cwd, target)
        if (
          !path ||
          isAbsolute(path) ||
          path === '..' ||
          path.startsWith('..' + sep)
        )
          continue
        const files = new WorkspaceFilesService({
          resolveProject: () => ({
            sessionId: input.sessionId,
            projectRoot: cwd,
          }),
        })
        return files.read({ sessionId: input.sessionId, relativePath: path })
      }
      throw new WorkspaceOperationError(
        'reference_image_outside_workspace',
        '图片不属于当前会话工作区。',
      )
    },
    resolve: (input: Parameters<WorkspaceReferenceService['resolve']>[0]) =>
      this.workspaceReferenceService.resolve(input),
    /** Electron main-only capability; returns a path only after reference ownership checks. */
    revealPath: (input: { sessionId: string; referenceId: string }) =>
      this.workspaceReferenceService.revealPath(
        input.referenceId,
        input.sessionId,
      ),
  }

  /** Processes of a named session (KRN-01: `SESSION_REQUIRED` without one). */
  readonly processes = {
    list: (opts: { sessionId?: string | null; activeOnly?: boolean }): Dict[] =>
      this.host.kept.processRuntime
        .list({
          activeOnly: opts.activeOnly,
          sessionId: this.requireSessionId(opts.sessionId, 'processes.list'),
        })
        .map((receipt) => receipt as unknown as Dict),
    cancel: (
      processId: string,
      opts: { sessionId?: string | null; leaseId: string; reason?: string },
    ): Dict => {
      const sessionId = this.requireSessionId(
        opts.sessionId,
        'processes.cancel',
      )
      this.assertMutation('processes', 'cancel', { sessionId })
      this.assertProcessOwner(processId, sessionId)
      return this.host.kept.processRuntime.cancel(
        processId,
        opts.leaseId,
        opts.reason,
      ) as unknown as Dict
    },
    reparent: (
      processId: string,
      opts: {
        sessionId?: string | null
        leaseId: string
        ownerKind: 'session' | 'task' | 'terminal'
        ownerId: string
      },
    ): Dict => {
      const sessionId = this.requireSessionId(
        opts.sessionId,
        'processes.reparent',
      )
      this.assertMutation('processes', 'reparent', { sessionId })
      this.assertProcessOwner(processId, sessionId)
      return this.host.kept.processRuntime.reparent(processId, opts.leaseId, {
        kind: opts.ownerKind,
        id: opts.ownerId,
        sessionId,
      }) as unknown as Dict
    },
  }

  readonly workspace = {
    snapshot: (input: { sessionId: string }): Promise<WorkspaceSnapshot> =>
      this.workspaceApplicationService.snapshot(input),
    /** One file of a recorded turn: the diff between its snapshots. */
    turnDiff: (input: {
      sessionId: string
      turn: number
      path: string
    }): Promise<{ path: string; diff: string; truncated: boolean }> =>
      this.turnFiles.diff(input),
    /** Undo a recorded turn (its files that did not change since). */
    revertTurn: (input: {
      sessionId: string
      turn: number
      paths?: string[]
    }): Promise<TurnFilesReverted> => this.turnFiles.revert(input),
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
    view: (
      input: Parameters<PullRequestBrowserService['view']>[0],
      options?: Parameters<PullRequestBrowserService['view']>[1],
    ) => this.pullRequestBrowser.view(input, options),
    diff: (input: Parameters<PullRequestBrowserService['diff']>[0]) =>
      this.pullRequestBrowser.diff(input),
  }

  readonly files = {
    preview: async (input: FilePreviewInput): Promise<FilePreviewResult> => {
      if (input.source === 'reference')
        return this.workspaceReferenceService.previewFile(input)
      if (input.source === 'attachment') {
        const ref = this.attachmentStore.get(input.attachmentId)
        if (!ref)
          throw new WorkspaceOperationError(
            'reference_attachment_unknown',
            '附件不存在或已被移除。',
          )
        // Managed attachments have the same global access as attachments.rawPath.
        const root = realpathSync(this.attachmentStore.root)
        const path = resolve(root, ref.rel_path)
        const canonical = realpathSync(path)
        const fromRoot = relative(root, canonical)
        if (
          fromRoot.startsWith('..') ||
          isAbsolute(fromRoot) ||
          canonical !== path
        )
          throw new WorkspaceOperationError(
            'reference_attachment_invalid',
            '附件路径超出存储范围。',
          )
        const value = await previewCanonicalFile(canonical)
        const extracted =
          ref.mime === 'application/pdf' && ref.has_text
            ? this.attachmentStore.readText(ref, 1024 * 1024)
            : ''
        return {
          ...value,
          name: ref.name,
          mimeType: ref.mime,
          revealable: true,
          ...(extracted
            ? {
                kind: 'text' as const,
                content: Buffer.from(extracted)
                  .subarray(0, 1024 * 1024)
                  .toString('utf8'),
                extractedText: true,
                truncated: Buffer.byteLength(extracted) >= 1024 * 1024,
              }
            : {}),
        }
      }
      return filePreviewResult(
        await this.files.read({
          sessionId: input.sessionId,
          relativePath: input.path,
          ...(input.source === 'turn' ? { turn: input.turn } : {}),
        }),
      )
    },
    /** Size and mtime of a preview that can change on disk (FIX-05). */
    stat: async (input: FileStatInput): Promise<FileStatResult> =>
      input.source === 'reference'
        ? this.workspaceReferenceService.statFile(input)
        : this.workspaceFilesService.stat({
            sessionId: input.sessionId,
            relativePath: input.path,
          }),
    list: (
      input: Parameters<WorkspaceFilesService['list']>[0],
    ): Promise<WorkspaceFileListResult> =>
      this.workspaceFilesService.list(input),
    search: (
      input: Parameters<WorkspaceFilesService['search']>[0],
    ): Promise<WorkspaceFileListResult> =>
      this.workspaceFilesService.search(input),
    read: async (
      input: Parameters<WorkspaceFilesService['read']>[0] & { turn?: number },
    ): Promise<WorkspaceFileReadResult> => {
      if (input.turn === undefined)
        return this.workspaceFilesService.read(input)
      const sessionId = this.requireReadableLogSession(
        input.sessionId,
        'files.read',
      )
      const recorded = this.host
        .sessionLog(sessionId)
        ?.events.some(
          (event) =>
            event.type === 'turn/files' &&
            event.data.turn === input.turn &&
            event.data.status === 'recorded' &&
            event.data.files.some((file) => file.path === input.relativePath),
        )
      if (!recorded)
        throw new WorkspaceOperationError(
          'turn_file_not_recorded',
          '这一轮没有该文件的改动记录。',
        )
      // The persisted record authorizes this exact path, not the whole Chat workspace.
      // Reuse the existing bounded reader and canonical path / symlink checks.
      return new WorkspaceFilesService({
        resolveProject: () => ({
          sessionId,
          projectRoot: this.host.sessionWorkspaceRoot(sessionId),
        }),
      }).read({ sessionId, relativePath: input.relativePath })
    },
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
    /** Memory and the context gauge of the session in view. */
    get: (view: ViewScope) =>
      this.memoryService.getMemory(this.viewedSession(view)?.id ?? null),
    save: (content: string) => this.memoryService.saveMemory(content),
    getEpisode: (date?: string | null) =>
      this.memoryService.getEpisode(String(date ?? '')),
    saveEpisode: (content: string, date?: string | null) =>
      this.memoryService.saveEpisode(content, String(date ?? '')),
    listVersions: (opts: { limit?: number; target?: string | null } = {}) =>
      this.memoryService.listVersions(opts),
    getVersion: (versionId: string) => this.memoryService.getVersion(versionId),
    restoreVersion: (versionId: string, view: ViewScope) =>
      this.memoryService.restoreVersion(
        versionId,
        this.viewedSession(view)?.id ?? null,
      ),
    getWatchlist: () => this.memoryService.getWatchlist(),
    saveWatchlist: (content: string) =>
      this.memoryService.saveWatchlist(content),
    checkWatchlist: async () => this.memoryService.checkWatchlist(),
    tokens: (view: ViewScope) =>
      this.memoryService.tokens(this.viewedSession(view)?.id ?? null),
    compact: (opts: { force?: boolean; sessionId: string | null }) =>
      this.memoryService.compact(opts),
    explainContext: (opts: {
      sessionId: string | null
      turnId?: string | null
    }) => this.memoryService.explainContext(opts),
  }

  readonly projects = {
    list: () => this.host.kept.projectStore.list(),
    resolve: (path: string) => this.host.kept.projectStore.resolve(path),
  }

  /**
   * Skills of a named session (`sessionId: null` = Chat, no project
   * Skills); KRN-01: never the session in view by default.
   */
  readonly skills = {
    /** The tools the session in view sees (its project's MCP tools included). */
    tools: (view: ViewScope) =>
      this.skillService.tools(this.viewedSession(view)?.id ?? null),
    list: (opts: { sessionId: string | null }) => this.skillService.list(opts),
    get: (name: string, opts: { sessionId: string | null }) =>
      this.skillService.get(name, opts),
    create: (
      input: Parameters<CoreSkillService['create']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('skills', 'create', view)
      return this.skillService.create(input)
    },
    validate: (input: Parameters<CoreSkillService['validate']>[0]) =>
      this.skillService.validate(input),
    save: (
      name: string,
      content: string,
      opts: { sessionId: string | null },
      view: ViewScope,
    ) => {
      this.assertMutation('skills', 'save', view)
      return this.skillService.save(name, content, opts)
    },
    delete: (
      name: string,
      opts: {
        sessionId: string | null
        scope?: 'user' | 'project' | null
      },
      view: ViewScope,
    ) => {
      this.assertMutation('skills', 'delete', view)
      return this.skillService.delete(name, opts)
    },
    import: async (
      input: Parameters<CoreSkillService['import']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('skills', 'import', view)
      return await this.skillService.import(input)
    },
    copyToUser: (
      input: Parameters<CoreSkillService['copyToUser']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('skills', 'copyToUser', view)
      return this.skillService.copyToUser(input)
    },
    /** Electron main-only capability: the Skills folder of a scope (created when missing). */
    folderPath: (input: Parameters<CoreSkillService['folderPath']>[0]) =>
      this.skillService.folderPath(input),
  }

  /** Plugins as the project of the session in view sees them (KRN-01). */
  readonly plugins = {
    list: (view: ViewScope) =>
      this.pluginService.list(this.viewProjectRoot(view)),
    /** Connection checks (such as gh) run first, so app members show their real state. */
    getDetail: async (
      input: Parameters<PluginApplicationService['detail']>[0],
      view: ViewScope,
    ) => await this.pluginDetail(input, this.viewProjectRoot(view)),
    /** Electron main-only: a logo's bytes for the `app://plugin-assets` handler. */
    logo: (input: Parameters<PluginApplicationService['logo']>[0]) =>
      this.pluginService.logo(input),
    inspect: (input: Parameters<PluginApplicationService['inspect']>[0]) =>
      this.pluginService.inspect(input),
    // Each mutation resolves once its MCP servers and hooks are applied.
    install: async (
      input: Parameters<PluginApplicationService['install']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('plugins', 'install', view)
      const result = await this.pluginService.install(
        input,
        this.viewProjectRoot(view),
      )
      await this.pluginActivation.settled()
      return result
    },
    uninstall: async (
      input: Parameters<PluginApplicationService['uninstall']>[0],
      view: ViewScope,
    ) => {
      this.assertMutation('plugins', 'uninstall', view)
      const result = this.pluginService.uninstall(
        input,
        this.viewProjectRoot(view),
      )
      await this.pluginActivation.settled()
      return result
    },
    setEnabled: async (
      input: Parameters<PluginApplicationService['setEnabled']>[0],
      view: ViewScope,
    ) => {
      // Switching Computer Use off narrows what the Agent can do: like its
      // Settings switch, a pending card never blocks it.
      const narrowsComputerUse =
        input.scope === 'managed' &&
        input.pluginId === COMPUTER_USE_PLUGIN_ID &&
        !input.enabled
      if (!narrowsComputerUse)
        this.assertMutation(
          'plugins',
          input.enabled ? 'enable' : 'disable',
          view,
        )
      const result = this.pluginService.setEnabled(
        input,
        this.viewProjectRoot(view),
      )
      await this.pluginActivation.settled()
      return result
    },
  }

  /** Read-only Issue and CI views of the GitHub plugin; refused while it is off. */
  readonly github = {
    listIssues: async (
      input: Parameters<PullRequestBrowserService['listIssues']>[0],
    ) => {
      this.requireGitHubPlugin()
      return await this.pullRequestBrowser.listIssues(input)
    },
    viewIssue: async (
      input: Parameters<PullRequestBrowserService['viewIssue']>[0],
      options?: Parameters<PullRequestBrowserService['viewIssue']>[1],
    ) => {
      this.requireGitHubPlugin()
      return await this.pullRequestBrowser.viewIssue(input, options)
    },
    listRuns: async (
      input: Parameters<PullRequestBrowserService['listRuns']>[0],
    ) => {
      this.requireGitHubPlugin()
      return await this.pullRequestBrowser.listRuns(input)
    },
    viewRun: async (
      input: Parameters<PullRequestBrowserService['viewRun']>[0],
      options?: Parameters<PullRequestBrowserService['viewRun']>[1],
    ) => {
      this.requireGitHubPlugin()
      return await this.pullRequestBrowser.viewRun(input, options)
    },
  }

  readonly environment = {
    /** Status for the project of the session in view (the runtime root otherwise). */
    getStatus: (
      input: { forceRefresh?: boolean } | undefined,
      view: ViewScope,
    ) =>
      this.environmentService.getStatus({
        forceRefresh: input?.forceRefresh ?? false,
        projectRoot: this.viewProjectRoot(view) ?? this.root,
      }),
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
      view: ViewScope,
    ) => {
      this.assertMutation('environment', 'cancel install', view)
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
    /** Diagnostics, with the facts of the session the page was opened from. */
    get: async (view: ViewScope) =>
      this.diagnosticsService.payload(this.viewOf(view, 'diagnostics.get')),
  }

  /**
   * Computer Use (GUI control). Switching off and revoking never call
   * `assertMutation`: narrowing capability must work while a grant card or
   * plan mode is pending.
   */
  readonly computerUse = {
    status: async (): Promise<ComputerUseStatusView> =>
      (await this.host.computerUse?.service.status()) ??
      unsupportedComputerUseStatus(),
    /** One driver's switch. Turning on is guarded; turning off never is. */
    setDriverEnabled: async (
      input: {
        driver: DriverKind
        enabled: boolean
      },
      view: ViewScope,
    ): Promise<ComputerUseStatusView> => {
      if (input.enabled) this.assertMutation('computerUse', 'enable', view)
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
     * Settings showed once that the apps the user had kept from Emperor can
     * be operated now (the app lists were retired). Never guarded: the
     * reach widened with the update, this only hides the notice.
     */
    acknowledgeRetiredApps: async (): Promise<ComputerUseStatusView> => {
      this.host.acknowledgeRetiredProtectedApps()
      return await this.computerUse.status()
    },
    /** Download inbox retention (never guarded: it only deletes sooner). */
    setDownloadRetention: async (input: {
      days: 0 | 7 | 30 | 90
    }): Promise<ComputerUseStatusView> => {
      this.host.setComputerUseDownloadRetention(input.days)
      return await this.computerUse.status()
    },
    /** Master switch. Turning on is a guarded mutation; turning off never is. */
    setEnabled: async (
      enabled: boolean,
      view: ViewScope,
    ): Promise<ComputerUseStatusView> => {
      if (enabled) this.assertMutation('computerUse', 'enable', view)
      this.host.setComputerUseEnabled(enabled)
      // The Computer Use plugin mirrors this switch (plugin contract §5).
      this.pluginsChanged()
      await this.pluginActivation.settled()
      return await this.computerUse.status()
    },
    /** Browser profiles: the temporary one and every persistent one. */
    listProfiles: (): BrowserProfileView[] =>
      this.host.computerUse?.service.listProfiles() ?? [],
    /**
     * Create or rename a persistent profile (guarded mutations), or wipe /
     * delete one (never guarded: it only removes data and grants).
     */
    manageProfile: async (
      input: {
        action: 'create' | 'rename' | 'clear' | 'delete'
        profileId?: string
        name?: string
      },
      view: ViewScope,
    ): Promise<{ profile?: BrowserProfileView; revokedGrants?: number }> => {
      const service = this.host.computerUse?.service
      if (service === undefined)
        throw new Error('computer use is not available on this host')
      if (input.action === 'create' || input.action === 'rename') {
        this.assertMutation('computerUse', `${input.action}Profile`, view)
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
    setSitePermission: (
      input: {
        profileId: string
        origin: string
        kind: SitePermissionKind
        allow: boolean
        minutes?: number
      },
      view: ViewScope,
    ): { permissions: SitePermission[] } => {
      const service = this.host.computerUse?.service
      if (service === undefined)
        throw new Error('computer use is not available on this host')
      if (input.allow) {
        this.assertMutation('computerUse', 'allowSitePermission', view)
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
    /**
     * Settings › 电脑操作 › Chrome 和 Edge: 浏览器权限 and 智能体权限
     * (PLAN-CAP-001 RV-09), and whether 站点工具 can be on (RV-11).
     */
    externalBrowserSettings: (): ExternalBrowserSettingsView =>
      externalBrowserSettingsView(
        this.host.computerUse?.service.externalBrowserSettings() ??
          DEFAULT_EXTERNAL_BROWSER_SETTINGS,
      ),
    /**
     * Change them. A change that lets the Agent do more (a looser rule, an
     * exception removed from a stricter one, history without asking) is a
     * guarded mutation; narrowing never is.
     */
    setExternalBrowserSettings: (
      patch: ExternalBrowserSettingsPatch,
      view: ViewScope,
    ): ExternalBrowserSettingsView => {
      const service = this.host.computerUse?.service
      if (service === undefined)
        throw new Error('computer use is not available on this host')
      const before = service.externalBrowserSettings()
      const after = applyExternalBrowserSettingsPatch(before, patch)
      if (widensExternalBrowserSettings(before, after))
        this.assertMutation('computerUse', 'externalBrowserSettings', view)
      return externalBrowserSettingsView(
        service.setExternalBrowserSettings(patch),
      )
    },
  }

  readonly desktopPet = {
    get: async () => this.desktopPetService.get(),
    setEnabled: (enabled: boolean, view: ViewScope) =>
      this.desktopPetService.setEnabled(enabled, view),
  }

  /** The user's own built-in browser (not the Agent's). */
  readonly browser = {
    preferences: async (): Promise<BrowserPreferences> =>
      this.browserPreferencesService.get(),
    setPreferences: async (
      change: Partial<BrowserPreferences>,
      view: ViewScope,
    ): Promise<BrowserPreferences> =>
      this.browserPreferencesService.update(change, view),
  }

  /** Task panel: background jobs and subagent sessions of a session tree. */
  readonly tasks = {
    /** Tasks of a named session (KRN-01: `SESSION_REQUIRED` without one). */
    list: (opts: { sessionId?: string | null }): CoreTaskRecord[] =>
      this.sessionTasks(this.requireSessionId(opts.sessionId, 'tasks.list')),
    get: (
      taskId: string,
      opts: { sessionId?: string | null } = {},
    ): CoreTaskRecord | null => this.findTask(taskId, opts.sessionId),
    transcript: (
      taskId: string,
      opts: { offset?: number; limit?: number; sessionId?: string | null } = {},
    ) => {
      const task = this.requireTask(taskId, opts.sessionId)
      const offset = Math.max(0, Math.floor(Number(opts.offset ?? 0)) || 0)
      const limit = Math.max(
        1,
        Math.min(500, Math.floor(Number(opts.limit ?? 200)) || 200),
      )
      const entries =
        task.kind === 'external-agent'
          ? this.delegationService.transcript(task.id, opts.sessionId)
          : task.kind === 'workflow'
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
      opts: { timeoutMs?: number; sessionId?: string | null } = {},
    ): Promise<Dict | null> => {
      const task = this.requireTask(taskId, opts.sessionId)
      const timeoutMs = Math.max(
        0,
        Math.min(600_000, Number(opts.timeoutMs ?? 30_000) || 30_000),
      )
      if (task.kind === 'external-agent')
        return this.delegationService.wait(task.id, timeoutMs, opts.sessionId)
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
    readOutput: async (
      taskId: string,
      opts: { cursor?: string; sessionId?: string | null } = {},
    ) => {
      const task = this.requireTask(taskId, opts.sessionId)
      const content =
        task.kind === 'job'
          ? this.host.jobs.peek(task.id, this.jobOwner(task)).text
          : (task.kind === 'external-agent'
              ? mergeExternalTranscript(
                  this.delegationService.transcript(task.id, opts.sessionId),
                )
              : task.kind === 'workflow'
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
      opts: { reason?: string; sessionId?: string | null } = {},
    ): Promise<Dict> => {
      const task = this.requireTask(taskId, opts.sessionId)
      if (task.kind !== 'external-agent')
        this.assertMutation('tasks', 'cancel', {
          sessionId: opts.sessionId ?? task.session_id,
        })
      if (task.kind === 'external-agent')
        await this.delegationService.interrupt({
          id: task.delegation_id!,
          runId: task.id,
          sessionId: opts.sessionId ?? task.session_id,
        })
      else this.cancelTask(taskId, opts.sessionId ?? null)
      return { ...this.findTask(taskId, opts.sessionId) }
    },
    /** 设置 › 高级 › 任务预算 (KRN-03). */
    budget: (): TaskBudgetSettings => this.taskBudgetService.get(),
    setBudget: (
      change: Partial<TaskBudgetSettings>,
      view: ViewScope,
    ): Promise<TaskBudgetSettings> =>
      this.taskBudgetService.update(change, view),
    resume: async (_taskId: string, _opts: Dict = {}): Promise<never> => {
      throw new OperationRetiredError(
        '子代理任务不再支持从面板恢复；请在对话中让主代理用 send_message 继续该子代理。',
        'use_send_message',
      )
    },
  }

  /** 设置 › 高级 › 存储 (KRN-12): what Emperor Home holds, and 「清理」. */
  readonly storage = {
    usage: (): Promise<StorageUsage> => this.retention.usage(),
    clean: async (
      view: ViewScope,
    ): Promise<{ report: RetentionReport; usage: StorageUsage }> => {
      this.assertMutation('storage', 'clean', view)
      const report = await this.retention.sweep()
      return { report, usage: await this.retention.usage() }
    },
  }

  readonly tools = {
    /** 设置 › 高级 › 网络工具: the web_fetch / web_search switches and availability. */
    networkSettings: (): WebToolsStatus => this.webToolsService.status(),
    setNetworkSettings: (
      change: Partial<WebToolPreferences>,
      view: ViewScope,
    ): Promise<WebToolsStatus> => this.webToolsService.update(change, view),
    /**
     * A spilled tool result (`ref` is the spill file path) in 256 KiB pages
     * that end on a character boundary (KRN-12); `page` counts from 1. The
     * real file (links resolved) must be a file inside the spill store.
     */
    readResult: (opts: { ref: string; page?: number }): ResultPage => {
      let target: string | null = null
      try {
        const real = realpathSync(resolve(String(opts?.ref ?? '')))
        const rel = relative(
          realpathSync(resolve(this.paths.stateRoot, 'spill')),
          real,
        )
        if (rel && !rel.startsWith('..') && !isAbsolute(rel))
          target = statSync(real).isFile() ? real : null
      } catch {
        target = null
      }
      if (target === null)
        throw new CoreMutationGuardError(
          403,
          'tool result ref is outside the spill store',
        )
      return readUtf8Page(target, opts?.page ?? 1)
    },
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /**
   * The user switched to a session. It only decides what the UI shows
   * (KRN-01): nothing runs differently. The plugin list the UI shows depends
   * on the project, so say when that changes.
   */
  private activateSession(sessionId: string) {
    const entry = this.host.kept.sessionStore.get(sessionId)
    if (entry === null) throw new Error(`unknown session ${sessionId}`)
    const previous =
      this.focusedSessionId === null
        ? null
        : this.host.kept.sessionStore.get(this.focusedSessionId)
    this.focusedSessionId = sessionId
    if (this.host.projectRootFor(previous) !== this.host.projectRootFor(entry))
      this.emitPluginsChanged('project')
    return entry
  }

  /** The view a caller passed (KRN-01); `SESSION_REQUIRED` when it passed none. */
  private viewOf(view: ViewScope | undefined, operation: string): ViewScope {
    if (view === undefined || view === null || typeof view !== 'object')
      throw new SessionRequiredError(operation)
    return view
  }

  /** The readable session a view shows; null for none, a draft, or an archived one. */
  private viewedSession(view: ViewScope | undefined) {
    const id = String(view?.sessionId ?? '').trim()
    if (!id || id.startsWith(DRAFT_SESSION_PREFIX)) return null
    const entry = this.host.kept.sessionStore.get(id)
    return entry && !entry.archived_at ? entry : null
  }

  /** The Build project of the session a view shows (null: Chat or none). */
  private viewProjectRoot(view: ViewScope | undefined): string | null {
    return this.host.projectRootFor(this.viewedSession(view))
  }

  /** The scope of the session a view shows (null: none). */
  private viewScopeOf(view: ViewScope | undefined) {
    const entry = this.viewedSession(view)
    return entry === null ? null : this.host.scopeFor(entry.id)
  }

  /** A session the caller named; `SESSION_REQUIRED` when it named none. */
  private requireSessionId(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    const id = String(sessionId ?? '').trim()
    if (!id) throw new SessionRequiredError(operation)
    return id
  }

  private async readGitHubReferencePreview(
    target: GitHubPreviewTarget,
    signal: AbortSignal,
  ): Promise<ReferencePreview> {
    try {
      this.requireGitHubPlugin()
      const options = { signal }
      let metadata: Pick<ReferencePreview, 'title' | 'description' | 'status'>
      if (target.kind === 'pull_request') {
        const pull = await this.pullRequests.view(
          { repo: target.repo, number: target.number },
          options,
        )
        metadata = {
          title: pull.title,
          description: `${pull.repo} #${pull.number} · ${pull.author}`,
          status: pull.isDraft ? 'DRAFT' : pull.state,
        }
      } else if (target.kind === 'issue') {
        const issue = await this.github.viewIssue(
          { repo: target.repo, number: target.number },
          options,
        )
        metadata = {
          title: issue.title,
          description: `${issue.repo} #${issue.number} · ${issue.author}`,
          status: issue.state,
        }
      } else {
        const { run } = await this.github.viewRun(
          { repo: target.repo, runId: target.number },
          options,
        )
        metadata = {
          title: run.title || run.name,
          description: `${target.repo} · ${run.name}`,
          status: run.conclusion ?? run.status,
        }
      }
      this.requireGitHubPlugin()
      if (signal.aborted)
        return { state: 'error', reason: 'cancelled', updatedAt: Date.now() }
      return { state: 'ready', ...metadata, updatedAt: Date.now() }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : ''
      const reason =
        code === 'github_plugin_disabled'
          ? code
          : code.endsWith('_not_found')
            ? 'not_found'
            : code === 'pull_request_gh_unauthenticated'
              ? 'github_unauthenticated'
              : 'github_unavailable'
      return { state: 'unavailable', reason, updatedAt: Date.now() }
    }
  }

  private requireGitHubPlugin(): void {
    // The GitHub package ships with Emperor: the same in every project.
    const on = this.pluginService
      .list(null)
      .some(
        (plugin) =>
          plugin.pluginId === 'github' &&
          plugin.effective &&
          plugin.activation === 'active',
      )
    if (!on)
      throw new EmperorError(
        'GitHub 插件已停用；在「能力 › 插件」里启用后再查看 Issue 与 CI。',
        'github_plugin_disabled',
      )
  }

  /** Installed plugins or their toggles changed: refresh Skills, contributions and the renderer. */
  private pluginsChanged(): void {
    this.host.kept.skillLoaders.refreshPluginSkillsRoots()
    this.host.kept.skillChangeDetector.notify()
    void this.syncPlugins()
    this.emitPluginsChanged('plugins')
  }

  /** Apply plugin MCP servers and hooks; a failure is logged, never thrown into callers. */
  /**
   * What a `@plugin` gesture tells the model: the plugin in effect with this
   * id and, when active, its members and whether each can be used (app
   * connections are checked first, as in the detail).
   */
  private async pluginReference(
    id: string,
    projectRoot: string | null,
  ): Promise<PluginReference> {
    const rows = this.pluginService
      .list(projectRoot)
      .filter((plugin) => plugin.pluginId === id)
    if (rows.length === 0) return { status: 'missing', id, name: null }
    const row = rows.find((plugin) => plugin.effective) ?? rows[0]!
    if (row.activation === 'blocked_unverified')
      return { status: 'blocked_unverified', id, name: row.displayName }
    if (row.activation === 'missing')
      return { status: 'missing', id, name: row.displayName }
    if (row.activation !== 'active')
      return {
        status: 'disabled',
        id,
        name: row.displayName,
        computerUseOff:
          row.scope === 'managed' && id === COMPUTER_USE_PLUGIN_ID,
      }
    const detail = await this.pluginDetail(
      { pluginId: id, scope: row.scope },
      projectRoot,
    )
    const members: PluginReferenceMember[] = []
    for (const component of detail.components) {
      if (
        component.kind !== 'skill' &&
        component.kind !== 'mcp' &&
        component.kind !== 'app' &&
        component.kind !== 'hook'
      )
        continue
      const usable =
        component.kind === 'mcp'
          ? component.state === 'running'
          : component.state === 'available'
      members.push({
        kind: component.kind,
        id: component.id,
        unavailable: usable ? null : (component.reason ?? component.state),
        ...(component.kind === 'mcp'
          ? {
              tools:
                this.pluginActivation.mcpServer(
                  id,
                  row.scope,
                  component.id,
                  projectRoot,
                )?.toolCount ?? 0,
            }
          : {}),
      })
    }
    return {
      status: 'enabled',
      id,
      name: detail.displayName,
      description: detail.description,
      members,
    }
  }

  /** A plugin's detail for one project (null: Chat); app connections are checked first. */
  private async pluginDetail(
    input: Parameters<PluginApplicationService['detail']>[0],
    projectRoot: string | null,
  ) {
    const detail = this.pluginService.detail(input, projectRoot)
    // Only an active package shows its members' own states, so nothing
    // is checked otherwise (asking a Computer Use driver can launch the
    // macOS Helper).
    if (detail.activation !== 'active' || !detail.effective) return detail
    const apps = detail.components
      .filter((component) => component.kind === 'app')
      .map((component) =>
        appConnectionKey({
          scope: detail.scope,
          pluginId: detail.pluginId,
          appId: component.id,
        }),
      )
      .filter((key) => this.appConnections.has(key))
    if (!apps.length) return detail
    await this.appConnections.refresh(apps)
    return this.pluginService.detail(input, projectRoot)
  }

  private async syncPlugins(): Promise<void> {
    try {
      await this.pluginActivation.sync()
    } catch (error) {
      logger.warn('plugin activation failed', { error: String(error) })
    }
  }

  private emitPluginsChanged(reason: 'plugins' | 'project' | 'hooks'): void {
    this.host.emitHost({ event: 'plugins_changed', reason })
  }

  private controlSessionId(
    sessionId: string | null | undefined,
  ): string | null {
    const id = String(sessionId ?? '').trim()
    return id || null
  }

  private requireControlSession(
    sessionId: string | null | undefined,
    operation: string,
  ): string {
    return this.requireReadableSession(
      this.requireSessionId(sessionId, operation),
      operation,
    ).id
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
    if (this.host.kept.sessionStore.get(sessionId)?.archived_at)
      return this.delegationService.tasks(sessionId)
    const root = this.rootAgentOf(sessionId)
    if (root === null) return this.delegationService.tasks(sessionId)
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
    return [
      ...this.delegationService.tasks(sessionId),
      ...workflows,
      ...children,
      ...jobs,
    ].sort((left, right) => right.started_at - left.started_at)
  }

  private allSubagents(view: ViewScope): SubagentRecord[] {
    const sessionId = this.viewedSession(view)?.id ?? null
    const root = sessionId === null ? null : this.rootAgentOf(sessionId)
    return root === null ? [] : this.host.subagents.list(root, 'descendants')
  }

  private findTask(
    taskId: string,
    sessionId?: string | null,
  ): CoreTaskRecord | null {
    const id = String(taskId ?? '').trim()
    if (!id) return null
    if (id.startsWith('dgr-')) {
      const { state, run } = this.delegationService.run(id, sessionId)
      return externalTask(state, run)
    }
    for (const entry of this.host.kept.sessionStore.list({
      includeArchived: false,
    })) {
      const found = this.sessionTasks(entry.id).find((task) => task.id === id)
      if (found) return found
    }
    return null
  }

  private requireTask(
    taskId: string,
    sessionId?: string | null,
  ): CoreTaskRecord {
    const task = this.findTask(taskId, sessionId)
    if (task === null)
      throw new CoreMutationGuardError(
        403,
        `task not found or not owned by an open session: ${taskId}`,
      )
    return task
  }

  private cancelTask(taskId: string, sessionId: string | null): boolean {
    const task = this.findTask(taskId, sessionId)
    if (task === null) return false
    if (task.kind === 'external-agent') {
      void this.delegationService
        .interrupt({
          id: task.delegation_id!,
          runId: task.id,
          sessionId: sessionId ?? task.session_id,
        })
        .catch(() => undefined)
      return true
    }
    if (task.kind === 'workflow')
      return this.host.workflowRuns.cancel(
        task.id,
        'cancelled from the task panel',
      )
    if (task.kind === 'job')
      return (
        // The model is told the user stopped it (DSH-5).
        this.host.jobs.kill(task.id, this.jobOwner(task), 'user', 'user') ===
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

  /**
   * Refuse a mutation while the session the caller shows has a pending
   * Ask / Plan card or is in plan mode. The caller names that session
   * (`view`); without one it is `SESSION_REQUIRED` (KRN-01).
   */
  private assertMutation(
    area: string,
    action: string,
    view: ViewScope | undefined,
  ): void {
    const entry = this.viewedSession(this.viewOf(view, `${area}.${action}`))
    const control = this.host.controlPayload(entry?.id ?? null)
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

  private assertProcessOwner(processId: string, sessionId: string): void {
    const receipt = this.host.kept.processRuntime.get(processId)
    if (!receipt || receipt.owner.sessionId !== sessionId)
      throw new CoreMutationGuardError(
        403,
        `Process is not owned by session ${sessionId}: ${processId}`,
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
    platform: null,
    drivers: [],
    targets: [],
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
    drivers: status.drivers.map((driver) => ({
      driver: driver.driver,
      stage: driver.stage,
      label: driver.label,
      enabled: driver.enabled,
      available: driver.available,
      ...(driver.reason === undefined ? {} : { reason: driver.reason }),
    })),
    targets: status.targets.length,
  }
}

/** The Computer Use package's app members: one per driver (its `.app.json`). */
const COMPUTER_USE_DRIVERS: readonly DriverKind[] = [
  'embedded-browser',
  'external-browser',
  'desktop',
]

/** What a Computer Use driver shows in the plugin detail (plugin contract §5). */
function computerUseDriverState(
  status: ComputerUseStatusView,
  kind: DriverKind,
): AppConnectionState {
  const driver = status.drivers.find((item) => item.driver === kind)
  if (!driver || driver.stage === 'unavailable')
    return {
      state: 'unsupported',
      reason: driver?.reason ?? '这台电脑上不能使用',
    }
  if (!driver.enabled)
    return { state: 'disabled', reason: '已在「设置 › 电脑操作」里关闭' }
  if (driver.available)
    return {
      state: 'connected',
      reason: driver.missing.length
        ? `暂不支持：${driver.missing.join('、')}`
        : null,
    }
  return {
    state: 'needs_connection',
    reason:
      driver.reason ??
      (driver.missing.length
        ? `缺少${driver.missing.join('、')}`
        : '暂时不可用'),
  }
}

/** The shipped GitHub package's app member, the one connected through the local gh. */
const GITHUB_APP = {
  scope: 'managed',
  pluginId: 'github',
  appId: 'github',
} as const

/** What the GitHub plugin's app member shows for the local gh. */
function githubConnectionState(
  status: Awaited<ReturnType<PullRequestBrowserService['status']>>,
): AppConnectionState {
  if (status.available)
    return {
      state: 'connected',
      reason: status.login ? `已登录 ${status.login}` : null,
    }
  if (status.reason === 'gh_missing')
    return {
      state: 'needs_connection',
      reason: '没有可用的 GitHub CLI（gh）；可在「设置 › 诊断」里查看',
    }
  if (status.reason === 'gh_unauthenticated')
    return {
      state: 'needs_connection',
      reason: '在终端运行 gh auth login 登录 GitHub',
    }
  return { state: 'failed', reason: status.message ?? 'GitHub CLI 操作失败' }
}
