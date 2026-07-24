import { describe, expect, it, vi } from 'vitest'
import { ToolResultObj } from '../tools/base'
import { recordPlanDiscovery } from './runner-plan-recording'

describe('recordPlanDiscovery', () => {
  it('records a successful glob even when an empty project has no files', () => {
    const record = vi.fn()

    recordPlanDiscovery(
      { recordPlanDiscovery: record } as never,
      {
        id: 'call_glob',
        name: 'glob',
        arguments: { pattern: '*' },
      },
      ToolResultObj.fromText('No files matched.', {
        meta: { tool: 'glob' },
      }),
    )

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'glob',
        summary: 'No files matched.',
        files: [],
        evidenceRefs: ['scope:*'],
      }),
    )
  })
})
