import { describe, expect, it } from 'vitest'
import type { CoordinatorRequest, CoordinatorResult } from './coordinator'
import {
  GroupScheduler,
  type SpeakRequest,
  type SpeakResult,
} from './scheduler'
import { memoryGroups } from './test-fixture'
import type { GroupMessage, GroupTask } from './types'

type Coordinate = (request: CoordinatorRequest) => CoordinatorResult

function room(
  opts: {
    members?: string[]
    settings?: Record<string, unknown>
    coordinate?: Coordinate
    script?: (request: SpeakRequest) => Partial<SpeakResult>
    hands?: Record<string, { raise: boolean; score: number }>
    shorten?: (text: string) => Promise<string>
  } = {},
) {
  const groups = memoryGroups()
  const speeches: SpeakRequest[] = []
  const coordinations: CoordinatorRequest[] = []
  const view = groups.service.create({
    title: '内置协调',
    members: opts.members ?? ['ct-emperor', 'ct-arch', 'ct-rev'],
    settings: {
      coordination: 'builtin',
      summarizeAtEnd: false,
      ...opts.settings,
    } as never,
  })
  const scheduler = new GroupScheduler({
    groups: groups.service,
    speak: async (request) => {
      speeches.push(request)
      return {
        text: `${request.member} 的回答`,
        outcome: 'completed',
        spend: { usd: 0, tokens: 0 },
        ...opts.script?.(request),
      }
    },
    poll: async ({ member }) => ({
      ...(opts.hands?.[member.id] ?? { raise: false, score: 0 }),
      reason: '',
    }),
    coordinate: async (request) => {
      coordinations.push(request)
      return (
        opts.coordinate?.(request) ?? {
          kind: 'answer',
          text: '请直接 @ 成员。',
        }
      )
    },
    review: async () => ({ verdict: 'approve' }),
    ...(opts.shorten
      ? { shorten: async ({ text }) => opts.shorten!(text) }
      : {}),
    digest: async () => '',
  })
  const send = async (input: Parameters<typeof groups.service.send>[1]) => {
    const { message, plan } = groups.service.send(view.id, input)
    await scheduler.start(view.id, message, plan)
    return message
  }
  const messages = () => groups.service.state(view.id).messages
  return { groups, view, scheduler, speeches, coordinations, send, messages }
}

function plannedTask(to: string, title: string): GroupTask {
  return {
    taskId: `gt-${title}`,
    to,
    title,
    deliverable: `${title}的结果`,
    access: 'readonly',
    state: 'queued',
    confirmed: false,
  }
}

describe('CG-00 · built-in group coordination', () => {
  it('new groups have one fixed Emperor and no separate coordinator session', () => {
    const r = room()
    expect(r.view.moderator).toBeNull()
    expect(r.view.settings.coordination).toBe('builtin')
    expect(r.view.members.map((member) => member.id)).toEqual([
      'ct-emperor',
      'ct-arch',
      'ct-rev',
    ])
    expect(r.groups.service.state(r.view.id).memberSessions.size).toBe(3)
    expect(
      [...r.groups.sessions.values()].filter(
        (session) => session.surface === 'group_member',
      ),
    ).toHaveLength(3)
  })

  it('CG-01: legacy moderated input uses autonomous fallback, not a visible member', async () => {
    const r = room({
      settings: { collaboration: 'moderated' },
      coordinate: () => ({
        kind: 'relay',
        speakers: ['ct-arch', 'ct-rev'],
        note: '先设计，再评审',
      }),
    })
    await r.send({ way: 'broadcast', text: '评估这个方案' })
    expect(r.coordinations.map((request) => request.reason)).toEqual([
      'fallback',
    ])
    expect(r.speeches.map((speech) => speech.member)).toEqual([
      'ct-arch',
      'ct-rev',
    ])
    const note = r
      .messages()
      .find((message) => message.text === '先设计，再评审')
    expect(note).toMatchObject({ from: 'ct-emperor', kind: 'say' })
  })

  it('queues valid independent answers as the existing blind batch', async () => {
    const r = room({
      settings: { collaboration: 'moderated' },
      coordinate: () => ({
        kind: 'independent',
        speakers: ['ct-arch', 'ct-rev'],
      }),
    })
    await r.send({ way: 'broadcast', text: '各自判断' })
    expect(r.speeches.map((speech) => speech.reason)).toEqual([
      'batch',
      'batch',
    ])
    expect(r.messages().filter((message) => message.batchId)).toHaveLength(2)
  })

  it('autonomous hand raising is unchanged', async () => {
    const r = room({
      hands: { 'ct-rev': { raise: true, score: 0.9 } },
    })
    await r.send({ way: 'broadcast', text: '谁看看' })
    expect(r.coordinations).toEqual([])
    expect(r.speeches.map((speech) => speech.member)).toEqual(['ct-rev'])
  })

  it('does not let Emperor form a second autonomous voice by raising a hand', async () => {
    const r = room({
      hands: { 'ct-emperor': { raise: true, score: 1 } },
      coordinate: () => ({ kind: 'answer', text: '请直接 @ 一位成员。' }),
    })
    await r.send({ way: 'broadcast', text: '谁看看' })
    expect(r.speeches).toEqual([])
    expect(r.coordinations.map((request) => request.reason)).toEqual([
      'fallback',
    ])
    expect(r.messages().at(-1)).toMatchObject({
      from: 'ct-emperor',
      kind: 'say',
      text: '请直接 @ 一位成员。',
    })
  })

  it('falls back once when nobody raises a hand', async () => {
    const r = room({
      coordinate: (request) => ({
        kind: 'relay',
        speakers: ['ct-arch'],
        note: request.reason,
      }),
    })
    await r.send({ way: 'broadcast', text: '有人吗' })
    expect(r.coordinations.map((request) => request.reason)).toEqual([
      'fallback',
    ])
    expect(r.speeches.map((speech) => speech.member)).toEqual(['ct-arch'])
  })

  it('executes only a simple sequential GroupTask plan', async () => {
    const r = room({
      settings: { collaboration: 'moderated' },
      coordinate: () => ({
        kind: 'tasks',
        tasks: [plannedTask('ct-arch', '一'), plannedTask('ct-rev', '二')],
      }),
    })
    await r.send({ way: 'broadcast', text: '分两步检查' })
    expect(r.speeches.map((speech) => [speech.member, speech.reason])).toEqual([
      ['ct-arch', 'task'],
      ['ct-rev', 'task'],
    ])
    expect(
      [...r.groups.service.state(r.view.id).tasks.values()].map(
        (task) => task.state,
      ),
    ).toEqual(['done', 'done'])
    expect(
      r
        .messages()
        .some(
          (message) =>
            message.kind === 'say' &&
            message.from === 'ct-emperor' &&
            message.text.includes('2 项任务'),
        ),
    ).toBe(true)
  })

  it('publishes a short summary instead of a long execution transcript', async () => {
    const original = '详细执行过程。'.repeat(200)
    const r = room({
      script: () => ({ text: original }),
      shorten: async (text) => {
        expect(text).toBe(original)
        return '结论：场地与交通已核实，报告见附件。'
      },
    })
    await r.send({ way: 'mention', text: '@架构师 核实后交付' })
    const speech = r.messages().at(-1)!
    expect(speech.text).toBe('结论：场地与交通已核实，报告见附件。')
    expect(speech.text).not.toContain('详细执行过程')
  })

  it('never falls back to publishing the raw long transcript when summarizing fails', async () => {
    const original = '内部推理与工具过程。'.repeat(200)
    const r = room({
      script: () => ({ text: original }),
      shorten: async () => {
        throw new Error('summary unavailable')
      },
    })
    await r.send({ way: 'mention', text: '@架构师 开始' })
    expect(r.messages().at(-1)!.text).toBe('完整内容已保留在右侧执行详情。')
    expect(r.messages().at(-1)!.text).not.toContain('内部推理')
  })

  it('routes clarify through Emperor’s controlled question turn, not plain text', async () => {
    const r = room({
      settings: { collaboration: 'moderated' },
      coordinate: () => ({ kind: 'clarify', text: '你指哪一个方案？' }),
    })
    await r.send({ way: 'broadcast', text: '看看方案' })
    expect(r.speeches).toHaveLength(1)
    expect(r.speeches[0]).toMatchObject({
      member: 'ct-emperor',
      reason: 'clarify',
    })
    expect(r.speeches[0]!.prompt).toContain('ask_user_question')
    expect(r.speeches[0]!.prompt).toContain('你指哪一个方案？')
    expect(
      r.messages().some((message) => message.text === '你指哪一个方案？'),
    ).toBe(false)
  })

  it('applies the same short-public-message boundary to coordination text', async () => {
    const original = '协调过程与细节。'.repeat(200)
    const r = room({
      settings: { collaboration: 'moderated' },
      coordinate: () => ({ kind: 'answer', text: original }),
      shorten: async () => '请先直接 @ 一位成员。',
    })
    await r.send({ way: 'broadcast', text: '开始' })
    expect(r.messages().at(-1)).toMatchObject({
      from: 'ct-emperor',
      text: '请先直接 @ 一位成员。',
    })
    expect(r.messages().at(-1)!.text).not.toContain('协调过程与细节')
  })

  it('rejects an invalid speaker without running the valid subset', async () => {
    const r = room({
      settings: { collaboration: 'moderated' },
      coordinate: () => ({ kind: 'relay', speakers: ['ct-arch', 'ct-ghost'] }),
    })
    await r.send({ way: 'broadcast', text: '开始' })
    expect(r.speeches).toEqual([])
    expect(r.messages().at(-1)).toMatchObject({
      from: 'system',
      kind: 'system',
    })
    expect(r.messages().at(-1)!.text).toMatch(/自动协调/)
  })

  it('direct @ and stop never call a failing coordinator', async () => {
    const r = room({
      settings: { summarizeAtEnd: true },
      coordinate: () => {
        throw new Error('model unavailable')
      },
    })
    await r.send({ way: 'mention', text: '@架构师 直接回答' })
    expect(r.speeches.map((speech) => speech.member)).toEqual(['ct-arch'])
    expect(r.coordinations).toEqual([])
    expect(r.scheduler.stop(r.view.id)).toBe(false)
  })

  it('quiet mode without @ stays inert', async () => {
    const r = room({ settings: { quiet: true } })
    await r.send({ way: 'broadcast', text: '大家好' })
    expect(r.coordinations).toEqual([])
    expect(r.speeches).toEqual([])
  })

  it('writes the conclusion as a short Emperor message, not a dashboard card', async () => {
    const r = room({
      settings: { summarizeAtEnd: true },
      hands: { 'ct-arch': { raise: true, score: 1 } },
      coordinate: (request) =>
        request.reason === 'summary'
          ? { kind: 'close', text: '结论：按这个方案推进。' }
          : { kind: 'answer', text: '不需要安排。' },
    })
    await r.send({ way: 'broadcast', text: '看看方案' })
    const conclusion = r.messages().at(-1)!
    expect(conclusion).toMatchObject({
      from: 'ct-emperor',
      kind: 'say',
      text: '结论：按这个方案推进。',
    })
    expect(conclusion.coordination).toBeUndefined()
    expect(r.messages().some((message) => message.kind === 'summary')).toBe(
      false,
    )
  })

  it('CG-01: legacy moderated member mentions go directly without review', async () => {
    const r = room({
      settings: { collaboration: 'moderated' },
      script: (request) =>
        request.member === 'ct-arch' ? { text: '@审稿人 接着看' } : {},
    })
    await r.send({ way: 'mention', text: '@架构师 先看' })
    expect(r.speeches.map((speech) => speech.member)).toEqual([
      'ct-arch',
      'ct-rev',
    ])
    expect(r.coordinations).toEqual([])
  })

  it('coordinator-issued external write tasks still require user confirmation', async () => {
    const r = room({
      members: ['ct-arch', 'ct-codex'],
      settings: { collaboration: 'moderated' },
      coordinate: () => ({
        kind: 'tasks',
        tasks: [
          {
            ...plannedTask('ct-codex', '修改'),
            access: 'isolated_worktree',
            confirmed: false,
          },
        ],
      }),
    })
    await r.send({ way: 'broadcast', text: '提出一个候选修改' })
    expect(r.speeches).toEqual([])
    const task = [...r.groups.service.state(r.view.id).tasks.values()][0]!
    expect(task.state).toBe('waiting_user')
    await r.scheduler.confirmTask(r.view.id, task.taskId, true)
    expect(r.speeches.at(-1)).toMatchObject({
      member: 'ct-codex',
      reason: 'task',
      task: { confirmed: true },
    })
  })

  it('the loop guard asks the system to intervene and close', async () => {
    const polite = [
      '我觉得方案可以，就这么定吧',
      '同意，我觉得方案可以，就这么定',
      '好的，方案可以，就这么定吧',
      '同意，方案可以，就这么定吧',
      '嗯，方案可以，就这么定吧',
    ]
    let index = 0
    const r = room({
      script: (request) => ({
        text: `@${request.member === 'ct-arch' ? '审稿人' : '架构师'} ${polite[Math.min(index++, polite.length - 1)]}`,
      }),
      coordinate: (request) =>
        request.reason === 'intervene'
          ? { kind: 'close', text: '结论：意见已经收敛。' }
          : { kind: 'answer', text: '无需安排' },
    })
    await r.send({ way: 'mention', text: '@架构师 定一下' })
    expect(r.speeches).toHaveLength(4)
    expect(r.coordinations.map((request) => request.reason)).toEqual([
      'intervene',
    ])
    expect(r.messages().at(-1)).toMatchObject({
      from: 'ct-emperor',
      kind: 'say',
      text: '结论：意见已经收敛。',
    })
  })

  it('stop aborts a pending coordinator call and drops its late result', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const groups = memoryGroups()
    const view = groups.service.create({
      title: '停止协调',
      members: ['ct-arch'],
      settings: { collaboration: 'moderated', summarizeAtEnd: false },
    })
    const scheduler = new GroupScheduler({
      groups: groups.service,
      speak: async () => ({
        text: '不该发言',
        outcome: 'completed',
        spend: { usd: 0, tokens: 0 },
      }),
      poll: async () => ({ raise: false, score: 0, reason: '' }),
      coordinate: async () => {
        await gate
        return { kind: 'relay', speakers: ['ct-arch'] }
      },
      review: async () => ({ verdict: 'approve' }),
      digest: async () => '',
    })
    const { message, plan } = groups.service.send(view.id, {
      way: 'broadcast',
      text: '开始',
    })
    const sending = scheduler.start(view.id, message, plan)
    await Promise.resolve()
    expect(scheduler.stop(view.id)).toBe(true)
    release!()
    await sending
    expect(groups.service.state(view.id).messages).toHaveLength(1)
    expect(groups.service.state(view.id).turn?.state).toBe('stopped')
  })

  it('legacy moderator messages replay, then one settings event enables builtin coordination', () => {
    const groups = memoryGroups()
    const legacy = groups.service.create({
      title: '旧群',
      members: ['ct-emperor', 'ct-arch'],
      moderator: 'ct-emperor',
      settings: { coordination: 'member' },
    })
    const historical: GroupMessage = {
      id: 'gm-old',
      turnId: 'gt-old',
      from: 'ct-emperor',
      audience: { kind: 'all' },
      ask: [],
      answerMode: 'relay',
      kind: 'summary',
      text: '旧主持人的历史结论',
      at: 1,
    }
    groups.service.append(legacy.id, 'group/message', historical)
    expect(groups.service.migrateLegacyCoordination()).toBe(1)
    expect(groups.service.migrateLegacyCoordination()).toBe(0)
    expect(groups.service.get(legacy.id).settings.coordination).toBe('builtin')
    expect(groups.service.get(legacy.id).moderator).toBeNull()
    expect(groups.service.history(legacy.id).messages.at(-1)).toMatchObject({
      from: 'ct-emperor',
      kind: 'summary',
      text: '旧主持人的历史结论',
    })
    expect(
      groups.logs
        .get(legacy.id)!
        .filter(
          (event) =>
            event.type === 'group/settings' &&
            (event.data as { patch?: { coordination?: string } }).patch
              ?.coordination === 'builtin',
        ),
    ).toHaveLength(1)
  })
})
