import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../tools/registry'
import { buildRoutedRunner } from './runner-factory'
import type { TurnContinuationEvaluator } from './turn-continuation'

describe('buildRoutedRunner continuation evaluator wiring', () => {
  it('passes the isolated continuation evaluator only when explicitly supplied', () => {
    const continuationEvaluator: TurnContinuationEvaluator = {
      evaluate: vi.fn(),
    }
    const runner = buildRoutedRunner({
      route: {
        snapshot: {
          provider: { chat: vi.fn() } as never,
          providerName: 'openai',
          providerLabel: 'OpenAI',
          model: 'active-model',
          apiBase: null,
          generation: {
            maxTokens: 2_000,
            temperature: 0.1,
            reasoningEffort: null,
          },
          contextWindowTokens: 128_000,
          config: {},
          supportsVision: false,
          entryName: 'active-entry',
          entryLabel: 'active-model',
          routeReason: 'main_agent',
        },
        useCase: 'main_agent',
        reason: 'main_agent',
        estimatedTokens: null,
      },
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      tokenTracker: null,
      usageType: 'main_agent',
      continuationEvaluator,
    })

    expect(runner.continuationEvaluator).toBe(continuationEvaluator)
  })
})
