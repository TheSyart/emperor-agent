import { describe, expect, it } from 'vitest'
import { environmentSubagentGroups } from './environmentModel'

describe('Environment subagent projection', () => {
  it('shows every active agent and only the latest three completed agents', () => {
    const agents = [
      { id: 'active-1', status: 'running', ended_at: null },
      { id: 'done-1', status: 'completed', ended_at: 1 },
      { id: 'done-2', status: 'completed', ended_at: 2 },
      { id: 'done-3', status: 'completed', ended_at: 3 },
      { id: 'done-4', status: 'completed', ended_at: 4 },
      { id: 'failed-1', status: 'failed', ended_at: 5 },
    ]

    expect(environmentSubagentGroups(agents)).toEqual({
      active: [agents[0]],
      recent: [agents[5], agents[4], agents[3]],
      completedCount: 4,
      failedCount: 1,
      hiddenCount: 2,
    })
  })
})
