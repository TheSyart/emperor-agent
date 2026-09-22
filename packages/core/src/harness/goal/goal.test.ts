// Goal domain: service mutations, CAS revisions, and strict replay (ports dsh goal.spec).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessError } from '../../llm/error'
import { contextMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import { createTestHarness } from '../testing'
import {
  decodeGoalChange,
  foldGoal,
  GoalError,
  GoalService,
  type GoalView,
} from './index'

afterEach(() => {
  vi.useRealTimers()
})

function setup(options: ConstructorParameters<typeof GoalService>[0] = {}) {
  const h = createTestHarness()
  const agent = h.agent()
  return { h, agent, session: agent.session, goals: new GoalService(options) }
}

/** Reserve and admit one round directly in the log (what the driver + loop do). */
function appendRound(
  session: Session,
  goal: Pick<GoalView, 'id' | 'revision'>,
  round: number,
): void {
  const message = contextMessage('goal', `<goal_round>${round}</goal_round>`)
  session.append('goal/round', {
    goalId: goal.id,
    revision: goal.revision,
    round,
    messageId: message.id,
  })
  session.append('user/message', message, { surfaceOp: 'append' })
}

function change(data: Record<string, unknown>, seq = 0): SessionEvent {
  return { type: 'goal/change', seq, time: 0, data } as unknown as SessionEvent
}

function snapshot(
  overrides: Record<string, unknown> = {},
  goal: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: {
      id: 'g1',
      revision: 1,
      objective: 'x',
      phase: 'active',
      maxGoalRounds: 4,
      ...goal,
    },
    roundsStarted: 0,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

describe('GoalService creation and replay', () => {
  it('applies the configured default and writes one durable goal change', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const { goals, agent, session } = setup({ defaultMaxGoalRounds: 17 })
    const seen: string[] = []
    goals.onChange(({ change }) => {
      seen.push(change.operation)
    })
    const goal = goals.create(agent, { objective: '  finish the feature  ' })
    expect(goal).toMatchObject({
      objective: 'finish the feature',
      phase: 'active',
      revision: 1,
      maxGoalRounds: 17,
      roundsStarted: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      activation: 'armed',
    })
    expect(goal.id).toMatch(/^goal-/)
    expect(seen).toEqual(['create'])
    expect(session.events.map((event) => event.type)).toEqual(['goal/change'])
    const decoded = decodeGoalChange(session.events[0]!.data)
    expect(decoded).toMatchObject({
      operation: 'create',
      goal: { id: goal.id },
    })
    expect(agent.inbox.nextStep).toEqual([])
    expect(session.deriveMessages()).toEqual([])
    expect(foldGoal(session.events)).toMatchObject({
      goal: { id: goal.id },
      roundsStarted: 0,
    })
  })

  it('uses 256 rounds by default and validates create input', () => {
    const { goals, agent } = setup()
    expect(() => goals.create(agent, { objective: '   ' })).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_OBJECTIVE' }),
    )
    expect(() =>
      goals.create(agent, { objective: 'x', maxGoalRounds: 0 }),
    ).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_MAX_ROUNDS' }))
    expect(() =>
      goals.create(agent, { objective: 'x', maxGoalRounds: 1.5 }),
    ).toThrow(GoalError)
    expect(() =>
      goals.create(agent, { objective: 'x', maxGoalRounds: 1.5 }),
    ).toThrow(HarnessError)
    expect(() =>
      goals.create(agent, {
        objective: 'x',
        maxGoalRounds: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(GoalError)
    expect(goals.create(agent, { objective: 'x' }).maxGoalRounds).toBe(256)
  })

  it('rejects invalid configuration', () => {
    expect(() => new GoalService({ defaultMaxGoalRounds: 0 })).toThrow(
      GoalError,
    )
    expect(() => new GoalService({ blockedAfterConsecutiveRounds: 0 })).toThrow(
      TypeError,
    )
  })

  it('restores a persisted goal and rounds with activation disarmed', () => {
    const { goals, agent, session } = setup()
    const goal = goals.create(agent, {
      objective: 'survive restart',
      maxGoalRounds: 3,
    })
    appendRound(session, goal, 1)
    const restarted = new GoalService()
    expect(restarted.current(session)).toMatchObject({
      id: goal.id,
      phase: 'active',
      roundsStarted: 1,
      activation: 'disarmed',
    })
    const resumed = restarted.resume(agent, goal)
    expect(resumed).toMatchObject({ revision: 2, activation: 'armed' })
  })

  it('lets a lifecycle owner disarm without writing a durable revision', () => {
    const { goals, agent, session } = setup()
    goals.create(agent, { objective: 'disarm' })
    const seen: string[] = []
    goals.onChange(({ change }) => {
      seen.push(change.operation)
    })
    const before = session.seq
    expect(goals.disarm(agent)).toMatchObject({
      revision: 1,
      activation: 'disarmed',
    })
    expect(session.seq).toBe(before)
    expect(seen).toEqual([])
  })
})

describe('GoalService mutations', () => {
  it('edits with compare-and-set revisions and rejects empty edits', () => {
    const { goals, agent } = setup()
    const created = goals.create(agent, { objective: 'old', maxGoalRounds: 4 })
    expect(() => goals.edit(agent, created, {})).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_EDIT' }),
    )
    const objective = goals.edit(agent, created, { objective: ' new ' })
    expect(objective).toMatchObject({
      objective: 'new',
      maxGoalRounds: 4,
      revision: 2,
      activation: 'armed',
    })
    expect(() => goals.edit(agent, created, { maxGoalRounds: 8 })).toThrow(
      expect.objectContaining({ code: 'GOAL_STALE_REVISION' }),
    )
    const cap = goals.edit(agent, objective, { maxGoalRounds: 8 })
    expect(cap).toMatchObject({
      objective: 'new',
      maxGoalRounds: 8,
      revision: 3,
    })
    expect(() => goals.edit(agent, cap, { objective: ' ' })).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_OBJECTIVE' }),
    )
  })

  it('supports pause, resume, block, and completion transitions', () => {
    const { goals, agent } = setup()
    let goal = goals.create(agent, { objective: 'lifecycle' })
    goal = goals.pause(agent, goal)
    expect(goal).toMatchObject({
      phase: 'paused',
      activation: 'disarmed',
      revision: 2,
    })
    goal = goals.resume(agent, goal)
    expect(goal).toMatchObject({
      phase: 'active',
      activation: 'armed',
      revision: 3,
    })
    goal = goals.block(agent, goal, {
      code: 'needs-input',
      message: 'A choice is required.',
    })
    expect(goal).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'needs-input', message: 'A choice is required.' },
      activation: 'disarmed',
    })
    goal = goals.resume(agent, goal)
    goal = goals.pause(agent, goal)
    goal = goals.complete(agent, goal)
    expect(goal).toMatchObject({ phase: 'complete', activation: 'disarmed' })
    expect(() => goals.resume(agent, goal)).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }),
    )
  })

  it('allows completion from every stopped phase and replacement only after completion', () => {
    for (const phase of ['paused', 'blocked'] as const) {
      const { goals, agent } = setup()
      let goal = goals.create(agent, { objective: phase })
      goal =
        phase === 'paused'
          ? goals.pause(agent, goal)
          : goals.block(agent, goal, {
              code: 'test-blocker',
              message: 'Blocked for the test.',
            })
      const complete = goals.complete(agent, goal)
      const replacement = goals.create(agent, { objective: `after ${phase}` })
      expect(complete.phase).toBe('complete')
      expect(replacement.id).not.toBe(complete.id)
      expect(replacement.revision).toBe(1)
    }
  })

  it('rejects replacement and invalid transitions while a resumable goal exists', () => {
    const { goals, agent } = setup()
    const goal = goals.create(agent, { objective: 'still active' })
    expect(() => goals.create(agent, { objective: 'replacement' })).toThrow(
      expect.objectContaining({ code: 'GOAL_ALREADY_EXISTS' }),
    )
    expect(() => goals.resume(agent, goal)).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }),
    )
    const paused = goals.pause(agent, goal)
    expect(() => goals.pause(agent, paused)).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }),
    )
    expect(() =>
      goals.block(agent, paused, { code: 'test-blocker', message: 'x' }),
    ).toThrow(expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }))
  })

  it('records canonical blocker reasons and enforces the round cap on resume', () => {
    const { goals, agent, session } = setup()
    let goal = goals.create(agent, { objective: 'bounded', maxGoalRounds: 2 })
    for (const reason of [
      null,
      [],
      { code: 1, message: 'invalid code' },
      { code: 'round-limit', message: 1 },
      { code: 'Not Canonical', message: 'x' },
      { code: 'round-limit', message: '   ' },
    ]) {
      expect(() => goals.block(agent, goal, reason as never)).toThrow(
        expect.objectContaining({ code: 'GOAL_INVALID_BLOCK_REASON' }),
      )
    }
    appendRound(session, goal, 1)
    expect(goals.get(agent)?.roundsStarted).toBe(1)
    appendRound(session, goal, 2)
    goal = goals.block(agent, goal, {
      code: 'round-limit',
      message: '  Goal round limit reached.  ',
    })
    expect(goal).toMatchObject({
      phase: 'blocked',
      blockedReason: {
        code: 'round-limit',
        message: 'Goal round limit reached.',
      },
      roundsStarted: 2,
      activation: 'disarmed',
    })
    expect(() => goals.resume(agent, goal)).toThrow(
      expect.objectContaining({ code: 'GOAL_INVALID_TRANSITION' }),
    )
    goal = goals.edit(agent, goal, { maxGoalRounds: 3 })
    expect(goal.blockedReason).toEqual({
      code: 'round-limit',
      message: 'Goal round limit reached.',
    })
    goal = goals.resume(agent, goal)
    expect(goal).toMatchObject({
      phase: 'active',
      maxGoalRounds: 3,
      activation: 'armed',
    })
    expect(goal.blockedReason).toBeUndefined()
  })

  it('clears through a revisioned tombstone and permits a fresh goal', () => {
    const { goals, agent, session } = setup()
    const goal = goals.create(agent, { objective: 'temporary' })
    const tombstone = goals.clear(agent, goal)
    expect(tombstone).toEqual({ id: goal.id, revision: 2 })
    expect(goals.get(agent)).toBeUndefined()
    expect(foldGoal(session.events)).toEqual({
      roundsStarted: 0,
      lastRef: tombstone,
    })
    expect(() => goals.clear(agent, goal)).toThrow(
      expect.objectContaining({ code: 'GOAL_NOT_FOUND' }),
    )
    expect(goals.create(agent, { objective: 'fresh' }).id).not.toBe(goal.id)
  })

  it('keeps mutation timestamps monotonic when the wall clock moves backward', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const { goals, agent, session } = setup()
    let goal = goals.create(agent, { objective: 'monotonic time' })
    vi.setSystemTime(90)
    goal = goals.pause(agent, goal)
    expect(goal.updatedAt).toBe(100)
    vi.setSystemTime(80)
    goals.clear(agent, goal)
    const last = session.events
      .filter((event) => event.type === 'goal/change')
      .at(-1)!
    expect(decodeGoalChange(last.data)).toMatchObject({
      operation: 'clear',
      clearedAt: 100,
    })
    expect(() => foldGoal(session.events)).not.toThrow()
  })

  it('contains listener failures and preserves later listeners', () => {
    const { goals, agent } = setup()
    const seen: string[] = []
    goals.onChange(() => {
      throw new Error('listener broke')
    })
    goals.onChange(({ change }) => {
      seen.push(change.operation)
    })
    const goal = goals.create(agent, { objective: 'notify' })
    goals.pause(agent, goal)
    expect(seen).toEqual(['create', 'pause'])
  })

  it('notifies with a fresh view and a clear tombstone ref', () => {
    const { goals, agent } = setup()
    const changes: unknown[] = []
    goals.onChange(({ change }) => {
      changes.push(change)
    })
    const goal = goals.create(agent, { objective: 'notify' })
    goals.clear(agent, goal)
    expect(changes[0]).toMatchObject({
      operation: 'create',
      ref: { id: goal.id, revision: 1 },
      goal: { objective: 'notify' },
    })
    expect(changes[1]).toEqual({
      operation: 'clear',
      ref: { id: goal.id, revision: 2 },
    })
  })
})

describe('goal replay validation', () => {
  it('ignores unrelated events and unreserved goal-producer context', () => {
    const { goals, agent, session } = setup()
    const goal = goals.create(agent, { objective: 'rounds' })
    session.append('user/message', contextMessage('goal', 'forged round'), {
      surfaceOp: 'append',
    })
    expect(foldGoal(session.events).roundsStarted).toBe(0)
    appendRound(session, goal, 1)
    expect(foldGoal(session.events).roundsStarted).toBe(1)
  })

  it('does not count reservations that are never admitted or name a stale revision', () => {
    const { goals, agent, session } = setup()
    const goal = goals.create(agent, { objective: 'rounds' })
    session.append('goal/round', {
      goalId: goal.id,
      revision: 1,
      round: 1,
      messageId: 'never-admitted',
    })
    expect(foldGoal(session.events).roundsStarted).toBe(0)
    const edited = goals.edit(agent, goal, { objective: 'edited' })
    appendRound(session, goal, 1) // reserved for revision 1, admitted at revision 2
    expect(foldGoal(session.events).roundsStarted).toBe(0)
    appendRound(session, edited, 2) // not the next round
    expect(foldGoal(session.events).roundsStarted).toBe(0)
    appendRound(session, edited, 1)
    expect(goals.get(agent)?.roundsStarted).toBe(1)
  })

  it('rejects unsupported versions, operations, and extra fields', () => {
    expect(() => foldGoal([change(snapshot({ version: 2 }))])).toThrow(
      /unsupported goal change version/,
    )
    expect(() =>
      foldGoal([change(snapshot({ operation: 'teleport' }))]),
    ).toThrow(/operation is invalid/)
    expect(() => foldGoal([change(snapshot({ extra: true }))])).toThrow(
      /must have exactly/,
    )
    expect(() => foldGoal([change(snapshot({}, { extra: 1 }))])).toThrow(
      /must have exactly/,
    )
  })

  it('rejects invalid create and missing-current mutation sequences', () => {
    expect(() => foldGoal([change(snapshot({}, { revision: 2 }))])).toThrow(
      /fresh active revision-one/,
    )
    expect(() => foldGoal([change(snapshot({ roundsStarted: 1 }))])).toThrow(
      /fresh active revision-one/,
    )
    expect(() =>
      foldGoal([
        change(
          snapshot({ operation: 'pause' }, { revision: 2, phase: 'paused' }),
        ),
      ]),
    ).toThrow(/requires a current goal/)
    expect(() =>
      foldGoal([change(snapshot()), change(snapshot({}, { id: 'g2' }), 1)]),
    ).toThrow(/fresh active revision-one/)
  })

  it('rejects stale identity, counters, timestamps, and definition changes', () => {
    const create = change(snapshot())
    expect(() =>
      foldGoal([
        create,
        change(
          snapshot({ operation: 'pause' }, { revision: 3, phase: 'paused' }),
          1,
        ),
      ]),
    ).toThrow(/advance the current goal by one revision/)
    expect(() =>
      foldGoal([
        create,
        change(
          snapshot(
            { operation: 'pause', roundsStarted: 1 },
            { revision: 2, phase: 'paused' },
          ),
          1,
        ),
      ]),
    ).toThrow(/preserve the current counters/)
    expect(() =>
      foldGoal([
        create,
        change(
          snapshot(
            { operation: 'pause', createdAt: 5, updatedAt: 5 },
            { revision: 2, phase: 'paused' },
          ),
          1,
        ),
      ]),
    ).toThrow(/preserve the current counters/)
    expect(() =>
      foldGoal([
        create,
        change(
          snapshot(
            { operation: 'pause' },
            { revision: 2, phase: 'paused', objective: 'y' },
          ),
          1,
        ),
      ]),
    ).toThrow(/cannot change objective/)
  })

  it('rejects invalid replayed lifecycle transitions', () => {
    const create = change(snapshot())
    expect(() =>
      foldGoal([
        create,
        change(
          snapshot({ operation: 'block' }, { revision: 2, phase: 'paused' }),
          1,
        ),
      ]),
    ).toThrow(/block has an invalid phase transition/)
    expect(() =>
      foldGoal([
        create,
        change(
          snapshot({ operation: 'edit' }, { revision: 2, phase: 'paused' }),
          1,
        ),
      ]),
    ).toThrow(/edit cannot change phase/)
    const paused = change(
      snapshot({ operation: 'pause' }, { revision: 2, phase: 'paused' }),
      1,
    )
    expect(() =>
      foldGoal([
        create,
        paused,
        change(
          snapshot({ operation: 'pause' }, { revision: 3, phase: 'paused' }),
          2,
        ),
      ]),
    ).toThrow(/pause has an invalid phase transition/)
  })

  it('rejects invalid clear continuity and goal id reuse', () => {
    const create = change(snapshot())
    const clear = (revision: number, clearedAt = 10) =>
      change(
        {
          kind: 'goal/change',
          version: 1,
          operation: 'clear',
          cleared: { id: 'g1', revision },
          clearedAt,
        },
        1,
      )
    expect(() => foldGoal([clear(2)])).toThrow(/clear requires a current goal/)
    expect(() => foldGoal([create, clear(3)])).toThrow(
      /advance the current goal/,
    )
    expect(() => foldGoal([create, clear(2, 5)])).toThrow(/cannot precede/)
    expect(() => foldGoal([create, clear(2), change(snapshot(), 2)])).toThrow(
      /fresh active revision-one/,
    )
    expect(foldGoal([create, clear(2)])).toEqual({
      roundsStarted: 0,
      lastRef: { id: 'g1', revision: 2 },
    })
  })

  it('rejects malformed snapshots, refs, counters, and timestamps', () => {
    expect(() => foldGoal([change(snapshot({}, { id: '' }))])).toThrow(
      /goal.id/,
    )
    expect(() =>
      foldGoal([change(snapshot({}, { objective: ' x ' }))]),
    ).toThrow(/normalized/)
    expect(() => foldGoal([change(snapshot({}, { phase: 'done' }))])).toThrow(
      /phase is invalid/,
    )
    expect(() =>
      foldGoal([change(snapshot({}, { maxGoalRounds: 0 }))]),
    ).toThrow(/positive safe integer/)
    expect(() =>
      foldGoal([change(snapshot({ createdAt: 20, updatedAt: 10 }))]),
    ).toThrow(/cannot precede createdAt/)
    expect(() =>
      foldGoal([change(snapshot({}, { phase: 'blocked' }))]),
    ).toThrow(/must have exactly/)
    expect(() =>
      foldGoal([
        change({
          kind: 'goal/change',
          version: 1,
          operation: 'clear',
          cleared: { id: 'g1' },
          clearedAt: 1,
        }),
      ]),
    ).toThrow(/tombstone/)
    expect(() =>
      foldGoal([
        {
          type: 'goal/round',
          seq: 0,
          time: 0,
          data: { goalId: 'g', revision: 0, round: 1, messageId: 'm' },
        } as SessionEvent,
      ]),
    ).toThrow(/positive safe integer/)
  })
})
