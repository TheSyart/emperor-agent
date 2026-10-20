import { createRoutingChildProvider } from '../delegation/workflow-provider'
import { DelegationInteractionBridge } from '../delegation/interactions'
import { ExecutorConsentBridge } from '../delegation/consent'
/**
 * `HarnessHost`: the single composition root of Emperor's agent kernel.
 *
 * It composes the ported harness (LLM client, session log, agent loop,
 * tools, sandbox, approval, plan mode, compaction, hooks, goals,
 * subagents, jobs, questions, skills, memory, MCP) with the kept Emperor
 * services, owns one Agent per session, streams every session's log to the
 * UI through the projector, and answers pending interactions for CoreApi.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { AttachmentStore, type AttachmentRef } from '../../attachments/store'
import type { MessageReference } from './message-references'
import {
  findEntry,
  loadModelConfig,
  type ModelConfig,
} from '../../config/model-config'
import { createLlmClient } from '../../llm'
import type { LlmClient } from '../../llm/client'
import {
  createUserMessage,
  messageText,
  type UserMessage,
} from '../../llm/message'
import { routeFromEntry, type RouteSpec } from '../../llm/route'
import { imageDimensions } from '../../attachments/image-dimensions'
import type { ContentBlock, TokenUsage } from '../../llm/types'
import { entryPrices, ledgerUsage, usageCostUsd } from '../../model/usage-cost'
import {
  historyPage,
  type HistoryPageOptions,
  type SessionHistoryPage,
} from '../../session-log/history'
import type { Session } from '../../session-log/session'
import {
  LOG_FILE,
  SessionLogStore,
  type SessionLogState,
} from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import type { SessionEntry } from '../../sessions/store'
import { MCPClient } from '../../mcp/client'
import { ProjectMcpInstances } from '../../mcp/project-instances'
import type { FileSkillsLoader } from '../../skills/file-loader'
import { logger } from '../../util/log'
import { WatchlistService } from '../../watchlist/service'
import { Agent, type AgentDeps, type MessageOutcome } from '../agent/agent'
import { isUserTyped, type HoldReason, type QueueChange } from '../agent/inbox'
import { createMiddleware, type AgentMiddleware } from '../agent/middleware'
import { retryMiddleware } from '../agent/retry'
import {
  currentModel,
  fallbackConfigMiddleware,
  fallbackErrorMiddleware,
  type ModelPolicySource,
} from '../agent/model-policy'
import { PermissionPresetService } from '../approval/presets'
import { ApprovalService, type ApprovalPolicy } from '../approval/service'
import { CompactionEngine } from '../compaction/engine'
import { ToolResultPruner } from '../compaction/pruner'
import {
  createGoalTools,
  GoalService,
  installGoal,
  type InstalledGoal,
} from '../goal'
import { ClaudeCodeHooks, defaultHookConfigPaths } from '../hooks'
import { containedPluginHookRunner } from '../hooks/contained'
import type { UnsandboxedRequest } from '../../sandbox/consent'
import { createJobTools, installJobsPromptSection, JobRegistry } from '../jobs'
import { ComputerUseConfigStore } from '../computer-use/config'
import {
  browserStateDir,
  computerUseStateDir,
  installComputerUse,
  type InstalledComputerUse,
} from '../computer-use/install'
import type { ComputerUseHostPort } from '../computer-use/port'
import type { DriverKind } from '../computer-use/types'
import { createBrowserTools } from '../computer-use/tools/browser-tools'
import { createDesktopTools } from '../computer-use/tools/desktop-tools'
import { createExternalTools } from '../computer-use/tools/external-tools'
import type { ComputerUseSettings } from '../computer-use/service/service'
import { createMemoryTool, memoryMiddleware } from '../memory/memory'
import { PlanModeController } from '../plan/plan-mode'
import { agentInstructionsMiddleware } from '../prompt/agent-instructions'
import { SystemPromptAssembler } from '../prompt/assembler'
import { SessionProjector, type UiEvent } from '../projection/projector'
import { createAskUserQuestionTool, UserQuestionService } from '../questions'
import { UserQuestionDismissed } from '../questions/service'
import { LocalSandbox, type SandboxBackend } from '../sandbox/backend'
import { SandboxPolicyService, type SandboxMode } from '../sandbox/policy'
import { SubagentManager } from '../subagent/manager'
import { installSubagents } from '../subagent/tools'
import { createDelegationTools } from '../delegation/tools'
import type { DelegationService } from '../delegation/service'
import { DelegationError, type DelegationOwner } from '../delegation/types'
import type { DelegationParentContext } from '../delegation/policy'
import { discoverInstructionFiles } from '../prompt/agent-instructions'
import { workspaceMutationDomain } from '../../workspace/mutation-coordinator'
import {
  createSpawnChildProvider,
  installWorkflow,
  WorkflowEngine,
  WorkflowRunRegistry,
} from '../workflow'
import { createFsTools, installFsPromptSections } from '../tools/builtin/fs'
import {
  createSearchTools,
  installSearchPromptSections,
} from '../tools/builtin/search'
import {
  createShellTool,
  installShellPromptSection,
} from '../tools/builtin/shell'
import { createSkillTool, skillMiddleware } from '../tools/builtin/skill'
import {
  pluginReferenceMiddleware,
  type PluginReferenceResolver,
} from './plugin-references'
import {
  createSkillManageTool,
  installSkillManagePromptSection,
} from '../tools/builtin/skill-manage'
import {
  createMcpConfigTool,
  installMcpConfigPromptSection,
  mcpConfigDisplayPath,
} from '../tools/builtin/mcp-config'
import { createSchedulerTool } from '../tools/builtin/scheduler'
import { createTodoTool } from '../tools/builtin/todo'
import type { WebSearchBackend } from '../tools/builtin/web-search'
import { ToolRegistry } from '../tools/registry'
import { createRepeatReminder } from '../tools/repeat-reminder'
import type { ToolServices } from '../tools/services'
import { createSpillMiddleware, spillSessionDir } from '../tools/spill'
import { PendingInteractions, type UiAnswers } from './interactions'
import { installLinkGuidancePromptSection } from './link-guidance'
import { McpToolBridge } from './mcp-tools'
import { createSchedulerExecutor } from './scheduler'
import { currentTurnInfo, currentTurnSource } from './turn-source'
import { recordedDescendants, TaskTree, type TaskBudget } from './task-tree'
import {
  normalizeTaskBudgetSettings,
  type TaskBudgetSettings,
} from '../../config/local-config'
import {
  createKeptServices,
  type KeptServices,
  type KeptServicesOptions,
} from './services'
import {
  foldChildren,
  foldLineage,
  type SessionLineage,
  type SubagentChildView,
} from './session-views'
import { REPAIR_CONTRIBUTORS } from './repair-contributors'
import {
  DEFAULT_BACKGROUND_TURN_TIMEOUT_MS,
  realTimers,
  scopeOfEntry,
  SessionRequiredError,
  type BackgroundTurnOptions,
  type BackgroundTurnOutcome,
  type HostTimers,
  type InteractionPolicy,
  type SessionScope,
  type TurnResult,
} from './scope'
import type { ToolSchema } from '../../llm/types'
import { generateSessionTitle } from './title'
import { WebTools } from './web-tools'

export type HostEventSink = (
  event: Record<string, unknown>,
) => void | Promise<void>

/** Observer of every raw log event of every attached (root or child) agent. */
export type RawSessionTap = (sessionId: string, event: SessionEvent) => void

export interface HarnessHostOptions extends KeptServicesOptions {
  eventSink?: HostEventSink | null
  /**
   * A host's own web search backend: `web_search` is offered with it
   * whatever the provider. Without one, `web_search` exists only on
   * DeepSeek's official API (its Search API).
   */
  webSearch?: WebSearchBackend | null
  /** Test hook: the transport for DeepSeek's Search API (default `fetch`). */
  webSearchFetch?: typeof fetch
  /** Permission preset new sessions start with (default `workspace-write`). */
  defaultPreset?: string
  initializeMcp?: boolean
  /** Watch Skill folders and emit `skill_catalog_changed` (default true). */
  watchSkills?: boolean
  /** Test hook: replace the sandbox backend. */
  sandboxBackend?: SandboxBackend
  /** Test hook: replace the LLM client. */
  llm?: LlmClient
  /** Desktop host port for GUI control; absent → no computer-use tools. */
  computerUsePort?: ComputerUseHostPort | null
  /** Computer-use master switch and per-driver switches. */
  computerUseSettings?: () => ComputerUseSettings
  /** The master switch changed (the desktop clears its pointer when off). */
  computerUseEnabledChanged?: (enabled: boolean) => void
  /** Timers for deferred work (background turn limits, MCP idle stop); tests replace them. */
  timers?: HostTimers
}

export interface SubmitInput {
  sessionId: string
  content: string
  displayContent?: string | null
  /** Chips in the displayed text (renderer-only; validated by the caller). */
  references?: MessageReference[] | null
  /** The caller had chips whose offsets no longer fit the shown text (contract §2.3). */
  referencesDropped?: boolean | null
  clientMessageId?: string | null
  attachmentIds?: string[] | null
  source?: string | null
  scheduler?: Record<string, unknown> | null
  uiHidden?: boolean | null
  delivery?: 'queue' | 'interject' | null
  signal?: AbortSignal | null
  /**
   * A message no turn took (the turn before it failed or was stopped) waits
   * in the queue for the user (`keep`, the default), or is discarded when
   * its submitter cannot come back to it (`withdraw`: ACP, hidden prompts).
   */
  unconsumed?: 'keep' | 'withdraw' | null
}

export type { TurnResult } from './scope'

export interface SubmitResult {
  sessionId: string
  messageId: string
  turnId: string | null
  content: string
  /**
   * `completed`: a turn consumed the message (`result` says how it ended);
   * `interjected`: it entered the running turn's next step; `queued`: no
   * turn took it, it waits in the queue for the user (发送 / 丢弃);
   * `discarded`: it left the queue without running.
   */
  delivery: 'completed' | 'interjected' | 'queued' | 'discarded'
  /** Null for an interjection (it resolves before its step). */
  result: TurnResult | null
}

export interface QueuedPrompt {
  prompt_id: string
  content: string
  /** `failed-previous`: held until the user sends it again (see `reason`). */
  state: 'queued' | 'failed-previous'
  reason?: HoldReason
  target: 'next-turn' | 'next-step'
}

const DEFAULT_PRESET = 'workspace-write'

export class HarnessHost {
  readonly kept: KeptServices
  readonly llm: LlmClient
  readonly sessions: SessionLogStore
  readonly tools = new ToolRegistry()
  readonly prompt = new SystemPromptAssembler()
  readonly middleware: AgentMiddleware = createMiddleware()
  readonly sandbox: SandboxPolicyService
  readonly sandboxBackend: SandboxBackend
  readonly approval = new ApprovalService('ask')
  readonly presets: PermissionPresetService
  readonly planMode = new PlanModeController()
  readonly questions = new UserQuestionService()
  readonly compaction: CompactionEngine
  readonly jobs = new JobRegistry()
  readonly goals = new GoalService({
    requiresCompletionVerification: (agent, ref) =>
      (this.delegations?.requiredForGoal(ref, this.rootOf(agent).id).length ??
        0) > 0,
    completionCurrent: (agent, ref) =>
      this.delegations?.goalCompletionCurrent(ref, this.rootOf(agent).id) ??
      true,
    verifyCompletion: async (agent, ref) => {
      await this.delegations?.verifyGoalCompletion(ref, this.rootOf(agent).id)
    },
  })
  readonly goalInstall: InstalledGoal
  readonly subagents: SubagentManager
  delegations: DelegationService | null = null
  delegationQuestionTimeoutMs = () => 15 * 60 * 1000
  readonly delegationInteractions: DelegationInteractionBridge
  /** First-dispatch consent cards for external executors (AGT-05). */
  readonly delegationConsent: ExecutorConsentBridge
  /** Dynamic workflows (`workflow` / `ralph` tools) over in-process subagents. */
  readonly workflows: WorkflowEngine
  readonly workflowRuns = new WorkflowRunRegistry()
  readonly hooks: ClaudeCodeHooks
  readonly pending = new PendingInteractions()
  readonly attachments: AttachmentStore
  readonly watchlist: WatchlistService
  readonly mcpTools: McpToolBridge
  /** `web_fetch` / `web_search` and their switches (设置 › 高级 › 网络工具). */
  readonly webTools: WebTools
  /** Project-scoped MCP servers: one instance per project root (KRN-01). */
  readonly projectMcp: ProjectMcpInstances
  /** GUI control kernel; null on hosts without a computer-use port. */
  computerUse: InstalledComputerUse | null = null
  private computerUseConfig: ComputerUseConfigStore | null = null
  /** What `@plugin` gestures learn about a plugin (set by CoreApi's plugin service). */
  private pluginReferences: PluginReferenceResolver | null = null
  private computerUseEnabledChanged: ((enabled: boolean) => void) | undefined
  /** The preset a session without a log starts in (设置 › 常规 › 会话). */
  private defaultPresetId: string
  private readonly timers: HostTimers
  /** Background turns per root session, for their interaction policy (KRN-01). */
  private readonly backgroundTurns = new Map<string, BackgroundTurnState[]>()
  /** Plugin ids whose global copy a project replaces with its own (set by CoreApi). */
  private projectPluginOverrides: (projectRoot: string) => ReadonlySet<string> =
    () => new Set()
  private readonly agents = new Map<string, Agent>()
  /** Each root session's task tree: its subagents, their jobs, its budget (KRN-03). */
  private readonly taskTrees = new Map<string, TaskTree>()
  /** 设置 › 高级 › 任务预算 (the cost cap is the model policy's). */
  private taskBudgetSettings: TaskBudgetSettings
  private readonly projectors = new Map<string, SessionProjector>()
  private readonly unsubscribes = new Map<string, () => void>()
  /** Queued user prompt ids last announced per root session (prompt_queued/dequeued). */
  private readonly announcedQueue = new Map<string, Set<string>>()
  private eventSink: HostEventSink | null
  private readonly taps = new Set<HostEventSink>()
  private readonly rawTaps = new Set<RawSessionTap>()
  private closed = false
  private unwatchSkillRoots: (() => void) | undefined
  /** Catalog-resolved ripgrep path for the search tools (undefined → `rg` on PATH, else JS fallback). */
  private ripgrepPath: string | undefined

  private constructor(kept: KeptServices, options: HarnessHostOptions) {
    this.kept = kept
    this.eventSink = options.eventSink ?? null
    this.defaultPresetId =
      options.defaultPreset ??
      kept.localConfig?.sessions?.defaultPermission ??
      DEFAULT_PRESET
    this.timers = options.timers ?? realTimers
    this.taskBudgetSettings = normalizeTaskBudgetSettings(
      kept.localConfig?.taskBudget,
    )
    this.attachments = new AttachmentStore(kept.paths.stateRoot)
    this.llm =
      options.llm ??
      createLlmClient({
        images: async (ref) => {
          const stored = this.attachments.get(ref.attachmentId)
          if (stored === null)
            throw new Error(`attachment ${ref.attachmentId} is missing`)
          return {
            data: this.attachments.readBytes(stored),
            mediaType: stored.mime,
          }
        },
        // Screenshots removed by the quota or a user clear replay as text.
        imageAvailable: (ref) =>
          this.attachments.get(ref.attachmentId) !== null,
      })
    if (options.llm === undefined) this.applyModelConfig(kept.modelConfig)
    this.watchlist = new WatchlistService(kept.paths.stateRoot, {
      llm: this.llm,
      tokenTracker: kept.tokenTracker,
    })
    this.sessions = new SessionLogStore({
      root: kept.paths.sessionsRoot,
      repairContributors: [...REPAIR_CONTRIBUTORS],
      onLogState: (state) => this.emitHost(sessionLogStateEvent(state)),
    })
    this.sandbox = new SandboxPolicyService({
      defaultMode: 'workspace-write',
      workspaceRoot: this.chatWorkspace(),
    })
    this.sandboxBackend =
      options.sandboxBackend ??
      new LocalSandbox({
        protectedStateRoot: kept.paths.stateRoot,
        backend: kept.containment,
      })
    this.presets = new PermissionPresetService(this.sandbox, this.approval)
    this.compaction = new CompactionEngine(this.llm, new ToolResultPruner())
    this.subagents = new SubagentManager({
      sessions: this.sessions,
      createAgent: (session, agentOptions) => {
        const child = this.attachAgent(
          new Agent(session, this.agentDeps(), agentOptions),
        )
        this.taskTreeOf(child).adopt({
          sessionId: child.id,
          agent: child,
          detach: () => this.detachAgent(child.id),
        })
        return child
      },
      lookupAgent: (id) => this.agents.get(id),
      sandbox: this.sandbox,
      approval: this.approval,
      // One budget per root task: total, pool, result wakes (KRN-03).
      budget: {
        reserve: (parent) => this.taskTreeOf(parent).reserve(parent),
        admission: (parent) => this.taskTreeOf(parent).gate,
        waiting: (parent, delta) =>
          this.taskTreeOf(parent).waiting(parent, delta),
        takeWake: (parent) => this.taskTreeOf(parent).takeWake(parent),
      },
    })
    this.workflows = new WorkflowEngine([
      createRoutingChildProvider({
        internal: createSpawnChildProvider({
          manager: this.subagents,
          llm: this.llm,
        }),
        delegations: () => this.delegations ?? undefined,
        ownerResolver: (agent, callId) => this.delegationOwner(agent, callId),
        readOnly: (agent) => {
          const parent = this.delegationParent(
            this.delegationOwner(agent, 'workflow'),
          )
          return parent.policy.mode === 'read-only' || !!parent.planMode
        },
      }),
    ])
    this.hooks = new ClaudeCodeHooks({
      configPaths: defaultHookConfigPaths({ stateRoot: kept.paths.stateRoot }),
      // A plugin's hooks run in the process containment (SEC-08).
      pluginHookRunner: containedPluginHookRunner({
        runtime: kept.processRuntime,
        stateRoot: kept.paths.stateRoot,
      }),
    })
    this.projectMcp = new ProjectMcpInstances({
      // The one place a project instance's client is made. Its servers are
      // plugins': contained, refused when no sandbox can run (SEC-08).
      createClient: (projectRoot) =>
        new MCPClient(kept.paths.stateRoot, {
          sealer: kept.secretSealer,
          processRuntime: kept.processRuntime,
          workspaceRoot: projectRoot,
          userServers: false,
        }),
      environment: async (projectRoot) => {
        try {
          return await kept.executionEnvironmentService.create({ projectRoot })
        } catch (error: unknown) {
          logger.warn('project MCP environment probe failed', {
            error: String(error),
          })
          return null
        }
      },
      reservedToolNames: () => this.mcpTools.reservedNames(),
      onChanged: () => this.mcpTools.sync(),
      timers: this.timers,
    })
    this.mcpTools = new McpToolBridge(
      {
        global: () => kept.mcpClient.getTools(),
        projects: () => this.projectMcp.projects(),
        project: (projectRoot) => this.projectMcp.tools(projectRoot),
        hiddenInProject: (projectRoot) =>
          this.projectPluginOverrides(projectRoot),
      },
      this.tools,
      (agent) => this.projectRootOfAgent(agent),
    )
    kept.mcpClient.setReservedToolNames(() => this.mcpTools.reservedNames())
    this.delegationInteractions = new DelegationInteractionBridge({
      pending: this.pending,
      root: (id) => {
        try {
          return this.agentFor(id)
        } catch {
          return undefined
        }
      },
      available: (owner) =>
        this.eventSink !== null && owner.source !== 'scheduler',
      timeoutMs: () => this.delegationQuestionTimeoutMs(),
    })
    this.delegationConsent = new ExecutorConsentBridge({
      pending: this.pending,
      root: (id) => {
        try {
          return this.agentFor(id)
        } catch {
          return undefined
        }
      },
      available: (owner) =>
        this.eventSink !== null && owner.source !== 'scheduler',
      timeoutMs: () => this.delegationQuestionTimeoutMs(),
    })
    this.webTools = new WebTools({
      settings: kept.localConfig.webTools,
      fetchClient: options.webFetchClient ?? null,
      searchBackend: options.webSearch ?? null,
      ...(options.webSearchFetch
        ? { searchFetch: options.webSearchFetch }
        : {}),
      routeOf: (agent) => this.routeOf(agent),
    })
    this.goalInstall = this.compose(options)
  }

  static async create(options: HarnessHostOptions): Promise<HarnessHost> {
    // Kept services call back into the host, which exists only after they do.
    const ref: { host?: HarnessHost } = {}
    const kept = await createKeptServices(options, {
      emit: (event) => ref.host?.emitHost(event),
      refreshRuntimeContext: () => {},
    })
    const host = new HarnessHost(kept, options)
    ref.host = host
    await host.start(options)
    return host
  }

  // ── composition ──────────────────────────────────────────────────────

  private compose(options: HarnessHostOptions): InstalledGoal {
    const { tools, prompt, middleware } = this
    this.tools.setApprovalHandler((request) => this.approval.request(request))
    // A background turn nobody watches gets its approvals and questions
    // rejected at once instead of waiting on a card (KRN-01).
    this.approval.setAnswerer((request) => {
      const background = this.autoRejecting(request.agent)
      if (background === undefined)
        return this.pending.approvalAnswerer(request)
      background.rejected.push(request.toolName)
      return Promise.resolve('rejected')
    })
    this.questions.setAnswerer((request) => {
      const background = this.autoRejecting(request.agent)
      if (background === undefined)
        return this.pending.questionAnswerer(request)
      const plan = request.intent?.kind === 'plan-review'
      background.rejected.push(plan ? 'plan review' : 'ask_user_question')
      if (plan) background.planRejected = true
      return Promise.reject(
        new UserQuestionDismissed(
          'nobody can answer during a background turn; it was rejected',
        ),
      )
    })
    this.planMode.setReviewer(
      async ({ agent, callId, plan, title, signal }) => {
        const outcome = await this.questions.ask({
          agent,
          callId,
          signal,
          intent: { kind: 'plan-review', approve: 'Approve' },
          questions: [
            {
              id: 'plan-review',
              header: 'Plan review',
              question:
                title === undefined
                  ? 'Approve this plan and leave plan mode?'
                  : `Approve "${title}" and leave plan mode?`,
              detail: plan,
              options: [
                {
                  label: 'Approve',
                  description:
                    'Leave plan mode; the plan is carried out from the next step.',
                },
                {
                  label: 'Keep planning',
                  description:
                    'Stay in plan mode; feedback goes back to the model.',
                },
              ],
            },
          ],
        })
        if (outcome.outcome !== 'answered') return { kind: outcome.outcome }
        const review = outcome.answers['plan-review']
        if (
          review?.selected.length === 1 &&
          review.selected[0] === 'Approve' &&
          review.custom === undefined
        )
          return { kind: 'approved' }
        return {
          kind: 'keep-planning',
          ...(review?.custom === undefined ? {} : { feedback: review.custom }),
        }
      },
    )
    // Prompt: persona and variables.
    prompt.variable('model', ({ agent }) =>
      agent === undefined ? undefined : this.modelLabel(),
    )
    prompt.variable(
      'cwd',
      ({ agent }) => agent?.session.header.cwd ?? this.chatWorkspace(),
    )
    prompt.section({ name: 'persona', order: 0, text: this.personaText() })
    // The model and working directory change per session and on a model
    // switch: they live in the runtime context, never in the system prompt
    // prefix (provider prefix cache, replayed reasoning signatures).
    prompt.context({
      name: 'session:environment',
      order: 100,
      text: ({ agent }) =>
        agent === undefined
          ? ''
          : `Current model: ${this.modelLabel(agent)}. Working directory: ${JSON.stringify(agent.session.header.cwd ?? this.chatWorkspace())}.`,
    })
    installLinkGuidancePromptSection(prompt)
    this.sandbox.install(prompt)
    this.approval.install(prompt)
    this.planMode.install(prompt, middleware)
    prompt.tools(({ agent }) => tools.schemas(agent))
    // Tools.
    const services: ToolServices = {
      sandbox: this.sandbox,
      sandboxBackend: this.sandboxBackend,
      approval: this.approval,
      spillRoot: join(this.kept.paths.stateRoot, 'spill'),
      shellEnv: () => process.env,
      resolveBinary: (name) => (name === 'rg' ? this.ripgrepPath : undefined),
      // The table Seatbelt keeps Shell out of (LocalSandbox): Emperor's
      // private state and config files, and the user's credential files.
      protectedStateRoot: this.kept.paths.stateRoot,
    }
    const fs = createFsTools(services)
    tools.register(fs.read)
    tools.register(fs.write)
    tools.register(fs.edit)
    installFsPromptSections(prompt)
    const search = createSearchTools(services)
    tools.register(search.glob)
    tools.register(search.grep)
    installSearchPromptSections(prompt)
    tools.register(createShellTool(services, { jobs: this.jobs }))
    installShellPromptSection(prompt)
    for (const tool of createJobTools(this.jobs)) tools.register(tool)
    installJobsPromptSection(prompt)
    tools.register(createTodoTool())
    tools.register(createAskUserQuestionTool(this.questions))
    tools.register(this.planMode.tool())
    this.webTools.install(tools, prompt)
    const skills = {
      loaderFor: (agent: Agent | undefined) => this.skillsLoaderFor(agent),
    }
    tools.register(createSkillTool(skills))
    // Emperor Skills: writes ask unless danger-full-access (skill_manage).
    tools.register(
      createSkillManageTool({
        library: this.kept.skillLibrary,
        sandbox: this.sandbox,
        approval: this.approval,
        projectRootOf: (agent) =>
          agent === undefined
            ? null
            : this.projectRootFor(this.entryFor(agent)),
      }),
    )
    installSkillManagePromptSection(prompt, {
      userSkillsDir: this.kept.skillLoaders.userDir,
    })
    tools.register(
      createMemoryTool({
        memory: this.kept.sharedMemory,
        projects: this.kept.projectStore,
        sessionEntry: (agent) => this.entryFor(agent),
        permissionMode: (agent) =>
          this.sandbox.resolve({ session: agent.session }).mode,
        approval: this.approval,
      }),
    )
    tools.register(
      createSchedulerTool({
        service: this.kept.schedulerService,
        sessionIdOf: (agent) =>
          agent === undefined ? null : (this.entryFor(agent)?.id ?? null),
        inSchedulerRun: (agent) =>
          agent === undefined
            ? false
            : currentTurnSource(this.rootOf(agent).session.events) ===
              'scheduler',
      }),
    )
    // Emperor's own MCP config; writes ask unless danger-full-access, then reload.
    tools.register(
      createMcpConfigTool({
        stateRoot: this.kept.paths.stateRoot,
        sealer: this.kept.secretSealer,
        sandbox: this.sandbox,
        approval: this.approval,
        reload: () => this.reloadMcp(),
        status: () => this.kept.mcpClient.snapshot(),
      }),
    )
    installMcpConfigPromptSection(prompt, {
      configPath: mcpConfigDisplayPath(this.kept.paths.stateRoot),
    })
    installSubagents(
      this.subagents,
      tools,
      prompt,
      createDelegationTools({
        internalManager: this.subagents,
        delegations: () => this.delegations ?? undefined,
        ownerResolver: (agent, callId) => this.delegationOwner(agent, callId),
        canControl: (agent, owner) => this.canControlDelegation(agent, owner),
        // collect_agent({abandon}) ends a run only with the user's approval.
        approve: ({ agent, callId, reason, signal }) =>
          this.approval.request({
            agent,
            toolName: 'collect_agent',
            callId,
            reason,
            signal,
          }),
        // Plan mode explores read-only: external children default to review.
        parentReadOnly: (agent) =>
          this.sandbox.resolve({ session: agent.session }).mode ===
            'read-only' || this.planMode.get(this.rootOf(agent).session).active,
        briefContext: (agent) => {
          const cwd = this.sandbox.resolve({
              session: agent.session,
            }).workspaceRoot,
            root = workspaceMutationDomain(cwd)
          const instructions = discoverInstructionFiles(cwd, {
            globalDir: this.kept.paths.stateRoot,
          }).filter((file) => {
            if (
              file.absolutePath === join(this.kept.paths.stateRoot, 'AGENTS.md')
            )
              return false
            const path = relative(root, realpathSync(file.absolutePath))
            if (
              isAbsolute(path) ||
              path === '..' ||
              path.startsWith('..' + sep)
            )
              throw new DelegationError(
                'PERMISSION_DENIED',
                'workspace instruction resolves outside source root',
              )
            if (
              statSync(file.absolutePath).size > Buffer.byteLength(file.content)
            )
              throw new DelegationError(
                'BRIEF_LIMIT',
                'workspace instruction exceeds complete brief budget',
              )
            return true
          })
          const goal = this.goals.get(this.rootOf(agent))
          return {
            instructions,
            ...(goal && goal.phase !== 'complete'
              ? { goal: goal.objective }
              : {}),
          }
        },
      }),
    )
    prompt.context({
      name: 'external-executors',
      order: 121,
      // Nothing when no external executor is enabled (AGT-05).
      text: () => this.delegations?.executorContext() ?? '',
    })
    installWorkflow(tools, prompt, {
      engine: this.workflows,
      runs: this.workflowRuns,
    })
    // A goal starts no new round while work it waits for still runs:
    // external delegations, subagents, background jobs (DSH-6).
    const goal = installGoal({ prompt, middleware, tools }, this.goals, {
      driverOptions: {
        hasOutstandingDelegations: (id) =>
          (this.delegations?.hasOutstanding(id) ?? false) ||
          this.taskTreeBusy(id),
      },
    })
    this.jobs.onJobDone((_snapshot, owner) => {
      if (owner !== undefined)
        goal.driver.delegationSettled(this.rootOf(owner).id)
    })
    void createGoalTools
    // A step of a project session holds the project's MCP instance (started
    // on first use) until its agent goes idle, before its tools are listed
    // (KRN-01). Then middleware (order matters): instructions, memory,
    // skills, compaction, hooks.
    middleware.preAssemble.push(async (input) => {
      await this.askUnsandboxedServers(input.agent, input.signal)
      const projectRoot = this.projectRootOfAgent(input.agent)
      if (projectRoot !== null)
        await untilAborted(
          this.projectMcp.acquire(projectRoot, input.agent.id),
          input.signal,
        )
    })
    middleware.preStep.push(
      agentInstructionsMiddleware({
        globalDir: this.kept.paths.stateRoot,
        globalDisplay: '~/.emperor/AGENTS.md',
      }),
    )
    middleware.preStep.push(
      memoryMiddleware({
        memory: this.kept.sharedMemory,
        projects: this.kept.projectStore,
        sessionEntry: (agent) => this.entryFor(agent),
      }),
    )
    middleware.preStep.push(
      skillMiddleware(
        skills,
        (agent) => tools.get('skill', agent) !== undefined,
      ),
    )
    // `@plugin` gestures: the plugin's reference after the step's messages.
    middleware.preStep.push(
      pluginReferenceMiddleware(skills, () => this.pluginReferences),
    )
    this.compaction.install(middleware)
    middleware.requestError.push(retryMiddleware())
    // Saved model execution policy: fallback after retries give up.
    const modelPolicy: ModelPolicySource = {
      policy: () => this.kept.modelConfig.policy,
    }
    middleware.requestError.push(fallbackErrorMiddleware(modelPolicy, this.llm))
    middleware.requestConfig.push(fallbackConfigMiddleware(this.llm))
    // Task budget (KRN-03): every request's usage, failed attempts too, is
    // charged to its root task; a spent budget ends the turn before its
    // next step (the policy's cost cap, now over the whole task).
    middleware.requestEnd.push(({ agent, provider, usage, attempt }) => {
      this.taskTreeOf(agent).charge({ routeId: provider, usage }, attempt)
    })
    middleware.budget.push(({ agent, step }) =>
      this.taskTreeOf(agent).check(agent, step),
    )
    const reminder = createRepeatReminder()
    middleware.preStep.push(reminder.preStep)
    tools.postExecute.push(reminder)
    this.hooks.install(middleware, tools)
    // After hooks: a hook's deny short-circuits before any grant card.
    if (options.computerUsePort) this.installComputerUse(options)
    tools.postExecute.push(createSpillMiddleware({ root: services.spillRoot }))
    // Pending interactions change the control payload.
    this.pending.onChange((sessionId) => {
      this.emitHost({
        event: 'control_mode_update',
        session_id: sessionId,
        control: this.controlPayload(sessionId),
      })
    })
    this.subagents.observe({
      started: (child, record) => {
        // The parent's log carries `subagent/started`; the projector emits subagent_start.
        void record
        this.hooks.subagentStarted(child)
      },
      settled: (child) => {
        this.hooks.subagentStopped(child)
        this.projectMcp.release(child.id)
        goal.driver.delegationSettled(this.rootOf(child).id)
      },
      // Its jobs stop now; once idle it leaves the host's tables (CORE-17/19).
      disposed: (child) => this.taskTreeOf(child).disposeChild(child.id),
    })
    return goal
  }

  /** Master switch: persist, (un)register the GUI tools, tell the desktop. */
  /** Answer `@plugin` gestures from the plugin service (CoreApi). */
  setPluginReferenceResolver(resolver: PluginReferenceResolver | null): void {
    this.pluginReferences = resolver
  }

  setComputerUseEnabled(enabled: boolean): void {
    const installed = this.computerUse
    if (installed === null) return
    this.computerUseConfig?.update({ enabled })
    installed.setEnabled(enabled)
    // Switching off ends every Agent target; nothing keeps running unseen.
    if (!enabled) void installed.service.closeAll('revoked')
    this.computerUseEnabledChanged?.(enabled)
    this.emitHost({ event: 'computer_use_changed', reason: 'state' })
  }

  /**
   * One driver's switch (spec 00 §8.4): the tools stay registered and
   * answer CAPABILITY_DISABLED; switching off ends that driver's targets.
   */
  setComputerUseDriverEnabled(driver: DriverKind, enabled: boolean): void {
    const installed = this.computerUse
    if (installed === null) return
    this.computerUseConfig?.update({ drivers: { [driver]: enabled } })
    if (!enabled) void installed.service.closeDriver(driver, 'revoked')
    this.emitHost({ event: 'computer_use_changed', reason: 'state' })
  }

  /** How long downloads stay in the inbox (0: until the user removes them). */
  setComputerUseDownloadRetention(days: 0 | 7 | 30 | 90): void {
    if (this.computerUse === null) return
    this.computerUseConfig?.update({ downloadRetentionDays: days })
    this.emitHost({ event: 'computer_use_changed', reason: 'state' })
  }

  /**
   * Settings showed that the apps once kept from Emperor can be operated now
   * (the app lists were retired 2026-10-01); the notice does not return.
   */
  acknowledgeRetiredProtectedApps(): void {
    if (this.computerUse === null) return
    this.computerUseConfig?.acknowledgeRetiredProtectedApps()
    this.emitHost({ event: 'computer_use_changed', reason: 'state' })
  }

  private installComputerUse(options: HarnessHostOptions): void {
    const port = options.computerUsePort
    if (!port) return
    const stateDir = computerUseStateDir(this.kept.paths.stateRoot)
    if (options.computerUseSettings === undefined)
      this.computerUseConfig = new ComputerUseConfigStore(stateDir)
    const config = this.computerUseConfig
    const settings =
      options.computerUseSettings ??
      ((): ComputerUseSettings => {
        if (config === null) return { enabled: false }
        const retired = config.retiredProtectedApps()
        return retired.length === 0
          ? config.get()
          : { ...config.get(), retiredProtectedApps: retired }
      })
    this.computerUseEnabledChanged = options.computerUseEnabledChanged
    this.computerUse = installComputerUse({
      port,
      tools: this.tools,
      prompt: this.prompt,
      pending: this.pending,
      grantAnswerer: (request) => {
        const root = this.agents.get(request.session.id)
        const background =
          root === undefined ? undefined : this.autoRejecting(root)
        if (background === undefined) return this.pending.grantAnswerer(request)
        background.rejected.push(request.toolName ?? 'computer use')
        return Promise.resolve({
          decision: 'denied',
          backgroundAllowed: false,
        })
      },
      stateDir,
      profilesDir: browserStateDir(this.kept.paths.stateRoot),
      attachments: this.attachments,
      sessionFor: (sessionId) =>
        this.agents.get(sessionId)?.session ?? this.sessions.get(sessionId),
      rootOf: (agent) => this.rootOf(agent),
      planActive: (agent) => {
        const plan = this.planMode.get(this.rootOf(agent).session)
        return plan.active || plan.pending === true
      },
      routeVision: (agent) => this.routeVision(agent),
      toolFamilies: [
        createBrowserTools,
        createDesktopTools,
        createExternalTools,
      ],
      settings,
      onChanged: (reason, sessionId) => {
        this.emitHost({
          event: 'computer_use_changed',
          reason,
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
        })
      },
    })
    // The task ends when the root's turn ends with no background subagent
    // still running, or when the last one settles after that (2026-09-29
    // §3.3): every window and tab it controlled is released, nothing closed.
    // A question asked with ask_user_question keeps the turn open. In a
    // microtask: session listeners run inside a non-reentrant append.
    this.rawTap((sessionId, event) => {
      if (event.type === 'turn/end')
        queueMicrotask(() => this.releaseComputerUseIfTaskEnded(sessionId))
    })
    this.subagents.observe({
      settled: (child) => {
        // By root: a disposed child may already have left the tables.
        const rootId = this.rootOf(child).id
        queueMicrotask(() => this.releaseComputerUseIfTaskEnded(rootId))
      },
    })
  }

  /** See `installComputerUse`: release when this agent's task has ended. */
  private releaseComputerUseIfTaskEnded(sessionId: string): void {
    const service = this.computerUse?.service
    const agent = this.agents.get(sessionId)
    if (service === undefined || agent === undefined) return
    const root = this.rootOf(agent)
    // The root's turn goes on (a subagent's turn ended, or a follow-up
    // already started the next turn): the task is not over.
    if (root.session.hasOpenTurn()) return
    if (
      this.subagents
        .list(root, 'descendants')
        .some((child) => child.status === 'running')
    )
      return
    void service.releaseTask(root.id, 'task-end')
  }

  /** Whether the route that served the agent's latest request can see images. */
  private routeVision(agent: Agent): boolean {
    const events = agent.session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type !== 'request/header') continue
      try {
        return this.llm.route(event.data.header.config.provider).vision
      } catch {
        return false
      }
    }
    return this.llm.activeRoute()?.vision ?? false
  }

  private async start(options: HarnessHostOptions): Promise<void> {
    this.kept.schedulerService.onJob = createSchedulerExecutor({
      // A scheduled turn runs in its own session, never moves the session in
      // view, rejects approvals nobody can answer and stops after 30 minutes.
      runTurn: async (request) =>
        await this.runBackgroundTurn(
          this.scopeFor(
            request.sessionId ?? this.defaultBackgroundSession().id,
          ),
          request.content,
          {
            source: 'scheduler',
            displayContent: request.displayContent,
            clientMessageId: request.clientMessageId,
            scheduler: request.scheduler,
            signal: request.signal,
            timeoutMs: DEFAULT_BACKGROUND_TURN_TIMEOUT_MS,
            interactionPolicy: 'auto-reject',
          },
        ),
      timeoutMs: DEFAULT_BACKGROUND_TURN_TIMEOUT_MS,
      hasPendingInteraction: (sessionId) =>
        sessionId === null ? false : this.pending.hasPending(sessionId),
      watchlistCheck: async (signal) => await this.watchlist.check(signal),
    })
    let environment:
      | Awaited<
          ReturnType<KeptServices['executionEnvironmentService']['create']>
        >
      | undefined
    try {
      environment = await this.kept.executionEnvironmentService.create({
        projectRoot: this.chatWorkspace(),
      })
      this.ripgrepPath = environment.toolPaths.ripgrep
    } catch (error: unknown) {
      logger.warn('execution environment probe failed', {
        error: String(error),
      })
    }
    if (options.initializeMcp !== false) {
      try {
        environment ??= await this.kept.executionEnvironmentService.create({
          projectRoot: this.chatWorkspace(),
        })
        await this.kept.mcpClient.initialize(environment)
        this.mcpTools.sync()
      } catch (error: unknown) {
        logger.warn('MCP initialization failed', { error: String(error) })
      }
    }
    try {
      this.kept.schedulerService.start()
    } catch (error: unknown) {
      logger.warn('scheduler failed to start', { error: String(error) })
    }
    if (options.watchSkills !== false) await this.startSkillWatcher()
  }

  /** Watch user, known project, and Plugin Skill folders for catalog changes. */
  private async startSkillWatcher(): Promise<void> {
    const loaders = this.kept.skillLoaders
    try {
      mkdirSync(loaders.userDir, { recursive: true })
      this.unwatchSkillRoots = loaders.onRootsChanged(() => {
        void this.syncSkillWatchRoots()
      })
      await this.syncSkillWatchRoots()
      await this.kept.skillChangeDetector.start()
    } catch (error: unknown) {
      logger.warn('skill watcher failed to start', { error: String(error) })
    }
  }

  private async syncSkillWatchRoots(): Promise<void> {
    if (this.closed) return
    try {
      await this.kept.skillChangeDetector.setRoots(
        this.kept.skillLoaders.watchRoots().filter((root) => existsSync(root)),
      )
    } catch (error: unknown) {
      logger.warn('skill watcher roots update failed', {
        error: String(error),
      })
    }
  }

  private agentDeps(): AgentDeps {
    return {
      llm: this.llm,
      tools: this.tools,
      prompt: this.prompt,
      middleware: this.middleware,
    }
  }

  private personaText(): string {
    const path = join(this.kept.templatesDir, 'agent', 'persona.md')
    if (existsSync(path)) return readFileSync(path, 'utf8').trim()
    return 'You are Emperor Agent, a coding agent. The runtime context names the model you run on and your working directory.'
  }

  /** The route an agent's next request goes to; no agent: the active route. */
  private routeOf(agent: Agent | undefined): RouteSpec | undefined {
    try {
      return agent === undefined
        ? this.llm.activeRoute()
        : this.llm.route(agent.proposedCallConfig().provider)
    } catch {
      // No model configured yet.
      return undefined
    }
  }

  /** The model an agent is on (its own route, or this turn's fallback). */
  private modelLabel(agent?: Agent): string {
    if (agent !== undefined) {
      try {
        return currentModel(agent, this.llm)
      } catch {
        // no route configured yet
      }
    }
    const route = this.llm.activeRoute()
    return route === undefined ? 'configured' : route.modelId
  }

  // ── model configuration ─────────────────────────────────────────────

  applyModelConfig(config: ModelConfig): void {
    const routes = config.models.flatMap((entry) => {
      try {
        return [routeFromEntry(entry)]
      } catch (error: unknown) {
        logger.warn('skipping unusable model entry', {
          entry: entry.entryId,
          error: String(error),
        })
        return []
      }
    })
    const active = findEntry(config, config.activeModelId)
    this.llm.setRoutes(
      routes,
      active === undefined ? null : (active.entryId ?? active.id),
    )
  }

  async refreshModelConfig(): Promise<void> {
    const config = await loadModelConfig(this.kept.paths.stateRoot, {
      create: true,
      sealer: this.kept.secretSealer,
    })
    this.kept.modelConfig = config
    this.applyModelConfig(config)
  }

  /**
   * SEC-08: a user's MCP server that is waiting to run outside an
   * unavailable sandbox is asked about once, on the ordinary approval card
   * of the next step of a conversation the user is in (never a background
   * turn, a subagent, or a session whose approvals are off). The answer is
   * remembered per server and command; an allowed server starts in that
   * step. A dismissed card asks again next time.
   */
  private async askUnsandboxedServers(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<void> {
    const consent = this.kept.unsandboxedConsent
    if (consent.pending().length === 0) return
    if (
      this.rootOf(agent) !== agent ||
      !agent.session.hasOpenTurn() ||
      this.autoRejecting(agent) !== undefined ||
      this.approval.effectivePolicy(agent.session) === 'never'
    )
      return
    let allowed = false
    for (const request of consent.pending()) {
      if (signal.aborted) return
      const outcome = await this.approval.request({
        agent,
        toolName: 'mcp_server',
        reason: unsandboxedServerQuestion(request),
        signal,
      })
      if (outcome === 'allowed-once') {
        consent.resolve(request, 'allowed')
        allowed = true
      } else if (outcome === 'rejected') consent.resolve(request, 'denied')
    }
    if (!allowed) return
    try {
      await untilAborted(this.reloadMcp(), signal)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      logger.warn('MCP reload after an unsandboxed consent failed', {
        error: String(error),
      })
    }
  }

  /** Reload the global servers (mcp_config.json and user-wide plugins). */
  async reloadMcp(): Promise<void> {
    const environment = await this.kept.executionEnvironmentService.create({
      projectRoot: this.chatWorkspace(),
    })
    this.ripgrepPath = environment.toolPaths.ripgrep
    await this.kept.mcpClient.reload(environment)
    this.mcpTools.sync()
  }

  // ── sessions and agents ─────────────────────────────────────────────

  /** Chat-mode workspace: a writable scratch directory under Emperor Home. */
  chatWorkspace(): string {
    const dir = join(this.kept.paths.stateRoot, 'workspace')
    // 0700 like every other Emperor Home directory (see ensureRuntimeStateDirs):
    // chat sessions do their file work here.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(dir, 0o700)
    return dir
  }

  workspaceRootFor(entry: SessionEntry | null | undefined): string {
    if (entry?.mode === 'build' && entry.project_path)
      return resolve(entry.project_path)
    return this.chatWorkspace()
  }

  /** A conversation's workspace (project root, or the chat workspace). */
  sessionWorkspaceRoot(sessionId: string): string {
    return this.workspaceRootFor(this.kept.sessionStore.get(sessionId))
  }

  /** One session's scope (KRN-01): its project and where its tools work. */
  scopeFor(
    sessionId: string | null | undefined,
    operation = 'scope',
  ): SessionScope {
    const id = String(sessionId ?? '').trim()
    if (!id) throw new SessionRequiredError(operation)
    const entry = this.kept.sessionStore.get(id)
    if (entry === null) throw new Error(`unknown session ${id}`)
    return scopeOfEntry(entry, this.chatWorkspace())
  }

  /** The project an agent works in: its root session's (null for Chat). */
  projectRootOfAgent(agent: Agent | undefined): string | null {
    return agent === undefined
      ? null
      : this.projectRootFor(this.entryFor(agent))
  }

  /** Which plugins' global copies a project replaces (the plugin activation controller). */
  setProjectPluginOverrides(
    overrides: (projectRoot: string) => ReadonlySet<string>,
  ): void {
    this.projectPluginOverrides = overrides
  }

  /**
   * The tools a session of `scope` sees, for views without an agent: the
   * built-in tools and the global MCP tools, plus its project's MCP tools.
   */
  toolSchemasFor(scope: SessionScope | null): ToolSchema[] {
    const mcp = new Set(this.mcpTools.names())
    return [
      ...this.tools.schemas().filter((schema) => !mcp.has(schema.name)),
      ...this.mcpTools.schemasFor(scope?.projectRoot ?? null),
    ].sort((left, right) => left.name.localeCompare(right.name))
  }

  /** The root (session-level) agent of an owner chain. */
  delegationOwner(agent: Agent, callId: string): DelegationOwner {
    const root = this.rootOf(agent),
      goal = this.goals.get(root)
    let messageId: string | undefined
    for (let i = root.session.events.length - 1; i >= 0; i--) {
      const e = root.session.events[i]!
      if (
        e.type === 'user/message' &&
        (e.data.source.kind === 'user' ||
          (e.data.source.kind === 'context' &&
            e.data.source.producer === 'scheduler'))
      ) {
        messageId = e.data.id
        break
      }
    }
    const activeGoal = goal && goal.phase !== 'complete' ? goal : undefined
    return {
      rootSessionId: root.id,
      parentAgentId: agent.id,
      taskScopeId: activeGoal
        ? 'goal:' + activeGoal.id
        : 'message:' + (messageId ?? root.id),
      ...(activeGoal
        ? { goalRef: { id: activeGoal.id, revision: activeGoal.revision } }
        : {}),
      requiredForGoal: Boolean(activeGoal),
      parentCallId: callId,
      depth: agent.depth + 1,
      source:
        currentTurnSource(root.session.events) === 'scheduler'
          ? 'scheduler'
          : 'model',
    }
  }
  delegationParent(owner: DelegationOwner): DelegationParentContext {
    const parent =
      this.agents.get(owner.parentAgentId) ??
      this.subagents.get(owner.parentAgentId)
    if (!parent || this.rootOf(parent).id !== owner.rootSessionId)
      throw new DelegationError(
        'PARENT_NOT_FOUND',
        'delegation parent is not active',
      )
    let policy = this.sandbox.resolve({ session: parent.session })
    let planMode = false
    const rank = {
      'read-only': 0,
      'workspace-write': 1,
      'danger-full-access': 2,
    }
    for (
      let ancestor: Agent | undefined = parent;
      ancestor;
      ancestor = ancestor.owner
    ) {
      const ancestorPolicy = this.sandbox.resolve({ session: ancestor.session })
      if (rank[ancestorPolicy.mode] < rank[policy.mode])
        policy = { ...policy, mode: ancestorPolicy.mode }
      planMode ||= this.planMode.get(ancestor.session).active
    }
    return { cwd: policy.workspaceRoot, policy, planMode }
  }
  canControlDelegation(agent: Agent, owner: DelegationOwner): boolean {
    if (this.rootOf(agent).id !== owner.rootSessionId) return false
    if (agent.id === owner.rootSessionId || agent.id === owner.parentAgentId)
      return true
    let target =
      this.agents.get(owner.parentAgentId) ??
      this.subagents.get(owner.parentAgentId)
    while (target) {
      if (target.id === agent.id) return true
      target = target.owner
    }
    return false
  }
  rootOf(agent: Agent): Agent {
    let current = agent
    while (current.owner !== undefined) current = current.owner
    return current
  }

  entryFor(agent: Agent): SessionEntry | null {
    let current: Agent | undefined = agent
    while (current?.owner !== undefined) current = current.owner
    return current === undefined ? null : this.kept.sessionStore.get(current.id)
  }

  /**
   * Where a background turn without a session runs (a scheduler job created
   * before jobs named their session): the most recent session, or a new one.
   */
  defaultBackgroundSession(): SessionEntry {
    return (
      this.kept.sessionStore.list()[0] ??
      this.kept.sessionStore.create('新会话', { mode: 'chat' })
    )
  }

  /** Project root whose Skills a session sees (Build sessions only). */
  projectRootFor(entry: SessionEntry | null | undefined): string | null {
    return entry?.mode === 'build' && entry.project_path
      ? resolve(entry.project_path)
      : null
  }

  /** The skills loader scoped to an agent's session (project skills in build mode). */
  skillsLoaderFor(agent: Agent | undefined): FileSkillsLoader {
    return this.kept.skillLoaders.forProject(
      agent === undefined ? null : this.projectRootFor(this.entryFor(agent)),
    )
  }

  /** The skills loader of a session index entry (chat loader for unknown ids). */
  skillsForSession(sessionId: string | null | undefined): FileSkillsLoader {
    return this.kept.skillLoaders.forProject(
      this.projectRootForSession(sessionId),
    )
  }

  projectRootForSession(sessionId: string | null | undefined): string | null {
    const id = String(sessionId ?? '').trim()
    return id ? this.projectRootFor(this.kept.sessionStore.get(id)) : null
  }

  /** The live agent of a session index entry (opening or creating its log). */
  agentFor(sessionId: string): Agent {
    const existing = this.agents.get(sessionId)
    if (existing !== undefined) return existing
    const entry = this.kept.sessionStore.get(sessionId)
    if (entry === null) throw new Error(`unknown session ${sessionId}`)
    const cwd = this.workspaceRootFor(entry)
    let session =
      this.sessions.get(sessionId) ?? this.sessions.tryOpen(sessionId)
    const fresh = session === undefined
    if (session === undefined)
      session = this.sessions.create({ id: sessionId, cwd })
    const tree = this.taskTree(sessionId)
    const agent = this.attachAgent(
      new Agent(session, this.agentDeps(), { admission: tree.gate }),
    )
    tree.setRoot(agent)
    if (fresh) this.presets.pin(session, this.defaultPreset)
    this.goalInstall.driver.attach(agent)
    this.hooks.sessionStarted(agent, fresh ? 'startup' : 'resume')
    return agent
  }

  /** Wire one agent (root or child) to projection, usage tracking, and the registry. */
  private attachAgent(agent: Agent): Agent {
    const sessionId = agent.id
    this.agents.set(sessionId, agent)
    const projector = new SessionProjector({
      sessionId,
      controlPayload: () => this.controlPayload(sessionId),
    })
    for (const event of agent.session.events) projector.apply(event)
    this.projectors.set(sessionId, projector)
    const parentCallId = this.parentCallId(agent)
    if (agent.owner === undefined)
      this.announcedQueue.set(
        sessionId,
        new Set(this.queuedPrompts(sessionId).map((p) => p.prompt_id)),
      )
    const unsubscribe = agent.session.subscribe((_session, event) => {
      if (event.type === 'sandbox/mode' || event.type === 'plan/mode') {
        const root = this.rootOf(agent)
        if (this.delegations?.parentPermissionsRevoked(root.id)) {
          this.goals.disarm(root)
          this.delegationInteractions.cancelRoot(root.id)
          this.delegationConsent.cancelRoot(root.id)
          void this.delegations.stopRoot(root.id).catch((error) =>
            logger.warn('external permission revocation needs recovery', {
              error: String(error),
            }),
          )
        }
      }
      // The splice is logged before the inbox applies it: diff afterwards.
      if (agent.owner === undefined && event.type === 'agent/inbox/spliced')
        queueMicrotask(() => {
          this.announceQueueChanges(sessionId)
        })
      const uiEvents = projector.apply(event)
      if (agent.owner === undefined) {
        for (const uiEvent of uiEvents) void this.sink(uiEvent)
      } else {
        this.forwardChildEvents(agent, parentCallId, uiEvents)
      }
      this.trackUsage(agent, event)
      this.publishRaw(sessionId, event)
    })
    const unobserve = agent.observe({
      queue: (_agent, change) => {
        if (agent.owner === undefined) this.announceQueueItem(sessionId, change)
      },
      status: (_agent, status) => {
        if (status === 'idle') this.projectMcp.release(sessionId)
        if (status === 'idle' && agent.owner === undefined) {
          try {
            const last = agent.session.lastOf('assistant/message')
            this.kept.sessionStore.touch(
              sessionId,
              last === undefined
                ? ''
                : messageText(last.data.message).slice(0, 120),
              { incrementMessages: true },
            )
          } catch {
            // index touch is best-effort
          }
        }
      },
    })
    this.unsubscribes.set(sessionId, () => {
      unsubscribe()
      unobserve()
    })
    return agent
  }

  /** Forget a disposed child: its subscription, projector and table entry. */
  private detachAgent(sessionId: string): void {
    this.unsubscribes.get(sessionId)?.()
    this.unsubscribes.delete(sessionId)
    this.projectors.delete(sessionId)
    this.agents.delete(sessionId)
    this.projectMcp.release(sessionId)
  }

  /** A root session's task tree (made on first use). */
  private taskTree(rootId: string): TaskTree {
    let tree = this.taskTrees.get(rootId)
    if (tree === undefined) {
      tree = new TaskTree(rootId, {
        budget: () => this.taskBudget(),
        pricing: (routeId) =>
          findEntry(this.kept.modelConfig, routeId)?.pricing,
        background: (root) => {
          const turn = currentTurnInfo(root.session.events)
          return turn.source === 'scheduler' || turn.goalRound
        },
        disposeJobs: (agentId) => this.jobs.disposeOwner(agentId),
        disposeChildren: (id) => this.subagents.disposeChildrenOf(id),
        // Nothing runs on its own past the cost cap: the goal waits for the user.
        exhausted: () => {
          const root = this.agents.get(rootId)
          if (root !== undefined) this.goals.disarm(root)
        },
      })
      this.taskTrees.set(rootId, tree)
    }
    return tree
  }

  /** The task tree an agent (root or child) belongs to. */
  private taskTreeOf(agent: Agent): TaskTree {
    return this.taskTree(this.rootOf(agent).id)
  }

  /** Whether a root's subagents, or any background job of its tree, still run. */
  private taskTreeBusy(rootId: string): boolean {
    const tree = this.taskTrees.get(rootId)
    return (
      tree !== undefined &&
      (tree.childrenActive() || this.jobs.hasActive(tree.agentIds()))
    )
  }

  /** One task's budget now: the settings and the model policy's cost cap. */
  private taskBudget(): TaskBudget {
    const cap = this.kept.modelConfig.policy?.cost.maxUsdPerAgentTurn
    return {
      ...this.taskBudgetSettings,
      ...(cap === null || cap === undefined ? {} : { maxCostUsd: cap }),
    }
  }

  /** 设置 › 高级 › 任务预算 as the host applies it. */
  get taskBudgetSettingsNow(): TaskBudgetSettings {
    return { ...this.taskBudgetSettings }
  }

  /** Apply new budget settings to every task from its next decision on. */
  setTaskBudget(settings: TaskBudgetSettings): void {
    this.taskBudgetSettings = normalizeTaskBudgetSettings(settings)
    // A larger pool may start agents that wait for a slot.
    for (const tree of this.taskTrees.values()) tree.wake()
  }

  /** Tell the queue UI a user message changed state (host-only `queue_item_state`). */
  private announceQueueItem(sessionId: string, change: QueueChange): void {
    if (!isUserTyped(change.message)) return
    this.emitHost({
      event: 'queue_item_state',
      session_id: sessionId,
      prompt_id: change.message.id,
      state: change.state,
      ...('reason' in change ? { reason: change.reason } : {}),
    })
  }

  /** Emit prompt_queued / prompt_dequeued for inbox changes since the last call. */
  private announceQueueChanges(sessionId: string): void {
    if (!this.agents.has(sessionId)) return
    const previous = this.announcedQueue.get(sessionId) ?? new Set<string>()
    const current = new Set(
      this.queuedPrompts(sessionId).map((prompt) => prompt.prompt_id),
    )
    for (const promptId of current) {
      if (!previous.has(promptId))
        this.emitHost({
          event: 'prompt_queued',
          session_id: sessionId,
          prompt_id: promptId,
        })
    }
    for (const promptId of previous) {
      if (!current.has(promptId))
        this.emitHost({
          event: 'prompt_dequeued',
          session_id: sessionId,
          prompt_id: promptId,
        })
    }
    this.announcedQueue.set(sessionId, current)
  }

  private parentCallId(agent: Agent): string | undefined {
    const descriptor = agent.session.lastOf('subagent/descriptor')
    return descriptor?.data.parentCallId
  }

  /** Child sessions stream to the root UI as subagent_* events. */
  private forwardChildEvents(
    child: Agent,
    parentCallId: string | undefined,
    events: UiEvent[],
  ): void {
    let root: Agent = child
    while (root.owner !== undefined) root = root.owner
    const base = {
      session_id: root.id,
      parent_id: parentCallId,
      subagent_id: child.id,
      agent_type: 'subagent',
    }
    for (const event of events) {
      if (event.event === 'message_delta')
        this.emitHost({ ...base, event: 'subagent_delta', delta: event.delta })
      else if (event.event === 'tool_call')
        this.emitHost({
          ...base,
          event: 'subagent_tool_call',
          id: event.id,
          name: event.name,
          arguments: event.arguments,
        })
      else if (event.event === 'tool_result')
        this.emitHost({
          ...base,
          event:
            event.is_error === true
              ? 'subagent_tool_error'
              : 'subagent_tool_result',
          id: event.id,
          name: event.name,
          summary: String(event.output ?? '').slice(0, 200),
          message: String(event.output ?? '').slice(0, 200),
        })
      else if (event.event === 'assistant_done')
        this.emitHost({
          ...base,
          event: 'subagent_done',
          summary: String(event.content ?? '').slice(0, 2000),
        })
      else if (event.event === 'error')
        this.emitHost({
          ...base,
          event: 'subagent_error',
          message: event.message,
        })
    }
  }

  /**
   * One token-ledger row per model call that reported usage: conversation
   * steps and compaction summaries, with disjoint counts, the entry's
   * provider and the cost from its (or the catalog's) price (CORE-18).
   */
  private trackUsage(agent: Agent, event: SessionEvent): void {
    let call:
      | { usage: TokenUsage; routeId: string; model: string; type: string }
      | undefined
    if (event.type === 'assistant/message' && event.data.usage !== undefined)
      call = {
        usage: event.data.usage,
        routeId: event.data.message.source.provider,
        model: event.data.message.source.model,
        type: agent.owner === undefined ? 'main_agent' : 'subagent',
      }
    else if (
      event.type === 'compaction/summary' &&
      event.data.usage !== undefined
    )
      call = {
        usage: event.data.usage,
        routeId: event.data.provider,
        model: event.data.model,
        type: 'compaction',
      }
    if (call === undefined) return
    try {
      const entry = findEntry(this.kept.modelConfig, call.routeId)
      const counts = ledgerUsage(call.usage)
      this.kept.tokenTracker.record(
        call.model,
        { ...counts },
        {
          provider: entry?.provider ?? null,
          usageType: call.type,
          modelEntryId: call.routeId,
          costUsd:
            entry === undefined
              ? null
              : usageCostUsd(counts, entryPrices(entry)),
        },
      )
    } catch {
      // usage accounting never breaks a turn
    }
  }

  // ── turns ───────────────────────────────────────────────────────────

  /** Pixel size of a stored image, for token pricing (KRN-05); empty when unreadable. */
  private imageSize(ref: AttachmentRef): { width?: number; height?: number } {
    try {
      return imageDimensions(this.attachments.readBytes(ref)) ?? {}
    } catch {
      return {}
    }
  }

  private userContent(input: SubmitInput): ContentBlock[] {
    const blocks: ContentBlock[] = []
    const extra: string[] = []
    for (const id of input.attachmentIds ?? []) {
      const ref: AttachmentRef | null = this.attachments.get(id)
      if (ref === null) continue
      if (ref.kind === 'image') {
        blocks.push({
          type: 'image',
          attachment: {
            attachmentId: ref.id,
            mediaType: ref.mime,
            bytes: ref.size,
            ...this.imageSize(ref),
          },
        })
      } else if (ref.has_text) {
        const text = this.attachments.readText(ref)
        extra.push(
          text
            ? `\n\n[附件 ${ref.name} 提取文本]\n${text}\n[/附件 ${ref.name}]`
            : `\n[附件 ${ref.name} 已落盘但抽取文本为空]`,
        )
      } else {
        extra.push(
          `\n[附件 ${ref.name} 已落盘: ${join(this.kept.paths.stateRoot, ref.rel_path)}]`,
        )
      }
    }
    const text = `${input.content}${extra.join('')}`
    return [
      ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
      ...blocks,
    ]
  }

  /**
   * Deliver one user prompt. Resolves when the turn that consumed it ended
   * (or immediately for an interjection into a running turn).
   */
  delegationNoticeParent(
    owner: import('../delegation/types').DelegationOwner,
  ): Agent | undefined {
    const root = this.kept.sessionStore.get(owner.rootSessionId)
    if (!root || root.archived_at || this.closed) return undefined
    return owner.parentAgentId === owner.rootSessionId
      ? this.agentFor(owner.rootSessionId)
      : this.agents.get(owner.parentAgentId)
  }
  private resumeDelegationNotices(input: SubmitInput): void {
    if (input.scheduler || (input.source && input.source !== 'user')) return
    void this.delegations?.resumeRootNotices(input.sessionId).catch((error) =>
      logger.warn('external result notification remains pending', {
        error: String(error),
      }),
    )
  }
  /**
   * Deliver one user prompt to its session. Resolves when the turn that
   * consumed it ended (or immediately for an interjection into a running
   * turn). The session the user is looking at does not change (KRN-01).
   */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    return await this.deliver(input)
  }

  /**
   * Run one turn in the background (scheduler, ACP, onboarding): in
   * the session `scope` names, never the one in view, with a typed result.
   * `auto-reject` answers its approvals and questions with a rejection at
   * once (the result is `blocked`); `timeoutMs` aborts it (`aborted` by
   * `timeout`, or `blocked` on `interaction-timeout` when it was waiting on
   * the user).
   */
  async runBackgroundTurn(
    scope: SessionScope,
    content: string,
    options: BackgroundTurnOptions,
  ): Promise<BackgroundTurnOutcome> {
    const sessionId = this.scopeFor(
      scope.sessionId,
      'runBackgroundTurn',
    ).sessionId
    const policy: InteractionPolicy = options.interactionPolicy ?? 'wait'
    let state: BackgroundTurnState | undefined
    let root: Agent | undefined
    let timer: unknown = null
    let timedOut: 'idle' | 'waiting' | null = null
    const emit = options.emit ?? null
    const untap =
      emit === null
        ? null
        : this.tap(async (event) => {
            if (event.session_id === sessionId) await emit(event)
          })
    try {
      const submitted = await this.deliver(
        {
          sessionId,
          content,
          displayContent: options.displayContent ?? null,
          clientMessageId: options.clientMessageId ?? null,
          source: options.source,
          scheduler: options.scheduler ?? null,
          uiHidden: options.uiHidden ?? null,
          signal: options.signal ?? null,
          unconsumed: options.unconsumed ?? null,
          delivery: 'queue',
        },
        (messageId, agent) => {
          root = agent
          state = { messageId, policy, rejected: [], planRejected: false }
          const states = this.backgroundTurns.get(agent.id) ?? []
          states.push(state)
          this.backgroundTurns.set(agent.id, states)
          const limit = options.timeoutMs ?? null
          if (limit !== null && limit > 0)
            timer = this.timers.setTimeout(() => {
              timedOut = this.pending.hasPending(sessionId) ? 'waiting' : 'idle'
              agent.cancelMessage(messageId)
            }, limit)
        },
      )
      let result: TurnResult = submitted.result ?? {
        kind: 'aborted',
        by: 'system',
        turnId: submitted.turnId,
      }
      if (timedOut !== null && result.kind === 'aborted')
        result =
          timedOut === 'waiting' && result.turnId !== null
            ? {
                kind: 'blocked',
                reason: 'interaction-timeout',
                turnId: result.turnId,
              }
            : { ...result, by: 'timeout' }
      else if (
        state !== undefined &&
        state.rejected.length > 0 &&
        result.kind === 'completed'
      )
        result = {
          kind: 'blocked',
          reason: state.planRejected ? 'plan-mode' : 'interaction-rejected',
          turnId: result.turnId,
          detail: [...new Set(state.rejected)].join('、'),
        }
      return {
        sessionId,
        messageId: submitted.messageId,
        turnId: submitted.turnId,
        content: submitted.content,
        delivery: submitted.delivery,
        result,
      }
    } finally {
      if (timer !== null) this.timers.clearTimeout(timer)
      if (root !== undefined && state !== undefined) {
        const states = (this.backgroundTurns.get(root.id) ?? []).filter(
          (item) => item !== state,
        )
        if (states.length > 0) this.backgroundTurns.set(root.id, states)
        else this.backgroundTurns.delete(root.id)
      }
      untap?.()
    }
  }

  /**
   * The auto-rejecting background turn an agent's interaction belongs to:
   * its root session's current turn is the one that took a background
   * message with policy `auto-reject`.
   */
  private autoRejecting(agent: Agent): BackgroundTurnState | undefined {
    const root = this.rootOf(agent)
    const states = this.backgroundTurns.get(root.id)
    if (states === undefined || !root.session.hasOpenTurn()) return undefined
    const current = root.position.turn
    return states.find(
      (state) =>
        state.policy === 'auto-reject' &&
        turnOfMessage(root.session.events, state.messageId) === current,
    )
  }

  private async deliver(
    input: SubmitInput,
    beforeSend?: (messageId: string, agent: Agent) => void,
  ): Promise<SubmitResult> {
    const agent = this.agentFor(input.sessionId)
    const message: UserMessage = createUserMessage({
      content: this.userContent(input),
      source: { kind: 'user' },
    })
    const attachments = (input.attachmentIds ?? [])
      .map((id) => this.attachments.get(id))
      .filter((ref): ref is AttachmentRef => ref !== null)
      .map((ref) => ({
        id: ref.id,
        name: ref.name,
        mime: ref.mime,
        size: ref.size,
        kind: ref.kind,
      }))
    agent.session.append('host/user-meta', {
      messageId: message.id,
      ...(input.clientMessageId
        ? { clientMessageId: input.clientMessageId }
        : {}),
      ...(input.displayContent ? { displayContent: input.displayContent } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
      ...(input.referencesDropped ? { referencesDropped: true } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.scheduler ? { scheduler: input.scheduler } : {}),
      ...(input.uiHidden ? { uiHidden: true } : {}),
    })
    // The user (or a scheduler) asks: a new task, a fresh budget (KRN-03).
    this.taskTree(agent.id).beginTask()
    if (input.delivery === 'interject' && agent.status === 'running') {
      agent.steer(message)
      this.resumeDelegationNotices(input)
      return {
        sessionId: agent.id,
        messageId: message.id,
        turnId: null,
        content: '',
        delivery: 'interjected',
        result: null,
      }
    }
    // The submitter's cancel reaches only this message: discarded while it
    // waits, or only the turn that took it (CORE-23).
    const onAbort = (): void => {
      agent.cancelMessage(message.id)
    }
    const outcome = agent.outcome(message.id)
    beforeSend?.(message.id, agent)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      agent.followup(message)
      if (input.signal?.aborted) onAbort()
      this.resumeDelegationNotices(input)
      const settled = await outcome
      const withdrawn =
        settled.kind === 'not-consumed' &&
        input.unconsumed === 'withdraw' &&
        agent.inbox.discard(message.id, 'cancelled')
      // Resolve once that turn has fully ended (the driver is idle or on to
      // the next queued turn), as callers did when submit awaited idleness.
      if (settled.kind !== 'discarded')
        await agent.whenTurnSettled(
          settled.kind === 'consumed' ? settled.turn : undefined,
        )
      const result = submitResultFor(agent, message.id, settled)
      return withdrawn ? { ...result, delivery: 'discarded' } : result
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Generate the first title for a freshly promoted session. */
  async generateTitle(
    sessionId: string,
    firstMessage: string,
  ): Promise<SessionEntry | null> {
    const title = await generateSessionTitle(this.llm, firstMessage)
    return this.kept.sessionStore.setGeneratedTitle(sessionId, title)
  }

  stop(sessionId: string): boolean {
    this.delegationInteractions.cancelRoot(sessionId)
    this.delegationConsent.cancelRoot(sessionId)
    const externalActive =
      this.delegations
        ?.list()
        .some(
          (state) =>
            state.record?.owner.rootSessionId === sessionId &&
            state.record.availability === 'active',
        ) ?? false
    void this.delegations?.stopRoot(sessionId).catch((error) =>
      logger.warn('external delegation stop requires recovery', {
        error: String(error),
      }),
    )
    const agent = this.agents.get(sessionId)
    if (agent === undefined) return externalActive
    const running = agent.status === 'running'
    this.pending.cancelSession(sessionId)
    this.goals.disarm(agent)
    agent.cancel({ kind: 'user' })
    this.subagents.disposeChildrenOf(sessionId)
    return running || externalActive
  }

  isBusy(sessionId: string | null): boolean {
    if (sessionId === null) return false
    return this.agents.get(sessionId)?.status === 'running'
  }

  busySessions(): string[] {
    return [...this.agents.values()]
      .filter(
        (agent) => agent.owner === undefined && agent.status === 'running',
      )
      .map((agent) => agent.id)
  }

  /**
   * The user's queue: waiting and held user prompts. A prompt a step has
   * reserved (state `sending`) is left out; it either enters (its
   * user_message follows) or comes back (queue_item_state).
   */
  queuedPrompts(sessionId: string): QueuedPrompt[] {
    const agent = this.agents.get(sessionId)
    if (agent === undefined) return []
    const listed = (
      messages: readonly UserMessage[],
      target: QueuedPrompt['target'],
    ): QueuedPrompt[] =>
      messages.flatMap((message) => {
        if (!isUserTyped(message)) return []
        const state = agent.inbox.stateOf(message.id)
        if (state === undefined || state === 'sending') return []
        const reason = agent.inbox.holdReason(message.id)
        return [
          {
            prompt_id: message.id,
            content: messageText(message),
            state,
            ...(reason === undefined ? {} : { reason }),
            target,
          },
        ]
      })
    return [
      ...listed(agent.inbox.nextStep, 'next-step'),
      ...listed(agent.inbox.nextTurn, 'next-turn'),
    ]
  }

  /**
   * Queue actions: `cancel` discards a waiting or held prompt (丢弃),
   * `interject` moves it into the running turn's next step, `send` runs a
   * held prompt (发送). A prompt a step already reserved cannot change.
   */
  manageQueuedPrompt(
    sessionId: string,
    promptId: string,
    action: 'cancel' | 'interject' | 'send',
  ): { ok: true } | { ok: false; reason: QueueActionRefusal } {
    const agent = this.agents.get(sessionId)
    const state = agent?.inbox.stateOf(promptId)
    if (agent === undefined || state === undefined)
      return { ok: false, reason: 'prompt_not_queued' }
    if (state === 'sending')
      return { ok: false, reason: 'prompt_already_started' }
    // Sending a held prompt again is the user asking anew (KRN-03).
    if (action !== 'cancel') this.taskTree(sessionId).beginTask()
    const applied =
      action === 'cancel'
        ? agent.inbox.discard(promptId, 'user')
        : action === 'send'
          ? agent.sendQueued(promptId)
          : agent.interjectQueued(promptId)
    return applied ? { ok: true } : { ok: false, reason: 'prompt_not_queued' }
  }

  async compactNow(
    sessionId: string,
  ): Promise<{ compacted: boolean; shadowedTokenCount?: number }> {
    const agent = this.agentFor(sessionId)
    const result = await this.compaction.compactNow(agent)
    return result === null
      ? { compacted: false }
      : { compacted: true, shadowedTokenCount: result.shadowedTokenCount }
  }

  // ── control ─────────────────────────────────────────────────────────

  get defaultPreset(): string {
    return this.defaultPresetId
  }

  /** Sessions opened from now on (and drafts) start in `preset`. */
  setDefaultPreset(preset: string): void {
    this.presets.spec(preset)
    this.defaultPresetId = preset
  }

  controlPayload(sessionId: string | null): Record<string, unknown> {
    if (sessionId === null || !this.kept.sessionStore.get(sessionId)) {
      return {
        version: 3,
        mode: this.defaultPreset,
        preset: this.defaultPreset,
        plan: false,
        approval: 'ask',
        sandbox: this.presets.spec(this.defaultPreset).sandbox,
        presets: this.presets.options(),
        pending: null,
      }
    }
    const session = this.sessionLog(sessionId)
    if (session === undefined) {
      return {
        version: 3,
        mode: this.defaultPreset,
        preset: this.defaultPreset,
        plan: false,
        approval: 'ask',
        sandbox: this.presets.spec(this.defaultPreset).sandbox,
        presets: this.presets.options(),
        pending: null,
      }
    }
    const preset = this.presets.current(session.events)
    const plan = this.planMode.get(session)
    return {
      version: 3,
      mode: preset,
      preset,
      plan: plan.pending ?? plan.active,
      approval: this.approval.effectivePolicy(session),
      sandbox: this.sandbox.resolve({ session }).mode,
      presets: this.presets.options(),
      pending: this.projectors.get(sessionId)?.pendingInteraction() ?? null,
    }
  }

  /** A session's log: the live agent's, an open one, or loaded from disk. */
  sessionLog(sessionId: string): Session | undefined {
    return (
      this.agents.get(sessionId)?.session ??
      this.sessions.get(sessionId) ??
      (this.sessions.has(sessionId)
        ? this.sessions.tryOpen(sessionId)
        : undefined)
    )
  }

  /** Estimated context tokens of a session and its model's window. */
  measureContext(
    sessionId: string,
  ): { totalTokens: number; contextWindow?: number } | null {
    const session = this.sessionLog(sessionId)
    if (session === undefined) return null
    const contextWindow = this.compaction.contextWindowFor(session)
    return {
      totalTokens: this.compaction.measure(session).totalTokens,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }
  }

  setPermissionPreset(
    sessionId: string,
    preset: string,
  ): Record<string, unknown> {
    const agent = this.agentFor(sessionId)
    this.presets.set(agent, preset)
    return this.controlPayload(sessionId)
  }

  setSandboxMode(sessionId: string, mode: SandboxMode): void {
    this.sandbox.set(this.agentFor(sessionId).session, mode)
  }

  setApprovalPolicy(sessionId: string, policy: ApprovalPolicy): void {
    this.approval.setPolicy(this.agentFor(sessionId), policy)
  }

  setPlanMode(sessionId: string, active: boolean): string {
    return this.planMode.set(this.agentFor(sessionId), active)
  }

  answerInteraction(interactionId: string, answers: UiAnswers): void {
    this.pending.answer(interactionId, answers)
  }

  approvePlan(interactionId: string): void {
    this.pending.approvePlan(interactionId)
  }

  commentPlan(interactionId: string, comment: string): void {
    this.pending.commentPlan(interactionId, comment)
  }

  cancelInteraction(interactionId: string): void {
    this.pending.cancel(interactionId)
  }

  // ── raw session log views ───────────────────────────────────────────

  /** One message-boundary page of a session's raw log (a fork child hides its seed). */
  history(
    sessionId: string,
    options: HistoryPageOptions = {},
  ): SessionHistoryPage | undefined {
    const session = this.sessionLog(sessionId)
    if (session === undefined) return undefined
    return historyPage(session.header, session.events, options)
  }

  /** One raw log event by seq, unsanitized (the wire page may truncate it). */
  event(sessionId: string, seq: number): SessionEvent | undefined {
    const session = this.sessionLog(sessionId)
    if (session === undefined) return undefined
    const events = session.events
    // Logs are append-only with dense seqs: try the direct index first.
    const direct = events[seq]
    if (direct?.seq === seq) return direct
    return events.find((event) => event.seq === seq)
  }

  /** A session's ancestor chain via `subagent/descriptor.parentSession`, root first. */
  lineage(sessionId: string): SessionLineage | undefined {
    return foldLineage(sessionId, (id) => this.sessionLog(id))
  }

  /** Delegated children recorded on a session's log, overlaid with live status. */
  children(sessionId: string): SubagentChildView[] {
    const session = this.sessionLog(sessionId)
    if (session === undefined) return []
    return foldChildren(session, (childId) => this.subagents.record(childId))
  }

  /** Observe every raw log event of attached root and child agents; returns an unsubscribe. */
  rawTap(listener: RawSessionTap): () => void {
    this.rawTaps.add(listener)
    return () => {
      this.rawTaps.delete(listener)
    }
  }

  private publishRaw(sessionId: string, event: SessionEvent): void {
    if (this.closed) return
    for (const listener of this.rawTaps) {
      try {
        listener(sessionId, event)
      } catch (error: unknown) {
        logger.warn('raw session tap failed', { error: String(error) })
      }
    }
  }

  // ── replay and events ───────────────────────────────────────────────

  /** Renderer events of a session's whole log (bootstrap / replay). */
  replay(
    sessionId: string,
    afterSeq = 0,
  ): { events: UiEvent[]; latestSeq: number } {
    const session = this.sessionLog(sessionId)
    if (session === undefined) return { events: [], latestSeq: 0 }
    const events = SessionProjector.projectAll(session.events, {
      sessionId,
      controlPayload: () => this.controlPayload(sessionId),
    })
    const latestSeq = events.at(-1)?.seq ?? 0
    return {
      events:
        afterSeq > 0 ? events.filter((event) => event.seq > afterSeq) : events,
      latestSeq,
    }
  }

  goalView(sessionId: string): Record<string, unknown> | null {
    const projector = this.projectors.get(sessionId)
    if (projector !== undefined) return projector.goalView()
    const session = this.sessionLog(sessionId)
    if (session === undefined) return null
    const temp = new SessionProjector({ sessionId })
    for (const event of session.events) temp.apply(event)
    return temp.goalView()
  }

  setEventSink(sink: HostEventSink | null): void {
    this.eventSink = sink
  }

  /** Extra listener for every UI event (in addition to the sink); returns an unsubscribe. */
  tap(listener: HostEventSink): () => void {
    this.taps.add(listener)
    return () => {
      this.taps.delete(listener)
    }
  }

  private async sink(event: Record<string, unknown>): Promise<void> {
    if (this.closed) return
    for (const listener of [
      ...(this.eventSink === null ? [] : [this.eventSink]),
      ...this.taps,
    ]) {
      try {
        await listener(event)
      } catch (error: unknown) {
        logger.warn('event sink failed', { error: String(error) })
      }
    }
  }

  /** Host-only (non-log) event: seq 0, stamped now. */
  emitHost(event: Record<string, unknown>): void {
    void this.sink({ ...event, seq: 0, ts: Date.now() })
  }

  /** Remove a session's log, agent, and children. */
  /**
   * Stop a session and drop it from the kernel, keeping its log on disk
   * (closed and flushed): a soft-deleted session can come back (FIX-01).
   */
  unloadSession(sessionId: string): void {
    this.stop(sessionId)
    this.projectMcp.release(sessionId)
    this.agents.get(sessionId)?.dispose()
    this.agents.delete(sessionId)
    this.unsubscribes.get(sessionId)?.()
    this.unsubscribes.delete(sessionId)
    this.projectors.delete(sessionId)
    this.announcedQueue.delete(sessionId)
    const tree = this.taskTrees.get(sessionId)
    this.taskTrees.delete(sessionId)
    // Its subagents (stop disposed them), their jobs and its own.
    void (
      tree?.disposeAll('session unloaded') ?? this.jobs.disposeOwner(sessionId)
    )
    void this.computerUse?.service.onSessionDeleted(sessionId)
    this.sessions.close(sessionId)
  }

  /** The host's per-session tables, for tests (KRN-03). */
  attachedForTest(): {
    agents: string[]
    projectors: string[]
    unsubscribes: string[]
  } {
    return {
      agents: [...this.agents.keys()],
      projectors: [...this.projectors.keys()],
      unsubscribes: [...this.unsubscribes.keys()],
    }
  }

  /** A root session's task tree, for tests (KRN-03). */
  taskTreeForTest(rootId: string): TaskTree | undefined {
    return this.taskTrees.get(rootId)
  }

  /** unloadSession, then remove the session's log directory and its tree's. */
  deleteSession(sessionId: string): void {
    this.unloadSession(sessionId)
    this.forgetSessionTree(
      sessionId,
      join(this.sessions.root, sessionId, LOG_FILE),
    )
    this.sessions.delete(sessionId)
  }

  /**
   * Remove what a deleted root session leaves outside its own directory
   * (KRN-03): the session of every subagent it (or they) recorded, and the
   * spill of all of them. `rootLog` is the root's log file — in the trash
   * when a deleted session is purged.
   */
  forgetSessionTree(rootId: string, rootLog: string): string[] {
    const descendants = recordedDescendants(
      this.sessions.readEventsAt(rootId, rootLog),
      (id) => {
        try {
          return this.sessions.readSnapshot(id).events
        } catch {
          return []
        }
      },
    )
    const spillRoot = join(this.kept.paths.stateRoot, 'spill')
    for (const id of [rootId, ...descendants])
      rmSync(spillSessionDir(spillRoot, id), { recursive: true, force: true })
    for (const id of descendants) this.sessions.delete(id)
    return descendants
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.delegationInteractions.cancelRoot()
    this.delegationConsent.cancelRoot()
    await this.delegations?.shutdown().catch((error) =>
      logger.warn('external delegation shutdown requires recovery', {
        error: String(error),
      }),
    )
    await this.computerUse?.dispose().catch(() => {})
    for (const agent of this.agents.values()) agent.dispose()
    for (const unsubscribe of this.unsubscribes.values()) unsubscribe()
    await this.jobs.dispose()
    await this.hooks.dispose()
    this.sessions.closeAll()
    await this.projectMcp.close()
    this.mcpTools.dispose()
    try {
      await this.kept.schedulerService.stop?.('host closing')
    } catch {
      // ignore
    }
    this.unwatchSkillRoots?.()
    await this.kept.skillChangeDetector.close().catch(() => {})
    await this.kept.mcpClient.close().catch(() => {})
    await this.kept.processRuntime.shutdown?.('host closing').catch?.(() => {})
  }
}

/** The renderer wire form of a store health report. */
export function sessionLogStateEvent(
  state: SessionLogState,
): Record<string, unknown> {
  const base = { event: 'session_log_state', session_id: state.sessionId }
  switch (state.state) {
    case 'repaired':
      return {
        ...base,
        state: state.state,
        kind: state.kind,
        dropped_bytes: state.droppedBytes,
        ...(state.line === undefined ? {} : { line: state.line }),
        backup_path: state.backupPath,
      }
    case 'unrecoverable':
      return { ...base, state: state.state, reason: state.reason }
    case 'write_paused':
      return {
        ...base,
        state: state.state,
        error: state.error,
        pending_events: state.pendingEvents,
      }
    case 'write_resumed':
      return { ...base, state: state.state }
  }
}

export type QueueActionRefusal = 'prompt_not_queued' | 'prompt_already_started'

/** One turn's final assistant text, and whether a cost cap stopped it (logs before KRN-03). */
function turnFacts(
  events: readonly SessionEvent[],
  turn: number,
): { text: string; costCapped: boolean } {
  let inside = false
  let text = ''
  let costCapped = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (inside) break
      inside = event.data.turn === turn
    } else if (!inside) {
      continue
    } else if (event.type === 'assistant/message') {
      const next = messageText(event.data.message).trim()
      if (next) text = next
    } else if (event.type === 'llm/cost-cap') {
      costCapped = true
    } else if (event.type === 'turn/end') {
      break
    }
  }
  return { text, costCapped }
}

/** The submit result for one message's outcome. */
function submitResultFor(
  agent: Agent,
  messageId: string,
  outcome: MessageOutcome,
): SubmitResult {
  const base = { sessionId: agent.id, messageId }
  if (outcome.kind === 'not-consumed')
    return {
      ...base,
      turnId: null,
      content: '',
      delivery: 'queued',
      result: { kind: 'not-consumed', reason: outcome.reason },
    }
  if (outcome.kind === 'discarded')
    return {
      ...base,
      turnId: null,
      content: '',
      delivery: 'discarded',
      result: {
        kind: 'aborted',
        by:
          outcome.reason === 'user' || outcome.reason === 'cancelled'
            ? 'user'
            : 'system',
        turnId: null,
      },
    }
  const turnId = `${agent.id}:${outcome.turn}`
  const { text, costCapped } = turnFacts(agent.session.events, outcome.turn)
  const reason = outcome.reason
  let result: TurnResult
  switch (reason.kind) {
    case 'error':
      result = {
        kind: 'error',
        code: reason.error.code ?? 'UNKNOWN',
        message: reason.error.message,
        turnId,
      }
      break
    case 'aborted':
      result = {
        kind: 'aborted',
        by: reason.reason?.kind === 'user' ? 'user' : 'system',
        turnId,
      }
      break
    case 'interrupted':
      result = { kind: 'aborted', by: 'system', turnId }
      break
    case 'blocked':
      result = {
        kind: 'blocked',
        reason: costCapped ? 'cost-cap' : 'prompt-rejected',
        turnId,
      }
      break
    case 'budget':
      result = {
        kind: 'blocked',
        reason: reason.limit === 'cost' ? 'cost-cap' : 'step-limit',
        turnId,
      }
      break
    default:
      result = { kind: 'completed', content: text, turnId }
  }
  return { ...base, turnId, content: text, delivery: 'completed', result }
}

/** A background turn's interaction policy and what it rejected. */
interface BackgroundTurnState {
  readonly messageId: string
  readonly policy: InteractionPolicy
  readonly rejected: string[]
  planRejected: boolean
}

/** The turn that took a message (its `user/message`), if one did. */
function turnOfMessage(
  events: readonly SessionEvent[],
  messageId: string,
): number | undefined {
  let turn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    else if (event.type === 'user/message' && event.data.id === messageId)
      return turn
  }
  return undefined
}

/** `work`, or the signal's reason as soon as it aborts. */
/** The approval card text for running one MCP server outside the sandbox. */
function unsandboxedServerQuestion(request: UnsandboxedRequest): string {
  const command = [request.command, ...request.args].join(' ').slice(0, 240)
  return (
    `MCP 服务器「${request.name}」无法在进程沙箱中启动（${request.reason}）。` +
    `允许它在沙箱外运行吗？它将能读写你的文件。命令：${command}。` +
    '选择会按这个服务器记住，修改它的命令后会重新询问。'
  )
}

async function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
