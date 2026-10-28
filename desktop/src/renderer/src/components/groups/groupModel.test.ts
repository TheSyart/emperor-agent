/**
 * GRP-08 (预览 B 第 3 步): the group page's pure rules — the five ways of
 * sending turned into `groups.send` envelopes, the message flow's eight
 * kinds (independent answers gathered into one card), the live bar, a
 * member's status line and the fold of a long message.
 */
import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  formatSpend,
  independentAskees,
  isLongMessage,
  liveBarParts,
  memberStatusLine,
  planGroupSend,
  privateLabel,
  SEND_WAYS,
  speechCount,
  timelineRows,
  type GroupHistoryMessage,
  type GroupMemberView,
} from './groupModel'

function member(
  id: string,
  name: string,
  extra: Partial<GroupMemberView> = {},
): GroupMemberView {
  return {
    id,
    name,
    intro: '',
    external: false,
    speak: 'relevant',
    memberSessionId: `member-${id}`,
    missing: false,
    ...extra,
  }
}

const MEMBERS = [
  member('ct-emperor', 'Emperor'),
  member('ct-arch', '架构师'),
  member('ct-rev', '审稿人'),
  member('ct-res', '研究员'),
  member('ct-codex', 'Codex', { external: true, speak: 'mentioned' }),
]

function message(
  id: string,
  from: string,
  text: string,
  extra: Partial<GroupHistoryMessage> = {},
): GroupHistoryMessage {
  return {
    id,
    turnId: 't1',
    from,
    audience: { kind: 'all' },
    ask: [],
    answerMode: 'relay',
    kind: 'say',
    text,
    at: 1_750_000_000_000,
    private: false,
    hidden: false,
    ...extra,
  }
}

describe('发给 ▾: five ways, five envelopes', () => {
  it('offers the five ways in the order of the preview', () => {
    expect(SEND_WAYS.map((way) => [way.way, way.label])).toEqual([
      ['broadcast', '所有人 · 有关的人举手'],
      ['independent', '所有人 · 各自独立回答'],
      ['mention', '@ 指定成员'],
      ['private', '私信…'],
      ['task', '交办…'],
    ])
  })

  it('broadcast: everyone sees it; an @ in the text makes it a mention', () => {
    expect(
      planGroupSend({ way: 'broadcast', text: '  大家怎么看？ ' }, MEMBERS, {
        moderator: 'ct-emperor',
      }),
    ).toEqual({ ok: true, input: { way: 'broadcast', text: '大家怎么看？' } })
    expect(
      planGroupSend({ way: 'broadcast', text: '@所有人 看一下' }, MEMBERS, {
        moderator: 'ct-emperor',
      }),
    ).toEqual({ ok: true, input: { way: 'broadcast', text: '@所有人 看一下' } })
    expect(
      planGroupSend({ way: 'broadcast', text: '@架构师 你先说' }, MEMBERS, {
        moderator: 'ct-emperor',
      }),
    ).toEqual({
      ok: true,
      input: { way: 'mention', text: '@架构师 你先说', ask: ['ct-arch'] },
    })
  })

  it('mention: the @-mentioned in order; none, or a name not in the group, stops it', () => {
    expect(
      planGroupSend(
        { way: 'mention', text: '@审稿人 @架构师 接力看看' },
        MEMBERS,
        { moderator: null },
      ),
    ).toEqual({
      ok: true,
      input: {
        way: 'mention',
        text: '@审稿人 @架构师 接力看看',
        ask: ['ct-rev', 'ct-arch'],
      },
    })
    expect(
      planGroupSend({ way: 'mention', text: '看看' }, MEMBERS, {
        moderator: null,
      }),
    ).toEqual({ ok: false, reason: '先 @ 一位成员：输入 @ 就能选人' })
    expect(
      planGroupSend({ way: 'mention', text: '@设计师 看看' }, MEMBERS, {
        moderator: null,
      }),
    ).toEqual({
      ok: false,
      reason: '群里没有「设计师」：改一下名字，或者去掉 @',
    })
  })

  it('independent: the @-mentioned, else everyone but the moderator and those who speak only when @', () => {
    expect(independentAskees(MEMBERS, 'ct-emperor')).toEqual([
      'ct-arch',
      'ct-rev',
      'ct-res',
    ])
    expect(
      planGroupSend(
        { way: 'independent', text: '各自说说最担心的一点' },
        MEMBERS,
        { moderator: 'ct-emperor' },
      ),
    ).toEqual({
      ok: true,
      input: {
        way: 'independent',
        text: '各自说说最担心的一点',
        ask: ['ct-arch', 'ct-rev', 'ct-res'],
      },
    })
    expect(
      planGroupSend(
        { way: 'independent', text: '@审稿人 @Codex 各自评估' },
        MEMBERS,
        { moderator: 'ct-emperor' },
      ),
    ).toMatchObject({ ok: true, input: { ask: ['ct-rev', 'ct-codex'] } })
  })

  it('private: one recipient, who must be a member', () => {
    expect(
      planGroupSend(
        { way: 'private', text: '私下说一句', to: 'ct-res' },
        MEMBERS,
        {
          moderator: null,
        },
      ),
    ).toEqual({
      ok: true,
      input: { way: 'private', text: '私下说一句', to: 'ct-res' },
    })
    expect(
      planGroupSend({ way: 'private', text: '私下说一句' }, MEMBERS, {
        moderator: null,
      }),
    ).toEqual({ ok: false, reason: '选一位成员私信' })
  })

  it('task: to whom, a title, a deliverable and an access level; the text defaults to the title', () => {
    expect(
      planGroupSend(
        {
          way: 'task',
          text: '',
          to: 'ct-rev',
          task: {
            title: ' 写停止规则说明 ',
            deliverable: '一页 Markdown',
            basis: '',
            access: 'group_files',
          },
        },
        MEMBERS,
        { moderator: null },
      ),
    ).toEqual({
      ok: true,
      input: {
        way: 'task',
        text: '写停止规则说明',
        to: 'ct-rev',
        task: {
          title: '写停止规则说明',
          deliverable: '一页 Markdown',
          access: 'group_files',
        },
      },
    })
    expect(
      planGroupSend(
        {
          way: 'task',
          text: '',
          to: 'ct-rev',
          task: {
            title: '写说明',
            deliverable: '',
            basis: '',
            access: 'readonly',
          },
        },
        MEMBERS,
        { moderator: null },
      ),
    ).toEqual({ ok: false, reason: '写一下交付物：要交出什么' })
  })
})

describe('the message flow: eight kinds', () => {
  it('sorts each message into its kind and gathers independent answers into one card', () => {
    const rows = timelineRows([
      message('m1', 'user', '各自说说', {
        answerMode: 'independent',
        ask: ['ct-arch', 'ct-rev', 'ct-res'],
        batchId: 'gb_1',
      }),
      message('m2', 'ct-arch', '形成环', {
        batchId: 'gb_1',
        answerMode: 'independent',
      }),
      message('m3', 'ct-rev', '费用', {
        batchId: 'gb_1',
        answerMode: 'independent',
      }),
      message('m4', 'ct-res', '客气地来回', {
        batchId: 'gb_1',
        answerMode: 'independent',
      }),
      message('m5', 'ct-rev', '@架构师 主持人什么时候插手？', {
        audience: { kind: 'members', ids: ['ct-arch'] },
        ask: ['ct-arch'],
      }),
      message('m6', 'ct-res', '资料在群文件', {
        audience: { kind: 'private', to: 'ct-wri' },
        private: true,
      }),
      message('m7', 'ct-rev', '写说明', {
        kind: 'task',
        task: {
          taskId: 'gt_1',
          to: 'ct-wri',
          title: '写说明',
          deliverable: '一页',
          access: 'group_files',
          state: 'queued',
        },
      }),
      message('m8', 'ct-wri', '写好了', { kind: 'result' }),
      message('m9', 'ct-emperor', '结论：三条', { kind: 'summary' }),
      message('m10', 'system', '审稿人 这次发言达到工具调用上限，已停下。', {
        kind: 'system',
      }),
      message('m11', 'ct-arch', '同意', { kind: 'pass' }),
    ])
    expect(rows.map((row) => row.kind)).toEqual([
      'user',
      'independent',
      'say',
      'private',
      'task',
      'result',
      'summary',
      'system',
      'pass',
    ])
    const batch = rows[1]!
    expect(batch.kind === 'independent' && batch.batch).toMatchObject({
      batchId: 'gb_1',
      members: ['ct-arch', 'ct-rev', 'ct-res'],
      revealed: true,
    })
  })

  it('keeps the user’s answers to members as lines of their own (GRP-12)', () => {
    const note = message('ga_1', 'system', '你回答了 审稿人 的提问：登录', {
      kind: 'system',
      audience: { kind: 'private', to: 'user' },
      private: true,
      note: {
        id: 'ga_1',
        turnId: 't1',
        contactId: 'ct-rev',
        outcome: 'answered',
        subject: 'question',
        asked: '先看哪一部分？',
        reply: '登录',
        at: 1_750_000_000_100,
      },
    })
    const rows = timelineRows([
      message('m1', 'user', '@审稿人 看看'),
      note,
      message('m2', 'ct-rev', '好，先看登录。'),
    ])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'note', 'say'])
    // Not a speech.
    expect(speechCount([note], 't1')).toBe(0)
  })

  it('keeps an independent card waiting until its answers are revealed', () => {
    const rows = timelineRows([
      message('m1', 'user', '各自说说', {
        answerMode: 'independent',
        ask: ['ct-arch', 'ct-rev'],
        batchId: 'gb_2',
      }),
      message('m2', 'ct-arch', '我先想好了', {
        batchId: 'gb_2',
        answerMode: 'independent',
        hidden: true,
      }),
    ])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'independent'])
    const card = rows[1]!
    expect(card.kind === 'independent' && card.batch.revealed).toBe(false)
  })

  it('counts this turn’s speeches: not a pass, not the system, not the user', () => {
    expect(
      speechCount(
        [
          message('a', 'user', 'q'),
          message('b', 'ct-arch', 'x'),
          message('c', 'ct-rev', 'y', { kind: 'pass' }),
          message('d', 'system', 'z', { kind: 'system' }),
          message('e', 'ct-rev', 'w', { kind: 'task' }),
          message('f', 'ct-arch', 'old', { turnId: 't0' }),
        ],
        't1',
      ),
    ).toBe(2)
  })

  it('folds a message longer than 12 lines', () => {
    expect(isLongMessage('一行')).toBe(false)
    expect(
      isLongMessage(Array.from({ length: 13 }, (_, i) => `${i}`).join('\n')),
    ).toBe(true)
    expect(isLongMessage('长'.repeat(1200))).toBe(true)
  })

  it('labels a private message for the user', () => {
    expect(privateLabel('写作者')).toBe(
      '🔒 私信 → 写作者 · 其他成员看不到，你能看到',
    )
  })
})

describe('the live bar and the members’ status', () => {
  it('says who speaks, who waits, how long, how many speeches and what it cost — no cap', () => {
    expect(formatSpend(0.8612)).toBe('$0.86')
    expect(formatSpend(0)).toBe('$0')
    expect(formatDuration(192_000)).toBe('3 分 12 秒')
    expect(formatDuration(9_000)).toBe('9 秒')
    expect(
      liveBarParts({
        turn: {
          turnId: 't1',
          state: 'speaking',
          spend: { usd: 0.86, tokens: 1200 },
          startedAt: 1_000,
          speakers: ['ct-arch'],
          queued: ['ct-wri'],
        },
        names: (id) => ({ 'ct-arch': '架构师', 'ct-wri': '写作者' })[id] ?? id,
        tasks: new Set(['ct-wri']),
        speeches: 7,
        now: 193_000,
      }),
    ).toEqual({
      running: true,
      speaking: '正在发言：架构师',
      queued: '排队：写作者（交办）',
      totals: '本轮 3 分 12 秒 · 7 次发言 · $0.86',
      spend: '本轮 $0.86 · 不设上限',
    })
  })

  it('says how a turn ended', () => {
    expect(
      liveBarParts({
        turn: {
          turnId: 't1',
          state: 'paused',
          reason: 'loop_guard',
          spend: { usd: 0.2, tokens: 10 },
          startedAt: 1_000,
          speakers: [],
          queued: [],
        },
        names: (id) => id,
        tasks: new Set(),
        speeches: 4,
        now: 61_000,
        endedAt: 31_000,
      }),
    ).toMatchObject({
      running: false,
      speaking: '本轮已暂停：两位成员来回没有新进展',
      totals: '本轮 30 秒 · 4 次发言 · $0.20',
    })
  })

  it('says a turn ended on a task relay or a run of 没有补充 (GRP-15)', () => {
    const ended = (state: 'paused' | 'finished', reason: string) =>
      liveBarParts({
        turn: {
          turnId: 't1',
          state,
          reason,
          spend: { usd: 0, tokens: 0 },
          startedAt: 1_000,
          speakers: [],
          queued: [],
        },
        names: (id) => id,
        tasks: new Set(),
        speeches: 9,
        now: 61_000,
      }).speaking
    expect(ended('paused', 'task_relay')).toBe(
      '本轮已暂停：同一位成员交办的次数多了，回复「继续」接着做',
    )
    expect(ended('finished', 'pass_streak')).toBe('本轮已结束：大家都没有补充')
  })

  it('gives each member one status line', () => {
    const base = {
      moderator: 'ct-emperor',
      status: 'idle' as const,
      tool: false,
      pending: null,
      task: false,
    }
    expect(memberStatusLine(MEMBERS[0]!, base)).toEqual({
      text: '主持人 · 空闲',
      tone: 'idle',
    })
    expect(
      memberStatusLine(MEMBERS[1]!, { ...base, status: 'thinking' }),
    ).toEqual({ text: '发言中', tone: 'busy' })
    expect(
      memberStatusLine(MEMBERS[1]!, {
        ...base,
        status: 'thinking',
        tool: true,
      }),
    ).toEqual({ text: '执行中', tone: 'busy' })
    expect(
      memberStatusLine(MEMBERS[2]!, { ...base, status: 'queued', task: true }),
    ).toEqual({ text: '排队 · 交办任务', tone: 'queued' })
    expect(
      memberStatusLine(MEMBERS[2]!, {
        ...base,
        status: 'thinking',
        pending: { id: 'ask_1', kind: 'ask', status: 'waiting' },
      }),
    ).toEqual({ text: '等你回答', tone: 'ask' })
    expect(memberStatusLine(MEMBERS[2]!, { ...base, status: 'error' })).toEqual(
      {
        text: '出错',
        tone: 'error',
      },
    )
    expect(memberStatusLine(MEMBERS[4]!, base)).toEqual({
      text: '外部 · 只读 · 只在被 @ 时',
      tone: 'idle',
    })
    expect(
      memberStatusLine(member('ct-gone', 'ct-gone', { missing: true }), base),
    ).toEqual({ text: '联系人已删除', tone: 'idle' })
  })
})
