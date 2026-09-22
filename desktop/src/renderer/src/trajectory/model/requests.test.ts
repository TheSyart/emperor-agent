import { describe, expect, it } from 'vitest'
import type { TrajectoryEventNode, TrajectoryRequestView } from './contract'
import {
  addTrajectoryUsage,
  deriveTrajectoryRequestNumbers,
  indexTrajectoryRequestNumbers,
  trajectoryRequestUsage,
  trajectoryUsageInputTotal,
} from './requests'

const timing = { ttftMs: 1, decodeMs: 2 }

describe('trajectory request numbering', () => {
  it('numbers assistant and compaction requests in log order with cumulative usage', () => {
    const requests: TrajectoryRequestView[] = [
      {
        purpose: 'assistant',
        startSeq: 2,
        turn: 1,
        step: 1,
        startedAt: 2,
        completedAt: 3,
        status: 'complete',
        timing,
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 },
        provenance: { provider: 'p', model: 'm' },
        route: { provider: 'p', model: 'm', contextWindow: 1000 },
        retry: 1,
        maxRetries: 2,
        retryDelayMs: 50,
        error: 'boom',
      },
      {
        purpose: 'compaction',
        compactionId: 'c',
        startSeq: 5,
        turn: null,
        step: 0,
        startedAt: 5,
        completedAt: 6,
        status: 'complete',
        timing,
        usage: { inputTokens: 7, outputTokens: 1 },
        provenance: { provider: 'p', model: 'm2' },
      },
    ]
    // An assistant message whose request is outside the window still counts.
    const nodes = [
      {
        kind: 'assistant',
        seq: 8,
        time: 8,
        turn: 2,
        step: 1,
        blocks: [],
        usage: { inputTokens: 3, outputTokens: 3 },
      },
    ] as unknown as TrajectoryEventNode[]
    const numbers = deriveTrajectoryRequestNumbers(nodes, requests)
    expect(numbers).toMatchObject([
      {
        number: 1,
        turn: 1,
        step: 1,
        group: 'Step 1',
        status: 'complete',
        provider: 'p',
        model: 'm',
        contextWindow: 1000,
        retry: 1,
        maxRetries: 2,
        retryDelayMs: 50,
        error: 'boom',
        timing,
        usage: { input: 10, output: 2, cacheRead: 4 },
        cumulativeUsage: { input: 10, output: 2, cacheRead: 4 },
      },
      {
        number: 2,
        purpose: 'compaction',
        turn: null,
        step: 0,
        group: 'Compaction 5',
        model: 'm2',
        usage: { input: 7, output: 1 },
        cumulativeUsage: { input: 17, output: 3, cacheRead: 4 },
      },
      {
        number: 3,
        turn: 2,
        step: 1,
        group: 'Step 1',
        seq: 8,
        cumulativeUsage: { input: 20, output: 6, cacheRead: 4 },
      },
    ])
    expect(numbers[2]?.status).toBeUndefined()
    expect(
      indexTrajectoryRequestNumbers(numbers).get('null\u0000Compaction 5')
        ?.number,
    ).toBe(2)
  })

  it('adds usage buckets only once they are reported', () => {
    expect(trajectoryRequestUsage(undefined)).toBeUndefined()
    expect(addTrajectoryUsage(undefined, undefined)).toBeUndefined()
    expect(addTrajectoryUsage({ input: 1 }, { output: 2 })).toEqual({
      input: 1,
      output: 2,
    })
    expect(trajectoryUsageInputTotal({ output: 1 })).toBeUndefined()
    expect(
      trajectoryUsageInputTotal({ input: 1, cacheRead: 2, cacheWrite: 3 }),
    ).toBe(6)
  })
})
