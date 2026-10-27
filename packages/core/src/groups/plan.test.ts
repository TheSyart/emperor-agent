// GRP-07: what a new group message puts in the speaking queue. Pure: the
// scheduler executes these items; no quota appears anywhere.
import { describe, expect, it } from 'vitest'
import { foldGroupEvents, type GroupLogEvent } from './events'
import { assignTask, planFor } from './plan'
import type { GroupMember, GroupMessage, GroupSettings } from './types'

const ROSTER: GroupMember[] = [
  { id: 'ct-emperor', name: 'Emperor', intro: '主持人', speak: 'relevant' },
  { id: 'ct-arch', name: '架构师', intro: '系统设计', speak: 'relevant' },
  { id: 'ct-rev', name: '审稿人', intro: '评审', speak: 'relevant' },
  { id: 'ct-res', name: '研究员', intro: '调研', speak: 'always' },
  {
    id: 'ct-cc',
    name: 'Claude Code',
    intro: '外部',
    external: true,
    speak: 'mentioned',
  },
]
function state(
  settings: Partial<GroupSettings> = {},
  moderator: string | null = 'ct-emperor',
) {
  return foldGroupEvents([
    {
      type: 'group/created',
      data: {
        title: 'g',
        moderator,
        members: ROSTER.map((m) => m.id),
        charter: '',
        settings: {
          collaboration: 'autonomous',
          quiet: false,
          summarizeAtEnd: true,
          loopGuard: true,
          ...settings,
        },
      },
    } as GroupLogEvent,
  ])
}
function msg(m: Partial<GroupMessage>): GroupMessage {
  return {
    id: 'm1',
    turnId: 't',
    from: 'user',
    audience: { kind: 'all' },
    ask: [],
    answerMode: 'relay',
    kind: 'say',
    text: '',
    at: 0,
    ...m,
  }
}

describe('planFor · from the user', () => {
  it('an @ asks those members in @ order, each seeing the one before', () => {
    expect(
      planFor(
        msg({
          ask: ['ct-rev', 'ct-arch'],
          audience: { kind: 'members', ids: ['ct-rev', 'ct-arch'] },
        }),
        state(),
        ROSTER,
      ),
    ).toEqual([
      { kind: 'speak', member: 'ct-rev', reason: 'asked', source: 'm1' },
      { kind: 'speak', member: 'ct-arch', reason: 'asked', source: 'm1' },
    ])
  })

  it('independent answers become one blind batch', () => {
    expect(
      planFor(
        msg({
          ask: ['ct-arch', 'ct-rev'],
          answerMode: 'independent',
          batchId: 'b1',
        }),
        state(),
        ROSTER,
      ),
    ).toEqual([
      {
        kind: 'batch',
        members: ['ct-arch', 'ct-rev'],
        batchId: 'b1',
        source: 'm1',
      },
    ])
  })

  it('autonomous: a broadcast polls the members who speak when relevant, and queues those who always speak', () => {
    expect(planFor(msg({}), state(), ROSTER)).toEqual([
      {
        kind: 'poll',
        members: ['ct-emperor', 'ct-arch', 'ct-rev'],
        source: 'm1',
      },
      { kind: 'speak', member: 'ct-res', reason: 'always', source: 'm1' },
    ])
  })

  it('moderated: a broadcast goes to the moderator to plan', () => {
    expect(
      planFor(msg({}), state({ collaboration: 'moderated' }), ROSTER),
    ).toEqual([
      {
        kind: 'speak',
        member: 'ct-emperor',
        reason: 'moderator-plan',
        source: 'm1',
      },
    ])
  })

  it('moderated without a moderator falls back to raising hands', () => {
    const items = planFor(
      msg({}),
      state({ collaboration: 'moderated' }, null),
      ROSTER,
    )
    expect(items[0]).toMatchObject({ kind: 'poll' })
  })

  it('quiet mode: a broadcast starts nobody and says how to get an answer', () => {
    expect(planFor(msg({}), state({ quiet: true }), ROSTER)).toEqual([
      {
        kind: 'notice',
        text: '安静模式下只有被 @ 的成员发言：@ 一位成员，或在群设置里关掉安静模式。',
        source: 'm1',
      },
    ])
  })

  it('a task queues the assignee, never for review', () => {
    const task = {
      taskId: 'gt1',
      to: 'ct-rev',
      title: 't',
      deliverable: 'd',
      access: 'readonly' as const,
      state: 'queued' as const,
    }
    expect(
      planFor(
        msg({ kind: 'task', ask: ['ct-rev'], task }),
        state({ collaboration: 'moderated' }),
        ROSTER,
      ),
    ).toEqual([{ kind: 'task', task, source: 'm1' }])
  })
})

describe('planFor · from a member', () => {
  it('a member who mentions nobody ends that line', () => {
    expect(planFor(msg({ from: 'ct-arch' }), state(), ROSTER)).toEqual([])
  })

  it('autonomous: a member @-ing another queues them directly', () => {
    expect(
      planFor(msg({ from: 'ct-rev', ask: ['ct-arch'] }), state(), ROSTER),
    ).toEqual([
      { kind: 'speak', member: 'ct-arch', reason: 'mention', source: 'm1' },
    ])
  })

  it('moderated: a member’s @ or task goes to the moderator for review first', () => {
    const s = state({ collaboration: 'moderated' })
    expect(
      planFor(msg({ from: 'ct-rev', ask: ['ct-arch'] }), s, ROSTER),
    ).toEqual([
      { kind: 'review', reviewer: 'ct-emperor', message: 'm1', source: 'm1' },
    ])
  })

  it('the moderator’s own @ needs no review', () => {
    const s = state({ collaboration: 'moderated' })
    expect(
      planFor(msg({ from: 'ct-emperor', ask: ['ct-arch'] }), s, ROSTER),
    ).toEqual([
      { kind: 'speak', member: 'ct-arch', reason: 'mention', source: 'm1' },
    ])
  })

  it('ignores a member @-ing itself or someone outside the group', () => {
    expect(
      planFor(
        msg({ from: 'ct-rev', ask: ['ct-rev', 'ct-nobody', 'ct-arch'] }),
        state(),
        ROSTER,
      ),
    ).toEqual([
      { kind: 'speak', member: 'ct-arch', reason: 'mention', source: 'm1' },
    ])
  })
})

describe('assignTask · the chain never loops back', () => {
  it('extends the chain with the assigner', () => {
    expect(assignTask('ct-rev', 'ct-arch', [])).toEqual(['ct-rev'])
    expect(assignTask('ct-arch', 'ct-res', ['ct-rev'])).toEqual([
      'ct-rev',
      'ct-arch',
    ])
  })

  it('refuses a task back to anyone up the chain, or to oneself', () => {
    expect(() => assignTask('ct-arch', 'ct-rev', ['ct-rev'])).toThrow(/绕回/)
    expect(() => assignTask('ct-res', 'ct-rev', ['ct-rev', 'ct-arch'])).toThrow(
      /绕回/,
    )
    expect(() => assignTask('ct-arch', 'ct-arch', [])).toThrow(/自己/)
  })
})
