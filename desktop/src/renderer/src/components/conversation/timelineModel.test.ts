import { describe, expect, it } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from '../../conversation/chatSnapshot'
import { LogBuilder, replay } from '../../conversation/testing/fixtures'
import { activeTurnTick, promptPreview, turnTicks } from './timelineModel'

function threeTurns() {
  const log = new LogBuilder()
  const prompts = [
    '第一轮：  帮我\n看看登录页',
    '第二轮：把这个很长很长的提示词截断到四十个字符以内，这样悬停提示不会太长也不会换行太多次',
    '第三轮',
  ]
  prompts.forEach((prompt, index) => {
    const turn = index + 1
    log.user(`u${turn}`, prompt)
    log.add('turn/start', { turn })
    log.add('step/start', { turn, step: 1 })
    log.message(turn, 1, [{ type: 'text', text: `回复 ${turn}` }])
    log.add('step/end', { turn, step: 1 })
    log.add('turn/end', { turn, reason: { kind: 'completed' } })
  })
  return replay(log.events).snapshot
}

describe('turnTicks', () => {
  it('is empty without user messages', () => {
    expect(turnTicks(null)).toEqual([])
    expect(turnTicks(EMPTY_CHAT_SNAPSHOT)).toEqual([])
  })

  it('emits one tick per user message with a 40-character preview', () => {
    const snapshot = threeTurns()
    const ticks = turnTicks(snapshot)
    expect(ticks.map((tick) => tick.turn)).toEqual([1, 2, 3])
    expect(ticks[0]?.label).toBe('第一轮： 帮我 看看登录页')
    expect([...(ticks[1]?.label ?? '')]).toHaveLength(41)
    expect(ticks[1]?.label.endsWith('…')).toBe(true)
    for (const tick of ticks) {
      expect(snapshot.order[tick.index]).toBe(tick.key)
      expect(snapshot.nodes.get(tick.key)?.kind).toBe('user')
    }
  })
})

describe('activeTurnTick', () => {
  it('follows the first visible row', () => {
    const snapshot = threeTurns()
    const ticks = turnTicks(snapshot)
    const order = snapshot.order
    expect(activeTurnTick([], order, null)).toBe(-1)
    // Pinned to the bottom before any scroll report: the last turn.
    expect(activeTurnTick(ticks, order, null)).toBe(2)
    expect(activeTurnTick(ticks, order, ticks[0]!.key)).toBe(0)
    // A reply row of turn 2 belongs to turn 2.
    expect(activeTurnTick(ticks, order, order[ticks[1]!.index + 1]!)).toBe(1)
    expect(activeTurnTick(ticks, order, ticks[2]!.key)).toBe(2)
    expect(activeTurnTick(ticks, order, 'unknown')).toBe(2)
  })
})

describe('promptPreview', () => {
  it('collapses whitespace and cuts by characters', () => {
    expect(promptPreview('  a\n\tb  ')).toBe('a b')
    expect(promptPreview('abcdef', 3)).toBe('abc…')
    expect(promptPreview('😀😀😀😀', 2)).toBe('😀😀…')
  })
})
