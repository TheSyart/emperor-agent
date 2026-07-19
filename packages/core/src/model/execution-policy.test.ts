import { describe, expect, it } from 'vitest'
import {
  calculateUsageCost,
  planCostBound,
  stripModelBoundMessageState,
  usdToNanos,
} from './execution-policy'

const pricing = {
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 10,
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 3,
}

describe('model execution cost policy', () => {
  it('uses deterministic nano-USD arithmetic for normalized usage categories', () => {
    expect(
      calculateUsageCost(
        {
          input: 1_000,
          output: 100,
          cache_read: 200,
          cache_create: 50,
        },
        pricing,
      ),
    ).toEqual({ costUsdNanos: 3_250_000, complete: true })
  })

  it('marks absent prices incomplete instead of interpreting them as free', () => {
    expect(calculateUsageCost({ input: 100 }, null)).toEqual({
      costUsdNanos: null,
      complete: false,
    })
  })

  it('reserves conservative input cost and reduces the output limit to budget', () => {
    expect(
      planCostBound({
        remainingUsdNanos: usdToNanos(0.01),
        estimatedInputTokens: 1_000,
        requestedMaxTokens: 1_000,
        pricing,
      }),
    ).toEqual({
      estimatedInputCostUsdNanos: 3_000_000,
      maxTokens: 700,
      bounded: true,
    })
  })

  it('supports explicitly free output while rejecting unaffordable input', () => {
    expect(
      planCostBound({
        remainingUsdNanos: 2_999_999,
        estimatedInputTokens: 1_000,
        requestedMaxTokens: 1_000,
        pricing: { ...pricing, outputUsdPerMillionTokens: 0 },
      }),
    ).toEqual({
      estimatedInputCostUsdNanos: 3_000_000,
      maxTokens: 0,
      bounded: true,
    })
  })
})

describe('cross-model message projection', () => {
  it('removes nested model-bound reasoning/signatures without mutating canonical input', () => {
    const canonical = [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: 'visible answer',
        reasoning_content: 'private reasoning',
        reasoning: 'vendor reasoning',
        thinking_blocks: [
          { type: 'thinking', thinking: 'hidden', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'encrypted' },
        ],
        extra_content: {
          safe_note: 'drop with vendor envelope',
          encrypted_reasoning: 'ciphertext',
          nested: { signature: 'sig-2' },
        },
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'ordinary result' },
      { role: 'user', content: 'continue' },
    ]

    const projected = stripModelBoundMessageState(canonical)

    expect(projected).toEqual([
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: 'visible answer',
        tool_calls: canonical[1]!.tool_calls,
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'ordinary result' },
      { role: 'user', content: 'continue' },
    ])
    expect(canonical[1]).toHaveProperty(
      'reasoning_content',
      'private reasoning',
    )
    expect(projected).not.toBe(canonical)
    expect(projected[1]).not.toBe(canonical[1])
  })
})
