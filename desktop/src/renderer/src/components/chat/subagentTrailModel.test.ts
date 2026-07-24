import { describe, expect, it } from 'vitest'
import { subagentNodeOpen } from './subagentTrailModel'

describe('subagent trail presentation', () => {
  it('keeps active and failed agents open but collapses completed reviewers', () => {
    expect(subagentNodeOpen({ status: 'running' })).toBe(true)
    expect(subagentNodeOpen({ status: 'error' })).toBe(true)
    expect(subagentNodeOpen({ status: 'error_aborted' })).toBe(true)
    expect(subagentNodeOpen({ status: 'done' })).toBe(false)
  })
})
