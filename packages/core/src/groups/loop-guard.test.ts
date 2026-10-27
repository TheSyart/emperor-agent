// GRP-07 · 防打转: not a quota. Only two members trading messages count, and
// only when their last two messages bring almost nothing new.
import { describe, expect, it } from 'vitest'
import {
  LOOP_MIN_EXCHANGES,
  LOOP_NOVELTY,
  loopStall,
  novelty,
} from './loop-guard'
import type { GroupMessage } from './types'

let n = 0
function say(
  from: string,
  text: string,
  kind: GroupMessage['kind'] = 'say',
): GroupMessage {
  n += 1
  return {
    id: `m${n}`,
    turnId: 't',
    from,
    audience: { kind: 'all' },
    ask: [],
    answerMode: 'relay',
    kind,
    text,
    at: 0,
  }
}

describe('novelty', () => {
  it('is 0 for a repeat and 1 for something entirely new', () => {
    expect(
      novelty('我同意你的看法，就这么定吧', ['我同意你的看法，就这么定吧']),
    ).toBe(0)
    expect(novelty('数据库要加索引', ['前端按钮颜色太浅'])).toBe(1)
  })

  it('ignores punctuation, spaces and letter case', () => {
    expect(novelty('Agree. Ship it!', ['agree ship it'])).toBe(0)
  })

  it('compares against the most similar earlier message', () => {
    const v = novelty('我同意，就这么定', [
      '完全无关的话题内容',
      '我同意，就这么定',
    ])
    expect(v).toBe(0)
  })

  it('ignores @-mentions: who is addressed is not new content', () => {
    expect(
      novelty('@审稿人 好的，方案可以，就这么定吧', [
        '@架构师 好的，方案可以，就这么定吧',
      ]),
    ).toBe(0)
  })

  it('treats an empty reply as nothing new', () => {
    expect(novelty('', ['什么都行'])).toBe(0)
  })
})

describe('loopStall', () => {
  it('flags two members politely agreeing back and forth', () => {
    const log = [
      say('ct-a', '我觉得方案可以，就这么定吧'),
      say('ct-b', '同意，我觉得方案可以，就这么定'),
      say('ct-a', '好的，方案可以，就这么定吧'),
      say('ct-b', '同意，方案可以，就这么定吧'),
    ]
    expect(loopStall(log)).toEqual({ stalled: true, pair: ['ct-a', 'ct-b'] })
  })

  it('does not flag a real discussion that keeps adding content', () => {
    const log = [
      say('ct-a', '停止规则要覆盖没人点名的情况'),
      say('ct-b', '还要考虑用户中途插话时怎么重排队列'),
      say('ct-a', '主持人结论应当列出分歧和各自的理由'),
      say('ct-b', '外部成员续聊时复用同一个委派，费用更低'),
    ]
    expect(loopStall(log).stalled).toBe(false)
  })

  it(`needs at least ${LOOP_MIN_EXCHANGES} alternating messages`, () => {
    const log = [
      say('ct-a', '同意，就这么定'),
      say('ct-b', '同意，就这么定'),
      say('ct-a', '同意，就这么定'),
    ]
    expect(loopStall(log).stalled).toBe(false)
  })

  it('does not count three members taking turns', () => {
    const log = [
      say('ct-a', '同意，就这么定'),
      say('ct-b', '同意，就这么定'),
      say('ct-c', '同意，就这么定'),
      say('ct-a', '同意，就这么定'),
      say('ct-b', '同意，就这么定'),
    ]
    expect(loopStall(log).stalled).toBe(false)
  })

  it('starts counting again after the user speaks', () => {
    const log = [
      say('ct-a', '同意，就这么定'),
      say('ct-b', '同意，就这么定'),
      say('user', '那就这样，谢谢'),
      say('ct-a', '同意，就这么定'),
      say('ct-b', '同意，就这么定'),
    ]
    expect(loopStall(log).stalled).toBe(false)
  })

  it('ignores system lines and 没有补充 between the two', () => {
    const log = [
      say('ct-a', '我觉得方案可以，就这么定吧'),
      say('ct-b', '同意，我觉得方案可以，就这么定'),
      say('system', '研究员 没有补充', 'system'),
      say('ct-a', '好的，方案可以，就这么定吧'),
      say('ct-c', '', 'pass'),
      say('ct-b', '同意，方案可以，就这么定吧'),
    ]
    expect(loopStall(log).stalled).toBe(true)
  })

  it('does not flag when only the last message repeats', () => {
    const log = [
      say('ct-a', '停止规则要覆盖没人点名的情况'),
      say('ct-b', '还要考虑用户中途插话时怎么重排队列'),
      say('ct-a', '主持人结论应当列出分歧和各自的理由'),
      say('ct-b', '主持人结论应当列出分歧和各自的理由'),
    ]
    expect(loopStall(log).stalled).toBe(false)
  })

  it('exposes its threshold as a constant between 0 and 1', () => {
    expect(LOOP_NOVELTY).toBeGreaterThan(0)
    expect(LOOP_NOVELTY).toBeLessThan(1)
  })
})
