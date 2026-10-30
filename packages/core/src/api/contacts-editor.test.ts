// GRP-04: what the contact editor asks Core for — a recommended avatar, a
// draft from a brief, an imported agent file, the compiled prompt of an
// unsaved draft, and a trial run of it in a hidden session (result, cost,
// stop, 24-hour cleanup). End to end on a CoreApi with a scripted model.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { libraryAvatarTheme } from '../contacts/avatars'
import { TRIAL_RETENTION_MS } from '../contacts/trials'
import { toolPresetTable } from '../contacts/runtime'
import type { ContactInput } from '../contacts/types'
import { replyChunks, type ScriptedReply } from '../harness/testing'
import { calculateUsageCost, nanosToUsd } from '../model/execution-policy'
import type { GenerateOptions } from '../llm/types'
import {
  CoreOperationArgumentsError,
  coreOperationKeys,
  invokeCoreOperation,
} from './operations'
import { makeApi, tmp, waitFor, type ApiFixture } from './test-helpers'

const PRICING = {
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 8,
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 0,
}

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

/** A Core whose model entry `test-route` has a price, so trials cost something. */
async function setup(replies: ScriptedReply[] = []): Promise<ApiFixture> {
  const root = tmp('emperor-contacts-editor-')
  const stateRoot = join(root, 'home')
  mkdirSync(stateRoot, { recursive: true })
  writeFileSync(
    join(stateRoot, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'test-route',
      models: [
        {
          entryId: 'test-route',
          provider: 'deepseek',
          protocol: 'openai',
          modelId: 'test-model',
          displayName: 'Test',
          apiBase: 'https://api.deepseek.com',
          apiKey: null,
          contextWindowTokens: 100000,
          maxTokens: 4096,
          pricing: PRICING,
        },
      ],
    }),
  )
  const fixture = await makeApi({ root, stateRoot, replies })
  fixtures.push(fixture)
  return fixture
}

const DRAFT = {
  name: '安全审计',
  intro: '找出代码里的安全漏洞',
  domains: ['engineering', 'security'],
  role: {
    mission: '审查改动中的安全问题。',
    deliverable: '问题清单：位置 · 问题 · 修法。',
    playbook: '1. 弄清信任边界\n2. 沿数据流追',
    boundaries: '不改代码。',
    knowledge: [],
  },
  capabilities: {
    model: 'inherit',
    tools: { preset: 'read_only' },
    permission: 'read_only',
  },
} satisfies ContactInput

function toolNames(request: GenerateOptions | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name)
}

describe('the editor operations', () => {
  it('registers the six of them', () => {
    const keys = coreOperationKeys()
    for (const key of [
      'contacts.capabilities.resolve',
      'contacts.draftFromBrief',
      'contacts.importAgentFile',
      'contacts.preview',
      'contacts.recommendAvatar',
      'contacts.stopTrial',
      'contacts.trial',
    ])
      expect(keys).toContain(key)
  })

  it('checks their arguments', async () => {
    const { api } = await setup()
    for (const [key, args] of [
      ['contacts.recommendAvatar', [{ templateId: '../x' }]],
      ['contacts.draftFromBrief', [{ brief: 'x'.repeat(5000) }]],
      [
        'contacts.draftFromBrief',
        [
          {
            brief: 'x',
            answers: [1, 2, 3, 4].map(() => ({ question: 'q', answer: 'a' })),
          },
        ],
      ],
      ['contacts.importAgentFile', [{ path: '' }]],
      ['contacts.trial', [{ draft: DRAFT, task: 'hi', trialId: 'bad id' }]],
      ['contacts.stopTrial', [{ trialId: 'x' }]],
    ] as const)
      await expect(
        invokeCoreOperation(api, key, args),
        key,
      ).rejects.toBeInstanceOf(CoreOperationArgumentsError)
  })
})

describe('contacts.recommendAvatar', () => {
  it('recommends from the template’s theme, skipping what others use', async () => {
    const { api } = await setup()
    const engineering = Array.from({ length: 18 }, (_, i) =>
      i < 9 ? `AV-01-${i + 1}` : `AV-02-${i - 8}`,
    )
    // Seventeen of the eighteen engineering heads are taken.
    for (const [i, id] of engineering.slice(0, 17).entries())
      await api.contacts.create({
        name: `工程 ${i}`,
        avatar: { kind: 'library', id },
      })
    for (let i = 0; i < 5; i++)
      expect(
        await invokeCoreOperation(api, 'contacts.recommendAvatar', [
          { templateId: 'security-auditor' },
        ]),
      ).toEqual({ id: engineering[17], theme: 'engineering' })
    // 换一个 with the only free one on screen: a repeat, never that one.
    const next = await invokeCoreOperation(api, 'contacts.recommendAvatar', [
      { templateId: 'security-auditor', exclude: [engineering[17]!] },
    ])
    expect(next.id).not.toBe(engineering[17])
    expect(libraryAvatarTheme(next.id)).toBe('engineering')
  })

  it('recommends a person, an animal or a robot for a blank contact', async () => {
    const { api } = await setup()
    const pick = await invokeCoreOperation(api, 'contacts.recommendAvatar', [
      {},
    ])
    expect(['people', 'animals', 'robots']).toContain(pick.theme)
  })
})

describe('contacts.importAgentFile', () => {
  it('reads the picked file into a draft, saving nothing', async () => {
    const { api, root } = await setup()
    const path = join(root, 'reviewer.md')
    writeFileSync(
      path,
      '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep, Glob, NotebookEdit\nmodel: opus\n---\n1. 读改动\n2. 列问题\n',
    )
    const before = (await api.contacts.list()).contacts.length
    const result = await invokeCoreOperation(api, 'contacts.importAgentFile', [
      { path },
    ])
    expect(result.draft).toMatchObject({
      name: 'reviewer',
      intro: 'Reviews code',
      role: { playbook: '1. 读改动\n2. 列问题' },
      capabilities: { tools: { preset: 'read_only' }, permission: 'read_only' },
    })
    expect(result.unknownTools).toEqual(['NotebookEdit'])
    expect(result.modelHint).toBe('opus')
    expect((await api.contacts.list()).contacts).toHaveLength(before)
  })
})

describe('contacts.draftFromBrief', () => {
  it('asks, then drafts after the answers, on the default model', async () => {
    const { api, adapter } = await setup([
      {
        tools: [
          {
            name: 'ask_questions',
            args: { questions: ['审什么代码？', '要不要改代码？'] },
          },
        ],
      },
      {
        tools: [
          {
            name: 'submit_role_card',
            args: {
              name: '审稿人',
              intro: '审 TypeScript 改动',
              domains: ['engineering'],
              mission: '审查改动。',
              deliverable: '问题清单。',
              playbook: '1. 读改动\n2. 列问题',
              boundaries: '不改代码。',
              tools: 'read_only',
              permission: 'read_only',
              speak: 'relevant',
            },
          },
        ],
      },
    ])
    const first = await invokeCoreOperation(api, 'contacts.draftFromBrief', [
      { brief: '帮我找个审稿人' },
    ])
    expect(first).toMatchObject({
      kind: 'questions',
      questions: ['审什么代码？', '要不要改代码？'],
    })
    const second = await invokeCoreOperation(api, 'contacts.draftFromBrief', [
      {
        brief: '帮我找个审稿人',
        answers: [
          { question: '审什么代码？', answer: 'TypeScript' },
          { question: '要不要改代码？', answer: '不要' },
        ],
      },
    ])
    expect(second).toMatchObject({
      kind: 'draft',
      draft: { name: '审稿人' },
    })
    expect(adapter.requests.map((request) => request.purpose)).toEqual([
      'auxiliary',
      'auxiliary',
    ])
    // Priced and in the ledger, like every other model call.
    expect(second.costUsd).toBeGreaterThan(0)
    const stats = api.memory.tokens({ sessionId: null }) as {
      recentCalls: Array<Record<string, unknown>>
    }
    expect(
      stats.recentCalls.filter((call) => call.usage_type === 'contact_draft'),
    ).toHaveLength(2)
  })
})

describe('contacts.capabilities.resolve (CP-02)', () => {
  it('says which selected Skills and MCP tools are usable here', async () => {
    const { api } = await setup()
    const view = await invokeCoreOperation(
      api,
      'contacts.capabilities.resolve',
      [
        {
          draft: {
            ...DRAFT,
            skills: [
              { id: 'sk-one123', sourceId: 'user', name: 'ghost-skill' },
            ],
            mcp: [{ serverId: 'github', toolNames: ['search'] }],
          },
        },
      ],
    )
    expect(view.tools).toContain('read')
    expect(view.tools).not.toContain('mcp_github_search')
    expect(view.skills).toEqual([
      {
        id: 'sk-one123',
        sourceId: 'user',
        name: 'ghost-skill',
        available: false,
        reason: '安装里没有这个 Skill',
      },
    ])
    expect(view.mcp[0]).toMatchObject({
      serverId: 'github',
      available: false,
      tools: [{ name: 'search', available: false }],
    })
    expect(view.mcp[0]!.reason).toContain('没有连上')
  })
})

describe('contacts.preview', () => {
  it('compiles an unsaved draft as it would run, with its tools', async () => {
    const { api } = await setup()
    const preview = await invokeCoreOperation(api, 'contacts.preview', [
      { draft: DRAFT },
    ])
    expect(preview.prompt).toMatch(/^# 身份/)
    expect(preview.prompt).toContain('你是「安全审计」')
    expect(preview.prompt).toContain('1. 弄清信任边界')
    expect(preview.chars).toBe(Array.from(preview.prompt).length)
    const table = toolPresetTable(api.host.registeredToolNames())
    expect(preview.tools).toEqual(table.read_only)
    expect(preview.presets).toEqual(table)
  })

  it('names a nameless draft 新联系人 and keeps a knowledge file that is gone', async () => {
    const { api, root } = await setup()
    const preview = await invokeCoreOperation(api, 'contacts.preview', [
      {
        draft: {
          ...DRAFT,
          name: '',
          role: {
            ...DRAFT.role,
            knowledge: [{ kind: 'file', path: join(root, 'gone.md') }],
          },
        },
      },
    ])
    expect(preview.prompt).toContain('你是「新联系人」')
    expect(preview.prompt).toContain('已不存在')
  })

  it('shows Emperor its persona', async () => {
    const { api } = await setup()
    const preview = await invokeCoreOperation(api, 'contacts.preview', [
      { draft: { id: 'ct-emperor', name: 'Emperor' } },
    ])
    expect(preview.prompt).toMatch(/Emperor/)
    expect(preview.tools).toBeNull()
  })
})

describe('contacts.trial (card tests: 试用台)', () => {
  it('runs the unsaved draft once and returns its answer and cost', async () => {
    const usage = { inputTokens: 1200, outputTokens: 300 }
    const { api, adapter } = await setup([
      () => replyChunks({ text: '高 · a.ts:12 拼接 SQL', usage }),
    ])
    const before = await api.contacts.list()
    const result = await invokeCoreOperation(api, 'contacts.trial', [
      { draft: DRAFT, task: '审查这段代码', trialId: 'tr-abc123' },
    ])
    expect(result).toMatchObject({
      trialId: 'tr-abc123',
      status: 'completed',
      text: '高 · a.ts:12 拼接 SQL',
      usage: { inputTokens: 1200, outputTokens: 300 },
    })
    expect(result.costUsd).toBeCloseTo(
      nanosToUsd(
        calculateUsageCost(
          { input: 1200, output: 300, cache_read: 0, cache_create: 0 },
          PRICING,
        ).costUsdNanos!,
      ),
    )
    // It ran as the draft: its role card and only its tools.
    const request = adapter.requests.at(-1)!
    expect(request.system).toContain('你是「安全审计」')
    expect(toolNames(request)).toEqual(
      toolPresetTable(api.host.registeredToolNames()).read_only,
    )
    // Nothing was saved.
    expect(await api.contacts.list()).toEqual(before)
  })

  it('never shows its session in a list, a search or the event stream', async () => {
    const { api, events } = await setup([{ text: '没有发现问题' }])
    const result = await invokeCoreOperation(api, 'contacts.trial', [
      { draft: DRAFT, task: '审查', trialId: 'tr-hidden1' },
    ])
    const trial = api.host.kept.sessionStore
      .list({ includeArchived: true })
      .find((session) => session.surface === 'trial')!
    expect(trial).toBeDefined()
    expect(result.status).toBe('completed')
    expect(
      api.sessions.list({ includeArchived: true }).map((session) => session.id),
    ).not.toContain(trial.id)
    expect((await api.sessions.search({ query: '没有发现问题' })).hits).toEqual(
      [],
    )
    expect(events.filter((event) => event.session_id === trial.id)).toEqual([])
  })

  it('runs an edit of a saved contact without touching the saved one', async () => {
    const { api, adapter } = await setup([{ text: 'ok' }, { text: 'ok' }])
    const saved = await api.contacts.create({ ...DRAFT, name: '审稿人' })
    await invokeCoreOperation(api, 'contacts.trial', [
      {
        draft: {
          ...DRAFT,
          id: saved.id,
          name: '审稿人',
          role: { ...DRAFT.role, mission: '只看 SQL 注入。' },
          capabilities: { ...DRAFT.capabilities, tools: { preset: 'writer' } },
        },
        task: '审查',
        trialId: 'tr-edit01',
      },
    ])
    expect(adapter.requests.at(-1)!.system).toContain('只看 SQL 注入。')
    expect(toolNames(adapter.requests.at(-1))).toContain('write')
    // The saved contact's own sessions still run as saved.
    const single = api.host.kept.sessionStore.create('单聊', {
      surface: 'contact',
      contactId: saved.id,
    }).id
    await api.chat.submit({ content: 'hi', sessionId: single })
    expect(adapter.requests.at(-1)!.system).toContain('审查改动中的安全问题。')
    expect(adapter.requests.at(-1)!.system).not.toContain('只看 SQL 注入。')
    expect(toolNames(adapter.requests.at(-1))).not.toContain('write')
    expect((await api.contacts.get({ id: saved.id })).version).toBe(1)
  })

  it('stops when asked (closing the editor stops it)', async () => {
    const { api } = await setup([{ hang: true }])
    const running = invokeCoreOperation(api, 'contacts.trial', [
      { draft: DRAFT, task: '审查', trialId: 'tr-stop01' },
    ])
    await waitFor(() =>
      api.host.kept.sessionStore
        .list({ includeArchived: true })
        .some((session) => session.surface === 'trial'),
    )
    // Give the turn a moment to reach the model.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      await invokeCoreOperation(api, 'contacts.stopTrial', [
        { trialId: 'tr-stop01' },
      ]),
    ).toEqual({ stopped: true })
    expect(await running).toMatchObject({ status: 'stopped' })
    expect(
      await invokeCoreOperation(api, 'contacts.stopTrial', [
        { trialId: 'tr-stop01' },
      ]),
    ).toEqual({ stopped: false })
  })

  it('reports a failed run with what went wrong', async () => {
    const { api } = await setup([{ error: 'boom', code: 'AUTH' }])
    const result = await invokeCoreOperation(api, 'contacts.trial', [
      { draft: DRAFT, task: '审查', trialId: 'tr-fail01' },
    ])
    expect(result.status).toBe('failed')
    expect(result.text.length).toBeGreaterThan(0)
  })

  it('refuses a draft above the global permission or with unknown tools', async () => {
    const { api } = await setup()
    await api.sessions.setDefaults(
      { permission: 'read-only' },
      { sessionId: null },
    )
    await expect(
      invokeCoreOperation(api, 'contacts.trial', [
        {
          draft: {
            ...DRAFT,
            capabilities: {
              ...DRAFT.capabilities,
              permission: 'workspace_write',
            },
          },
          task: '审查',
          trialId: 'tr-perm01',
        },
      ]),
    ).rejects.toMatchObject({ code: 'contact_invalid' })
    await expect(
      invokeCoreOperation(api, 'contacts.trial', [
        {
          draft: {
            ...DRAFT,
            capabilities: {
              ...DRAFT.capabilities,
              tools: { preset: 'custom', allow: ['no_such_tool'] },
            },
          },
          task: '审查',
          trialId: 'tr-tool01',
        },
      ]),
    ).rejects.toMatchObject({ code: 'contact_invalid' })
  })

  it('clears trial sessions after 24 hours', async () => {
    const { api } = await setup([{ text: 'ok' }])
    // The store always keeps one session; a trial is never the one kept.
    api.sessions.create({ title: 'Chat' })
    await invokeCoreOperation(api, 'contacts.trial', [
      { draft: DRAFT, task: '审查', trialId: 'tr-purge1' },
    ])
    const trials = () =>
      api.host.kept.sessionStore
        .list({ includeArchived: true })
        .filter((session) => session.surface === 'trial')
    expect(trials()).toHaveLength(1)
    const dir = api.host.kept.sessionStore.sessionDir(trials()[0]!.id)
    expect(await api.contactTrials.purgeExpired(Date.now())).toEqual([])
    expect(trials()).toHaveLength(1)
    const purged = await api.contactTrials.purgeExpired(
      Date.now() + TRIAL_RETENTION_MS + 1000,
    )
    expect(purged).toHaveLength(1)
    expect(trials()).toHaveLength(0)
    expect(api.sessions.listDeleted().map((entry) => entry.id)).not.toContain(
      purged[0],
    )
    const { existsSync } = await import('node:fs')
    expect(existsSync(dir)).toBe(false)
  })
})
