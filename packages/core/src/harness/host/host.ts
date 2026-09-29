/**
 * `HarnessHost`: the single composition root of Emperor's agent kernel.
 *
 * It composes the ported harness (LLM client, session log, agent loop,
 * tools, sandbox, approval, plan mode, compaction, hooks, goals,
 * subagents, jobs, questions, skills, memory, MCP) with the kept Emperor
 * services, owns one Agent per session, streams every session's log to the
 * UI through the projector, and answers pending interactions for CoreApi.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AttachmentStore, type AttachmentRef } from '../../attachments/store'
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
import { SessionLogStore } from '../../session-log/store'
import type { SessionEvent } from '../../session-log/types'
import type { SessionEntry } from '../../sessions/store'
import type { FileSkillsLoader } from '../../skills/file-loader'
import { logger } from '../../util/log'
import { WatchlistService } from '../../watchlist/service'
import { Agent, type AgentDeps } from '../agent/agent'
import { createMiddleware, type AgentMiddleware } from '../agent/middleware'
import { retryMiddleware } from '../agent/retry'
import {
  costCapMiddleware,
  fallbackConfigMiddleware,
  fallbackErrorMiddleware,
  type ModelPolicySource,
} from '../agent/model-policy'
import { PermissionPresetService } from '../approval/presets'
import {
  ApprovalService,
  approvalRepair,
  type ApprovalPolicy,
} from '../approval/service'
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
import { computerUseRepair } from '../computer-use/events'
import {
  browserStateDir,
  computerUseStateDir,
  installComputerUse,
  type InstalledComputerUse,
} from '../computer-use/install'
import type { ComputerUseHostPort } from '../computer-use/port'
import type { DriverKind } from '../computer-use/types'
import type { AppListKind } from '../computer-use/service/service'
import { createBrowserTools } from '../computer-use/tools/browser-tools'
import { createDesktopTools } from '../computer-use/tools/desktop-tools'
import { createExternalTools } from '../computer-use/tools/external-tools'
import type {
  ComputerUseSettings,
  KillSwitchStatus,
} from '../computer-use/service/service'
import { createMemoryTool, memoryMiddleware } from '../memory/memory'
import { PlanModeController } from '../plan/plan-mode'
import { agentInstructionsMiddleware } from '../prompt/agent-instructions'
import { SystemPromptAssembler } from '../prompt/assembler'
import { SessionProjector, type UiEvent } from '../projection/projector'
import {
  createAskUserQuestionTool,
  UserQuestionService,
  questionRepair,
} from '../questions'
import { LocalSandbox, type SandboxBackend } from '../sandbox/backend'
import { SandboxPolicyService, type SandboxMode } from '../sandbox/policy'
import { SubagentManager } from '../subagent/manager'
import { installSubagents } from '../subagent/tools'
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
  /** Emergency-stop shortcut registration status (desktop). */
  computerUseKillSwitch?: () => KillSwitchStatus
  /** The master switch changed (desktop registers the kill switch only while on). */
  computerUseEnabledChanged?: (enabled: boolean) => void
  /**
   * The user changed the emergency-stop shortcut (`null`: the platform
   * default); the desktop re-registers it and reports the result.
   */
  computerUseKillSwitchChanged?: (accelerator: string | null) => void
}

export interface SubmitInput {
  sessionId: string
  content: string
  displayContent?: string | null
  clientMessageId?: string | null
  attachmentIds?: string[] | null
  source?: string | null
  scheduler?: Record<string, unknown> | null
  uiHidden?: boolean | null
  delivery?: 'queue' | 'interject' | null
  signal?: AbortSignal | null
}

export interface SubmitResult {
  sessionId: string
  messageId: string
  turnId: string | null
  content: string
  delivery: 'completed' | 'interjected'
}

export interface QueuedPrompt {
  prompt_id: string
  content: string
  state: 'queued'
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
  readonly goals = new GoalService()
  readonly goalInstall: InstalledGoal
  readonly subagents: SubagentManager
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
  private computerUseEnabledChanged: ((enabled: boolean) => void) | undefined
  private computerUseKillSwitchChanged:
    ((accelerator: string | null) => void) | undefined
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
      repairContributors: [approvalRepair, questionRepair, computerUseRepair],
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
      createSpawnChildProvider({ manager: this.subagents, llm: this.llm }),
    ])
    this.hooks = new ClaudeCodeHooks({
      configPaths: defaultHookConfigPaths({ stateRoot: kept.paths.stateRoot }),
    })
    this.mcpTools = new McpToolBridge(kept.mcpClient, this.tools)
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
    installSubagents(this.subagents, tools, prompt)
    installWorkflow(tools, prompt, {
      engine: this.workflows,
      runs: this.workflowRuns,
    })
    const goal = installGoal({ prompt, middleware, tools }, this.goals)
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

  /** Persist the GUI permission mode without changing Shell sandbox access. */
  setComputerUseAuthorizationMode(mode: 'unrestricted' | 'scoped'): void {
    if (this.computerUse === null) return
    this.computerUseConfig?.update({ authorizationMode: mode })
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

  /**
   * The user's additions to the protected / high-risk / sensitive app lists
   * (01 §4.4, §5.2). Whole lists are replaced.
   */
  setComputerUseAppLists(
    lists: Partial<Record<AppListKind, readonly string[]>>,
  ): void {
    if (this.computerUse === null) return
    this.computerUseConfig?.update({ appLists: lists })
    this.emitHost({ event: 'computer_use_changed', reason: 'state' })
  }

  /** How long downloads stay in the inbox (0: until the user removes them). */
  setComputerUseDownloadRetention(days: 0 | 7 | 30 | 90): void {
    if (this.computerUse === null) return
    this.computerUseConfig?.update({ downloadRetentionDays: days })
    this.emitHost({ event: 'computer_use_changed', reason: 'state' })
  }

  /** The user's emergency-stop shortcut (`null`: the platform default). */
  setComputerUseKillSwitch(accelerator: string | null): void {
    if (this.computerUse === null) return
    this.computerUseConfig?.update({ killSwitchAccelerator: accelerator })
    this.computerUseKillSwitchChanged?.(accelerator)
    this.emitHost({ event: 'computer_use_changed', reason: 'kill-switch' })
  }

  /** The persisted emergency-stop shortcut, if the user changed it. */
  computerUseKillSwitchAccelerator(): string | undefined {
    return this.computerUseConfig?.get().killSwitchAccelerator
  }

  private installComputerUse(options: HarnessHostOptions): void {
    const port = options.computerUsePort
    if (!port) return
    const stateDir = computerUseStateDir(this.kept.paths.stateRoot)
    if (options.computerUseSettings === undefined)
      this.computerUseConfig = new ComputerUseConfigStore(stateDir)
    const config = this.computerUseConfig
    const settings =
      options.computerUseSettings ?? (() => config?.get() ?? { enabled: false })
    this.computerUseEnabledChanged = options.computerUseEnabledChanged
    this.computerUseKillSwitchChanged = options.computerUseKillSwitchChanged
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
      isDirectChild: (parentSessionId, childId) =>
        this.subagents.record(childId)?.parentId === parentSessionId,
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
      ...(options.computerUseKillSwitch === undefined
        ? {}
        : { killSwitch: options.computerUseKillSwitch }),
      onChanged: (reason, sessionId) => {
        this.emitHost({
          event: 'computer_use_changed',
          reason,
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
        })
      },
    })
    // Once / task grants end with the turn that asked for them.
    this.rawTap((sessionId, event) => {
      if (event.type === 'turn/end')
        queueMicrotask(() => this.computerUse?.service.endTask(sessionId))
    })
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
    return 'You are Emperor Agent, a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
  }

  private modelLabel(): string {
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
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.scheduler ? { scheduler: input.scheduler } : {}),
      ...(input.uiHidden ? { uiHidden: true } : {}),
    })
    if (input.delivery === 'interject' && agent.status === 'running') {
      agent.steer(message)
      return {
        sessionId: agent.id,
        messageId: message.id,
        turnId: null,
        content: '',
        delivery: 'interjected',
      }
    }
    const onAbort = (): void => {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      agent.followup(message)
      await agent.whenIdle()
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
    }
    const outcome = turnOutcomeFor(agent.session.events, message.id)
    return {
      sessionId: agent.id,
      messageId: message.id,
      turnId: outcome.turn === undefined ? null : `${agent.id}:${outcome.turn}`,
      content: outcome.text,
      delivery: 'completed',
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
    const agent = this.agents.get(sessionId)
    if (agent === undefined) return false
    const running = agent.status === 'running'
    this.pending.cancelSession(sessionId)
    agent.cancel({ kind: 'user' })
    this.subagents.disposeChildrenOf(sessionId)
    return running
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

  queuedPrompts(sessionId: string): QueuedPrompt[] {
    const agent = this.agents.get(sessionId)
    if (agent === undefined) return []
    const user = (message: UserMessage): boolean =>
      message.source.kind === 'user'
    return [
      ...agent.inbox.nextStep.filter(user).map((message) => ({
        prompt_id: message.id,
        content: messageText(message),
        state: 'queued' as const,
        target: 'next-step' as const,
      })),
      ...agent.inbox.nextTurn.filter(user).map((message) => ({
        prompt_id: message.id,
        content: messageText(message),
        state: 'queued' as const,
        target: 'next-turn' as const,
      })),
    ]
  }

  manageQueuedPrompt(
    sessionId: string,
    promptId: string,
    action: 'cancel' | 'interject',
  ): boolean {
    const agent = this.agents.get(sessionId)
    if (agent === undefined) return false
    if (action === 'cancel') return agent.inbox.remove(promptId)
    return agent.inbox.promote(promptId)
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

/** The turn that consumed a message, and that turn's final assistant text. */
function turnOutcomeFor(
  events: readonly SessionEvent[],
  messageId: string,
): { turn?: number; text: string } {
  let turn: number | undefined
  let found = false
  let text = ''
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (found) break
      turn = event.data.turn
      text = ''
    } else if (event.type === 'user/message' && event.data.id === messageId) {
      found = true
    } else if (found && event.type === 'assistant/message') {
      const next = messageText(event.data.message).trim()
      if (next) text = next
    } else if (found && event.type === 'turn/end') {
      break
    }
  }
  return found
    ? { ...(turn === undefined ? {} : { turn }), text }
    : { text: '' }
}
