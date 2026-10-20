import { describe, expect, it } from 'vitest'
import { estimateExecutorUsd } from './pricing'

describe('estimateExecutorUsd (AGT-07, MOD-01 catalog)', () => {
  it('prices a Codex model from the bundled catalog', () => {
    // gpt-5.3-codex: $1.75 in, $14 out, $0.175 cache read per million.
    expect(
      estimateExecutorUsd({
        backend: 'codex',
        model: 'gpt-5.3-codex',
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 1_000_000,
        },
      }),
    ).toBeCloseTo(1.75 + 1.4 + 0.175, 6)
  })

  it('prices a Claude model when its cost was not reported', () => {
    expect(
      estimateExecutorUsd({
        backend: 'claude-code',
        model: 'claude-sonnet-4-5',
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      }),
    ).toBeCloseTo(3, 6)
  })

  it('returns null for an unknown model or no model', () => {
    expect(
      estimateExecutorUsd({
        backend: 'codex',
        model: 'my-private-model-x',
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    ).toBeNull()
    expect(
      estimateExecutorUsd({
        backend: 'codex',
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    ).toBeNull()
  })
})
