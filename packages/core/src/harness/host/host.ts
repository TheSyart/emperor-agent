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
import { routeFromEntry } from '../../llm/route'
import type { ContentBlock } from '../../llm/types'
import {
  historyPage,
  type HistoryPageOptions,
  type SessionHistoryPage,
} from '../../session-log/history'
import type { Session } from '../../session-log/session'
import { SessionLogStore, type SessionLogState } from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import type { SessionEntry } from '../../sessions/store'
import type { FileSkillsLoader } from '../../skills/file-loader'
import { logger } from '../../util/log'
import { WatchlistService } from '../../watchlist/service'
import { Agent, type AgentDeps, type MessageOutcome } from '../agent/agent'
import { isUserTyped, type HoldReason, type QueueChange } from '../agent/inbox'
import { createMiddleware, type AgentMiddleware } from '../agent/middleware'
import { retryMiddleware } from '../agent/retry'
import {
  costCapMiddleware,
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
import {
  createWebSearchTool,
  installWebSearchPromptSection,
  type WebSearchBackend,
} from '../tools/builtin/web-search'
import { ToolRegistry } from '../tools/registry'
import { createRepeatReminder } from '../tools/repeat-reminder'
import type { ToolServices } from '../tools/services'
import { createSpillMiddleware } from '../tools/spill'
import { PendingInteractions, type UiAnswers } from './interactions'
import { installLinkGuidancePromptSection } from './link-guidance'
import { McpToolBridge } from './mcp-tools'
import { createSchedulerExecutor } from './scheduler'
import { currentTurnSource } from './turn-source'
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
import { generateSessionTitle } from './title'

export type HostEventSink = (
  event: Record<string, unknown>,
) => void | Promise<void>

/** Observer of every raw log event of every attached (root or child) agent. */
export type RawSessionTap = (sessionId: string, event: SessionEvent) => void

export interface HarnessHostOptions extends KeptServicesOptions {
  eventSink?: HostEventSink | null
  /** Web search backend; `web_search` is only offered when one is configured. */
  webSearch?: WebSearchBackend | null
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

/** What one submitted message came to (KRN-02; the shape KRN-01 builds on). */
export type TurnResult =
  | { kind: 'completed'; content: string; turnId: string }
  | { kind: 'error'; code: string; message: string; turnId: string }
  /** `turnId` is null when the message was cancelled before a turn took it. */
  | { kind: 'aborted'; by: 'user' | 'system'; turnId: string | null }
  | { kind: 'blocked'; reason: 'cost-cap' | 'prompt-rejected'; turnId: string }
  | { kind: 'not-consumed'; reason: HoldReason }

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
  /** GUI control kernel; null on hosts without a computer-use port. */
  computerUse: InstalledComputerUse | null = null
  private computerUseConfig: ComputerUseConfigStore | null = null
  /** What `@plugin` gestures learn about a plugin (set by CoreApi's plugin service). */
  private pluginReferences: PluginReferenceResolver | null = null
  private computerUseEnabledChanged: ((enabled: boolean) => void) | undefined
  readonly defaultPreset: string
  activeSessionId: string | null = null
  private readonly agents = new Map<string, Agent>()
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
    this.defaultPreset = options.defaultPreset ?? DEFAULT_PRESET
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
      new LocalSandbox({ protectedStateRoot: kept.paths.stateRoot })
    this.presets = new PermissionPresetService(this.sandbox, this.approval)
    this.compaction = new CompactionEngine(this.llm, new ToolResultPruner())
    this.subagents = new SubagentManager({
      sessions: this.sessions,
      createAgent: (session, agentOptions) =>
        this.attachAgent(new Agent(session, this.agentDeps(), agentOptions)),
      lookupAgent: (id) => this.agents.get(id),
      sandbox: this.sandbox,
      approval: this.approval,
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
    })
    this.mcpTools = new McpToolBridge(kept.mcpClient, this.tools)
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
    this.goalInstall = this.compose(options)
  }

  static async create(options: HarnessHostOptions): Promise<HarnessHost> {
    // Kept services call back into the host, which exists only after they do.
    const ref: { host?: HarnessHost } = {}
    const kept = await createKeptServices(options, {
      emit: (event) => ref.host?.emitHost(event),
      activeSessionId: () => ref.host?.activeSessionId ?? null,
      activeWorkspaceRoot: () =>
        ref.host?.activeWorkspaceRoot() ?? resolve(options.root),
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
    this.approval.setAnswerer(this.pending.approvalAnswerer)
    this.questions.setAnswerer(this.pending.questionAnswerer)
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
      // The same directories Seatbelt keeps Shell out of (LocalSandbox).
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
    if (options.webSearch) {
      tools.register(createWebSearchTool(options.webSearch))
      installWebSearchPromptSection(prompt)
    }
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
    const goal = installGoal({ prompt, middleware, tools }, this.goals, {
      driverOptions: {
        hasOutstandingDelegations: (id) =>
          this.delegations?.hasOutstanding(id) ?? false,
      },
    })
    void createGoalTools
    // Middleware (order matters): instructions, memory, skills, compaction, hooks.
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
    // Saved model execution policy: fallback after retries give up, per-turn cost cap.
    const modelPolicy: ModelPolicySource = {
      policy: () => this.kept.modelConfig.policy,
      pricing: (routeId) => findEntry(this.kept.modelConfig, routeId)?.pricing,
    }
    middleware.requestError.push(fallbackErrorMiddleware(modelPolicy, this.llm))
    middleware.requestConfig.push(fallbackConfigMiddleware(this.llm))
    middleware.preStep.unshift(costCapMiddleware(modelPolicy))
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
      },
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
      settled: (child) =>
        queueMicrotask(() => this.releaseComputerUseIfTaskEnded(child.id)),
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
      submitTurn: async (request) => {
        const sessionId =
          request.sessionId ??
          this.activeSessionId ??
          this.ensureDefaultSession().id
        const result = await this.submit({
          sessionId,
          content: request.content,
          displayContent: request.displayContent,
          clientMessageId: request.clientMessageId,
          source: 'scheduler',
          scheduler: request.scheduler,
          signal: request.signal,
        })
        // A prompt no turn took never ran: the run did not complete.
        if (result.delivery === 'queued' || result.delivery === 'discarded')
          throw new Error(
            result.result?.kind === 'not-consumed'
              ? `the scheduled prompt was not sent (${result.result.reason}); it waits in the session queue`
              : 'the scheduled prompt was cancelled before it ran',
          )
        return result.content
      },
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
    })
    this.kept.modelConfig = config
    this.applyModelConfig(config)
  }

  async reloadMcp(): Promise<void> {
    const environment = await this.kept.executionEnvironmentService.create({
      projectRoot: this.activeWorkspaceRoot(),
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

  activeWorkspaceRoot(): string {
    return this.workspaceRootFor(
      this.activeSessionId === null
        ? null
        : this.kept.sessionStore.get(this.activeSessionId),
    )
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

  activeSession(): SessionEntry | null {
    return this.activeSessionId === null
      ? null
      : this.kept.sessionStore.get(this.activeSessionId)
  }

  activateSession(sessionId: string): SessionEntry {
    const entry = this.kept.sessionStore.get(sessionId)
    if (entry === null) throw new Error(`unknown session ${sessionId}`)
    this.activeSessionId = sessionId
    return entry
  }

  ensureDefaultSession(): SessionEntry {
    const active = this.activeSession()
    if (active !== null) return active
    const existing = this.kept.sessionStore.list()[0]
    const entry =
      existing ?? this.kept.sessionStore.create('新会话', { mode: 'chat' })
    this.activeSessionId = entry.id
    return entry
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
    const agent = this.attachAgent(new Agent(session, this.agentDeps()))
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

  private trackUsage(agent: Agent, event: SessionEvent): void {
    if (event.type !== 'assistant/message' || event.data.usage === undefined)
      return
    const usage = event.data.usage
    try {
      this.kept.tokenTracker.record(
        event.data.message.source.model,
        {
          prompt_tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0),
          completion_tokens: usage.outputTokens,
          prompt_cache_hit_tokens: usage.cacheReadTokens ?? 0,
        },
        {
          usageType: agent.owner === undefined ? 'main_agent' : 'subagent',
          modelEntryId: event.data.message.source.provider,
        },
      )
    } catch {
      // usage accounting never breaks a turn
    }
  }

  // ── turns ───────────────────────────────────────────────────────────

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
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const agent = this.agentFor(input.sessionId)
    this.activeSessionId = input.sessionId
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
  deleteSession(sessionId: string): void {
    this.stop(sessionId)
    this.agents.get(sessionId)?.dispose()
    this.agents.delete(sessionId)
    this.unsubscribes.get(sessionId)?.()
    this.unsubscribes.delete(sessionId)
    this.projectors.delete(sessionId)
    this.announcedQueue.delete(sessionId)
    void this.jobs.disposeOwner(sessionId)
    void this.computerUse?.service.onSessionDeleted(sessionId)
    this.sessions.delete(sessionId)
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

/** One turn's final assistant text, and whether a cost cap stopped it. */
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
    default:
      result = { kind: 'completed', content: text, turnId }
  }
  return { ...base, turnId, content: text, delivery: 'completed', result }
}
