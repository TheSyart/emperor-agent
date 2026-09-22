import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from './types'

const goalUpdated = {
  event: 'goal_updated',
  goal: {
    id: 'goal-1',
    revision: 1,
    objective: 'ship it',
    phase: 'active',
    maxGoalRounds: 10,
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
  },
} satisfies RuntimeEvent

const thought = {
  event: 'agent_thought',
  thought_id: 's:1:0:0',
  stage: 'reasoning',
  status: 'running',
} satisfies RuntimeEvent

describe('runtime event union', () => {
  it('carries the projector goal and thought payloads', () => {
    expect([goalUpdated.event, thought.event]).toEqual([
      'goal_updated',
      'agent_thought',
    ])
  })
})
