// GRP-04: 「说说你要什么人」 — one structured call to the default model that
// either asks at most three questions or returns a role card draft. Tests run
// on a scripted model; nothing goes online.
import { describe, expect, it, vi } from 'vitest'
import { LlmClient } from '../llm/client'
import type { GenerateOptions } from '../llm/types'
import {
  replyChunks,
  ScriptedAdapter,
  testRoute,
  type ScriptedReply,
} from '../harness/testing'
import { messageText } from '../llm/message'
import { draftFromBrief, type BriefDraftDeps } from './draft'

function client(replies: ScriptedReply[]): {
  llm: LlmClient
  adapter: ScriptedAdapter
} {
  const adapter = new ScriptedAdapter(replies)
  const llm = new LlmClient({ adapterFor: () => adapter })
  llm.setRoutes([testRoute()], 'test-route')
  return { llm, adapter }
}

const CARD = {
  name: '安全审计',
  intro: '找出代码里的安全漏洞，给出证据和修法',
  domains: ['engineering', 'security'],
  mission: '审查改动中的安全问题。',
  deliverable: '按严重程度排序的问题清单。',
  playbook: '1. 弄清信任边界\n2. 沿数据流追\n3. 查密钥',
  boundaries: '不改代码。',
  trial_task: '审查这段拼接 SQL 的代码。',
  tools: 'read_only',
  permission: 'read_only',
  speak: 'relevant',
}

function deps(
  llm: LlmClient,
  extra: Partial<BriefDraftDeps> = {},
): BriefDraftDeps {
  return { llm, globalPermission: () => 'workspace-write', ...extra }
}

function toolNames(request: GenerateOptions | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name)
}

function userText(request: GenerateOptions | undefined): string {
  return (
    request?.messages.map((message) => messageText(message)).join('\n') ?? ''
  )
}

describe('draftFromBrief (card test: 起草追问)', () => {
  it('returns a draft when the model submits a role card', async () => {
    const { llm, adapter } = client([
      { tools: [{ name: 'submit_role_card', args: CARD }] },
    ])
    const result = await draftFromBrief(
      { brief: '我要一个看安全问题的审稿人' },
      deps(llm),
    )
    expect(result.kind).toBe('draft')
    if (result.kind !== 'draft') return
    expect(result.draft).toEqual({
      name: '安全审计',
      intro: '找出代码里的安全漏洞，给出证据和修法',
      domains: ['engineering', 'security'],
      role: {
        mission: '审查改动中的安全问题。',
        deliverable: '按严重程度排序的问题清单。',
        playbook: '1. 弄清信任边界\n2. 沿数据流追\n3. 查密钥',
        boundaries: '不改代码。',
        trialTask: '审查这段拼接 SQL 的代码。',
      },
      tools: 'read_only',
      permission: 'read_only',
      speak: 'relevant',
    })
    expect(result.sections).toEqual([
      'identity',
      'mission',
      'playbook',
      'boundaries',
      'capabilities',
      'groupHabit',
    ])
    const request = adapter.requests[0]!
    // One auxiliary call on the default model, outside any session.
    expect(request).toMatchObject({
      provider: 'test-route',
      model: 'test-model',
      purpose: 'auxiliary',
    })
    expect(request.sessionId).toBeUndefined()
    expect(toolNames(request)).toEqual(['ask_questions', 'submit_role_card'])
    expect(userText(request)).toContain('我要一个看安全问题的审稿人')
    expect(request.system).toMatch(/最多问 3 个问题/)
  })

  it('asks at most three questions', async () => {
    const { llm } = client([
      {
        tools: [
          {
            name: 'ask_questions',
            args: {
              questions: [
                '审什么语言？',
                ' ',
                '审什么语言？',
                '要不要改代码？',
                '多久交？',
                '第五个？',
              ],
            },
          },
        ],
      },
    ])
    const result = await draftFromBrief({ brief: '帮我找个审稿人' }, deps(llm))
    expect(result).toMatchObject({
      kind: 'questions',
      questions: ['审什么语言？', '要不要改代码？', '多久交？'],
    })
  })

  it('offers only the role card once the answers are in, and sends them', async () => {
    const { llm, adapter } = client([
      { tools: [{ name: 'submit_role_card', args: CARD }] },
    ])
    const result = await draftFromBrief(
      {
        brief: '帮我找个审稿人',
        answers: [{ question: '审什么语言？', answer: 'TypeScript' }],
      },
      deps(llm),
    )
    expect(result.kind).toBe('draft')
    const request = adapter.requests[0]!
    expect(toolNames(request)).toEqual(['submit_role_card'])
    expect(userText(request)).toContain('审什么语言？')
    expect(userText(request)).toContain('TypeScript')
  })

  it('fails when the model asks again after the answers', async () => {
    const { llm } = client([
      { tools: [{ name: 'ask_questions', args: { questions: ['还有呢？'] } }] },
    ])
    await expect(
      draftFromBrief(
        { brief: '审稿人', answers: [{ question: 'a', answer: 'b' }] },
        deps(llm),
      ),
    ).rejects.toMatchObject({ code: 'contact_draft_failed' })
  })

  it('reads a JSON answer written as text', async () => {
    const { llm } = client([
      { text: `好的，草稿如下：\n\`\`\`json\n${JSON.stringify(CARD)}\n\`\`\`` },
    ])
    const result = await draftFromBrief({ brief: '审稿人' }, deps(llm))
    expect(result.kind).toBe('draft')
  })

  it('fails on an answer that is neither (起草失败)', async () => {
    const { llm } = client([{ text: '我不太明白你的意思。' }])
    await expect(
      draftFromBrief({ brief: '审稿人' }, deps(llm)),
    ).rejects.toMatchObject({
      code: 'contact_draft_failed',
      message: expect.stringMatching(/没能起草/),
    })
  })

  it('keeps the model’s card within the rules', async () => {
    const { llm } = client([
      {
        tools: [
          {
            name: 'submit_role_card',
            args: {
              ...CARD,
              name: '@审稿\n人'.padEnd(40, '长'),
              intro: '第一行\n第二行',
              domains: [
                'engineering',
                'cooking',
                'security',
                'data',
                'product',
              ],
              mission: '职'.repeat(2500),
              tools: 'everything',
              permission: 'workspace_write',
              speak: 'shout',
            },
          },
        ],
      },
    ])
    const result = await draftFromBrief(
      { brief: '审稿人' },
      deps(llm, { globalPermission: () => 'read-only' }),
    )
    if (result.kind !== 'draft') throw new Error('expected a draft')
    expect(result.draft.name).not.toMatch(/[@\n]/)
    expect(Array.from(result.draft.name).length).toBeLessThanOrEqual(24)
    expect(result.draft.intro).toBe('第一行')
    expect(result.draft.domains).toEqual(['engineering', 'security', 'data'])
    expect(Array.from(result.draft.role.mission)).toHaveLength(2000)
    expect(result.draft.tools).toBe('read_only')
    // Never above the global preset.
    expect(result.draft.permission).toBe('read_only')
    expect(result.draft.speak).toBe('relevant')
  })

  it('wants a brief', async () => {
    const { llm, adapter } = client([])
    await expect(
      draftFromBrief({ brief: '   ' }, deps(llm)),
    ).rejects.toMatchObject({ code: 'contact_invalid' })
    expect(adapter.requests).toHaveLength(0)
  })

  it('prices the call and records it', async () => {
    const { llm } = client([
      () =>
        replyChunks({
          tools: [{ name: 'submit_role_card', args: CARD }],
          usage: { inputTokens: 1000, outputTokens: 500 },
        }),
    ])
    const record = vi.fn()
    const result = await draftFromBrief(
      { brief: '审稿人' },
      deps(llm, {
        cost: (routeId, usage) =>
          routeId === 'test-route'
            ? usage.inputTokens * 1e-6 + usage.outputTokens * 2e-6
            : null,
        record,
      }),
    )
    expect(result.costUsd).toBeCloseTo(0.002)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: 'test-route',
        model: 'test-model',
        usage: { inputTokens: 1000, outputTokens: 500 },
        costUsd: expect.closeTo(0.002),
      }),
    )
  })

  it('turns a missing model into 「先配置模型」', async () => {
    const llm = new LlmClient({ adapterFor: () => new ScriptedAdapter([]) })
    await expect(
      draftFromBrief({ brief: '审稿人' }, deps(llm)),
    ).rejects.toMatchObject({ code: 'model_configuration_required' })
  })
})
