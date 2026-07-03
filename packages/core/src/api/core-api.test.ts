import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { ExternalInbound } from '../external/models'
import { makePlanRecord } from '../plans/models'
import { ToolResultStore } from '../context/tool-results'
import { RuntimeEventStore } from '../runtime/store'
import { SchedulerPayload, SchedulerSchedule } from '../scheduler/models'
import { CoreApi, CORE_API_ROUTE_OPERATIONS } from './core-api'
import { CoreMutationGuardError } from './mutation-guard'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

const EXPECTED_OPERATIONS = [
  'attachments.rawPath',
  'attachments.save',
  'bootstrap',
  'chat.stopRuntime',
  'chat.submit',
  'config.get',
  'config.save',
  'control.answerInteraction',
  'control.approvePlan',
  'control.cancelInteraction',
  'control.commentPlan',
  'control.get',
  'control.setMode',
  'desktopPet.get',
  'desktopPet.setEnabled',
  'diagnostics.get',
  'external.get',
  'mcp.getConfig',
  'mcp.saveConfig',
  'memory.checkWatchlist',
  'memory.compact',
  'memory.get',
  'memory.getEpisode',
  'memory.getVersion',
  'memory.getWatchlist',
  'memory.listVersions',
  'memory.restoreVersion',
  'memory.save',
  'memory.saveEpisode',
  'memory.saveWatchlist',
  'memory.tokens',
  'model.getConfig',
  'model.saveConfig',
  'model.saveOnboardingConfig',
  'model.test',
  'plans.get',
  'plans.list',
  'projects.list',
  'projects.resolve',
  'runtime.replay',
  'scheduler.createJob',
  'scheduler.deleteJob',
  'scheduler.get',
  'scheduler.pauseJob',
  'scheduler.resumeJob',
  'scheduler.runJob',
  'scheduler.updateJob',
  'sessions.activate',
  'sessions.create',
  'sessions.delete',
  'sessions.list',
  'sessions.rename',
  'sidebar.get',
  'sidebar.patch',
  'skills.delete',
  'skills.get',
  'skills.importArchive',
  'skills.list',
  'skills.save',
  'skills.tools',
  'tasks.get',
  'tasks.list',
  'tasks.transcript',
  'team.get',
  'team.getMember',
  'team.sendMessage',
  'team.shutdownMember',
  'team.spawnMember',
  'team.wakeMember',
  'tools.readResult',
]

describe('CoreApi (MIG-IPC-001)', () => {
  it('exposes a typed in-process method for every retired web route operation', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(CORE_API_ROUTE_OPERATIONS.map((op) => op.key).sort()).toEqual(EXPECTED_OPERATIONS)
    for (const key of EXPECTED_OPERATIONS) {
      expect(resolveMethod(api, key), key).toBeTypeOf('function')
    }
    await api.close()
  })

  it('boots, submits a chat turn, and persists session runtime state without HTTP', async () => {
    const root = tmp('emperor-core-api-')
    const provider = new FakeProvider()
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(provider) })
    const events: Array<Record<string, unknown>> = []

    const boot = await api.bootstrap()
    const session = api.sessions.create({ title: 'API Chat' })
    const reply = await api.chat.submit({ content: 'ping', turnId: 'turn_api_1', sessionId: String(session.id), emit: async (event) => { events.push(event) } })
    const tools = boot.tools as Array<Record<string, unknown>>
    const activeSessionId = String(api.loop.activeSessionId ?? '')

    expect(boot.app).toBe('Emperor Agent')
    expect(boot).toMatchObject({ sessionIndexSource: expect.any(String), repairedSessions: expect.any(Number) })
    expect(tools.some((tool) => tool.name === 'read_file')).toBe(true)
    expect(reply.content).toBe('pong')
    expect(events.map((event) => event.event)).toContain('assistant_done')
    expect(activeSessionId).toBeTruthy()
    expect(existsSync(join(root, '.emperor', 'sessions', activeSessionId, 'history.jsonl'))).toBe(true)

    await api.close()
  })

  it('stores new private runtime state under .emperor and reports effective paths', async () => {
    const root = tmp('emperor-core-api-state-root-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })

    const session = api.sessions.create({ title: 'State Root Chat' })
    await api.chat.submit({ content: 'ping', turnId: 'turn_state_1', sessionId: String(session.id), emit: async () => {} })
    const diagnostics = await api.diagnostics.get()

    expect(existsSync(join(root, '.emperor', 'memory', 'MEMORY.local.md'))).toBe(true)
    expect(existsSync(join(root, '.emperor', 'sessions', String(session.id), 'history.jsonl'))).toBe(true)
    expect(existsSync(join(root, '.emperor', 'sessions', String(session.id), 'runtime', 'events.jsonl'))).toBe(true)
    expect(existsSync(join(root, '.emperor', 'sessions', String(session.id), 'prompt-snapshots', 'turn_state_1.json'))).toBe(true)
    expect(existsSync(join(root, '.emperor', 'memory', 'control', 'state.json'))).toBe(true)
    expect(existsSync(join(root, '.emperor', '.team', 'config.json'))).toBe(false)
    expect(existsSync(join(root, 'memory'))).toBe(false)
    expect(existsSync(join(root, 'sessions'))).toBe(false)
    expect(diagnostics.paths).toMatchObject({
      runtimeRoot: root,
      stateRoot: join(root, '.emperor'),
      sessionsRoot: join(root, '.emperor', 'sessions'),
      memoryRoot: join(root, '.emperor', 'memory'),
    })
    expect((diagnostics as any).promptSnapshots.recent[0]).toMatchObject({
      sessionId: String(session.id),
      turnId: 'turn_state_1',
    })
    expect((diagnostics as any).promptSnapshots.recent[0].sections.map((section: any) => section.name)).toContain('bootstrap')

    await api.close()
  })

  it('rejects draft session ids at bootstrap before activating or replaying', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-bootstrap-session-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const activeSessionId = api.loop.activeSessionId

    await expect(api.bootstrap({ sessionId: 'draft:new-chat' })).rejects.toThrow(/draft/i)
    expect(api.loop.activeSessionId).toBe(activeSessionId)

    await api.close()
  })

  it('replays runtime events for the requested session only', async () => {
    const root = tmp('emperor-core-api-runtime-replay-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    const firstSessionId = String(api.loop.activeSessionId)
    const second = api.sessions.create({ title: 'Second Chat' })

    await api.chat.submit({ content: 'first', turnId: 'turn_first', sessionId: firstSessionId, emit: async () => {} })
    await api.chat.submit({ content: 'second', turnId: 'turn_second', sessionId: String(second.id), emit: async () => {} })

    const replay = api.runtime.replay({ sessionId: firstSessionId, afterSeq: 0 }) as any
    const turnIds = replay.events.map((event: any) => event.turn_id)

    expect(replay).toMatchObject({
      sessionId: firstSessionId,
      afterSeq: 0,
      latestSeq: expect.any(Number),
    })
    expect(turnIds).toContain('turn_first')
    expect(turnIds).not.toContain('turn_second')
    expect(replay.events.every((event: any) => event.session_id === firstSessionId)).toBe(true)

    const boot = await api.bootstrap({ sessionId: firstSessionId })
    const bootTurnIds = ((boot.runtime as any).events as any[]).map((event) => event.turn_id)
    expect(bootTurnIds).toContain('turn_first')
    expect(bootTurnIds).not.toContain('turn_second')

    await api.close()
  })

  it('compacts high-frequency delta events in replay by default without touching disk', async () => {
    const root = tmp('emperor-core-api-replay-compact-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    const sessionId = String(api.loop.activeSessionId)
    const store = new RuntimeEventStore(api.loop.sessionStore.sessionDir(sessionId), { sessionDirOverride: true })
    store.append({ event: 'user_message', content: 'go' }, { turnId: 't1', sessionId })
    for (let index = 0; index < 20; index += 1) {
      store.append({
        event: 'plan_draft_delta',
        tool_call_id: 'c1',
        interaction: { id: 'p', title: 'T'.repeat(index + 1), meta: { plan_stream_id: 'c1' } },
      }, { turnId: 't1', sessionId })
    }
    store.append({ event: 'assistant_done', content: 'done' }, { turnId: 't1', sessionId })

    const replay = api.runtime.replay({ sessionId, afterSeq: 0 }) as any
    expect(replay.events.filter((event: any) => event.event === 'plan_draft_delta')).toHaveLength(1)
    expect(replay.events.find((event: any) => event.event === 'plan_draft_delta').interaction.title).toBe('T'.repeat(20))

    const full = api.runtime.replay({ sessionId, afterSeq: 0, compact: false }) as any
    expect(full.events.filter((event: any) => event.event === 'plan_draft_delta')).toHaveLength(20)

    const boot = await api.bootstrap({ sessionId })
    expect(((boot.runtime as any).events as any[]).filter((event) => event.event === 'plan_draft_delta')).toHaveLength(1)

    await api.close()
  })

  it('matches session route response shapes for IPC callers', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const created = api.sessions.create({ title: 'Work' })
    const items = api.sessions.list()
    const renamed = api.sessions.rename(String(created.id), { title: 'Renamed' })
    const archived = api.sessions.rename(String(created.id), { archived: true })
    const all = api.sessions.list({ includeArchived: true })
    const activated = api.sessions.activate(String(api.loop.activeSessionId))

    expect(Array.isArray(items)).toBe(true)
    expect(items.some((item) => item.id === created.id)).toBe(true)
    expect(renamed).toMatchObject({ id: created.id, title: 'Renamed' })
    expect(archived).toMatchObject({ id: created.id })
    expect(String(archived.archived_at || '')).toBeTruthy()
    expect(all.some((item) => item.id === created.id)).toBe(true)
    expect(activated).toMatchObject({ active: api.loop.activeSessionId, complete: true })

    await api.close()
  })

  it('returns distinct workspace and agent state paths for resolved projects', async () => {
    const root = tmp('emperor-core-api-project-paths-')
    const projectDir = tmp('emperor-core-api-project-workspace-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })

    const project = api.projects.resolve(projectDir) as any

    expect(project).toMatchObject({
      project_path: resolve(projectDir),
      workspace_path: resolve(projectDir),
      state_path: join(root, '.emperor', 'projects', project.project_id),
      memory_path: join(root, '.emperor', 'projects', project.project_id, 'AGENTS.local.md'),
      agents_path: join(root, '.emperor', 'projects', project.project_id, 'AGENTS.local.md'),
      legacy_agents_path: null,
      legacy_imported_at: null,
    })
    expect(existsSync(join(projectDir, 'AGENTS.md'))).toBe(false)

    await api.close()
  })

  it('keeps chat and build project contexts isolated in provider prompts', async () => {
    const root = tmp('emperor-core-api-context-isolation-')
    const provider = new FakeProvider()
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(provider) })
    const chatSessionId = String(api.loop.activeSessionId)
    const projectAPath = join(root, 'project-a')
    const projectBPath = join(root, 'project-b')
    mkdirSync(projectAPath, { recursive: true })
    mkdirSync(projectBPath, { recursive: true })
    const projectA = api.projects.resolve(projectAPath) as any
    const projectB = api.projects.resolve(projectBPath) as any
    api.loop.projectStore.updateMemory(String(projectA.project_id), 'PROJECT_A_PRIVATE_MEMORY')
    api.loop.projectStore.updateMemory(String(projectB.project_id), 'PROJECT_B_PRIVATE_MEMORY')
    const buildA = api.sessions.create({ title: 'Build A', mode: 'build', project_path: projectAPath })
    const buildB = api.sessions.create({ title: 'Build B', mode: 'build', project_path: projectBPath })
    api.control.setMode('auto')

    await api.chat.submit({ content: 'ping', turnId: 'turn_chat_iso', sessionId: chatSessionId })
    await api.chat.submit({ content: 'ping', turnId: 'turn_a_iso', sessionId: String(buildA.id) })
    await api.chat.submit({ content: 'ping', turnId: 'turn_b_iso', sessionId: String(buildB.id) })

    const prompts = provider.calls.slice(-3).map((call) => JSON.stringify(call.messages))
    const chatPrompt = prompts[0] ?? ''
    const promptA = prompts[1] ?? ''
    const promptB = prompts[2] ?? ''

    expect(chatPrompt).not.toContain('PROJECT_A_PRIVATE_MEMORY')
    expect(chatPrompt).not.toContain('PROJECT_B_PRIVATE_MEMORY')
    expect(promptA).toContain(projectAPath)
    expect(promptA).toContain('PROJECT_A_PRIVATE_MEMORY')
    expect(promptA).not.toContain('PROJECT_B_PRIVATE_MEMORY')
    expect(promptB).toContain(projectBPath)
    expect(promptB).toContain('PROJECT_B_PRIVATE_MEMORY')
    expect(promptB).not.toContain('PROJECT_A_PRIVATE_MEMORY')
    expect(readFileSync(join(root, '.emperor', 'sessions', chatSessionId, 'history.jsonl'), 'utf8')).toContain('turn_chat_iso')
    expect(readFileSync(join(root, '.emperor', 'sessions', String(buildA.id), 'history.jsonl'), 'utf8')).toContain('turn_a_iso')
    expect(readFileSync(join(root, '.emperor', 'sessions', String(buildB.id), 'history.jsonl'), 'utf8')).toContain('turn_b_iso')

    await api.close()
  })

  it('reconciles stale session pending tags before bootstrap and session list responses', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-control-tags-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const active = api.loop.sessionStore.get(String(api.loop.activeSessionId))!
    const stale = api.loop.sessionStore.create('Stale Session')
    api.loop.sessionStore.setControlPending(active.id, {
      kind: 'plan',
      label: '计划需要用户确认',
      tone: 'green',
      interaction_id: 'plan_current',
      updated_at: 1,
    })
    api.loop.sessionStore.setControlPending(stale.id, {
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: 'ask_stale',
      updated_at: 2,
    })

    await api.bootstrap()

    expect(api.loop.sessionStore.get(active.id)?.control_pending).toBeNull()
    expect(api.loop.sessionStore.get(stale.id)?.control_pending).toBeNull()

    const pending = api.loop.controlManager.createPlan({
      title: 'Pending Plan',
      summary: 'Need approval',
      planMarkdown: '# Plan',
      riskLevel: 'low',
    })
    api.loop.sessionStore.setControlPending(stale.id, {
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: 'ask_stale',
      updated_at: 3,
    })

    const sessions = api.sessions.list() as Array<Record<string, unknown>>

    expect(api.loop.sessionStore.get(active.id)?.control_pending).toMatchObject({ interaction_id: pending.id })
    expect(api.loop.sessionStore.get(stale.id)?.control_pending).toBeNull()
    expect(sessions.find((item) => item.id === active.id)?.control_pending).toMatchObject({ interaction_id: pending.id })
    expect(sessions.find((item) => item.id === stale.id)?.control_pending).toBeNull()

    await api.close()
  })

  it('serves USER.local.md through the config route parity surface', async () => {
    const root = tmp('emperor-core-api-config-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })

    const initial = api.config.get()

    expect(initial).toMatchObject({ path: 'templates/USER.local.md' })
    expect(readFileSync(join(root, '.emperor', 'templates', 'USER.local.md'), 'utf8')).toBe((initial as any).content)
    expect(existsSync(join(root, 'emperor.local.json'))).toBe(false)

    const saved = api.config.save({ content: '偏好更新\n\n' })

    expect(saved).toEqual({
      path: 'templates/USER.local.md',
      content: '偏好更新\n',
    })
    expect(readFileSync(join(root, '.emperor', 'templates', 'USER.local.md'), 'utf8')).toBe('偏好更新\n')
    expect(existsSync(join(root, 'emperor.local.json'))).toBe(false)

    await api.close()
  })

  it('applies mutation guard at CoreApi write boundaries', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    api.control.setMode('plan')

    expect(() => api.scheduler.createJob({})).toThrow(CoreMutationGuardError)
    expect(() => api.team.wakeMember('alice')).toThrow(CoreMutationGuardError)

    await api.close()
  })

  it('applies mutation guard to mcp/model config saves (audit P0-5)', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-mutation-guard-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    api.control.setMode('plan')

    // mcp.saveConfig 能触发 StdioClientTransport spawn 子进程 —— 审计 P0-5 点名的高危 pivot，
    // 必须和 scheduler/team 一样受 mutation guard 约束，不能在 renderer 发一条 IPC 就无条件执行。
    await expect(api.mcp.saveConfig({ servers: {} })).rejects.toThrow(CoreMutationGuardError)
    await expect(api.model.saveConfig({})).rejects.toThrow(CoreMutationGuardError)
    await expect(api.model.saveOnboardingConfig({})).rejects.toThrow(CoreMutationGuardError)
    expect(() => api.config.save('x')).toThrow(CoreMutationGuardError)

    await api.close()
  })

  it('normalizes missing and legacy sidebar state before returning it', async () => {
    const root = tmp('emperor-core-api-sidebar-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })

    expect(api.sidebar.get()).toEqual({
      section_order: ['projects', 'chats'],
      project_sort: 'updated_at',
      chat_sort: 'updated_at',
      project_order: [],
      chat_order: [],
      project_session_order: {},
      collapsed_project_ids: [],
    })

    mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(join(root, 'memory', 'sidebar_state.json'), JSON.stringify({
      project_sort: 'manual',
      section_order: ['chats'],
      collapsed_project_ids: 'legacy-bad-value',
      project_session_order: { p1: ['s1', 2] },
    }), 'utf8')

    expect(api.sidebar.get()).toEqual({
      section_order: ['chats', 'projects'],
      project_sort: 'manual',
      chat_sort: 'updated_at',
      project_order: [],
      chat_order: [],
      project_session_order: { p1: ['s1', '2'] },
      collapsed_project_ids: [],
    })

    await api.close()
  })

  it('returns diagnostics summaries without mutating missing or corrupt config files', async () => {
    const root = tmp('emperor-core-api-')
    writeFileSync(join(root, 'emperor.local.json'), '{not valid json', 'utf8')
    writeFileSync(join(root, 'emperor.local.json.corrupt-1'), '{old broken json', 'utf8')
    const api = await CoreApi.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const diagnostics = await api.diagnostics.get()

    expect(existsSync(join(root, 'model_config.json'))).toBe(false)
    expect(diagnostics.modelConfig).toMatchObject({
      path: join(root, 'model_config.json'),
      exists: false,
      status: 'missing',
      error: '',
    })
    expect(diagnostics.localConfig).toMatchObject({
      path: join(root, 'emperor.local.json'),
      exists: true,
      status: 'corrupt',
    })
    expect((diagnostics.localConfig as any).corruptBackups).toEqual([
      expect.objectContaining({ path: join(root, 'emperor.local.json.corrupt-1') }),
    ])
    expect(diagnostics).toHaveProperty('dependencies.desktopRenderer')
    expect(diagnostics).toHaveProperty('dependencies.desktopPetNodeModules')

    await api.close()
  })

  it('answers pending ask interactions and resumes through mainline chat', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const events: Array<Record<string, unknown>> = []
    const interaction = api.loop.controlManager.createAsk({
      questions: [{
        id: 'scope',
        header: '范围',
        question: '本次范围怎么定',
        options: [
          { label: '完整', description: 'full' },
          { label: '最小', description: 'small' },
        ],
      }],
      context: 'need scope',
    })

    const result = await api.control.answerInteraction(
      interaction.id,
      { scope: { choice: '完整', freeform: '' } },
      { clientMessageId: 'control-msg-1', uiHidden: true, emit: async (event: Record<string, unknown>) => { events.push(event) } },
    )

    expect(result).toMatchObject({ resume: true, result: { content: 'pong' } })
    expect(events.map((event) => event.event)).toContain('ask_answered')
    expect(events.map((event) => event.event)).toContain('assistant_done')
    expect(events.find((event) => event.event === 'user_message')).toMatchObject({
      source: 'control',
      ui_hidden: true,
      client_message_id: 'control-msg-1',
    })
    expect(JSON.stringify(api.loop.activeMemoryStore.loadUnarchivedHistory())).toContain('[CONTROL:ASK_ANSWERED]')

    await api.close()
  })

  it('resumes answered control interactions in their owning session after the user switches away', async () => {
    const root = tmp('emperor-core-api-control-owner-')
    const api = await CoreApi.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const ownerSessionId = String(api.loop.activeSessionId)
    const other = api.sessions.create({ title: 'Other Session' })
    const interaction = api.loop.controlManager.createAsk({
      questions: [{
        id: 'scope',
        header: '范围',
        question: '范围怎么定',
        options: [
          { label: '完整', description: 'full' },
          { label: '最小', description: 'small' },
        ],
      }],
      context: 'need scope',
    })
    api.sessions.activate(String(other.id))

    await api.control.answerInteraction(
      interaction.id,
      { scope: { choice: '完整', freeform: '' } },
      { clientMessageId: 'control-owner-msg', uiHidden: true },
    )

    expect(api.loop.activeSessionId).toBe(ownerSessionId)
    expect(api.loop.sessionStore.get(ownerSessionId)?.control_pending).toBeNull()
    expect(api.loop.sessionStore.get(String(other.id))?.control_pending).toBeNull()
    expect(readFileSync(join(root, '.emperor', 'sessions', ownerSessionId, 'history.jsonl'), 'utf8')).toContain('[CONTROL:ASK_ANSWERED]')
    const ownerEvents = readFileSync(join(root, '.emperor', 'sessions', ownerSessionId, 'runtime', 'events.jsonl'), 'utf8')
    expect(ownerEvents).toContain('"event":"ask_answered"')
    expect(ownerEvents).toContain(`"session_id":"${ownerSessionId}"`)
    const otherHistoryPath = join(root, '.emperor', 'sessions', String(other.id), 'history.jsonl')
    expect(existsSync(otherHistoryPath) ? readFileSync(otherHistoryPath, 'utf8') : '').not.toContain('[CONTROL:ASK_ANSWERED]')
    const otherEventsPath = join(root, '.emperor', 'sessions', String(other.id), 'runtime', 'events.jsonl')
    expect(existsSync(otherEventsPath) ? readFileSync(otherEventsPath, 'utf8') : '').not.toContain('"event":"ask_answered"')

    await api.close()
  })

  it('records cancelled control interactions in their owning session after the user switches away', async () => {
    const root = tmp('emperor-core-api-control-cancel-owner-')
    const api = await CoreApi.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const ownerSessionId = String(api.loop.activeSessionId)
    const other = api.sessions.create({ title: 'Other Session' })
    const interaction = api.loop.controlManager.createAsk({
      questions: [{
        id: 'scope',
        header: '范围',
        question: '范围怎么定',
        options: [
          { label: '完整', description: 'full' },
          { label: '最小', description: 'small' },
        ],
      }],
      context: 'need scope',
    })
    api.sessions.activate(String(other.id))

    await api.control.cancelInteraction(interaction.id)

    expect(api.loop.sessionStore.get(ownerSessionId)?.control_pending).toBeNull()
    expect(api.loop.sessionStore.get(String(other.id))?.control_pending).toBeNull()
    const ownerEvents = readFileSync(join(root, '.emperor', 'sessions', ownerSessionId, 'runtime', 'events.jsonl'), 'utf8')
    expect(ownerEvents).toContain('"event":"interaction_cancelled"')
    expect(ownerEvents).toContain(`"session_id":"${ownerSessionId}"`)
    const otherEventsPath = join(root, '.emperor', 'sessions', String(other.id), 'runtime', 'events.jsonl')
    expect(existsSync(otherEventsPath) ? readFileSync(otherEventsPath, 'utf8') : '').not.toContain('"event":"interaction_cancelled"')

    await api.close()
  })

  it('drains queued external messages into the session that received them after the user switches away', async () => {
    const root = tmp('emperor-core-api-external-owner-')
    const api = await CoreApi.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const ownerSessionId = String(api.loop.activeSessionId)
    const other = api.sessions.create({ title: 'Other Session' })
    const pending = api.loop.controlManager.createAsk({
      questions: [{
        id: 'scope',
        header: '范围',
        question: '范围怎么定',
        options: [
          { label: '完整', description: 'full' },
          { label: '最小', description: 'small' },
        ],
      }],
      context: 'busy owner session',
    })

    const queued = await api.externalBridge.ingest(new ExternalInbound({
      platform: 'slack',
      sender_id: 'u1',
      external_message_id: 'm-owner',
      content: 'external hello',
    }))
    api.sessions.activate(String(other.id))
    await api.control.cancelInteraction(pending.id)

    const drained = await api.externalBridge.drainPending()

    expect(queued.status).toBe('queued')
    expect(drained[0]).toMatchObject({ status: 'dispatched' })
    const ownerHistory = readFileSync(join(root, '.emperor', 'sessions', ownerSessionId, 'history.jsonl'), 'utf8')
    expect(ownerHistory).toContain('external hello')
    const ownerEvents = readFileSync(join(root, '.emperor', 'sessions', ownerSessionId, 'runtime', 'events.jsonl'), 'utf8')
    expect(ownerEvents).toContain('"event":"external_queued"')
    expect(ownerEvents).toContain(`"session_id":"${ownerSessionId}"`)
    const otherHistoryPath = join(root, '.emperor', 'sessions', String(other.id), 'history.jsonl')
    expect(existsSync(otherHistoryPath) ? readFileSync(otherHistoryPath, 'utf8') : '').not.toContain('external hello')
    const otherEventsPath = join(root, '.emperor', 'sessions', String(other.id), 'runtime', 'events.jsonl')
    expect(existsSync(otherEventsPath) ? readFileSync(otherEventsPath, 'utf8') : '').not.toContain('"event":"external_queued"')

    await api.close()
  })

  it('runs scheduler agent_turn jobs in the session that created them after the user switches away', async () => {
    const root = tmp('emperor-core-api-scheduler-owner-')
    const api = await CoreApi.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const ownerSessionId = String(api.loop.activeSessionId)
    const other = api.sessions.create({ title: 'Other Session' })
    const job = api.loop.schedulerService.addJob({
      name: 'Owner scheduled turn',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ kind: 'agent_turn', message: 'scheduled hello', deliver: false }),
    })
    api.sessions.activate(String(other.id))

    await expect(api.loop.schedulerService.runJob(job.id, { force: true })).resolves.toBe(true)

    const ownerHistory = readFileSync(join(root, '.emperor', 'sessions', ownerSessionId, 'history.jsonl'), 'utf8')
    expect(ownerHistory).toContain('scheduled hello')
    const ownerEvents = readFileSync(join(root, '.emperor', 'sessions', ownerSessionId, 'runtime', 'events.jsonl'), 'utf8')
    expect(ownerEvents).toContain('"event":"scheduler_run_start"')
    expect(ownerEvents).toContain(`"session_id":"${ownerSessionId}"`)
    const otherHistoryPath = join(root, '.emperor', 'sessions', String(other.id), 'history.jsonl')
    expect(existsSync(otherHistoryPath) ? readFileSync(otherHistoryPath, 'utf8') : '').not.toContain('scheduled hello')
    const otherEventsPath = join(root, '.emperor', 'sessions', String(other.id), 'runtime', 'events.jsonl')
    expect(existsSync(otherEventsPath) ? readFileSync(otherEventsPath, 'utf8') : '').not.toContain('"event":"scheduler_run_start"')

    await api.close()
  })

  it('keeps persistent Team roster isolated between build projects', async () => {
    const root = tmp('emperor-core-api-team-project-scope-')
    const projectAPath = join(root, 'project-a')
    const projectBPath = join(root, 'project-b')
    mkdirSync(projectAPath, { recursive: true })
    mkdirSync(projectBPath, { recursive: true })
    const api = await CoreApi.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const buildA = api.sessions.create({ title: 'Build A', mode: 'build', project_path: projectAPath })
    const buildB = api.sessions.create({ title: 'Build B', mode: 'build', project_path: projectBPath })

    api.sessions.activate(String(buildA.id))
    await api.team.spawnMember({ name: 'alice', role: 'reader' })
    expect((api.team.get().members as Array<Record<string, unknown>>).map((member) => member.name)).toContain('alice')

    api.sessions.activate(String(buildB.id))
    expect((api.team.get().members as Array<Record<string, unknown>>).map((member) => member.name)).not.toContain('alice')

    await api.close()
  })

  it('probes the active model entry through CoreApi model.test', async () => {
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })

    await expect(api.model.test({ entryName: 'fake', kind: 'text', role: 'main' })).resolves.toMatchObject({
      ok: true,
      kind: 'text',
      model: 'fake-main',
      provider: 'fake',
      modelRole: 'main',
      sample: 'pong',
    })
    expect(provider.calls.at(-1)?.messages.at(-1)?.content).toBe('Reply with exactly one word: pong')

    await api.close()
  })

  it('cascades session deletion to owned tasks and plans, sparing legacy and other sessions', async () => {
    const root = tmp('emperor-core-api-cascade-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    await api.bootstrap()
    const keep = api.sessions.create({ title: 'Keep' })
    const doomed = api.sessions.create({ title: 'Doomed' })
    const keepId = String(keep.id)
    const doomedId = String(doomed.id)

    const ownedTask = api.loop.taskManager.startTask({ kind: 'subagent', title: 'owned', source: 'test', sessionId: doomedId })
    const keepTask = api.loop.taskManager.startTask({ kind: 'subagent', title: 'kept', source: 'test', sessionId: keepId })
    const legacyTask = api.loop.taskManager.startTask({ kind: 'subagent', title: 'legacy', source: 'test' })
    const planStore = api.loop.controlManager.planStore
    planStore.save(makePlanRecord({ id: 'plan_doomed', title: 'd', summary: 's', status: 'draft', createdAt: 1, updatedAt: 1, sessionId: doomedId }))
    planStore.save(makePlanRecord({ id: 'plan_keep', title: 'k', summary: 's', status: 'draft', createdAt: 1, updatedAt: 1, sessionId: keepId }))
    api.loop.taskManager.appendSidechain(ownedTask.id, { role: 'user', content: 'owned work' })
    const ownedSidechainDir = join(root, '.emperor', 'memory', 'tasks', ownedTask.id)
    expect(existsSync(ownedSidechainDir)).toBe(true)

    expect(api.tasks.list({ sessionId: keepId }).map((t) => t.id)).toEqual([keepTask.id])
    expect(api.tasks.list().length).toBe(3)

    const result = api.sessions.delete(doomedId)

    expect(result).toMatchObject({ deleted: true, removedTasks: 1, removedPlans: 1 })
    expect(api.loop.taskManager.store.get(ownedTask.id)).toBeNull()
    expect(api.loop.taskManager.store.get(keepTask.id)).not.toBeNull()
    expect(api.loop.taskManager.store.get(legacyTask.id)).not.toBeNull()
    expect(planStore.get('plan_doomed')).toBeNull()
    expect(planStore.get('plan_keep')).not.toBeNull()
    expect(existsSync(ownedSidechainDir)).toBe(false)

    await api.close()
  })

  it('serves persisted full tool outputs and fences path escapes', async () => {
    const root = tmp('emperor-core-api-toolresult-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    const store = new ToolResultStore(join(root, '.emperor'))
    const record = store.persistLargeResult('turn_x', 'call_x', 'huge_output', 'full text content')

    expect(api.tools.readResult({ ref: record.artifact_path })).toEqual({ content: 'full text content' })
    expect(() => api.tools.readResult({ ref: '../outside.txt' })).toThrow()
    expect(() => api.tools.readResult({ ref: 'memory/tool-results/../../memory.md' })).toThrow()
    expect(() => api.tools.readResult({ ref: '/etc/passwd' })).toThrow()

    await api.close()
  })

  it('deletes skill directories through CoreApi skills.delete', async () => {
    const root = tmp('emperor-core-api-')
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# Demo\n', 'utf8')
    const api = await CoreApi.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(api.skills.delete('demo')).toEqual({ deleted: 'demo' })
    expect(existsSync(join(root, 'skills', 'demo'))).toBe(false)

    await api.close()
  })

  it('imports skill zip archives through CoreApi skills.importArchive', async () => {
    const root = tmp('emperor-core-api-')
    const api = await CoreApi.create({
      root,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const archive = makeStoredZip({
      'imported-skill/SKILL.md': '# Imported\n\nUse when testing import.\n',
      'imported-skill/notes/readme.txt': 'extra file\n',
    })

    expect(api.skills.importArchive({ name: 'skill.zip', raw: archive })).toEqual({ imported: 'imported-skill' })
    expect(readFileSync(join(root, 'skills', 'imported-skill', 'SKILL.md'), 'utf8')).toContain('Imported')

    await api.close()
  })

  it('manages desktop pet preference and reports missing dependency', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-core-api-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    const enabled = await api.desktopPet.setEnabled(true)
    expect(enabled).toMatchObject({ enabled: true, running: false })
    expect(String(enabled.lastError)).toContain('Electron dependency missing')
    expect((await api.desktopPet.get()).enabled).toBe(true)

    const disabled = await api.desktopPet.setEnabled(false)
    expect(disabled).toMatchObject({ enabled: false, running: false, lastError: null })

    await api.close()
  })
})

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function resolveMethod(api: CoreApi, key: string): unknown {
  let current: unknown = api
  for (const part of key.split('.')) {
    current = current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
  }
  return current
}

class FakeProvider extends LLMProvider {
  calls: ChatArgs[] = []
  constructor() {
    super({ defaultModel: 'fake-main' })
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    return response('pong')
  }
}

function fakeRouter(provider: FakeProvider): { route: (useCase: string, agentType?: string | null, task?: string | null) => ModelRoute; payload: () => Record<string, unknown> } {
  return {
    route: (useCase: string, _agentType?: string | null, _task?: string | null) => ({
      snapshot: snapshot(provider, useCase === 'main_agent' ? 'main' : 'secondary'),
      fallback: null,
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    payload: () => ({ mainModel: 'fake-main', secondaryModel: 'fake-secondary' }),
  }
}

function snapshot(provider: FakeProvider, role: 'main' | 'secondary'): ProviderSnapshot {
  return {
    provider,
    providerName: 'fake',
    providerLabel: 'Fake',
    model: role === 'main' ? 'fake-main' : 'fake-secondary',
    apiBase: null,
    generation: { maxTokens: 2000, temperature: 0.1, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: true,
    entryName: 'fake',
    entryLabel: 'Fake',
    modelRole: role,
    routeReason: `${role}_model`,
  }
}

function response(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input: 1, output: 1 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

function makeStoredZip(files: Record<string, string>): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    localParts.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const centralStart = offset
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return new Uint8Array(Buffer.concat([...localParts, central, eocd]))
}
