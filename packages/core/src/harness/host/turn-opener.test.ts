// UI-S15: what opened a root turn decides whether it starts a task — a
// message the user or a scheduler sent — or continues the running one: a
// result that woke the session (a subagent, Claude Code or Codex, a
// background job), a goal round, anything else.
import { describe, expect, it } from 'vitest'
import { DELEGATION_NOTICE_PRODUCER } from '../delegation/notices'
import { GOAL_ROUND_PRODUCER } from '../goal/round-driver'
import { JOB_NOTICE_PRODUCER } from '../jobs/registry'
import { TURN_OPENER_PRODUCERS, turnOpener } from './turn-opener'

const context = (producer: string) => ({ kind: 'context' as const, producer })
const runtime = context('runtime-context')

describe('turnOpener', () => {
  it('a message the user (or a scheduler) sent opens a task, whatever else is there', () => {
    expect(turnOpener([{ kind: 'user' }])).toBe('user')
    expect(turnOpener([runtime, { kind: 'user' }])).toBe('user')
    expect(turnOpener([context('subagent'), { kind: 'user' }])).toBe('user')
  })

  it('a message inserted into the running turn opens nothing', () => {
    expect(turnOpener([{ kind: 'user', steering: true }])).toBe('other')
    expect(
      turnOpener([context('subagent'), { kind: 'user', steering: true }]),
    ).toBe('subagent')
  })

  it('a subagent’s result, Claude Code’s or Codex’s, wakes the session to continue', () => {
    expect(turnOpener([context('subagent'), runtime])).toBe('subagent')
    expect(turnOpener([context('delegation')])).toBe('subagent')
    expect(turnOpener([context('jobs'), context('subagent')])).toBe('subagent')
  })

  it('a background job’s result continues as a job; a goal round, as a goal', () => {
    expect(turnOpener([context('jobs'), runtime])).toBe('job')
    expect(turnOpener([context('goal')])).toBe('goal')
    expect(turnOpener([context('jobs'), context('goal')])).toBe('job')
  })

  it('anything else continues the task without a reason', () => {
    expect(turnOpener([])).toBe('other')
    expect(turnOpener([runtime, context('task-budget')])).toBe('other')
  })

  it('names the producers the harness writes', () => {
    expect(TURN_OPENER_PRODUCERS).toEqual({
      subagent: 'subagent',
      delegation: DELEGATION_NOTICE_PRODUCER,
      job: JOB_NOTICE_PRODUCER,
      goal: GOAL_ROUND_PRODUCER,
    })
  })
})
