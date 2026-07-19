import { describe, expect, it } from 'vitest'
import {
  LLMProvider,
  type ChatArgs,
  type ChatStreamArgs,
  type LLMResponse,
  type ToolCallRequest,
} from '../providers/base'
import { SamplingCoordinator } from '../sampling/coordinator'
import {
  createModelPolicyTurnState,
  ModelCaller,
  type ModelCallPolicy,
  type ModelCallTarget,
  type RunnerModelHost,
} from './model-caller'

const pricing = {
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 10,
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 3,
}

function response(
  content: string,
  usage: Record<string, number> = { input: 10, output: 2 },
): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage,
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

class ScriptProvider extends LLMProvider {
  calls = 0
  seen: ChatArgs[] = []

  constructor(
    readonly label: string,
    private readonly run: (
      args: ChatArgs | ChatStreamArgs,
      call: number,
    ) => Promise<LLMResponse>,
  ) {
    super({ defaultModel: label })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls += 1
    this.seen.push(args)
    return await this.run(args, this.calls)
  }

  override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    this.calls += 1
    this.seen.push(args)
    return await this.run(args, this.calls)
  }
}

function providerError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

function target(
  provider: LLMProvider,
  modelEntryId: string,
  overrides: Partial<ModelCallTarget> = {},
): ModelCallTarget {
  return {
    provider,
    model: `${modelEntryId}-model`,
    providerName: modelEntryId,
    modelEntryId,
    supportsToolCall: true,
    maxTokens: 1_000,
    temperature: 0,
    reasoningEffort: null,
    pricing,
    ...overrides,
  }
}

function host(
  primary: ModelCallTarget,
  policy: ModelCallPolicy | null,
): RunnerModelHost {
  return {
    provider: primary.provider,
    model: primary.model,
    providerName: primary.providerName,
    modelEntryId: primary.modelEntryId,
    supportsToolCall: primary.supportsToolCall,
    routeReason: 'test',
    routeEstimatedTokens: null,
    maxTokens: primary.maxTokens,
    temperature: primary.temperature,
    reasoningEffort: primary.reasoningEffort,
    pricing: primary.pricing,
    usageType: 'main_agent',
    lastEstimatedInputTokens: 1_000,
    lastModelCall: undefined as never,
    modelPolicy: policy,
    modelPolicyTurn: createModelPolicyTurnState(),
  }
}

function caller(runner: RunnerModelHost): ModelCaller {
  return new ModelCaller(
    runner,
    new SamplingCoordinator({
      maxAttempts: 3,
      deadlineMs: 10_000,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
      jitterRatio: 0,
      sleep: async () => undefined,
    }),
  )
}

describe('explicit model fallback policy', () => {
  it('exhausts primary retries, discards provisional output/tools, strips model-bound state, and emits one visible transition', async () => {
    let completedTools = 0
    const primaryProvider = new ScriptProvider(
      'primary',
      async (args, call) => {
        const stream = args as ChatStreamArgs
        await stream.onContentDelta?.(`leaked-${call}`)
        await stream.onToolCallComplete?.({
          id: `old-${call}`,
          name: 'write_file',
          arguments: { path: 'should-not-run' },
        })
        throw providerError(429, 'rate limit')
      },
    )
    const fallbackProvider = new ScriptProvider('fallback', async (args) => {
      await (args as ChatStreamArgs).onContentDelta?.('safe')
      return response('safe')
    })
    const primary = target(primaryProvider, 'primary')
    const fallback = target(fallbackProvider, 'fallback')
    const runner = host(primary, {
      fallback,
      triggerOn: ['rate_limit'],
      maxUsdPerAgentTurn: null,
    })
    const emitted: Array<Record<string, unknown>> = []
    const messages = [
      {
        role: 'assistant',
        content: 'visible',
        reasoning_content: 'private',
        thinking_blocks: [{ type: 'thinking', signature: 'sig' }],
        extra_content: { encrypted_reasoning: 'cipher' },
      },
      { role: 'user', content: 'continue' },
    ]

    const result = await caller(runner).ask({
      messages,
      tools: [],
      emit: (event) => {
        emitted.push(event)
      },
      onToolCallComplete: (_call: ToolCallRequest) => {
        completedTools += 1
      },
    })

    expect(result.content).toBe('safe')
    expect(primaryProvider.calls).toBe(3)
    expect(fallbackProvider.calls).toBe(1)
    expect(completedTools).toBe(0)
    expect(
      emitted
        .filter((event) => event.event === 'message_delta')
        .map((event) => event.delta),
    ).toEqual(['safe'])
    expect(
      emitted.filter((event) => event.event === 'model_route_fallback'),
    ).toHaveLength(1)
    expect(fallbackProvider.seen[0]?.messages[0]).toEqual({
      role: 'assistant',
      content: 'visible',
    })
    expect(messages[0]).toHaveProperty('reasoning_content', 'private')
    expect(runner.lastModelCall).toMatchObject({
      modelEntryId: 'fallback',
      usedFallback: true,
      fallbackReason: 'rate_limit',
      costComplete: false,
    })
  })

  it('never falls back for auth or for a trigger the user did not select', async () => {
    for (const [status, triggerOn] of [
      [401, ['rate_limit']],
      [503, ['rate_limit']],
    ] as const) {
      const primaryProvider = new ScriptProvider('primary', async () => {
        throw providerError(status, 'provider failed')
      })
      const fallbackProvider = new ScriptProvider('fallback', async () =>
        response('must not run'),
      )
      const runner = host(target(primaryProvider, 'primary'), {
        fallback: target(fallbackProvider, 'fallback'),
        triggerOn: [...triggerOn],
        maxUsdPerAgentTurn: null,
      })

      await expect(
        caller(runner).ask({
          messages: [{ role: 'user', content: 'hello' }],
          tools: null,
          emit: null,
        }),
      ).rejects.toHaveProperty(
        'code',
        status === 401 ? 'model_provider_auth' : 'model_provider_transient',
      )
      expect(fallbackProvider.calls).toBe(0)
    }
  })

  it('keeps fallback sticky inside the current policy scope', async () => {
    const primaryProvider = new ScriptProvider('primary', async () => {
      throw providerError(503, 'unavailable')
    })
    const fallbackProvider = new ScriptProvider('fallback', async () =>
      response('fallback'),
    )
    const runner = host(target(primaryProvider, 'primary'), {
      fallback: target(fallbackProvider, 'fallback'),
      triggerOn: ['transient'],
      maxUsdPerAgentTurn: null,
    })
    const modelCaller = caller(runner)

    await modelCaller.ask({
      messages: [{ role: 'user', content: 'one' }],
      tools: null,
      emit: null,
    })
    await modelCaller.ask({
      messages: [{ role: 'user', content: 'two' }],
      tools: null,
      emit: null,
    })

    expect(primaryProvider.calls).toBe(3)
    expect(fallbackProvider.calls).toBe(2)
    expect(runner.modelPolicyTurn?.activeTarget).toBe('fallback')
  })
})

describe('per-Agent-turn cost cap', () => {
  it('bounds output before the call, records actual cost, and blocks the next call after exhaustion', async () => {
    const maxTokens: number[] = []
    const provider = new ScriptProvider('primary', async (args) => {
      maxTokens.push(Number(args.maxTokens))
      return response('done', { input: 1_000, output: 800 })
    })
    const runner = host(target(provider, 'primary'), {
      fallback: null,
      triggerOn: ['rate_limit'],
      maxUsdPerAgentTurn: 0.01,
    })
    const modelCaller = caller(runner)

    await modelCaller.ask({
      messages: [{ role: 'user', content: 'spend' }],
      tools: [{ name: 'x' }],
      emit: null,
    })

    // 1,000 estimated message tokens + 14 serialized schema bytes +
    // 16 framing tokens, charged at the conservative $3/M input rate.
    expect(maxTokens).toEqual([691])
    expect(runner.lastModelCall).toMatchObject({
      costUsdNanos: 10_000_000,
      turnCostUsdNanos: 10_000_000,
      costCapUsdNanos: 10_000_000,
      costComplete: true,
    })
    await expect(
      modelCaller.ask({
        messages: [{ role: 'user', content: 'again' }],
        tools: null,
        emit: null,
      }),
    ).rejects.toHaveProperty('code', 'model_cost_cap_exceeded')
    expect(provider.calls).toBe(1)
  })
})
