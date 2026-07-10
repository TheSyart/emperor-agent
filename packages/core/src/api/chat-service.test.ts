import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import {
  SCHEDULER_TARGET_SESSION_METADATA_KEY,
  SchedulerPayload,
  SchedulerSchedule,
} from '../scheduler/models'
import { CoreApi } from './core-api'
import { MainlineTurnService } from './chat-service'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

describe('MainlineTurnService (MIG-IPC-005)', () => {
  it('submits chat turns through AgentLoop and returns durable turn metadata', async () => {
    const root = tmp('emperor-mainline-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const events: Array<Record<string, unknown>> = []
    const session = api.sessions.create({ title: 'Mainline' })

    const result = await api.mainline.submit({
      content: 'ping',
      displayContent: 'Ping display',
      clientMessageId: 'client-1',
      turnId: 'turn_main_1',
      source: 'chat',
      sessionId: String(session.id),
      emit: async (event) => {
        events.push(event)
      },
    })

    expect(result).toMatchObject({
      turnId: 'turn_main_1',
      content: 'pong',
      activeSessionId: api.loop.activeSessionId,
    })
    expect(events.map((event) => event.event)).toContain('user_message')
    expect(events.map((event) => event.event)).toContain('assistant_done')
    expect(
      api.loop.activeMemoryStore.loadUnarchivedHistory().map((row) => row.role),
    ).toEqual(['user', 'assistant'])
    expect(
      JSON.stringify(api.loop.activeMemoryStore.loadUnarchivedHistory()),
    ).toContain('Ping display')
    expect(
      existsSync(
        join(
          root,
          '.emperor',
          'sessions',
          api.loop.activeSessionId!,
          'history.jsonl',
        ),
      ),
    ).toBe(true)

    await api.close()
  })

  it('backs CoreApi chat.submit with the same mainline service', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-mainline-'),
      stateRoot: tmp('emperor-mainline-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const session = api.sessions.create({ title: 'Chat' })

    expect(api.mainline).toBeInstanceOf(MainlineTurnService)
    await expect(
      api.chat.submit({
        content: 'hello',
        turnId: 'turn_chat_1',
        sessionId: String(session.id),
      }),
    ).resolves.toMatchObject({ turnId: 'turn_chat_1', content: 'pong' })

    await api.close()
  })

  it('delivers attachment content and requested skill metadata through the turn', async () => {
    const root = tmp('emperor-mainline-attachments-')
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Attachments' })
    const skillDir = join(root, '.emperor', 'skills', 'reviewer')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# Reviewer Skill\n\nGeneral review helper.\n\nREQUESTED_SKILL_CONTEXT_MARKER',
      'utf8',
    )
    const attachment = api.attachments.save({
      raw: Buffer.from('attachment evidence', 'utf8'),
      name: 'evidence.txt',
      mime: 'text/plain',
    })
    const events: Array<Record<string, unknown>> = []

    await api.chat.submit({
      content: 'inspect',
      displayContent: 'inspect @skill(reviewer)',
      attachments: [attachment.id],
      requestedSkills: [{ name: 'reviewer', source: 'slash' }],
      turnId: 'turn_attachment_1',
      sessionId: String(session.id),
      emit: async (event) => {
        events.push(event)
      },
    })

    const userMessage = provider.calls[0]?.messages.find(
      (message) => message.role === 'user',
    )
    expect(String(userMessage?.content)).toContain('attachment evidence')
    expect(JSON.stringify(provider.calls[0]?.messages)).toContain(
      'REQUESTED_SKILL_CONTEXT_MARKER',
    )
    const history = api.loop.activeMemoryStore.loadUnarchivedHistory()
    expect(history.find((row) => row.role === 'user')).toMatchObject({
      attachments: [expect.objectContaining({ id: attachment.id })],
      requestedSkills: [{ name: 'reviewer', source: 'slash' }],
    })
    expect(
      events.find((event) => event.event === 'user_message'),
    ).toMatchObject({
      attachments: [expect.objectContaining({ id: attachment.id })],
      requested_skills: [{ name: 'reviewer', source: 'slash' }],
    })

    await api.close()
  })

  it('rejects an unavailable explicitly requested skill before model execution', async () => {
    const provider = new FakeProvider()
    const api = await CoreApi.create({
      root: tmp('emperor-mainline-missing-skill-'),
      stateRoot: tmp('emperor-mainline-missing-skill-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const session = api.sessions.create({ title: 'Missing Skill' })

    await expect(
      api.chat.submit({
        content: 'review',
        requestedSkills: [{ name: 'missing-skill', source: 'slash' }],
        sessionId: String(session.id),
      }),
    ).rejects.toMatchObject({
      code: 'requested_skill_unavailable',
      skillName: 'missing-skill',
    })
    expect(provider.calls).toHaveLength(0)

    await api.close()
  })

  it('rejects chat submits without a real known session id before writing history', async () => {
    const root = tmp('emperor-mainline-session-boundary-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const activeSessionId = String(api.loop.activeSessionId)

    await expect(
      api.chat.submit({ content: 'missing session' }),
    ).rejects.toThrow(/session/i)
    await expect(
      api.chat.submit({ content: 'unknown session', sessionId: 'not-real' }),
    ).rejects.toThrow(/unknown|session/i)
    // P1-6 起 draft 提交不再被拒，而是晋升为真实 session（见 core-api.test 的 draft submit 用例）

    const historyPath = join(
      root,
      '.emperor',
      'sessions',
      activeSessionId,
      'history.jsonl',
    )
    expect(
      existsSync(historyPath) ? readFileSync(historyPath, 'utf8').trim() : '',
    ).toBe('')

    await api.close()
  })

  it('writes the first build-session chat turn to the build session history only', async () => {
    const root = tmp('emperor-mainline-build-session-')
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const defaultSessionId = String(api.loop.activeSessionId)
    const projectPath = join(root, 'project')
    mkdirSync(projectPath, { recursive: true })
    const build = api.sessions.create({
      title: 'Build Project',
      mode: 'build',
      project_path: projectPath,
    })
    api.control.setMode('auto')

    await api.chat.submit({
      content: 'ping',
      turnId: 'turn_build_1',
      sessionId: String(build.id),
    })

    const buildHistory = readFileSync(
      join(root, '.emperor', 'sessions', String(build.id), 'history.jsonl'),
      'utf8',
    )
    expect(buildHistory).toContain('ping')
    const defaultHistory = join(
      root,
      '.emperor',
      'sessions',
      defaultSessionId,
      'history.jsonl',
    )
    expect(
      existsSync(defaultHistory)
        ? readFileSync(defaultHistory, 'utf8').trim()
        : '',
    ).toBe('')
    expect(api.loop.sessionStore.get(String(build.id))).toMatchObject({
      mode: 'build',
      project_path: projectPath,
      project_name: 'project',
    })

    await api.close()
  })

  it('rejects a second concurrent mainline turn before switching sessions', async () => {
    const root = tmp('emperor-mainline-concurrent-turn-')
    const provider = new BlockingProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const first = api.sessions.create({ title: 'First' })
    const second = api.sessions.create({ title: 'Second' })

    const running = api.chat.submit({
      content: 'first',
      turnId: 'turn_busy_1',
      sessionId: String(first.id),
    })
    await provider.started

    await expect(
      api.chat.submit({
        content: 'second',
        turnId: 'turn_busy_2',
        sessionId: String(second.id),
      }),
    ).rejects.toMatchObject({ name: 'TurnBusyError' })
    expect(api.loop.activeSessionId).toBe(String(first.id))

    provider.finish(response('first done'))
    await expect(running).resolves.toMatchObject({ content: 'first done' })

    const secondHistoryPath = join(
      root,
      '.emperor',
      'sessions',
      String(second.id),
      'history.jsonl',
    )
    expect(
      existsSync(secondHistoryPath)
        ? readFileSync(secondHistoryPath, 'utf8')
        : '',
    ).not.toContain('second')

    await api.close()
  })

  it('routes scheduler agent_turn jobs through MainlineTurnService', async () => {
    const api = await CoreApi.create({
      root: tmp('emperor-mainline-'),
      stateRoot: tmp('emperor-mainline-state-'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const submitSchedulerTurn = vi.spyOn(api.mainline, 'submitSchedulerTurn')
    const originalSessionId = api.loop.activeSessionId!
    const target = api.sessions.create({ title: 'Scheduler target' })
    const job = api.loop.schedulerService.addJob({
      name: 'daily summary',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({
        kind: 'agent_turn',
        message: 'summarize today',
        deliver: false,
        meta: { [SCHEDULER_TARGET_SESSION_METADATA_KEY]: String(target.id) },
      }),
    })

    await expect(
      api.loop.schedulerService.runJob(job.id, { force: true }),
    ).resolves.toBe(true)

    expect(submitSchedulerTurn).toHaveBeenCalledOnce()
    expect(api.loop.activeSessionId).toBe(originalSessionId)
    api.loop.activateSession(String(target.id))
    const history = JSON.stringify(
      api.loop.activeMemoryStore.loadUnarchivedHistory(),
    )
    expect(history).toContain('[SCHEDULER_TRIGGER]')
    expect(history).toContain('定时任务触发 · daily summary')

    await api.close()
  })
})

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
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

class BlockingProvider extends LLMProvider {
  calls: ChatArgs[] = []
  private startedResolve: () => void = () => {}
  private finishResolve: (response: LLMResponse) => void = () => {}
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length > 1) return response('unexpected second turn')
    this.startedResolve()
    return new Promise<LLMResponse>((resolve) => {
      this.finishResolve = resolve
    })
  }

  finish(response: LLMResponse): void {
    this.finishResolve(response)
  }
}

function fakeRouter(provider: LLMProvider): {
  route: (
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ) => ModelRoute
  payload: () => Record<string, unknown>
} {
  return {
    route: (
      useCase: string,
      _agentType?: string | null,
      _task?: string | null,
    ) => ({
      snapshot: snapshot(
        provider,
        useCase === 'main_agent' ? 'main' : 'secondary',
      ),
      fallback: null,
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    payload: () => ({
      mainModel: 'fake-main',
      secondaryModel: 'fake-secondary',
    }),
  }
}

function snapshot(
  provider: LLMProvider,
  role: 'main' | 'secondary',
): ProviderSnapshot {
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
