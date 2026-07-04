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
import { ExternalBridgeService } from '../external/service'
import { AgentLoop, type AgentLoopCreateOptions, type LoopModelRouter } from '../agent/loop'
import type { RuntimePaths } from '../runtime/paths'
import { RuntimeEventStore } from '../runtime/store'
import { assertCoreMutationAllowed } from './mutation-guard'
import { ChatService, InvalidSessionError, MainlineTurnService, type DraftSessionInput } from './chat-service'
import { CoreConfigService, type UserConfigPayload } from './services/config-service'
import { CoreDiagnosticsService } from './services/diagnostics-service'
import { CoreDesktopPetService } from './services/desktop-pet-service'
import { CoreMemoryService } from './services/memory-service'
import { CoreModelService } from './services/model-service'
import { CoreSkillService } from './services/skill-service'
import { CoreTeamService } from './services/team-service'
import { planToDict } from '../plans/models'
import { SidechainTranscript } from '../tasks/sidechain'
import { ToolResultStore } from '../context/tool-results'
import { WatchlistService } from '../watchlist/service'

type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>
type Dict = Record<string, unknown>

export interface CoreApiCreateOptions extends AgentLoopCreateOptions {
  loop?: AgentLoop | null
}

export interface RouteOperation {
  key: string
  method: string
  route: string
}

export const CORE_API_ROUTE_OPERATIONS: RouteOperation[] = [
  op('chat.submit', 'IPC', 'chat.submit'),
  op('bootstrap', 'GET', '/api/bootstrap'),
  op('chat.stopRuntime', 'POST', '/api/runtime/stop'),
  op('config.get', 'GET', '/api/config'),
  op('config.save', 'POST', '/api/config'),
  op('attachments.save', 'POST', '/api/attachments'),
  op('attachments.rawPath', 'GET', '/api/attachments/{id}/raw'),
  op('mcp.getConfig', 'GET', '/api/mcp-config'),
  op('mcp.saveConfig', 'POST', '/api/mcp-config'),
  op('model.getConfig', 'GET', '/api/model-config'),
  op('model.saveConfig', 'POST', '/api/model-config'),
  op('model.saveOnboardingConfig', 'IPC', 'model.saveOnboardingConfig'),
  op('model.test', 'POST', '/api/model-test'),
  op('control.get', 'GET', '/api/control'),
  op('control.setMode', 'POST', '/api/control/mode'),
  op('control.answerInteraction', 'IPC', 'control.answerInteraction'),
  op('control.commentPlan', 'IPC', 'control.commentPlan'),
  op('control.approvePlan', 'IPC', 'control.approvePlan'),
  op('control.cancelInteraction', 'POST', '/api/control/interactions/{id}/cancel'),
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
  op('tasks.list', 'GET', '/api/tasks'),
  op('tasks.get', 'GET', '/api/tasks/{task_id}'),
  op('tasks.transcript', 'GET', '/api/tasks/{task_id}/transcript'),
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
  op('projects.list', 'GET', '/api/projects'),
  op('projects.resolve', 'POST', '/api/projects/resolve'),
  op('runtime.replay', 'GET', '/api/runtime/replay'),
  op('skills.tools', 'GET', '/api/tools'),
  op('skills.list', 'GET', '/api/skills'),
  op('skills.get', 'GET', '/api/skill'),
  op('skills.save', 'POST', '/api/skill'),
  op('skills.delete', 'DELETE', '/api/skill'),
  op('skills.importArchive', 'POST', '/api/skills/import'),
  op('sidebar.get', 'GET', '/api/sidebar-state'),
  op('sidebar.patch', 'PATCH', '/api/sidebar-state'),
  op('diagnostics.get', 'GET', '/api/diagnostics'),
  op('desktopPet.get', 'GET', '/api/desktop-pet'),
  op('desktopPet.setEnabled', 'POST', '/api/desktop-pet'),
].sort((a, b) => a.key.localeCompare(b.key))

export class CoreApi {
  readonly root: string
  readonly paths: RuntimePaths
  readonly loop: AgentLoop
  readonly attachmentStore: AttachmentStore
  readonly watchlist: WatchlistService
  readonly externalBridge: ExternalBridgeService
  readonly mainline: MainlineTurnService
  readonly chatService: ChatService
  readonly configService: CoreConfigService
  readonly desktopPetService: CoreDesktopPetService
  readonly diagnosticsService: CoreDiagnosticsService
  readonly memoryService: CoreMemoryService
  readonly modelService: CoreModelService
  readonly skillService: CoreSkillService
  readonly teamService: CoreTeamService

  private constructor(root: string, loop: AgentLoop) {
    this.root = resolve(root)
    this.loop = loop
    this.paths = loop.paths
    this.attachmentStore = new AttachmentStore(this.paths.stateRoot)
    this.watchlist = new WatchlistService(this.paths.stateRoot, { tokenTracker: this.loop.tokenTracker })
    this.configService = new CoreConfigService(this.paths.stateRoot, {
      refreshRuntimeContext: () => { this.loop.refreshRuntimeContext() },
      reloadMcp: () => this.loop.reloadMcp(),
    }, { templatesDir: this.loop.templatesDir })
    this.desktopPetService = new CoreDesktopPetService(this.root, {
      assertMutation: (area, action) => this.assertMutation(area, action),
    })
    this.modelService = new CoreModelService(this.root, {
      router: () => this.loop.modelRouter,
      refreshModelConfig: () => this.loop.refreshModelConfig(),
    })
    this.memoryService = new CoreMemoryService(this.paths.stateRoot, {
      loop: this.loop,
      watchlist: this.watchlist,
      refreshRuntimeContext: () => { this.loop.refreshRuntimeContext() },
    })
    this.skillService = new CoreSkillService(this.root, {
      registry: this.loop.registry,
      refreshRuntimeContext: () => { this.loop.refreshRuntimeContext() },
    })
    this.teamService = new CoreTeamService({
      teamManager: () => this.loop.teamManagerForActiveSession(),
      activeSession: () => this.loop.activeSession,
      assertMutation: (area, action) => this.assertMutation(area, action),
    })
    this.mainline = new MainlineTurnService(this.loop)
    this.chatService = new ChatService(this.mainline)
    this.loop.setSchedulerAgentTurnSubmitter((payload) => this.mainline.submitSchedulerTurn(payload))
    this.externalBridge = new ExternalBridgeService({
      root: this.paths.stateRoot,
      canAcceptTurn: () => !this.loop.activeTasks.hasActive() && !this.loop.controlManager.payload().pending,
      targetSessionId: () => this.loop.activeSessionId,
      eventSink: async (event) => {
        await this.emitRuntime(event, { sessionId: runtimeEventSessionId(event) || this.loop.activeSessionId })
      },
      submitTurn: async (payload) => {
        const turnId = String(payload.client_message_id ?? payload.clientMessageId ?? '')
        const result = await this.mainline.submit({
          content: String(payload.content ?? ''),
          turnId: turnId || null,
          displayContent: String(payload.display_content ?? payload.displayContent ?? payload.content ?? ''),
          source: 'external',
          sessionId: String(payload.session_id ?? payload.sessionId ?? '').trim() || null,
          memoryExtra: isRecord(payload.memory_extra) ? payload.memory_extra : isRecord(payload.memoryExtra) ? payload.memoryExtra : null,
        })
        return result.turnId
      },
    })
    this.diagnosticsService = new CoreDiagnosticsService(this.root, {
      runtimePaths: this.paths,
      schedulerDiagnostics: () => this.loop.schedulerStore.diagnostics(),
      runtimeStats: () => this.loop.runtimeStore.stats({ activeTurnIds: this.loop.activeMemoryStore.loadUnarchivedTurnIds() }) as unknown as Dict,
      workspacePolicy: () => this.loop.workspacePolicyDiagnostics() as Dict,
      externalPayload: () => this.externalBridge.payload(),
      activeTasks: () => this.loop.activeTasks.list(),
      desktopPetPayload: () => this.desktopPet.get(),
    })
  }

  static async create(opts: CoreApiCreateOptions): Promise<CoreApi> {
    const root = resolve(opts.root)
    const loop = opts.loop ?? await AgentLoop.create(opts)
    return new CoreApi(root, loop)
  }

  async close(): Promise<void> {
    await this.externalBridge.stop()
    await this.loop.close()
  }

  async bootstrap(opts: { sessionId?: string | null } = {}): Promise<Dict> {
    const sessionId = String(opts.sessionId ?? '').trim()
    if (sessionId) this.activateBootstrapSession(sessionId)
    this.loop.reconcileSessionControlPending()
    const sessionDiagnostics = this.loop.sessionStore.diagnostics()
    const route = this.loop.modelRouter.route('main_agent')
    const activeTurnIds = this.loop.activeMemoryStore.loadUnarchivedTurnIds()
    const runtimeReplay = this.runtime.replay({ sessionId: this.loop.activeSessionId, afterSeq: 0, limit: 5000 })
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
      team: this.team.get(),
      scheduler: this.scheduler.get(),
      control: this.control.get(),
      desktopPet: await this.desktopPet.get(),
      context_used: this.loop.tokenTracker.lastInputTokensValue(),
      unarchivedHistory: this.loop.activeMemoryStore.loadUnarchivedHistory(),
      runtime: {
        events: runtimeReplay.events,
        latestSeq: runtimeReplay.latestSeq,
        busy: this.loop.activeTasks.hasActive(),
        active_tasks: this.loop.activeTasks.list(),
        stats: this.loop.runtimeStore.stats({ activeTurnIds }),
      },
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
      clientDraftId?: string | null
      draftSession?: DraftSessionInput | null
    }): Promise<Dict> => {
      const result = await this.chatService.submit({
        content: String(opts.content ?? ''),
        turnId: opts.turnId ?? null,
        emit: opts.emit ?? null,
        displayContent: opts.displayContent ?? null,
        clientMessageId: opts.clientMessageId ?? null,
        sessionId: opts.sessionId ?? null,
        uiHidden: opts.uiHidden ?? false,
        clientDraftId: opts.clientDraftId ?? null,
        draftSession: opts.draftSession ?? null,
      })
      return result as unknown as Dict
    },
    stopRuntime: (opts: { taskId?: string | null; kind?: 'turn' | 'scheduler' | 'team' | 'watchlist' | null } = {}): Dict => {
      const cancelled = this.loop.activeTasks.cancel({ taskId: opts.taskId ?? null, kind: opts.kind ?? null })
      return { cancelled, active: this.loop.activeTasks.list() }
    },
  }

  readonly runtime = {
    replay: (opts: {
      sessionId?: string | null
      afterSeq?: number | string | null
      after_seq?: number | string | null
      limit?: number | string | null
      includeArchive?: boolean | string | null
      include_archive?: boolean | string | null
      compact?: boolean | string | null
    } = {}): Dict => {
      const sessionId = this.requireReadableSessionId(opts.sessionId ?? this.loop.activeSessionId ?? null, 'runtime.replay')
      const afterSeq = normalizedNonNegativeNumber(opts.afterSeq ?? opts.after_seq ?? 0)
      const limit = normalizedPositiveNumber(opts.limit ?? null)
      const includeArchive = normalizedBoolean(opts.includeArchive ?? opts.include_archive ?? false)
      // P1-5：回放默认读取侧压缩（磁盘不变）；传 compact:false 取原始流
      const compact = opts.compact === undefined ? true : normalizedBoolean(opts.compact)
      const store = new RuntimeEventStore(this.loop.sessionStore.sessionDir(sessionId), { sessionDirOverride: true })
      return {
        sessionId,
        afterSeq,
        latestSeq: store.latestSeq,
        events: store.replayAfter(afterSeq, { sessionId, limit, includeArchive, compact }),
      }
    },
  }

  readonly config = {
    get: (): UserConfigPayload => this.configService.getUserConfig(),
    save: (body: { content?: unknown } | string = {}): UserConfigPayload => {
      this.assertMutation('config', 'save')
      return this.configService.saveUserConfig(typeof body === 'string' ? body : String(body.content ?? ''))
    },
  }

  readonly attachments = {
    save: (opts: { raw: Buffer | Uint8Array; name: string; mime: string }): Dict => this.attachmentStore.save(opts) as unknown as Dict,
    rawPath: (attachmentId: string): Dict | null => {
      const ref = this.attachmentStore.get(attachmentId)
      return ref ? { path: join(this.attachmentStore.root, ref.rel_path), ref } : null
    },
  }

  readonly mcp = {
    getConfig: (): Dict => this.configService.getMcpConfig() as unknown as Dict,
    saveConfig: async (raw: Dict): Promise<Dict> => {
      // mcp.saveConfig 落盘后会经 MCPClient 以 servers.*.command 起子进程（stdio transport）；
      // 未经审批就能被 renderer 一条 IPC 写任意 command/args 是一条进程执行 pivot（审计 P0-5）。
      this.assertMutation('mcp', 'saveConfig')
      return this.configService.saveMcpConfig(raw) as unknown as Dict
    },
  }

  readonly model = {
    getConfig: async (): Promise<Dict> => this.modelService.getConfig() as unknown as Dict,
    saveConfig: async (raw: Dict): Promise<Dict> => {
      this.assertMutation('model', 'saveConfig')
      return this.modelService.saveConfig(raw) as unknown as Dict
    },
    saveOnboardingConfig: async (settings: Dict): Promise<Dict> => {
      this.assertMutation('model', 'saveOnboardingConfig')
      return this.modelService.saveOnboardingConfig(settings) as unknown as Dict
    },
    test: async (body: Dict): Promise<Dict> => this.modelService.test(body),
  }

  readonly control = {
    get: (): Dict => this.loop.controlManager.payload(),
    setMode: (mode: string): Dict => this.loop.controlManager.setMode(mode),
    answerInteraction: (id: string, answers: Dict, opts: ControlResumeOptions = {}): Promise<Dict> => {
      const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
      return this.resumeControl(this.loop.controlManager.answer(id, answers), opts, ownerSessionId)
    },
    commentPlan: (id: string, comment: string, opts: ControlResumeOptions = {}): Promise<Dict> => {
      const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
      return this.resumeControl(this.loop.controlManager.comment(id, comment), opts, ownerSessionId)
    },
    approvePlan: (id: string, opts: ControlResumeOptions = {}): Promise<Dict> => {
      const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
      return this.resumeControl(this.loop.controlManager.approve(id), opts, ownerSessionId)
    },
    cancelInteraction: async (id: string): Promise<Dict> => {
      const ownerSessionId = this.loop.controlPendingOwnerSessionId(id)
      const result = this.loop.controlManager.cancel(id)
      const event = { ...result, control: this.loop.controlManager.payload() }
      await this.emitRuntime(event, { sessionId: ownerSessionId })
      return event
    },
  }

  readonly plans = {
    list: (): Dict[] => this.loop.controlManager.planStore.list().map(planToDict),
    get: (planId: string): Dict | null => {
      const plan = this.loop.controlManager.planStore.get(planId)
      return plan ? planToDict(plan) : null
    },
  }

  readonly scheduler = {
    get: (): Dict => ({
      status: this.loop.schedulerService.status(),
      jobs: this.loop.schedulerService.listJobs({ includeDisabled: true }).map((job) => job.toDict()),
      diagnostics: this.loop.schedulerStore.diagnostics(),
    }),
    createJob: (args: Dict): Promise<Dict> => { this.assertMutation('scheduler', 'create'); return this.schedulerTool({ ...args, action: 'add' }) },
    updateJob: (jobId: string, args: Dict): Promise<Dict> => { this.assertMutation('scheduler', 'update'); return this.schedulerTool({ ...args, action: 'update', job_id: jobId }) },
    runJob: (jobId: string): Promise<Dict> => { this.assertMutation('scheduler', 'run'); return this.schedulerTool({ action: 'run', job_id: jobId }) },
    pauseJob: (jobId: string): Promise<Dict> => { this.assertMutation('scheduler', 'pause'); return this.schedulerTool({ action: 'pause', job_id: jobId }) },
    resumeJob: (jobId: string): Promise<Dict> => { this.assertMutation('scheduler', 'resume'); return this.schedulerTool({ action: 'resume', job_id: jobId }) },
    deleteJob: (jobId: string): Promise<Dict> => { this.assertMutation('scheduler', 'delete'); return this.schedulerTool({ action: 'remove', job_id: jobId }) },
  }

  readonly sessions = {
    list: (opts: { includeArchived?: boolean } = {}): Dict[] => {
      this.loop.reconcileSessionControlPending()
      return this.loop.sessionStore.list({ includeArchived: opts.includeArchived ?? false }) as unknown as Dict[]
    },
    create: (opts: { title?: string; mode?: string; project?: Dict | null; project_path?: string | null } = {}): Dict => {
      let project = opts.project ?? null
      const mode = opts.mode === 'build' ? 'build' : 'chat'
      if (mode === 'build' && !project) {
        const projectPath = String(opts.project_path || '').trim()
        if (!projectPath) throw new Error('Build session requires project_path')
        project = this.loop.projectStore.resolve(projectPath) as unknown as Dict
      }
      return this.loop.sessionStore.create(opts.title ?? 'Untitled', { mode, project }) as unknown as Dict
    },
    rename: (sessionId: string, patch: string | { title?: string | null; archived?: boolean | null }): Dict => {
      if (typeof patch === 'object' && patch !== null && 'archived' in patch) {
        const entry = patch.archived ? this.loop.sessionStore.archive(sessionId) : this.loop.sessionStore.restore(sessionId)
        if (!entry) throw new Error('session not found')
        return entry as unknown as Dict
      }
      const title = typeof patch === 'string' ? patch : String(patch?.title ?? '').trim()
      if (!title) throw new Error('title is required')
      if (!this.loop.sessionStore.rename(sessionId, title)) throw new Error('session not found')
      const entry = this.loop.sessionStore.get(sessionId)
      return (entry ?? {}) as unknown as Dict
    },
    delete: (sessionId: string): Dict => {
      if (!this.loop.sessionStore.delete(sessionId)) throw new Error('cannot delete session')
      const removedTasks = this.loop.taskManager.store.deleteBySession(sessionId)
      const removedPlans = this.loop.controlManager.planStore.deleteBySession(sessionId)
      return { deleted: true, removedTasks, removedPlans }
    },
    activate: (sessionId: string): Dict => {
      this.loop.activateSession(sessionId)
      return { active: sessionId, complete: true }
    },
  }

  readonly team = {
    get: (): Dict => this.teamService.get(),
    getMember: (name: string): Dict => this.teamService.getMember(name),
    spawnMember: (opts: { name: string; role: string; task?: string | null; agent_type?: string | null }): Promise<Dict> => this.teamService.spawnMember(opts),
    sendMessage: (opts: { to: string; content: string; wake?: boolean }): Promise<Dict> => this.teamService.sendMessage(opts),
    wakeMember: (name: string, opts: { purpose?: string } = {}): Promise<Dict> => this.teamService.wakeMember(name, opts),
    shutdownMember: (name: string): Promise<Dict> => this.teamService.shutdownMember(name),
  }

  readonly external = {
    get: (): Dict => this.externalBridge.payload(),
  }

  readonly tasks = {
    list: (opts: { sessionId?: string | null } = {}): Dict[] => {
      const sessionId = String(opts.sessionId ?? '').trim()
      const records = this.loop.taskManager.store.list()
      const filtered = sessionId ? records.filter((task) => task.session_id === sessionId) : records
      return filtered.map((task) => task.toDict() as unknown as Dict)
    },
    get: (taskId: string): Dict | null => this.loop.taskManager.store.get(taskId)?.toDict() as unknown as Dict ?? null,
    transcript: (taskId: string, opts: { offset?: number; limit?: number } = {}): Dict => new SidechainTranscript(this.paths.stateRoot, taskId).read(opts),
  }

  readonly tools = {
    readResult: (opts: { ref: string }): Dict => {
      const content = new ToolResultStore(this.paths.stateRoot).readArtifact(String(opts?.ref ?? ''))
      return { content }
    },
  }

  readonly memory = {
    get: (): Dict => this.memoryService.getMemory(),
    save: (content: string): Dict => this.memoryService.saveMemory(content),
    getEpisode: (date?: string | null): Dict => this.memoryService.getEpisode(String(date ?? '')),
    saveEpisode: (content: string, date?: string | null): Dict => this.memoryService.saveEpisode(content, String(date ?? '')),
    listVersions: (opts: { limit?: number; target?: string | null } = {}): Dict => this.memoryService.listVersions(opts),
    getVersion: (versionId: string): Dict => this.memoryService.getVersion(versionId),
    restoreVersion: (versionId: string): Dict => this.memoryService.restoreVersion(versionId),
    getWatchlist: (): Dict => this.memoryService.getWatchlist(),
    saveWatchlist: (content: string): Dict => this.memoryService.saveWatchlist(content),
    checkWatchlist: async (): Promise<Dict> => this.memoryService.checkWatchlist(),
    tokens: (): Dict => this.memoryService.tokens(),
    compact: (): Promise<Dict> => this.memoryService.compact(),
  }

  readonly projects = {
    list: (): Dict[] => this.loop.projectStore.list() as unknown as Dict[],
    resolve: (path: string): Dict => this.loop.projectStore.resolve(path) as unknown as Dict,
  }

  readonly skills = {
    tools: (): Dict[] => this.skillService.tools(),
    list: (): Dict[] => this.skillService.list() as unknown as Dict[],
    get: (name: string): Dict => this.skillService.get(name) as unknown as Dict,
    save: (name: string, content: string): Dict => this.skillService.save(name, content) as unknown as Dict,
    delete: (name: string): Dict => this.skillService.delete(name),
    importArchive: (archive: unknown): Dict => this.skillService.importArchive(archive),
  }

  readonly sidebar = {
    get: (): Dict => normalizeSidebarState(readJson(
      join(this.paths.memoryRoot, 'sidebar_state.json'),
      readJson(join(this.root, 'memory', 'sidebar_state.json'), {}),
    )),
    patch: (patch: Dict): Dict => {
      const path = join(this.paths.memoryRoot, 'sidebar_state.json')
      const next = normalizeSidebarState({ ...readJson(path, {}), ...patch })
      atomicWriteText(path, JSON.stringify(next, null, 2) + '\n')
      return next
    },
  }

  readonly diagnostics = {
    get: async (): Promise<Dict> => this.diagnosticsService.payload() as unknown as Dict,
  }

  readonly desktopPet = {
    get: async (): Promise<Dict> => this.desktopPetService.get(),
    setEnabled: (enabled: boolean): Promise<Dict> => this.desktopPetService.setEnabled(enabled),
  }

  private assertMutation(area: string, action: string): void {
    assertCoreMutationAllowed(this.loop.controlManager.payload(), { area, action })
  }

  private async schedulerTool(args: Dict): Promise<Dict> {
    const result = await this.loop.registry.executeResult('scheduler', args)
    return { ok: !result.isError, result: result.modelContent, summary: result.summary }
  }

  private async resumeControl(resume: ControlResume, opts: ControlResumeOptions, ownerSessionId: string | null): Promise<Dict> {
    const event = isRecord(resume.event) ? { ...resume.event, control: this.loop.controlManager.payload() } : null
    if (event) await this.emitRuntime(event, { emit: opts.emit ?? null, sessionId: ownerSessionId })
    let result: Dict | null = null
    if (resume.resume === true) {
      const uiHidden = opts.uiHidden ?? false
      result = await this.mainline.submit({
        content: String(resume.message ?? ''),
        displayContent: uiHidden ? '' : opts.displayContent ?? String(resume.message ?? ''),
        clientMessageId: opts.clientMessageId ?? null,
        turnId: opts.turnId ?? null,
        source: 'control',
        sessionId: ownerSessionId,
        uiHidden,
        emit: opts.emit ?? null,
      }) as unknown as Dict
    }
    return { ...(resume as unknown as Dict), event: event ?? resume.event, result }
  }

  private async emitRuntime(event: Dict, opts: { emit?: StreamEmitter | null; sessionId?: string | null } = {}): Promise<Dict> {
    const targetSessionId = String(opts.sessionId ?? '').trim()
    const store = targetSessionId && targetSessionId !== this.loop.activeSessionId
      ? new RuntimeEventStore(this.loop.sessionStore.sessionDir(targetSessionId), { sessionDirOverride: true })
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

  private requireReadableSessionId(sessionId: string | null | undefined, operation: string): string {
    return this.requireReadableSession(String(sessionId ?? '').trim(), operation).id
  }

  private requireReadableSession(sessionId: string, operation: string): { id: string; archived_at?: string | null } {
    if (!sessionId) {
      throw new InvalidSessionError(`${operation} requires a real sessionId`, null)
    }
    if (sessionId.startsWith(DRAFT_SESSION_PREFIX)) {
      throw new InvalidSessionError(`${operation} cannot read draft session ${sessionId}`, sessionId)
    }
    const session = this.loop.sessionStore.get(sessionId)
    if (!session || session.archived_at) {
      throw new InvalidSessionError(`${operation} received unknown session ${sessionId}`, sessionId)
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

function op(key: string, method: string, route: string): RouteOperation {
  return { key, method, route }
}

function readJson(path: string, fallback: Dict): Dict {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Dict : fallback
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
    project_session_order: normalizeSidebarProjectSessionOrder(raw.project_session_order),
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

function normalizeSidebarProjectSessionOrder(value: unknown): Record<string, string[]> {
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
  return isRecord(owner) ? String(owner.session_id ?? owner.sessionId ?? '').trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export type { LoopModelRouter }
