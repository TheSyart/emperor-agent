/**
 * query_state 契约 (MIG-CORE-007)。移植 Python tests/unit/test_query_state.py。
 */
import { describe, expect, it } from 'vitest'
import {
  TransitionReason,
  beginIteration,
  emptyResponseRetry,
  lengthRecovery,
  makeQueryState,
  maxTurnsReached,
  nearMaxTurns,
  todoFollowup,
  toolFollowup,
} from './query-state'

describe('query_state (test_query_state.py)', () => {
  it('tracks iteration and max turns', () => {
    const state = makeQueryState({ turnId: 'turn_1', maxTurns: 1 })
    const first = beginIteration(state)
    const blocked = maxTurnsReached(first.nextState)
    expect(first.reason).toBe(TransitionReason.ITERATION)
    expect(first.nextState.turnCount).toBe(1)
    expect(blocked).not.toBeNull()
    expect(blocked!.reason).toBe(TransitionReason.MAX_TURNS)
    expect(blocked!.terminalReply).toBe('（达到 max_turns=1 上限，未办妥；history 中已有部分进展）')
  })

  it('nearMaxTurns injects a one-shot wrap-up reminder two turns before the limit', () => {
    const state = makeQueryState({ maxTurns: 5, turnCount: 3 })
    const warning = nearMaxTurns(state)
    expect(warning).not.toBeNull()
    expect(warning!.messages).toHaveLength(1)
    expect(warning!.messages[0]!.role).toBe('user')
    expect(String(warning!.messages[0]!.content)).toContain('回合上限')
    expect(String(warning!.messages[0]!.content)).toContain('交付报告')
    expect(warning!.nextState.finalWarningIssued).toBe(true)
    expect(nearMaxTurns(warning!.nextState)).toBeNull()
  })

  it('nearMaxTurns stays silent for small limits, other turns, or unlimited turns', () => {
    expect(nearMaxTurns(makeQueryState({ maxTurns: 2, turnCount: 0 }))).toBeNull()
    expect(nearMaxTurns(makeQueryState({ maxTurns: 4, turnCount: 2 }))).toBeNull()
    expect(nearMaxTurns(makeQueryState({ maxTurns: 5, turnCount: 2 }))).toBeNull()
    expect(nearMaxTurns(makeQueryState({ maxTurns: null, turnCount: 3 }))).toBeNull()
  })

  it('empty response retry has message and event', () => {
    const transition = emptyResponseRetry(makeQueryState(), { maxRetries: 2 })
    expect(transition).not.toBeNull()
    expect(transition!.reason).toBe(TransitionReason.EMPTY_RESPONSE_RETRY)
    expect(transition!.nextState.emptyRetries).toBe(1)
    expect(transition!.messages).toEqual([{ role: 'user', content: '（上一轮无任何输出，请继续推进或给出最终答复）' }])
    expect(transition!.events).toEqual([{ event: 'tool_error', name: '_empty_response', message: 'empty response, retry 1/2' }])
  })

  it('length recovery preserves partial reply with turn id', () => {
    const transition = lengthRecovery(makeQueryState({ turnId: 'turn_1' }), 'partial', { maxRetries: 3 })
    expect(transition).not.toBeNull()
    expect(transition!.reason).toBe(TransitionReason.LENGTH_RECOVERY)
    expect(transition!.nextState.lengthRetries).toBe(1)
    expect(transition!.messages).toEqual([
      { role: 'assistant', content: 'partial', turn_id: 'turn_1' },
      { role: 'user', content: '（上一轮被 max_tokens 截断，请从中断处续写，不要重复已输出内容）' },
    ])
    expect(transition!.events[0]!.message).toBe('truncated, continuing 1/3')
  })

  it('tool followup resets retry counters', () => {
    const transition = toolFollowup(makeQueryState({ emptyRetries: 1, lengthRetries: 1 }))
    expect(transition.reason).toBe(TransitionReason.TOOL_FOLLOWUP)
    expect(transition.nextState.emptyRetries).toBe(0)
    expect(transition.nextState.lengthRetries).toBe(0)
  })

  it('todo followup builds continuation prompt', () => {
    const transition = todoFollowup(makeQueryState(), { unfinishedText: '  [ ] 1. Run tests', unfinishedCount: 1 })
    expect(transition.reason).toBe(TransitionReason.TODO_CONTINUATION)
    expect(transition.nextState.transition).toBe(TransitionReason.TODO_CONTINUATION)
    expect(transition.messages).toEqual([
      { role: 'user', content: '差事尚未办妥，以下任务仍未完成，请按计划继续执行，并按规矩更新 todolist 状态：\n  [ ] 1. Run tests' },
    ])
    expect(transition.events).toEqual([])
  })
})
