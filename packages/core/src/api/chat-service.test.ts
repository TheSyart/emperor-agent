import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { SchedulerPayload, SchedulerSchedule } from '../scheduler/models'
import { CoreApi } from './core-api'
import { MainlineTurnService } from './chat-service'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

describe('MainlineTurnService (MIG-IPC-005)', () => {
  it('submits chat turns through AgentLoop and returns durable turn metadata', async () => {
    const root = tmp('emperor-mainline-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    const events: Array<Record<string, unknown>> = []
    const session = api.sessions.create({ title: 'Mainline' })

    const result = await api.mainline.submit({
      content: 'ping',
      displayContent: 'Ping display',
      clientMessageId: 'client-1',
      turnId: 'turn_main_1',
      source: 'chat',
      sessionId: String(session.id),
      emit: async (event) => { events.push(event) },
    })

    expect(result).toMatchObject({ turnId: 'turn_main_1', content: 'pong', activeSessionId: api.loop.activeSessionId })
    expect(events.map((event) => event.event)).toContain('user_message')
    expect(events.map((event) => event.event)).toContain('assistant_done')
    expect(api.loop.activeMemoryStore.loadUnarchivedHistory().map((row) => row.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(api.loop.activeMemoryStore.loadUnarchivedHistory())).toContain('Ping display')
    expect(existsSync(join(root, 'sessions', api.loop.activeSessionId!, 'history.jsonl'))).toBe(true)

    await api.close()
  })

  it('backs CoreApi chat.submit with the same mainline service', async () => {
    const api = await CoreApi.create({ root: tmp('emperor-mainline-'), templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    const session = api.sessions.create({ title: 'Chat' })

    expect(api.mainline).toBeInstanceOf(MainlineTurnService)
    await expect(api.chat.submit({ content: 'hello', turnId: 'turn_chat_1', sessionId: String(session.id) })).resolves.toMatchObject({ turnId: 'turn_chat_1', content: 'pong' })

    await api.close()
  })

  it('rejects chat submits without a real known session id before writing history', async () => {
    const root = tmp('emperor-mainline-session-boundary-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    const activeSessionId = String(api.loop.activeSessionId)

    await expect(api.chat.submit({ content: 'missing session' })).rejects.toThrow(/session/i)
    await expect(api.chat.submit({ content: 'draft session', sessionId: 'draft:new-chat' })).rejects.toThrow(/draft/i)
    await expect(api.chat.submit({ content: 'unknown session', sessionId: 'not-real' })).rejects.toThrow(/unknown|session/i)

    const historyPath = join(root, 'sessions', activeSessionId, 'history.jsonl')
    expect(existsSync(historyPath) ? readFileSync(historyPath, 'utf8').trim() : '').toBe('')

    await api.close()
  })

  it('writes the first build-session chat turn to the build session history only', async () => {
    const root = tmp('emperor-mainline-build-session-')
    const api = await CoreApi.create({ root, templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    const defaultSessionId = String(api.loop.activeSessionId)
    const projectPath = join(root, 'project')
    mkdirSync(projectPath, { recursive: true })
    const build = api.sessions.create({ title: 'Build Project', mode: 'build', project_path: projectPath })
    api.control.setMode('auto')

    await api.chat.submit({ content: 'ping', turnId: 'turn_build_1', sessionId: String(build.id) })

    const buildHistory = readFileSync(join(root, 'sessions', String(build.id), 'history.jsonl'), 'utf8')
    expect(buildHistory).toContain('ping')
    const defaultHistory = join(root, 'sessions', defaultSessionId, 'history.jsonl')
    expect(existsSync(defaultHistory) ? readFileSync(defaultHistory, 'utf8').trim() : '').toBe('')
    expect(api.loop.sessionStore.get(String(build.id))).toMatchObject({
      mode: 'build',
      project_path: projectPath,
      project_name: 'project',
    })

    await api.close()
  })

  it('routes scheduler agent_turn jobs through MainlineTurnService', async () => {
    const api = await CoreApi.create({ root: tmp('emperor-mainline-'), templatesDir: TEMPLATES_DIR, modelRouter: fakeRouter(new FakeProvider()) })
    const submitSchedulerTurn = vi.spyOn(api.mainline, 'submitSchedulerTurn')
    const job = api.loop.schedulerService.addJob({
      name: 'daily summary',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ kind: 'agent_turn', message: 'summarize today', deliver: false }),
    })

    await expect(api.loop.schedulerService.runJob(job.id, { force: true })).resolves.toBe(true)

    expect(submitSchedulerTurn).toHaveBeenCalledOnce()
    const history = JSON.stringify(api.loop.activeMemoryStore.loadUnarchivedHistory())
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
