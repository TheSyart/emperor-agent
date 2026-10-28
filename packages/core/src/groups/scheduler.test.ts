// GRP-07: who speaks when, with no quota. Speeches, hand polls, moderator
// reviews and digests are injected, so each rule is checked against a
// scripted room; the stop conditions are the queue running dry, the
// moderator closing, the user stopping, and the loop guard.
import { describe, expect, it } from 'vitest'
import type { GroupMessage } from './types'
import {
  GroupScheduler,
  type SpeakRequest,
  type SpeakResult,
} from './scheduler'
import type { GroupContact } from './service'
import { memoryGroups, TEST_CONTACTS } from './test-fixture'

type Script = (
  req: SpeakRequest,
  scheduler: GroupScheduler,
) => Partial<SpeakResult> | Promise<Partial<SpeakResult>>

function room(
  opts: {
    contacts?: GroupContact[]
    members?: string[]
    settings?: Record<string, unknown>
    moderator?: string | null
    script?: Script
    hands?: Record<string, { raise: boolean; score: number }>
    review?: (message: GroupMessage) => {
      verdict: 'approve' | 'reorder' | 'reject'
      order?: string[]
      note?: string
    }
  } = {},
) {
  const groups = memoryGroups(opts.contacts)
  const speeches: SpeakRequest[] = []
  const polls: string[] = []
  const reviews: GroupMessage[] = []
  const events: Array<Record<string, unknown>> = []
  let active = 0
  let maxActive = 0
  const scheduler: GroupScheduler = new GroupScheduler({
    groups: groups.service,
    speak: async (req) => {
      speeches.push(req)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        const out = (await (opts.script ?? (() => ({})))(req, scheduler)) ?? {}
        return {
          text: `${req.member} 的回答`,
          outcome: 'completed',
          spend: { usd: 0.01, tokens: 100 },
          ...out,
        }
      } finally {
        active -= 1
      }
    },
    poll: async ({ member }) => {
      polls.push(member.id)
      const hand = opts.hands?.[member.id] ?? { raise: false, score: 0 }
      return { ...hand, reason: `${member.name} 想说` }
    },
    review: async ({ message }) => {
      reviews.push(message)
      return opts.review?.(message) ?? { verdict: 'approve' }
    },
    digest: async () => '群纪要',
    emit: (event) => events.push(event),
  })
  const view = groups.service.create({
    title: '评审',
    members: opts.members ?? ['ct-emperor', 'ct-arch', 'ct-rev'],
    ...(opts.moderator !== undefined ? { moderator: opts.moderator } : {}),
    settings: { loopGuard: true, ...opts.settings } as never,
  })
  const send = async (input: Parameters<typeof groups.service.send>[1]) => {
    const { message, plan } = groups.service.send(view.id, input)
    await scheduler.start(view.id, message, plan)
    return message
  }
  const messages = () => groups.service.state(view.id).messages
  const said = () =>
    messages()
      .filter((m) => m.from !== 'user')
      .map((m) => `${m.from}:${m.kind}:${m.text}`)
  const turns = () =>
    groups.logs
      .get(view.id)!
      .filter((e) => e.type === 'group/turn')
      .map((e) => e.data as { state: string; reason?: string; spend: unknown })
  return {
    groups,
    view,
    scheduler,
    speeches,
    polls,
    reviews,
    events,
    send,
    messages,
    said,
    turns,
    maxActive: () => maxActive,
  }
}

describe('relay and independent answers', () => {
  it('1 · @ two members: they answer in order, the second sees the first', async () => {
    const r = room({ settings: { summarizeAtEnd: false } })
    await r.send({ way: 'mention', text: '@审稿人 @架构师 看看方案' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-rev', 'ct-arch'])
    expect(r.speeches[1]!.prompt).toContain('ct-rev 的回答')
    expect(r.said()).toEqual([
      'ct-rev:say:ct-rev 的回答',
      'ct-arch:say:ct-arch 的回答',
    ])
  })

  it('2 · independent answers run together, blind to each other, revealed at once', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const r = room({
      settings: { summarizeAtEnd: false },
      script: async (req) => {
        if (r.speeches.length === 2) release()
        await gate
        return { text: `${req.member} 估三天` }
      },
    })
    await r.send({
      way: 'independent',
      ask: ['ct-arch', 'ct-rev'],
      text: '各自估个工期',
    })
    expect(r.maxActive()).toBe(2)
    for (const speech of r.speeches) expect(speech.prompt).not.toMatch(/估三天/)
    const state = r.groups.service.state(r.view.id)
    const answers = state.messages.filter((m) => m.from !== 'user')
    expect(answers).toHaveLength(2)
    expect(new Set(answers.map((m) => m.batchId)).size).toBe(1)
    expect(state.revealed.has(answers[0]!.batchId!)).toBe(true)
  })
})

describe('who answers a broadcast', () => {
  it('3 · moderated: the moderator plans with group_next', async () => {
    const r = room({
      settings: { collaboration: 'moderated', summarizeAtEnd: false },
      script: (req, s) => {
        if (req.planning) {
          s.next(r.view.id, 'ct-emperor', {
            speakers: ['ct-arch', 'ct-rev'],
            mode: 'relay',
          })
          return { text: '' }
        }
        return {}
      },
    })
    await r.send({ way: 'broadcast', text: '大家看看' })
    expect(r.speeches.map((s) => [s.member, s.planning])).toEqual([
      ['ct-emperor', true],
      ['ct-arch', false],
      ['ct-rev', false],
    ])
  })

  it('4 · autonomous: only the members who raise a hand speak, highest score first', async () => {
    const r = room({
      settings: { summarizeAtEnd: false },
      hands: {
        'ct-arch': { raise: true, score: 0.4 },
        'ct-rev': { raise: true, score: 0.9 },
      },
    })
    await r.send({ way: 'broadcast', text: '方案有问题吗' })
    expect(r.polls.sort()).toEqual(['ct-arch', 'ct-emperor', 'ct-rev'])
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-rev', 'ct-arch'])
  })

  it('autonomous with no hand raised: the moderator answers', async () => {
    const r = room({ settings: { summarizeAtEnd: false } })
    await r.send({ way: 'broadcast', text: '有人吗' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-emperor'])
  })

  it('5 · quiet: nobody speaks without an @, and the group says how', async () => {
    const r = room({ settings: { quiet: true } })
    await r.send({ way: 'broadcast', text: '大家好' })
    expect(r.speeches).toEqual([])
    expect(r.said()).toEqual([
      'system:system:安静模式下只有被 @ 的成员发言：@ 一位成员，或在群设置里关掉安静模式。',
    ])
  })
})

describe('what a member’s message starts', () => {
  it('6 · a member who mentions nobody ends that line', async () => {
    const r = room({ settings: { summarizeAtEnd: false } })
    await r.send({ way: 'mention', text: '@架构师 说说' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-arch'])
  })

  it('7 · an @ in a reply queues that member; an @ to an outsider gets a note to the speaker', async () => {
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req) =>
        req.member === 'ct-arch'
          ? { text: '@审稿人 你看看，@产品经理 也看看' }
          : {},
    })
    await r.send({ way: 'mention', text: '@架构师 说说' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-arch', 'ct-rev'])
    const note = r
      .messages()
      .find((m) => m.from === 'system' && /产品经理/.test(m.text))!
    expect(note.audience).toEqual({ kind: 'private', to: 'ct-arch' })
  })

  it('8 · whisper, assign and pass from a speech', async () => {
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        if (req.member === 'ct-arch') {
          s.whisper(r.view.id, 'ct-arch', { to: 'ct-rev', text: '私下说' })
          s.assign(r.view.id, 'ct-arch', {
            to: 'ct-rev',
            title: '查溢出',
            deliverable: '原因和修法',
            access: 'readonly',
          })
          return { text: '' }
        }
        if (req.reason === 'task') {
          return { text: '溢出来自固定宽度' }
        }
        s.pass(r.view.id, req.member)
        return { text: '' }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 说说' })
    expect(r.said()).toEqual([
      'ct-arch:say:私下说',
      'ct-arch:task:查溢出',
      'ct-rev:result:溢出来自固定宽度',
    ])
    const whisper = r.messages().find((m) => m.text === '私下说')!
    expect(whisper.audience).toEqual({ kind: 'private', to: 'ct-rev' })
    const task = [...r.groups.service.state(r.view.id).tasks.values()][0]!
    expect(task).toMatchObject({ to: 'ct-rev', state: 'done' })
  })

  it('pass leaves a 没有补充 line and starts nothing', async () => {
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        s.pass(r.view.id, req.member, '同意')
        return { text: '' }
      },
    })
    await r.send({ way: 'mention', text: '@审稿人 还有吗' })
    expect(r.said()).toEqual(['ct-rev:pass:同意'])
  })
})

describe('collaboration modes', () => {
  it('9 · autonomous: a member’s @ and task run directly, no review', async () => {
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req) =>
        req.member === 'ct-arch' ? { text: '@审稿人 看看' } : {},
    })
    await r.send({ way: 'mention', text: '@架构师 说说' })
    expect(r.reviews).toEqual([])
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-arch', 'ct-rev'])
  })

  it('9 · moderated: a member’s @ goes to the moderator, who approves, reorders or rejects', async () => {
    const script: Script = (req) =>
      req.member === 'ct-arch' ? { text: '@审稿人 @研究员 你们看看' } : {}
    const members = ['ct-emperor', 'ct-arch', 'ct-rev', 'ct-res']
    const settings = { collaboration: 'moderated', summarizeAtEnd: false }
    const approved = room({ members, settings, script })
    await approved.send({ way: 'mention', text: '@架构师 说说' })
    expect(approved.reviews).toHaveLength(1)
    expect(approved.speeches.map((s) => s.member)).toEqual([
      'ct-arch',
      'ct-rev',
      'ct-res',
    ])
    const reordered = room({
      members,
      settings,
      script,
      review: () => ({ verdict: 'reorder', order: ['ct-res', 'ct-rev'] }),
    })
    await reordered.send({ way: 'mention', text: '@架构师 说说' })
    expect(reordered.speeches.map((s) => s.member)).toEqual([
      'ct-arch',
      'ct-res',
      'ct-rev',
    ])
    const rejected = room({
      members,
      settings,
      script,
      review: () => ({ verdict: 'reject', note: '先别扩大范围' }),
    })
    await rejected.send({ way: 'mention', text: '@架构师 说说' })
    expect(rejected.speeches.map((s) => s.member)).toEqual(['ct-arch'])
    expect(rejected.messages().some((m) => /先别扩大范围/.test(m.text))).toBe(
      true,
    )
  })

  it('9 · moderated: the user’s own task is not reviewed', async () => {
    const r = room({
      settings: { collaboration: 'moderated', summarizeAtEnd: false },
    })
    await r.send({
      way: 'task',
      to: 'ct-rev',
      text: '查一下溢出',
      task: { title: '查溢出', deliverable: '原因', access: 'readonly' },
    })
    expect(r.reviews).toEqual([])
    expect(r.speeches.map((s) => [s.member, s.reason])).toEqual([
      ['ct-rev', 'task'],
    ])
  })
})

describe('no quota', () => {
  it('10 · thirty speeches in a row are never cut by a count', async () => {
    let n = 0
    const r = room({
      settings: { summarizeAtEnd: false, loopGuard: false },
      script: (req) => {
        n += 1
        if (n >= 30) return { text: `第 ${n} 条，说完了` }
        const next = req.member === 'ct-arch' ? '审稿人' : '架构师'
        return {
          text: `@${next} 第 ${n} 条新想法 ${'甲乙丙丁戊己庚辛'[n % 8]}`,
        }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 开始' })
    expect(r.speeches).toHaveLength(30)
    expect(r.turns().at(-1)).toMatchObject({ state: 'finished' })
  })

  it('16 · spend adds up in the turn and stops nothing', async () => {
    const r = room({
      settings: { summarizeAtEnd: false },
      script: () => ({ spend: { usd: 2.5, tokens: 1000 } }),
    })
    await r.send({ way: 'mention', text: '@审稿人 @架构师 看看' })
    expect(r.turns().at(-1)).toMatchObject({
      state: 'finished',
      spend: { usd: 5, tokens: 2000 },
    })
    expect(
      r.events.filter((e) => e.event === 'group_turn_changed').at(-1),
    ).toMatchObject({ spend: { usd: 5, tokens: 2000 } })
  })

  it('15 · a speech cut at its step limit says why, and the others go on', async () => {
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req) =>
        req.member === 'ct-rev' ? { text: '', outcome: 'step-limit' } : {},
    })
    await r.send({ way: 'mention', text: '@审稿人 @架构师 看看' })
    expect(r.said()).toEqual([
      'system:system:审稿人 这次发言达到工具调用上限，已停下。',
      'ct-arch:say:ct-arch 的回答',
    ])
  })

  it('17 · a task chain cannot loop back', async () => {
    let refused = ''
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        if (req.member === 'ct-arch' && req.reason !== 'task') {
          s.assign(r.view.id, 'ct-arch', {
            to: 'ct-rev',
            title: 'A',
            deliverable: 'a',
            access: 'readonly',
          })
          return { text: '' }
        }
        if (req.member === 'ct-rev') {
          try {
            s.assign(r.view.id, 'ct-rev', {
              to: 'ct-arch',
              title: 'B',
              deliverable: 'b',
              access: 'readonly',
            })
          } catch (error) {
            refused = String((error as Error).message)
          }
          return { text: '做完了' }
        }
        return {}
      },
    })
    await r.send({ way: 'mention', text: '@架构师 安排一下' })
    expect(refused).toMatch(/绕回/)
  })
})

describe('the loop guard', () => {
  const polite = [
    '我觉得方案可以，就这么定吧',
    '同意，我觉得方案可以，就这么定',
    '好的，方案可以，就这么定吧',
    '同意，方案可以，就这么定吧',
    '嗯，方案可以，就这么定吧',
  ]

  it('11 · two members agreeing back and forth: the moderator steps in after the fourth', async () => {
    let i = 0
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req) => {
        if (req.reason === 'intervene') return { text: '好，这个点到此为止。' }
        const next = req.member === 'ct-arch' ? '审稿人' : '架构师'
        return { text: `@${next} ${polite[Math.min(i++, polite.length - 1)]}` }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 定一下' })
    expect(r.speeches.map((s) => s.reason).at(-1)).toBe('intervene')
    expect(r.speeches.filter((s) => s.reason !== 'intervene')).toHaveLength(4)
    expect(r.speeches.at(-1)!.prompt).toMatch(/来回没有新进展/)
  })

  it('without a moderator the turn pauses and asks the user', async () => {
    let i = 0
    const r = room({
      members: ['ct-arch', 'ct-rev'],
      settings: { summarizeAtEnd: false },
      script: (req) => {
        const next = req.member === 'ct-arch' ? '审稿人' : '架构师'
        return { text: `@${next} ${polite[Math.min(i++, polite.length - 1)]}` }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 定一下' })
    expect(r.speeches).toHaveLength(4)
    expect(r.turns().at(-1)).toMatchObject({ state: 'paused' })
  })

  it('a real discussion that keeps adding content is left alone', async () => {
    const lines = [
      '停止规则要覆盖没人点名的情况',
      '还要考虑用户中途插话时怎么重排队列',
      '主持人结论应当列出分歧和各自的理由',
      '外部成员续聊时复用同一个委派，费用更低',
      '最后补一条：重启后要把进行中的轮次标记停止',
    ]
    let i = 0
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req) => {
        if (i >= lines.length - 1) return { text: lines[i++]! }
        const next = req.member === 'ct-arch' ? '审稿人' : '架构师'
        return { text: `@${next} ${lines[i++]}` }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 开始' })
    expect(r.speeches.every((s) => s.reason !== 'intervene')).toBe(true)
    expect(r.speeches).toHaveLength(5)
  })
})

describe('interrupting, stopping and restarting', () => {
  it('12 · a new message while someone speaks: they finish, then the queue follows the new one', async () => {
    let resent: Promise<unknown> | undefined
    const r: ReturnType<typeof room> = room({
      settings: { summarizeAtEnd: false },
      script: (req) => {
        if (req.member === 'ct-rev' && !resent)
          resent = r.send({ way: 'mention', text: '@研究员 你先说' })
        return {}
      },
      members: ['ct-emperor', 'ct-arch', 'ct-rev', 'ct-res'],
    })
    await r.send({ way: 'mention', text: '@审稿人 @架构师 看看' })
    await resent
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-rev', 'ct-res'])
    expect(r.said()).toEqual([
      'ct-rev:say:ct-rev 的回答',
      'ct-res:say:ct-res 的回答',
    ])
  })

  it('13 · after stop no message is added and the task is cancelled', async () => {
    const r: ReturnType<typeof room> = room({
      settings: { summarizeAtEnd: false },
      script: async (req) => {
        r.scheduler.stop(r.view.id)
        return { text: `${req.member} 太晚了` }
      },
    })
    await r.send({
      way: 'task',
      to: 'ct-rev',
      text: '查一下',
      task: { title: '查', deliverable: '原因', access: 'readonly' },
    })
    expect(r.said()).toEqual([])
    expect(r.turns().at(-1)).toMatchObject({ state: 'stopped', reason: 'user' })
    const task = [...r.groups.service.state(r.view.id).tasks.values()][0]!
    expect(task.state).toBe('cancelled')
  })

  it('14 · a turn left running by a restart is marked stopped', async () => {
    const r = room()
    r.groups.service.append(r.view.id, 'group/turn', {
      turnId: 't-old',
      state: 'started',
      spend: { usd: 0, tokens: 0 },
    })
    expect(r.scheduler.recover()).toBe(1)
    expect(r.turns().at(-1)).toMatchObject({
      state: 'stopped',
      reason: 'app_restart',
    })
    expect(r.scheduler.recover()).toBe(0)
  })
})

describe('the end of a turn', () => {
  it('the moderator sums up when others spoke', async () => {
    const r = room({
      script: (req) =>
        req.reason === 'summary' ? { text: '结论：先修溢出' } : {},
    })
    await r.send({ way: 'mention', text: '@审稿人 看看' })
    expect(r.said()).toEqual([
      'ct-rev:say:ct-rev 的回答',
      'ct-emperor:summary:结论：先修溢出',
    ])
  })

  it('group_close ends the turn with the moderator’s summary', async () => {
    const r = room({
      settings: { collaboration: 'moderated' },
      script: (req, s) => {
        if (req.planning) {
          s.close(r.view.id, 'ct-emperor', '这件事不用讨论：已经定了。')
          return { text: '' }
        }
        return {}
      },
    })
    await r.send({ way: 'broadcast', text: '要不要改' })
    expect(r.said()).toEqual(['ct-emperor:summary:这件事不用讨论：已经定了。'])
    expect(r.speeches).toHaveLength(1)
  })
})

describe('external members and code changes (GRP-09)', () => {
  const members = ['ct-emperor', 'ct-arch', 'ct-codex']

  it('a member’s worktree task for Claude Code or Codex waits for the user', async () => {
    const r = room({
      members,
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        if (req.member === 'ct-arch') {
          s.assign(r.view.id, 'ct-arch', {
            to: 'ct-codex',
            title: '修溢出',
            deliverable: '改好的代码',
            access: 'isolated_worktree',
          })
          return { text: '' }
        }
        return { text: 'Codex 改好了' }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 安排一下' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-arch'])
    const task = [...r.groups.service.state(r.view.id).tasks.values()][0]!
    expect(task.state).toBe('waiting_user')
    expect(r.said().at(-1)).toMatch(/system:system:.*Codex.*独立的工作树.*确认/)

    await r.scheduler.confirmTask(r.view.id, task.taskId, true)
    const confirmed = r.speeches.at(-1)!
    expect([confirmed.member, confirmed.reason]).toEqual(['ct-codex', 'task'])
    expect(confirmed.task).toMatchObject({ confirmed: true })
    expect(
      [...r.groups.service.state(r.view.id).tasks.values()][0]!.state,
    ).toBe('done')
  })

  it('a declined task is cancelled and nobody runs it', async () => {
    const r = room({
      members,
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        if (req.member === 'ct-arch')
          s.assign(r.view.id, 'ct-arch', {
            to: 'ct-codex',
            title: '修溢出',
            deliverable: '代码',
            access: 'isolated_worktree',
          })
        return { text: '' }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 安排一下' })
    const task = [...r.groups.service.state(r.view.id).tasks.values()][0]!
    await r.scheduler.confirmTask(r.view.id, task.taskId, false)
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-arch'])
    expect(
      [...r.groups.service.state(r.view.id).tasks.values()][0]!.state,
    ).toBe('cancelled')
    await expect(
      r.scheduler.confirmTask(r.view.id, task.taskId, true),
    ).rejects.toThrow(/不在等你确认/)
  })

  it('the user’s own worktree task runs at once, confirmed', async () => {
    const r = room({ members, settings: { summarizeAtEnd: false } })
    await r.send({
      way: 'task',
      to: 'ct-codex',
      text: '修一下',
      task: {
        title: '修溢出',
        deliverable: '代码',
        access: 'isolated_worktree',
      },
    })
    expect(r.speeches.at(-1)!.task).toMatchObject({ confirmed: true })
  })

  it('a read-only task for an external member needs no confirmation', async () => {
    const r = room({
      members,
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        if (req.member === 'ct-arch')
          s.assign(r.view.id, 'ct-arch', {
            to: 'ct-codex',
            title: '审一下',
            deliverable: '意见',
            access: 'readonly',
          })
        return { text: '' }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 安排一下' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-arch', 'ct-codex'])
  })

  it('an external member’s task result carries its result card', async () => {
    const r = room({
      members,
      settings: { summarizeAtEnd: false },
      script: (req) =>
        req.reason === 'task'
          ? { text: '改好了', delegation: { id: 'dlg-1', runId: 'dgr-1' } }
          : {},
    })
    await r.send({
      way: 'task',
      to: 'ct-codex',
      text: '修一下',
      task: {
        title: '修溢出',
        deliverable: '代码',
        access: 'isolated_worktree',
      },
    })
    const result = r.messages().find((m) => m.kind === 'result')!
    expect(result.delegation).toEqual({ id: 'dlg-1', runId: 'dgr-1' })
  })
})

// GRP-15 · how a group turn ends, from the real GRP-10 run: 「@反方」 never
// reached 「反方（红队）」, the moderator could not close outside planning,
// nine spec revisions went round as tasks, and thirteen 「没有补充」 in a row.
const DEBATE: GroupContact[] = [
  ...TEST_CONTACTS,
  ...[
    ['ct-pm', '产品经理', '需求'],
    ['ct-red', '反方（红队）', '专挑毛病'],
    ['ct-blue', '反方（蓝队）', '另一组'],
  ].map(([id, name, intro]) => ({
    id: id!,
    name: name!,
    intro: intro!,
    kind: 'local' as const,
    speak: 'relevant' as const,
    version: 1,
  })),
]
const notices = (r: ReturnType<typeof room>) =>
  r.messages().filter((m) => m.from === 'system')

describe('GRP-15 · mentions by a name written short', () => {
  it('「@反方」 reaches 「反方（红队）」, and so does 「`@反方`」', async () => {
    const r = room({
      contacts: DEBATE,
      members: ['ct-emperor', 'ct-pm', 'ct-red'],
      settings: { summarizeAtEnd: false },
      script: (req) =>
        req.member === 'ct-emperor'
          ? {
              text: '等产品经理交稿后，@反方 再做签字检查；`@反方` 重点查两处。',
            }
          : {},
    })
    await r.send({ way: 'mention', text: '@Emperor 安排一下' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-emperor', 'ct-red'])
    expect(notices(r)).toEqual([])
  })

  it('the full name 「@反方（红队）」 gets no 「不在这个群里」 notice', async () => {
    const r = room({
      contacts: DEBATE,
      members: ['ct-emperor', 'ct-pm', 'ct-red'],
      settings: { summarizeAtEnd: false },
      script: (req) =>
        req.member === 'ct-emperor' ? { text: '@反方（红队） 两边都打' } : {},
    })
    await r.send({ way: 'mention', text: '@Emperor 开始' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-emperor', 'ct-red'])
    expect(notices(r)).toEqual([])
  })

  it('a prefix two members share is not guessed: the speaker is asked for the full name', async () => {
    const r = room({
      contacts: DEBATE,
      members: ['ct-emperor', 'ct-red', 'ct-blue'],
      settings: { summarizeAtEnd: false },
      script: (req) =>
        req.member === 'ct-emperor' ? { text: '@反方 你们看看' } : {},
    })
    await r.send({ way: 'mention', text: '@Emperor 开始' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-emperor'])
    const [note] = notices(r)
    expect(note!.audience).toEqual({ kind: 'private', to: 'ct-emperor' })
    expect(note!.text).toBe(
      '「反方」能对上好几位成员：反方（红队）、反方（蓝队），请写全名；这次点名没有送达。',
    )
  })

  it('a name nobody has gets one notice that lists who is in the group', async () => {
    const r = room({
      contacts: DEBATE,
      members: ['ct-emperor', 'ct-pm', 'ct-red'],
      settings: { summarizeAtEnd: false },
      script: (req) =>
        req.member === 'ct-pm'
          ? { text: '@界面设计评审，未过。@界面设计评审 再看看' }
          : {},
    })
    await r.send({ way: 'mention', text: '@产品经理 交稿' })
    expect(notices(r).map((m) => m.text)).toEqual([
      '「界面设计评审」不在这个群里，这次点名没有送达。群里的成员：Emperor、反方（红队）。',
    ])
  })
})

describe('GRP-15 · the moderator closes the turn whenever it speaks', () => {
  it('asked by an @, not planning: group_close posts the summary and ends the turn', async () => {
    const r = room({
      script: (req, s) => {
        if (req.member === 'ct-rev') return { text: '@架构师 你也看看' }
        if (req.member === 'ct-emperor' && req.reason !== 'summary') {
          s.close(r.view.id, 'ct-emperor', '结论：先修溢出，不用再讨论。')
          return { text: '' }
        }
        return {}
      },
    })
    await r.send({ way: 'mention', text: '@审稿人 @Emperor 看看' })
    expect(r.speeches.map((s) => [s.member, s.reason, s.planning])).toEqual([
      ['ct-rev', 'asked', false],
      ['ct-emperor', 'asked', false],
    ])
    // Its prompt says it may end the turn.
    expect(r.speeches[1]!.prompt).toMatch(/group_close/)
    expect(r.said()).toEqual([
      'ct-rev:say:@架构师 你也看看',
      'ct-emperor:summary:结论：先修溢出，不用再讨论。',
    ])
    expect(r.turns().at(-1)).toMatchObject({ state: 'finished' })
  })

  it('while it works on a task too: the result, then the summary', async () => {
    const r = room({
      script: (req, s) => {
        if (req.reason === 'task') {
          s.close(r.view.id, 'ct-emperor', '交付了，本轮到此为止。')
          return { text: '报告在群文件里' }
        }
        return {}
      },
    })
    await r.send({
      way: 'task',
      to: 'ct-emperor',
      text: '写报告',
      task: { title: '写报告', deliverable: '报告', access: 'group_files' },
    })
    expect(r.said()).toEqual([
      'ct-emperor:result:报告在群文件里',
      'ct-emperor:summary:交付了，本轮到此为止。',
    ])
    expect(
      [...r.groups.service.state(r.view.id).tasks.values()][0]!.state,
    ).toBe('done')
  })

  it('group_next stays a planning tool, and its refusal says what to do instead', async () => {
    const errors: string[] = []
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        try {
          s.next(r.view.id, req.member, {
            speakers: ['ct-arch'],
            mode: 'relay',
          })
        } catch (error) {
          errors.push((error as Error).message)
        }
        return { text: '' }
      },
    })
    await r.send({ way: 'mention', text: '@Emperor @审稿人 看看' })
    expect(r.speeches.map((s) => s.member)).toEqual(['ct-emperor', 'ct-rev'])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/group_next 只在请你安排谁发言时能用/)
    expect(errors[0]).toMatch(/「@全名」/)
    expect(errors[0]).toMatch(/group_close/)
    expect(errors[1]).toBe('只有主持人能用 group_next')
  })

  it('only the moderator may close', async () => {
    let error = ''
    const r = room({
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        try {
          s.close(r.view.id, req.member, '我说完了')
        } catch (e) {
          error = (e as Error).message
        }
        return {}
      },
    })
    await r.send({ way: 'mention', text: '@审稿人 看看' })
    expect(error).toBe('只有主持人能用 group_close')
  })
})

describe('GRP-15 · the loop guard counts task relays and pass streaks', () => {
  const polite = [
    '我觉得方案可以，就这么定吧',
    '同意，我觉得方案可以，就这么定',
    '好的，方案可以，就这么定吧',
    '同意，方案可以，就这么定吧',
    '嗯，方案可以，就这么定吧',
  ]

  /** The debate group's moderator: one spec revision per speech, five at most. */
  function relay(settings: Record<string, unknown> = {}) {
    let n = 0
    const r: ReturnType<typeof room> = room({
      contacts: DEBATE,
      members: ['ct-emperor', 'ct-pm', 'ct-red'],
      settings: { summarizeAtEnd: false, ...settings },
      script: (req, s) => {
        if (req.member === 'ct-emperor') {
          if (n >= 5) return { text: '定稿了，不用再改。' }
          n += 1
          s.assign(r.view.id, 'ct-emperor', {
            to: 'ct-pm',
            title: `v0.3.${n}`,
            deliverable: '改好的需求稿',
            access: 'group_files',
          })
          return { text: '' }
        }
        if (req.reason === 'task')
          return { text: `@Emperor ${req.task!.title} 已交付` }
        return {}
      },
    })
    const tasks = () =>
      [...r.groups.service.state(r.view.id).tasks.values()].map((t) => [
        t.title,
        t.state,
      ])
    return { r, tasks }
  }

  it('a fourth task from one member in a turn is held and the turn pauses until 继续', async () => {
    const { r, tasks } = relay()
    await r.send({ way: 'mention', text: '@Emperor 把需求稿定下来' })
    expect(
      r.speeches.filter((s) => s.reason === 'task').map((s) => s.task!.title),
    ).toEqual(['v0.3.1', 'v0.3.2', 'v0.3.3'])
    expect(tasks()).toEqual([
      ['v0.3.1', 'done'],
      ['v0.3.2', 'done'],
      ['v0.3.3', 'done'],
      ['v0.3.4', 'waiting_user'],
    ])
    const held = [...r.groups.service.state(r.view.id).tasks.values()][3]!
    expect(held).toMatchObject({ hold: 'task_relay' })
    expect(r.turns().at(-1)).toMatchObject({
      state: 'paused',
      reason: 'task_relay',
    })
    const notice = r.messages().at(-1)!
    expect(notice).toMatchObject({ from: 'system', audience: { kind: 'all' } })
    expect(notice.text).toMatch(/「Emperor」这一轮已经交办了 3 次任务/)
    expect(notice.text).toMatch(/「v0\.3\.4」/)
    expect(notice.text).toMatch(/「继续」/)

    // 继续: the held task runs, and the count starts again in the new turn.
    await r.send({ way: 'broadcast', text: '继续' })
    expect(tasks()).toEqual([
      ['v0.3.1', 'done'],
      ['v0.3.2', 'done'],
      ['v0.3.3', 'done'],
      ['v0.3.4', 'done'],
      ['v0.3.5', 'done'],
    ])
    expect(r.turns().at(-1)).toMatchObject({ state: 'finished' })
  })

  it('同意 on the held task card runs it too, without counting as a code-change yes', async () => {
    const { r, tasks } = relay()
    await r.send({ way: 'mention', text: '@Emperor 把需求稿定下来' })
    const held = [...r.groups.service.state(r.view.id).tasks.values()][3]!
    await r.scheduler.confirmTask(r.view.id, held.taskId, true)
    const run = r.speeches.find((s) => s.task?.title === 'v0.3.4')!
    expect(run.task).not.toHaveProperty('confirmed')
    expect(run.task).not.toHaveProperty('hold')
    expect(tasks()[3]).toEqual(['v0.3.4', 'done'])
  })

  it('several tasks handed out in one speech count once', async () => {
    const r = room({
      contacts: DEBATE,
      members: ['ct-emperor', 'ct-arch', 'ct-rev', 'ct-res', 'ct-pm'],
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        if (req.member === 'ct-emperor')
          for (const to of ['ct-arch', 'ct-rev', 'ct-res', 'ct-pm'])
            s.assign(r.view.id, 'ct-emperor', {
              to,
              title: `分给 ${to}`,
              deliverable: '一节',
              access: 'readonly',
            })
        return { text: req.reason === 'task' ? '交了' : '' }
      },
    })
    await r.send({ way: 'mention', text: '@Emperor 分一下工' })
    expect(r.speeches.filter((s) => s.reason === 'task')).toHaveLength(4)
    expect(r.turns().at(-1)).toMatchObject({ state: 'finished' })
  })

  it('with 防打转 off, a relay is never held', async () => {
    const { r, tasks } = relay({ loopGuard: false })
    await r.send({ way: 'mention', text: '@Emperor 把需求稿定下来' })
    expect(tasks().every(([, state]) => state === 'done')).toBe(true)
    expect(tasks()).toHaveLength(5)
  })

  /**
   * Three members @-ing the other two in each of the first six speeches,
   * which leaves a backlog of asks; after that everyone passes (the real
   * research group: thirteen 没有补充 in a row).
   */
  function chatter(settings: Record<string, unknown> = {}) {
    const lines = [
      '停止规则要覆盖没人点名的情况',
      '还要考虑用户中途插话时怎么重排队列',
      '主持人结论应当列出分歧和各自的理由',
      '外部成员续聊时复用同一个委派',
      '重启后要把进行中的轮次标记停止',
      '交办链不能绕回，要写进群公告',
    ]
    const others: Record<string, string> = {
      'ct-arch': '@审稿人 @研究员',
      'ct-rev': '@架构师 @研究员',
      'ct-res': '@架构师 @审稿人',
    }
    let said = 0
    const r: ReturnType<typeof room> = room({
      members: ['ct-emperor', 'ct-arch', 'ct-rev', 'ct-res'],
      settings,
      script: (req, s) => {
        if (req.reason === 'summary') return { text: '结论：终稿已定。' }
        if (said < lines.length)
          return { text: `${others[req.member]} ${lines[said++]}` }
        s.pass(r.view.id, req.member, '终稿已核，没有补充')
        return { text: '' }
      },
    })
    const passers = () =>
      r
        .messages()
        .filter((m) => m.kind === 'pass')
        .map((m) => m.from)
    return { r, passers }
  }

  it('once everyone asked has said 没有补充 the turn ends: nobody passes twice, the summary runs once', async () => {
    const { r, passers } = chatter()
    await r.send({ way: 'mention', text: '@架构师 起个头' })
    expect(passers()).toHaveLength(3)
    expect(new Set(passers()).size).toBe(3)
    expect(r.speeches.filter((s) => s.reason === 'summary')).toHaveLength(1)
    expect(r.said().at(-1)).toBe('ct-emperor:summary:结论：终稿已定。')
    expect(r.turns().at(-1)).toMatchObject({
      state: 'finished',
      reason: 'pass_streak',
    })
  })

  it('with 防打转 off, every queued ask is still answered', async () => {
    const { r, passers } = chatter({ loopGuard: false })
    await r.send({ way: 'mention', text: '@架构师 起个头' })
    expect(passers()).toHaveLength(7)
  })

  it('the novelty guard is unchanged, and its intervention may re-plan with group_next', async () => {
    let i = 0
    const r = room({
      members: ['ct-emperor', 'ct-arch', 'ct-rev', 'ct-res'],
      settings: { summarizeAtEnd: false },
      script: (req, s) => {
        if (req.reason === 'intervene') {
          s.next(r.view.id, 'ct-emperor', {
            speakers: ['ct-res'],
            mode: 'relay',
            note: '换个角度',
          })
          return { text: '' }
        }
        if (req.member === 'ct-res')
          return { text: '从测试的角度看，还缺回归用例' }
        const next = req.member === 'ct-arch' ? '审稿人' : '架构师'
        return { text: `@${next} ${polite[Math.min(i++, polite.length - 1)]}` }
      },
    })
    await r.send({ way: 'mention', text: '@架构师 定一下' })
    expect(
      r.speeches.filter((s) => s.member === 'ct-arch' || s.member === 'ct-rev'),
    ).toHaveLength(4)
    const intervene = r.speeches.find((s) => s.reason === 'intervene')!
    expect(intervene.planning).toBe(true)
    expect(intervene.prompt).toMatch(/来回没有新进展/)
    expect(r.speeches.at(-1)!.member).toBe('ct-res')
  })
})
