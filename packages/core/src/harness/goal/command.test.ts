// `/goal` human command (ports dsh command-goal.spec).
import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '../../llm/types'
import { createTestHarness } from '../testing'
import {
  GOAL_COMMAND_USAGE,
  GoalService,
  installGoal,
  parseGoalCommand,
  runGoalCommand,
} from './index'

function setup() {
  const h = createTestHarness()
  const agent = h.agent()
  const goals = new GoalService()
  const run = (input: string, attachments?: ContentBlock[]) =>
    runGoalCommand(
      goals,
      agent,
      input,
      attachments === undefined ? {} : { attachments },
    )
  return { h, agent, goals, run }
}

const image: ContentBlock = {
  type: 'image',
  attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 2 },
}

describe('/goal human command', () => {
  it('shows an empty status without mutating the session', () => {
    const { agent, run } = setup()
    expect(run('')).toEqual({
      kind: 'success',
      text: `No goal is currently set.\n${GOAL_COMMAND_USAGE}`,
    })
    expect(agent.session.events).toEqual([])
  })

  it('creates a trimmed objective and refuses silent replacement of unfinished work', () => {
    const { goals, agent, run } = setup()
    const created = run('  ship the feature  ')
    expect(created.kind).toBe('success')
    expect(created.text).toBe(
      [
        'Goal created',
        'Status: active',
        'Objective: ship the feature',
        'Rounds: 0/256',
        'Activation: armed',
        '',
        'Commands: /goal edit <objective>, /goal pause, /goal clear',
      ].join('\n'),
    )
    expect(run('something else')).toEqual({
      kind: 'error',
      text: 'A goal is already active. Use /goal edit <objective> to change it or /goal clear before replacing it.',
    })
    expect(goals.get(agent)?.objective).toBe('ship the feature')
  })

  it('treats only exact control words as controls and accepts a full /goal line', () => {
    expect(parseGoalCommand('PAUSE')).toEqual({ kind: 'pause' })
    expect(parseGoalCommand('pause after verification')).toEqual({
      kind: 'create',
      objective: 'pause after verification',
    })
    expect(parseGoalCommand('Edit  new text ')).toEqual({
      kind: 'edit',
      objective: 'new text',
    })
    expect(parseGoalCommand('edit')).toEqual({ kind: 'invalid-edit' })
    expect(parseGoalCommand('editorial pass')).toEqual({
      kind: 'create',
      objective: 'editorial pass',
    })
    expect(parseGoalCommand('/goal resume')).toEqual({ kind: 'resume' })
    expect(parseGoalCommand('/goal')).toEqual({ kind: 'show' })
  })

  it('edits inline, requires an objective, and starts a new goal when the old one is complete', () => {
    const { goals, agent, run } = setup()
    expect(run('edit x')).toEqual({
      kind: 'error',
      text: `No goal is currently set; /goal edit requires one. ${GOAL_COMMAND_USAGE}`,
    })
    run('first')
    expect(run('edit')).toEqual({
      kind: 'error',
      text: `Goal editing requires a replacement objective.\n${GOAL_COMMAND_USAGE}`,
    })
    const edited = run('edit second')
    expect(edited.text.split('\n')[0]).toBe('Goal updated')
    expect(goals.get(agent)).toMatchObject({
      objective: 'second',
      revision: 2,
      activation: 'armed',
    })
    const current = goals.get(agent)!
    goals.complete(agent, current)
    const replaced = run('edit third')
    expect(replaced.text.split('\n')[0]).toBe('Goal created')
    expect(goals.get(agent)).toMatchObject({ objective: 'third', revision: 1 })
    expect(goals.get(agent)?.id).not.toBe(current.id)
  })

  it('returns direct missing-state results for pause, resume, and clear', () => {
    const { run } = setup()
    expect(run('pause')).toEqual({
      kind: 'error',
      text: `No goal is currently set; /goal pause requires one. ${GOAL_COMMAND_USAGE}`,
    })
    expect(run('resume')).toEqual({
      kind: 'error',
      text: `No goal is currently set; /goal resume requires one. ${GOAL_COMMAND_USAGE}`,
    })
    expect(run('clear')).toEqual({ kind: 'success', text: 'No goal to clear.' })
  })

  it('pauses, resumes, clears, and converts expected domain rejections', () => {
    const { goals, agent, run } = setup()
    run('long task')
    expect(run('resume')).toEqual({
      kind: 'error',
      text: 'The goal command is not valid for the current state. Run /goal to view available commands.',
    })
    expect(run('pause').text).toContain('Goal paused\nStatus: paused')
    expect(run('pause').kind).toBe('error')
    expect(run('resume').text).toContain('Goal resumed\nStatus: active')
    expect(run('clear')).toEqual({ kind: 'success', text: 'Goal cleared.' })
    expect(goals.get(agent)).toBeUndefined()
  })

  it('shows every durable phase and distinguishes disarmed active state', () => {
    const { goals, agent, run } = setup()
    run('phases')
    goals.disarm(agent)
    expect(run('').text).toContain(
      'Activation: disarmed\n\nCommands: /goal edit <objective>, /goal resume, /goal clear',
    )
    const goal = goals.block(agent, goals.get(agent)!, {
      code: 'needs-input',
      message: 'Pick one.',
    })
    expect(run('').text).toContain(
      'Status: blocked\nBlocker: needs-input: Pick one.\nObjective: phases',
    )
    goals.complete(agent, goal)
    expect(run('').text).toContain('Status: complete')
    expect(run('').text).toContain('Commands: /goal <objective>, /goal clear')
  })

  it('does not turn unexpected failures into command results', () => {
    const { agent } = setup()
    const broken = {
      get: () => {
        throw new Error('boom')
      },
    } as unknown as GoalService
    expect(() => runGoalCommand(broken, agent, '')).toThrow('boom')
  })
})

describe('/goal image attachments', () => {
  it('submits one user followup carrying the images ahead of the round prompt', async () => {
    const { h, agent, goals, run } = setup()
    installGoal(
      { prompt: h.prompt, middleware: h.middleware },
      goals,
    ).driver.attach(agent)
    h.adapter.push({ text: 'seen' }, { text: 'round' })
    expect(run('match the mockup', [image]).kind).toBe('success')
    await agent.whenIdle()
    const first = agent.session.events.find((e) => e.type === 'user/message')
    expect(first?.type === 'user/message' && first.data).toMatchObject({
      source: { kind: 'user' },
      content: [
        image,
        { type: 'text', text: 'Reference images for the goal objective.' },
      ],
    })
  })

  it('rejects attachments on sub-commands that cannot use them and on refused creation', () => {
    const { agent, goals, run } = setup()
    expect(run('pause', [image])).toEqual({
      kind: 'error',
      text: 'Image attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.',
    })
    run('first')
    const before = agent.inbox.nextTurn.length
    expect(run('second', [image]).kind).toBe('error')
    expect(agent.inbox.nextTurn.length).toBe(before)
    expect(goals.get(agent)?.objective).toBe('first')
  })
})
