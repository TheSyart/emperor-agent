// Goal tools + round driver through the real agent loop with a scripted
// model (ports dsh tool-goal.spec and goal-round-driver.spec).
import { describe, expect, it, vi } from 'vitest'
import { contextMessage, messageText, userText } from '../../llm/message'
import type { GenerateOptions } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import { createTestHarness, replyChunks, type ScriptedReply } from '../testing'
import {
  createGoalTools,
  GoalService,
  installGoal,
  renderGoalRoundPrompt,
  type GoalServiceOptions,
  type GoalView,
} from './index'

interface Setup {
  h: ReturnType<typeof createTestHarness>
  goals: GoalService
  agent: Agent
  detach: () => void
}

function setup(
  replies: ScriptedReply[] = [],
  options: GoalServiceOptions & { attach?: boolean } = {},
): Setup {
  const h = createTestHarness({ replies })
  const goals = new GoalService(options)
  const { driver } = installGoal(
    { prompt: h.prompt, middleware: h.middleware, tools: h.tools },
    goals,
  )
  const agent = h.agent()
  const detach = options.attach === false ? () => {} : driver.attach(agent)
  return { h, goals, agent, detach }
}

/** A model reply computed from live goal state when the request is made. */
function call(
  name: string,
  args: (goal: GoalView | undefined) => Record<string, unknown>,
  goals: GoalService,
  agent: Agent,
): ScriptedReply {
  return () => replyChunks({ tools: [{ name, args: args(goals.get(agent)) }] })
}

function ref(goal: GoalView | undefined): {
  goal_id: string
  revision: number
} {
  if (goal === undefined) throw new Error('expected a current goal')
  return { goal_id: goal.id, revision: goal.revision }
}

function toolResults(
  agent: Agent,
): Array<{ text: string; isError: boolean; code?: string; meta?: unknown }> {
  return agent.session.events
    .filter(
      (event): event is SessionEvent<'tool/result'> =>
        event.type === 'tool/result',
    )
    .map((event) => {
      const block = event.data.message.content[0]
      const text = block.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
      return {
        text,
        isError: block.isError === true,
        ...(event.data.error === undefined
          ? {}
          : { code: event.data.error.code }),
        ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
      }
    })
}

function requestText(request: GenerateOptions): string {
  return request.messages.map((message) => messageText(message)).join('\n')
}

async function settle(agent: Agent): Promise<void> {
  for (let quiet = 0; quiet < 3;) {
    await agent.whenIdle()
    await new Promise((resolve) => setTimeout(resolve, 2))
    quiet = agent.status === 'idle' ? quiet + 1 : 0
  }
}

async function waitForGoal(
  goals: GoalService,
  agent: Agent,
  predicate: (goal: GoalView | undefined) => boolean,
): Promise<GoalView | undefined> {
  await vi.waitFor(() => {
    expect(predicate(goals.get(agent))).toBe(true)
  })
  return goals.get(agent)
}

function roundEvents(agent: Agent): number[] {
  const reserved = new Map<string, number>()
  const admitted: number[] = []
  for (const event of agent.session.events) {
    if (event.type === 'goal/round')
      reserved.set(event.data.messageId, event.data.round)
    if (event.type === 'user/message' && reserved.has(event.data.id))
      admitted.push(reserved.get(event.data.id)!)
  }
  return admitted
}

describe('goal tool registration', () => {
  it('registers three tools and the order-114 policy section, and disposes them', () => {
    const h = createTestHarness()
    const goals = new GoalService({ blockedAfterConsecutiveRounds: 5 })
    const installed = installGoal(
      { prompt: h.prompt, middleware: h.middleware, tools: h.tools },
      goals,
    )
    const assembly = h.prompt.assemble({})
    expect(assembly.tools.map((tool) => tool.name)).toEqual([
      'create_goal',
      'get_goal',
      'update_goal',
    ])
    const section = assembly.sections.find((s) => s.name === 'tool:goal')
    expect(section?.text).toContain(
      'persists for at least 5 consecutive goal rounds',
    )
    expect(h.middleware.preStep).toContain(installed.driver.preStep)
    installed.dispose()
    expect(h.prompt.assemble({}).tools).toEqual([])
    expect(h.prompt.assemble({}).sections).toEqual([])
    expect(h.middleware.preStep).not.toContain(installed.driver.preStep)
  })

  it('publishes dsh schemas', () => {
    const [get, create, update] = createGoalTools(new GoalService())
    expect(get!.parameters).toMatchObject({ type: 'object', properties: {} })
    expect(create!.parameters).toMatchObject({
      required: ['objective'],
      properties: {
        objective: { type: 'string' },
        max_goal_rounds: { type: 'number' },
      },
    })
    expect(update!.parameters).toMatchObject({
      required: ['goal_id', 'revision', 'action'],
      properties: {
        action: { enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
      },
    })
  })
})

describe('goal tool execution authority', () => {
  it('lets a root model infer create intent from its human turn and reads, edits, pauses, resumes', async () => {
    const t = setup([], { attach: false })
    const { goals, agent } = t
    t.h.adapter.push(
      call('get_goal', () => ({}), goals, agent),
      call('create_goal', () => ({ objective: 'old' }), goals, agent),
      call(
        'update_goal',
        (g) => ({
          ...ref(g),
          action: 'edit',
          objective: 'new',
          max_goal_rounds: 8,
        }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), action: 'pause' }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), action: 'resume' }),
        goals,
        agent,
      ),
      { text: 'done' },
    )
    agent.followup(userText('please keep working until the feature ships'))
    await settle(agent)
    const results = toolResults(agent)
    expect(JSON.parse(results[0]!.text)).toEqual({ goal: null })
    expect(results[0]!.meta).toEqual({ goal: null })
    const created = JSON.parse(results[1]!.text)
    expect(created).toMatchObject({
      goal: {
        objective: 'old',
        revision: 1,
        phase: 'active',
        roundsStarted: 0,
        maxGoalRounds: 256,
      },
      activation: 'armed',
    })
    expect(Object.keys(created.goal).sort()).toEqual([
      'id',
      'maxGoalRounds',
      'objective',
      'phase',
      'revision',
      'roundsStarted',
    ])
    expect(results[1]!.meta).toMatchObject({
      goal: {
        objective: 'old',
        createdAt: expect.any(Number),
        activation: 'armed',
      },
    })
    expect(JSON.parse(results[2]!.text).goal).toMatchObject({
      objective: 'new',
      revision: 2,
      maxGoalRounds: 8,
    })
    expect(JSON.parse(results[3]!.text).goal).toMatchObject({
      phase: 'paused',
      revision: 3,
    })
    expect(JSON.parse(results[4]!.text).goal).toMatchObject({
      phase: 'active',
      revision: 4,
    })
  })

  it('rejects non-human and subagent creation', async () => {
    const t = setup([], { attach: false })
    const { goals, agent } = t
    t.h.adapter.push(
      call('create_goal', () => ({ objective: 'x' }), goals, agent),
      { text: 'ok' },
    )
    agent.followup(contextMessage('scheduler', 'scheduled prompt'))
    await settle(agent)
    expect(toolResults(agent)[0]).toMatchObject({
      isError: true,
      code: 'GOAL_TOOL_AUTHORITY_REQUIRED',
      text: 'Error: this goal operation requires a direct human turn on a top-level agent',
    })

    const child = t.h.agent('child', { owner: agent })
    t.h.adapter.push(
      call('create_goal', () => ({ objective: 'x' }), goals, child),
      { text: 'ok' },
    )
    child.followup(userText('child work'))
    await settle(child)
    expect(toolResults(child)[0]).toMatchObject({
      code: 'GOAL_TOOL_AUTHORITY_REQUIRED',
    })
    expect(goals.get(agent)).toBeUndefined()
  })

  it('rejects agentless and driverless calls', async () => {
    const goals = new GoalService()
    const [get] = createGoalTools(goals)
    const h = createTestHarness()
    const agent = h.agent()
    const context = (a?: Agent) => ({
      callId: 'c',
      name: 'get_goal',
      arguments: {},
      signal: new AbortController().signal,
      ...(a === undefined ? {} : { agent: a }),
      deferContext() {},
      concludeTurn() {},
    })
    await expect(get!.execute({}, context())).rejects.toMatchObject({
      code: 'GOAL_TOOL_AGENT_REQUIRED',
      message: 'goal tools require a calling agent',
    })
    await expect(get!.execute({}, context(agent))).rejects.toMatchObject({
      code: 'GOAL_TOOL_DRIVER_REQUIRED',
    })
    expect(() => goals.create(agent, { objective: 'x' }, 'model')).toThrow(
      expect.objectContaining({ code: 'GOAL_TOOL_DRIVER_REQUIRED' }),
    )
  })

  it('rejects terminal reporting without human input or a current goal round', async () => {
    const t = setup([], { attach: false })
    const { goals, agent } = t
    goals.create(agent, { objective: 'report later' })
    t.h.adapter.push(
      call(
        'update_goal',
        (g) => ({ ...ref(g), action: 'complete' }),
        goals,
        agent,
      ),
      { text: 'ok' },
    )
    agent.followup(contextMessage('scheduler', 'tick'))
    await settle(agent)
    expect(toolResults(agent)[0]).toMatchObject({
      code: 'GOAL_TOOL_AUTHORITY_REQUIRED',
      text: 'Error: complete and blocked require a direct human turn or the current goal round',
    })
    expect(goals.get(agent)?.phase).toBe('active')
  })

  it('returns structured domain and conditional-argument failures', async () => {
    const t = setup([], { attach: false })
    const { goals, agent } = t
    const upd = (extra: Record<string, unknown>) =>
      call('update_goal', (g) => ({ ...ref(g), ...extra }), goals, agent)
    t.h.adapter.push(
      call('create_goal', () => ({ objective: ' ' }), goals, agent),
      call('create_goal', () => ({ objective: 'valid' }), goals, agent),
      upd({ action: 'pause', objective: 'not valid for pause' }),
      upd({ action: 'complete', max_goal_rounds: 2 }),
      upd({ action: 'blocked' }),
      upd({ action: 'blocked', blocked_reason: ' ' }),
      upd({ action: 'complete', blocked_reason: 'Not a blocker.' }),
      upd({
        action: 'edit',
        objective: 'still valid',
        blocked_reason: 'Not valid for edit.',
      }),
      call(
        'update_goal',
        () => ({ goal_id: '', revision: 0, action: 'edit', objective: 'x' }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ goal_id: g!.id, revision: 99, action: 'pause' }),
        goals,
        agent,
      ),
      { text: 'done' },
    )
    agent.followup(userText('set it up'))
    await settle(agent)
    expect(toolResults(agent).map((result) => result.code)).toEqual([
      'GOAL_INVALID_OBJECTIVE',
      undefined,
      'GOAL_TOOL_INVALID_UPDATE',
      'GOAL_TOOL_INVALID_UPDATE',
      'GOAL_TOOL_INVALID_UPDATE',
      'GOAL_TOOL_INVALID_UPDATE',
      'GOAL_TOOL_INVALID_UPDATE',
      'GOAL_TOOL_INVALID_UPDATE',
      'GOAL_TOOL_INVALID_UPDATE',
      'GOAL_STALE_REVISION',
    ])
    expect(toolResults(agent)[2]!.text).toBe(
      'Error: objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked',
    )
  })

  it('accepts only empty fillers in fields unused by the selected action', async () => {
    const t = setup([], { attach: false })
    const { goals, agent } = t
    const fill = { objective: '', max_goal_rounds: 0, blocked_reason: '' }
    t.h.adapter.push(
      call('create_goal', () => ({ objective: 'valid' }), goals, agent),
      call(
        'update_goal',
        (g) => ({ ...ref(g), ...fill, action: 'edit', objective: 'edited' }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), ...fill, action: 'edit', max_goal_rounds: 8 }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), ...fill, action: 'pause' }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), ...fill, action: 'resume' }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({
          ...ref(g),
          ...fill,
          action: 'blocked',
          blocked_reason: 'actual blocker',
        }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), ...fill, action: 'resume' }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), ...fill, action: 'complete' }),
        goals,
        agent,
      ),
      { text: 'done' },
    )
    agent.followup(userText('go'))
    await settle(agent)
    const values = toolResults(agent).map(
      (result) => JSON.parse(result.text).goal,
    )
    expect(values[1]).toMatchObject({ objective: 'edited' })
    expect(values[2]).toMatchObject({ objective: 'edited', maxGoalRounds: 8 })
    expect(values[3]).toMatchObject({ phase: 'paused' })
    expect(values[4]).toMatchObject({ phase: 'active' })
    expect(values[5]).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'model-reported', message: 'actual blocker' },
    })
    expect(values[7]).toMatchObject({ phase: 'complete', objective: 'edited' })
  })

  it('lets direct human authority block before the model threshold without a wrap-up', async () => {
    const t = setup([], { attach: false, blockedAfterConsecutiveRounds: 9 })
    const { goals, agent } = t
    goals.create(agent, { objective: 'human stop' })
    t.h.adapter.push(
      call(
        'update_goal',
        (g) => ({
          ...ref(g),
          action: 'blocked',
          blocked_reason:
            'The user asked to stop until a prerequisite is available.',
        }),
        goals,
        agent,
      ),
      { text: 'stopped' },
    )
    agent.followup(userText('stop the goal, the prerequisite is missing'))
    await settle(agent)
    expect(goals.get(agent)).toMatchObject({
      phase: 'blocked',
      roundsStarted: 0,
      blockedReason: { code: 'model-reported' },
    })
    expect(requestText(t.h.adapter.requests[1]!)).not.toContain(
      '<goal_blocked>',
    )
  })

  it('rearms a restored active goal only after a new direct human prompt', async () => {
    const t = setup([], { attach: false })
    const created = t.goals.create(t.agent, { objective: 'continue later' })
    const restarted = new GoalService()
    const h2 = t.h
    const [, , update] = createGoalTools(restarted)
    h2.tools.register({ ...update!, name: 'update_goal_restored' })
    expect(restarted.get(t.agent)?.activation).toBe('disarmed')
    h2.adapter.push(
      () =>
        replyChunks({
          tools: [
            {
              name: 'update_goal_restored',
              args: {
                goal_id: created.id,
                revision: created.revision,
                action: 'resume',
              },
            },
          ],
        }),
      { text: 'resumed' },
    )
    t.agent.followup(userText('继续'))
    await settle(t.agent)
    expect(JSON.parse(toolResults(t.agent)[0]!.text)).toMatchObject({
      goal: { phase: 'active', revision: 2 },
      activation: 'armed',
    })
  })
})

describe('same-session goal driving', () => {
  it('admits exact numbered rounds until the durable round cap', async () => {
    const t = setup([{ text: 'round one' }, { text: 'round two' }])
    const created = t.goals.create(t.agent, {
      objective: 'finish twice',
      maxGoalRounds: 2,
    })
    const final = await waitForGoal(
      t.goals,
      t.agent,
      (goal) => goal?.phase === 'blocked',
    )
    expect(final).toMatchObject({
      id: created.id,
      roundsStarted: 2,
      activation: 'disarmed',
    })
    expect(final?.blockedReason).toEqual({
      code: 'round-limit',
      message: 'Goal reached its configured limit of 2 rounds.',
    })
    expect(t.h.adapter.requests).toHaveLength(2)
    expect(roundEvents(t.agent)).toEqual([1, 2])
    expect(requestText(t.h.adapter.requests[0]!)).toContain('Round: 1/2')
    expect(requestText(t.h.adapter.requests[1]!)).toContain('Round: 2/2')
    const roundMessage = t.agent.session.events.find(
      (e) => e.type === 'user/message',
    )
    expect(
      roundMessage?.type === 'user/message' && roundMessage.data.source,
    ).toEqual({ kind: 'context', producer: 'goal' })
    expect(
      roundMessage?.type === 'user/message' && messageText(roundMessage.data),
    ).toBe(
      renderGoalRoundPrompt({ objective: 'finish twice', maxGoalRounds: 2 }, 1),
    )
  })

  it('never adopts activation on attach and waits for explicit resume', async () => {
    const h = createTestHarness({ replies: [{ text: 'after resume' }] })
    const goals = new GoalService()
    const { driver } = installGoal(
      { prompt: h.prompt, middleware: h.middleware },
      goals,
    )
    const agent = h.agent()
    const created = goals.create(agent, {
      objective: 'wait for a human',
      maxGoalRounds: 1,
    })
    driver.attach(agent)
    await settle(agent)
    expect(goals.get(agent)).toMatchObject({
      phase: 'active',
      activation: 'disarmed',
      revision: 1,
    })
    expect(h.adapter.requests).toHaveLength(0)
    goals.resume(agent, created)
    await waitForGoal(goals, agent, (goal) => goal?.phase === 'blocked')
    expect(h.adapter.requests).toHaveLength(1)
  })

  it.each([
    ['request error', { error: 'provider broke', code: 'AUTH' }],
    ['max tokens', { text: 'unfinished', finish: 'max-tokens' as const }],
  ])('disarms automatic continuation after a %s', async (_label, reply) => {
    const t = setup([reply])
    t.goals.create(t.agent, { objective: 'stop safely', maxGoalRounds: 8 })
    const goal = await waitForGoal(
      t.goals,
      t.agent,
      (current) =>
        current?.phase === 'active' && current.activation === 'disarmed',
    )
    await settle(t.agent)
    expect(goal).toMatchObject({ roundsStarted: 1, activation: 'disarmed' })
    expect(t.h.adapter.requests).toHaveLength(1)
  })

  it('maps a downstream step rejection to blocked without entering the round', async () => {
    const t = setup()
    t.h.middleware.preStep.push(({ messages }) =>
      messages.some(
        (m) => m.source.kind === 'context' && m.source.producer === 'goal',
      )
        ? { kind: 'reject' }
        : undefined,
    )
    t.goals.create(t.agent, { objective: 'respect policy' })
    const goal = await waitForGoal(
      t.goals,
      t.agent,
      (current) => current?.phase === 'blocked',
    )
    expect(goal?.roundsStarted).toBe(0)
    expect(goal?.blockedReason).toEqual({
      code: 'prompt-rejected',
      message: 'Goal round was rejected before entering its step.',
    })
    expect(t.h.adapter.requests).toHaveLength(0)
  })

  it('pauses and drops a reserved round when cancellation lands before pre-step admits it', async () => {
    const t = setup()
    t.h.middleware.preStep.unshift(({ agent, messages }) => {
      if (
        messages.some(
          (m) => m.source.kind === 'context' && m.source.producer === 'goal',
        )
      )
        agent.cancel({ kind: 'user' })
      return undefined
    })
    t.goals.create(t.agent, { objective: 'do not start yet' })
    const goal = await waitForGoal(
      t.goals,
      t.agent,
      (current) => current?.phase === 'paused',
    )
    expect(goal).toMatchObject({ roundsStarted: 0, activation: 'disarmed' })
    expect(t.h.adapter.requests).toHaveLength(0)
    expect(roundEvents(t.agent)).toEqual([])
  })

  it('pauses an admitted round when cancellation aborts an active step', async () => {
    const t = setup([{ hang: true }])
    t.goals.create(t.agent, { objective: 'stop in flight' })
    await vi.waitFor(() => {
      expect(t.h.adapter.requests).toHaveLength(1)
    })
    t.agent.cancel({ kind: 'user' })
    const goal = await waitForGoal(
      t.goals,
      t.agent,
      (current) => current?.phase === 'paused',
    )
    expect(goal).toMatchObject({ roundsStarted: 1, activation: 'disarmed' })
    expect(t.h.adapter.requests).toHaveLength(1)
  })

  it('only disarms when cancellation belongs to unrelated human work', async () => {
    const t = setup([{ hang: true }])
    const goal = t.goals.create(t.agent, { objective: 'wait' })
    t.goals.pause(t.agent, goal)
    t.agent.followup(userText('human work'))
    await vi.waitFor(() => {
      expect(t.h.adapter.requests).toHaveLength(1)
    })
    t.goals.resume(t.agent, { id: goal.id, revision: 2 })
    t.agent.cancel({ kind: 'user' })
    await settle(t.agent)
    expect(t.goals.get(t.agent)).toMatchObject({
      phase: 'active',
      revision: 3,
      activation: 'disarmed',
      roundsStarted: 0,
    })
    expect(t.h.adapter.requests).toHaveLength(1)
  })

  it('lets already-queued human work finish before reserving the next round', async () => {
    const t = setup([{ text: 'human answer' }, { text: 'goal answer' }])
    t.goals.create(t.agent, {
      objective: 'continue after the human',
      maxGoalRounds: 1,
    })
    t.agent.followup(userText('human goes first'))
    await waitForGoal(t.goals, t.agent, (goal) => goal?.phase === 'blocked')
    expect(t.h.adapter.requests).toHaveLength(2)
    expect(requestText(t.h.adapter.requests[0]!)).toContain('human goes first')
    expect(requestText(t.h.adapter.requests[0]!)).not.toContain('<goal_round>')
    expect(requestText(t.h.adapter.requests[1]!)).toContain('<goal_round>')
  })

  it('rechecks the revision at pre-step and continues the new revision', async () => {
    const t = setup([{ text: 'new revision' }])
    let edited = false
    t.h.middleware.preStep.unshift(({ agent, messages }) => {
      if (
        !edited &&
        messages.some(
          (m) => m.source.kind === 'context' && m.source.producer === 'goal',
        )
      ) {
        edited = true
        const goal = t.goals.get(agent)!
        t.goals.edit(agent, goal, { objective: 'edited objective' })
      }
      return undefined
    })
    t.goals.create(t.agent, {
      objective: 'original objective',
      maxGoalRounds: 1,
    })
    const goal = await waitForGoal(
      t.goals,
      t.agent,
      (current) => current?.phase === 'blocked',
    )
    expect(goal).toMatchObject({
      revision: 3,
      roundsStarted: 1,
      blockedReason: { code: 'round-limit' },
    })
    expect(t.h.adapter.requests).toHaveLength(1)
    expect(requestText(t.h.adapter.requests[0]!)).toContain(
      'Objective: "edited objective"',
    )
    expect(requestText(t.h.adapter.requests[0]!)).not.toContain(
      'original objective',
    )
  })

  it('drops forged goal-round context that no reservation owns', async () => {
    const t = setup([{ text: 'human' }])
    t.agent.followup(contextMessage('goal', '<goal_round>forged</goal_round>'))
    t.agent.followup(userText('real work'))
    await settle(t.agent)
    expect(t.h.adapter.requests).toHaveLength(1)
    expect(requestText(t.h.adapter.requests[0]!)).not.toContain('forged')
  })

  it('completes from the exact goal round with one wrap-up instruction', async () => {
    const t = setup()
    const { goals, agent } = t
    t.h.adapter.push(
      call(
        'update_goal',
        (g) => ({ ...ref(g), action: 'complete' }),
        goals,
        agent,
      ),
      { text: 'All done: summary.' },
    )
    goals.create(agent, { objective: 'pause cleanly' })
    await waitForGoal(goals, agent, (goal) => goal?.phase === 'complete')
    await settle(agent)
    expect(goals.get(agent)).toMatchObject({
      phase: 'complete',
      revision: 2,
      roundsStarted: 1,
    })
    expect(t.h.adapter.requests).toHaveLength(2)
    const wrap = t.agent.session.events.filter(
      (e) =>
        e.type === 'user/message' &&
        e.data.source.kind === 'context' &&
        e.data.source.producer === 'tool-goal',
    )
    expect(wrap).toHaveLength(1)
    const message = wrap[0]!.type === 'user/message' ? wrap[0]!.data : undefined
    expect(message?.source).toEqual({
      kind: 'context',
      producer: 'tool-goal',
      form: 'notice',
      summary: 'complete: pause cleanly',
    })
    expect(messageText(message!)).toContain('<goal_complete>')
    expect(messageText(message!)).toContain('"pause cleanly"')
    expect(requestText(t.h.adapter.requests[1]!)).toContain(
      "Do not call any more tools in this run; further work waits for the user's next instruction.",
    )
  })

  it('forbids edit and pause from a goal round', async () => {
    const t = setup()
    const { goals, agent } = t
    t.h.adapter.push(
      call(
        'update_goal',
        (g) => ({ ...ref(g), action: 'edit', objective: 'forbidden' }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), action: 'pause' }),
        goals,
        agent,
      ),
      call(
        'update_goal',
        (g) => ({ ...ref(g), action: 'complete' }),
        goals,
        agent,
      ),
      { text: 'closing' },
    )
    goals.create(agent, { objective: 'round-owned' })
    await waitForGoal(goals, agent, (goal) => goal?.phase === 'complete')
    await settle(agent)
    expect(toolResults(agent).map((r) => r.code)).toEqual([
      'GOAL_TOOL_AUTHORITY_REQUIRED',
      'GOAL_TOOL_AUTHORITY_REQUIRED',
      undefined,
    ])
  })

  it('enforces the model self-block lower bound across admitted rounds', async () => {
    const t = setup([], { blockedAfterConsecutiveRounds: 3 })
    const { goals, agent } = t
    const blocked = call(
      'update_goal',
      (g) => ({
        ...ref(g),
        action: 'blocked',
        blocked_reason: 'The required credential is still unavailable.',
      }),
      goals,
      agent,
    )
    t.h.adapter.push(
      blocked,
      { text: 'r1' },
      blocked,
      { text: 'r2' },
      blocked,
      { text: 'closing' },
    )
    goals.create(agent, { objective: 'blocked eventually' })
    const goal = await waitForGoal(
      goals,
      agent,
      (current) => current?.phase === 'blocked',
    )
    await settle(agent)
    expect(goal).toMatchObject({
      roundsStarted: 3,
      blockedReason: {
        code: 'model-reported',
        message: 'The required credential is still unavailable.',
      },
    })
    const results = toolResults(agent)
    expect(results.map((r) => r.code)).toEqual([
      'GOAL_TOOL_BLOCK_THRESHOLD',
      'GOAL_TOOL_BLOCK_THRESHOLD',
      undefined,
    ])
    expect(results[0]!.text).toBe(
      'Error: blocked requires at least 3 consecutive goal rounds; current round is 1',
    )
    expect(requestText(t.h.adapter.requests[5]!)).toContain('<goal_blocked>')
    expect(t.h.adapter.requests).toHaveLength(6)
  })

  it('disarms and cancels an admitted round on detach', async () => {
    const t = setup([{ hang: true }])
    t.goals.create(t.agent, { objective: 'teardown' })
    await vi.waitFor(() => {
      expect(t.h.adapter.requests).toHaveLength(1)
    })
    t.detach()
    await settle(t.agent)
    expect(t.agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'parent' },
    })
    expect(t.goals.get(t.agent)).toMatchObject({
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 1,
    })
    expect(t.h.adapter.requests).toHaveLength(1)
  })
})
