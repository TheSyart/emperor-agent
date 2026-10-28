// GRP-06: the group message protocol — envelopes for the five ways to send,
// who sees what, what each member is delivered, and the group charter. All
// pure; the scheduler (GRP-07) and the stores build on these.
import { describe, expect, it } from 'vitest'
import { groupCharter } from './charter'
import { formatDelivery, pendingDelivery, planDelivery } from './delivery'
import { buildUserMessage, parseMentions, resolveMentions } from './envelope'
import { foldGroupEvents, type GroupLogEvent } from './events'
import type { GroupMember, GroupMessage } from './types'
import { visibleTo } from './visibility'

const ROSTER: GroupMember[] = [
  { id: 'ct-emperor', name: 'Emperor', intro: '主持人' },
  { id: 'ct-arch', name: '架构师', intro: '系统设计' },
  { id: 'ct-rev', name: '审稿人', intro: '代码与方案评审' },
  { id: 'ct-res', name: '研究员', intro: '资料调研' },
  { id: 'ct-wri', name: '写作者', intro: '技术写作' },
  { id: 'ct-cc', name: 'Claude Code', intro: '外部', external: true },
]
const AT = Date.UTC(2026, 9, 27, 2, 42) // 10:42 in UTC+8

function created(extra: Partial<GroupLogEvent['data']> = {}): GroupLogEvent {
  return {
    type: 'group/created',
    data: {
      title: '0.3 方案评审',
      moderator: 'ct-emperor',
      members: ROSTER.map((m) => m.id),
      charter: '目标：评审 0.3 的群聊方案。',
      settings: {
        collaboration: 'autonomous',
        quiet: false,
        summarizeAtEnd: true,
        loopGuard: true,
      },
      ...extra,
    },
  } as GroupLogEvent
}
function said(
  message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'from' | 'text'>,
): GroupLogEvent {
  return {
    type: 'group/message',
    data: {
      turnId: 't1',
      audience: { kind: 'all' },
      ask: [],
      answerMode: 'relay',
      kind: 'say',
      at: AT,
      ...message,
    },
  }
}

describe('parseMentions', () => {
  it('finds @names in order, once each, preferring the longest name', () => {
    expect(
      parseMentions(
        '@审稿人 和 @架构师 看看，@审稿人 再确认 @Claude Code',
        ROSTER,
      ),
    ).toEqual(['ct-rev', 'ct-arch', 'ct-cc'])
  })

  it('ignores names not in the group and a bare @', () => {
    expect(parseMentions('@产品经理 你好 @ 大家', ROSTER)).toEqual([])
  })

  it('treats @所有人 as no individual mention', () => {
    expect(parseMentions('@所有人 说说看', ROSTER)).toEqual([])
  })
})

// GRP-15 · the real debate group (GRP-10): the contact is 「反方（红队）」,
// the moderator wrote 「@反方」 and 「`@反方`」, and every one went nowhere.
describe('parseMentions · names written short (GRP-15)', () => {
  const DEBATE: GroupMember[] = [
    { id: 'ct-emperor', name: 'Emperor', intro: '主持人' },
    { id: 'ct-pm', name: '产品经理', intro: '需求' },
    { id: 'ct-red', name: '反方（红队）', intro: '专挑毛病' },
    { id: 'ct-cc', name: 'Claude Code', intro: '外部', external: true },
  ]

  it('reads a prefix that fits exactly one member as that member', () => {
    expect(parseMentions('等产品经理交稿后，@反方 再签字检查', DEBATE)).toEqual(
      ['ct-red'],
    )
    expect(parseMentions('@产品 改一下第 3 节', DEBATE)).toEqual(['ct-pm'])
    expect(parseMentions('@claude 看一下', DEBATE)).toEqual(['ct-cc'])
  })

  it('still reads the full name, full-width brackets and all', () => {
    expect(parseMentions('@反方（红队） 两边都打', DEBATE)).toEqual(['ct-red'])
  })

  it('leaves trailing punctuation, backticks and quotes off the name', () => {
    for (const text of [
      '第一次我写 `@反方`，没有送达',
      '请「@反方」看看',
      '"@反方" 你来',
      '@反方。',
      '@反方，你看',
      '@产品经理：请改',
    ])
      expect(parseMentions(text, DEBATE), text).toHaveLength(1)
    expect(parseMentions('第一次我写 `@反方`', DEBATE)).toEqual(['ct-red'])
  })

  it('does not guess when a prefix fits several members', () => {
    const two: GroupMember[] = [
      ...DEBATE,
      { id: 'ct-blue', name: '反方（蓝队）', intro: '另一组' },
    ]
    expect(parseMentions('@反方 看看', two)).toEqual([])
    expect(resolveMentions('@反方 看看', two)).toEqual([
      { kind: 'ambiguous', token: '反方', ids: ['ct-red', 'ct-blue'] },
    ])
    expect(parseMentions('@反方（蓝队） 看看', two)).toEqual(['ct-blue'])
  })

  it('reports a name that fits nobody, and skips addresses and paths', () => {
    expect(
      resolveMentions('@界面设计评审，未过。a@b.com @types/node', DEBATE),
    ).toEqual([{ kind: 'unknown', token: '界面设计评审' }])
  })
})

describe('buildUserMessage · the five ways to send', () => {
  const base = { id: 'm1', turnId: 't1', at: AT, roster: ROSTER }

  it('broadcast: everyone sees it, nobody in particular is asked', () => {
    expect(
      buildUserMessage({ ...base, way: 'broadcast', text: '大家怎么看？' }),
    ).toMatchObject({
      from: 'user',
      audience: { kind: 'all' },
      ask: [],
      answerMode: 'relay',
      kind: 'say',
    })
  })

  it('mention: visible to all, the @named answer in @ order', () => {
    expect(
      buildUserMessage({
        ...base,
        way: 'mention',
        text: '@审稿人 @架构师 看看',
      }),
    ).toMatchObject({
      audience: { kind: 'members', ids: ['ct-rev', 'ct-arch'] },
      ask: ['ct-rev', 'ct-arch'],
      answerMode: 'relay',
    })
  })

  it('independent: the asked answer without seeing each other, in one batch', () => {
    const m = buildUserMessage({
      ...base,
      way: 'independent',
      text: '各自说说最担心的一点',
      ask: ['ct-arch', 'ct-rev', 'ct-res'],
    })
    expect(m).toMatchObject({
      answerMode: 'independent',
      ask: ['ct-arch', 'ct-rev', 'ct-res'],
    })
    expect(m.batchId).toMatch(/\S/)
  })

  it('private: only the recipient (and the sender) see it', () => {
    expect(
      buildUserMessage({
        ...base,
        way: 'private',
        text: '资料在群文件里',
        to: 'ct-wri',
      }),
    ).toMatchObject({
      audience: { kind: 'private', to: 'ct-wri' },
      ask: ['ct-wri'],
    })
  })

  it('task: visible to all, the assignee does a job with a deliverable', () => {
    const m = buildUserMessage({
      ...base,
      way: 'task',
      text: '把讨论写成一页说明',
      to: 'ct-wri',
      task: {
        title: '群聊停止规则说明',
        deliverable: '一页 Markdown',
        access: 'group_files',
      },
    })
    expect(m).toMatchObject({
      kind: 'task',
      audience: { kind: 'all' },
      ask: ['ct-wri'],
    })
    expect(m.task).toMatchObject({
      to: 'ct-wri',
      state: 'queued',
      access: 'group_files',
    })
  })

  it('rejects a private message or a task to someone outside the group', () => {
    expect(() =>
      buildUserMessage({
        ...base,
        way: 'private',
        text: 'hi',
        to: 'ct-nobody',
      }),
    ).toThrow(/not a member/)
    expect(() =>
      buildUserMessage({
        ...base,
        way: 'task',
        text: 'x',
        to: 'ct-nobody',
        task: { title: 't', deliverable: 'd', access: 'readonly' },
      }),
    ).toThrow(/not a member/)
  })
})

describe('visibleTo', () => {
  const pub = { audience: { kind: 'all' }, from: 'ct-rev' } as GroupMessage
  const dm = {
    audience: { kind: 'private', to: 'ct-wri' },
    from: 'ct-res',
  } as GroupMessage
  const blind = {
    audience: { kind: 'all' },
    from: 'ct-arch',
    batchId: 'b1',
  } as GroupMessage

  it('shows public and @ messages to every member', () => {
    expect(visibleTo(pub, 'ct-arch', new Set())).toBe(true)
    const mention = {
      ...pub,
      audience: { kind: 'members', ids: ['ct-arch'] },
    } as GroupMessage
    expect(visibleTo(mention, 'ct-wri', new Set())).toBe(true)
  })

  it('shows a private message to its recipient and its sender only', () => {
    expect(visibleTo(dm, 'ct-wri', new Set())).toBe(true)
    expect(visibleTo(dm, 'ct-res', new Set())).toBe(true)
    expect(visibleTo(dm, 'ct-rev', new Set())).toBe(false)
  })

  it('hides an independent answer from the others until its batch is revealed', () => {
    expect(visibleTo(blind, 'ct-rev', new Set())).toBe(false)
    expect(visibleTo(blind, 'ct-arch', new Set())).toBe(true)
    expect(visibleTo(blind, 'ct-rev', new Set(['b1']))).toBe(true)
  })
})

describe('foldGroupEvents and delivery', () => {
  const events: GroupLogEvent[] = [
    created(),
    said({ id: 'm1', from: 'user', text: '大家怎么看？' }),
    said({
      id: 'm2',
      from: 'ct-rev',
      text: '@架构师 那主持人什么时候插手？',
      audience: { kind: 'members', ids: ['ct-arch'] },
      ask: ['ct-arch'],
    }),
    said({
      id: 'm3',
      from: 'ct-res',
      text: '资料在群文件里',
      audience: { kind: 'private', to: 'ct-wri' },
      ask: ['ct-wri'],
    }),
    { type: 'group/delivery', data: { contactId: 'ct-arch', upTo: 'm1' } },
  ]

  it('folds members, settings and messages, skipping unknown events', () => {
    const state = foldGroupEvents([
      ...events,
      {
        type: 'group/unknown-future-event',
        data: {},
      } as unknown as GroupLogEvent,
    ])
    expect(state.title).toBe('0.3 方案评审')
    expect(state.members).toHaveLength(6)
    expect(state.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(state.cursors.get('ct-arch')).toBe('m1')
  })

  it('delivers only what is after the cursor and visible to the member', () => {
    const state = foldGroupEvents(events)
    expect(pendingDelivery(state, 'ct-arch').map((m) => m.id)).toEqual(['m2'])
    expect(pendingDelivery(state, 'ct-wri').map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
    // A third member never receives someone else's private message.
    expect(pendingDelivery(state, 'ct-rev').map((m) => m.id)).toEqual([
      'm1',
      'm2',
    ])
  })

  it('moves the cursor forward only (a stale delivery event is ignored)', () => {
    const state = foldGroupEvents([
      ...events,
      { type: 'group/delivery', data: { contactId: 'ct-arch', upTo: 'm3' } },
      { type: 'group/delivery', data: { contactId: 'ct-arch', upTo: 'm2' } },
    ])
    expect(state.cursors.get('ct-arch')).toBe('m3')
  })

  it('stops delivering to a member who was removed', () => {
    const state = foldGroupEvents([
      ...events,
      {
        type: 'group/member',
        data: { action: 'removed', contactId: 'ct-wri', contactVersion: 1 },
      },
    ])
    expect(state.members.includes('ct-wri')).toBe(false)
    expect(pendingDelivery(state, 'ct-wri')).toEqual([])
  })

  it('formats a delivery as timed lines naming sender and audience', () => {
    const state = foldGroupEvents(events)
    const text = formatDelivery(
      pendingDelivery(state, 'ct-wri'),
      ROSTER,
      'ct-wri',
    )
    expect(text).toBe(
      [
        '[10:42] 用户 → 所有人：大家怎么看？',
        '[10:42] 审稿人 → @架构师：@架构师 那主持人什么时候插手？',
        '[10:42] 研究员 → 你（私信）：资料在群文件里',
      ].join('\n'),
    )
  })
})

describe('groupCharter', () => {
  it('tells a member who is in the group, the rules and how to talk', () => {
    const state = foldGroupEvents([created()])
    const text = groupCharter(state, ROSTER, 'ct-arch')
    expect(text).toContain('# 群聊：0.3 方案评审')
    expect(text).toContain('目标：评审 0.3 的群聊方案。')
    // GRP-15: each name as it is written after @, the role apart from it.
    expect(text).toContain('- @审稿人：代码与方案评审')
    expect(text).toContain('- @Emperor · 主持人：主持人')
    expect(text).toContain('- @Claude Code · 外部：外部')
    expect(text).toContain('点名时在 @ 后面照抄全名，比如「@Emperor」')
    expect(text).toContain('你是「架构师」')
    expect(text).toMatch(/写「@全名」/)
    expect(text).toMatch(/不点名/)
    expect(text).toMatch(/只会收到公开的消息和发给你的私信/)
    // Deterministic: the same state gives the same text.
    expect(groupCharter(state, ROSTER, 'ct-arch')).toBe(text)
  })

  it('tells the moderator it can end the turn whenever it speaks (GRP-15)', () => {
    const state = foldGroupEvents([created()])
    const moderator = groupCharter(state, ROSTER, 'ct-emperor')
    expect(moderator).toMatch(/你是主持人.*随时.*group_close/)
    expect(moderator).toMatch(/group_next/)
    expect(groupCharter(state, ROSTER, 'ct-arch')).not.toMatch(/group_close/)
  })

  it('describes the collaboration mode in force', () => {
    const autonomous = groupCharter(
      foldGroupEvents([created()]),
      ROSTER,
      'ct-rev',
    )
    expect(autonomous).toMatch(/自主/)
    const moderated = groupCharter(
      foldGroupEvents([
        created({
          settings: {
            collaboration: 'moderated',
            quiet: false,
            summarizeAtEnd: true,
            loopGuard: true,
          },
        } as never),
      ]),
      ROSTER,
      'ct-rev',
    )
    expect(moderated).toMatch(/主持人审核/)
  })
})

describe('planDelivery · the 8k-token digest rule', () => {
  const long = 'x'.repeat(400)
  const events: GroupLogEvent[] = [
    created(),
    ...Array.from({ length: 30 }, (_, i) =>
      said({ id: `m${i + 1}`, from: i % 2 ? 'ct-rev' : 'ct-arch', text: long }),
    ),
  ]
  const tokens = (text: string) => Math.ceil(text.length / 4)

  it('hands everything over while it fits', () => {
    const plan = planDelivery(foldGroupEvents(events), 'ct-res', tokens, 8_000)
    expect(plan).toMatchObject({ needsDigest: false, digest: null })
    expect(plan.messages).toHaveLength(30)
  })

  it('asks for a digest when it does not fit and none covers the backlog', () => {
    const plan = planDelivery(foldGroupEvents(events), 'ct-res', tokens, 1_000)
    expect(plan.needsDigest).toBe(true)
  })

  it('uses the latest digest plus what came after it', () => {
    const state = foldGroupEvents([
      ...events,
      {
        type: 'group/digest',
        data: { upTo: 'm25', text: '群纪要：前 25 条讨论了停止规则。' },
      },
    ])
    const plan = planDelivery(state, 'ct-res', tokens, 1_000)
    expect(plan.needsDigest).toBe(false)
    expect(plan.digest).toBe('群纪要：前 25 条讨论了停止规则。')
    expect(plan.messages.map((m) => m.id)).toEqual([
      'm26',
      'm27',
      'm28',
      'm29',
      'm30',
    ])
  })
})
