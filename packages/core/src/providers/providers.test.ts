import { describe, expect, it } from 'vitest'
import {
  resolveModelProfile,
  type ResolvedModelProfile,
} from '../model/profile'
import { AnthropicProvider } from './anthropic'
import { DEFAULT_MAX_RETRIES, parseJsonArgs } from './base'
import { classifyProviderError } from './errors'
import { createProvider } from './factory'
import { OpenAICompatProvider } from './openai-compat'
import { findByName } from './registry'

function profile(
  protocol: 'openai' | 'anthropic',
  options: {
    provider?: string
    modelId?: string
    maxTokens?: number
    toolCall?: boolean
    vision?: boolean
    reasoning?: boolean
  } = {},
): ResolvedModelProfile {
  return resolveModelProfile({
    provider:
      options.provider ?? (protocol === 'anthropic' ? 'anthropic' : 'custom'),
    protocol,
    modelId: options.modelId ?? 'unknown-model',
    maxTokens: options.maxTokens,
    capabilityOverrides: {
      ...(options.toolCall === undefined
        ? {}
        : { toolCall: options.toolCall }),
      ...(options.vision === undefined ? {} : { vision: options.vision }),
      ...(options.reasoning === undefined
        ? {}
        : { reasoning: options.reasoning }),
    },
  })
}

const IMAGE_MESSAGE = {
  role: 'user',
  content: [
    { type: 'text', text: 'parsed attachment text' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aGVsbG8=' },
    },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    },
  ],
}

const TOOL = {
  type: 'function',
  function: {
    name: 'lookup',
    description: 'lookup data',
    parameters: { type: 'object', properties: {} },
  },
}

// ── PROV-001 parseJsonArgs ──

describe('parseJsonArgs', () => {
  it('returns a plain object for valid JSON, empty for bad input', () => {
    expect(parseJsonArgs({ a: 1 })).toEqual({ a: 1 })
    expect(parseJsonArgs('{"x":2}')).toEqual({ x: 2 })
    expect(parseJsonArgs('not json')).toEqual({})
    expect(parseJsonArgs('')).toEqual({})
  })
})

describe('classifyProviderError', () => {
  it('classifies context window errors before generic provider errors', () => {
    expect(
      classifyProviderError(
        Object.assign(new Error('maximum context length exceeded'), {
          code: 'context_length_exceeded',
        }),
      ),
    ).toBe('context_overflow')
    expect(
      classifyProviderError(
        new Error('This model context window is too small for the prompt'),
      ),
    ).toBe('context_overflow')
  })
})

// ── PROV-004 Anthropic ──

describe('AnthropicProvider', () => {
  const MESSAGES = [
    { role: 'system', content: '稳定系统前缀' },
    { role: 'user', content: 'hi' },
  ]

  it('native endpoint caches system as block list + last tool', () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude-opus-4-8',
    })
    const kw = prov.kwargsFor({
      messages: MESSAGES,
      tools: [{ name: 't1', description: 'd1' }],
    })
    expect(Array.isArray(kw.system)).toBe(true)
    const sys = kw.system as Array<Record<string, unknown>>
    expect(sys[0]!.text).toBe('稳定系统前缀')
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' })
    const tools = kw.tools as Array<Record<string, unknown>>
    expect(tools[tools.length - 1]!.cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  it('third-party proxy stays uncached (system as string)', () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      apiBase: 'https://proxy.example.com/v1',
      defaultModel: 'claude',
    })
    const kw = prov.kwargsFor({
      messages: MESSAGES,
      tools: [{ name: 't1', description: 'd1' }],
    })
    expect(kw.system).toBe('稳定系统前缀')
    const tools = kw.tools as Array<Record<string, unknown>>
    expect(
      Object.keys(tools[tools.length - 1]!).includes('cache_control'),
    ).toBe(false)
  })

  it('enables retries from the shared constant', () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude',
    })
    expect(prov.client.maxRetries).toBe(DEFAULT_MAX_RETRIES)
  })

  it('normalizes a full Messages resource URL before the SDK appends its path', () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      apiBase: 'https://proxy.example.com/gateway/v1/messages/',
      defaultModel: 'claude',
      profile: profile('anthropic'),
    })

    expect(prov.client.baseURL).toBe('https://proxy.example.com/gateway')
  })

  it('emits adaptive and summarized reasoning payloads without temperature', () => {
    const adaptive = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude-opus-4-6',
      profile: profile('anthropic', { modelId: 'claude-opus-4-6' }),
    }).kwargsFor({ messages: MESSAGES, reasoningEffort: 'max' })
    const summarized = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude-opus-4-7',
      profile: profile('anthropic', { modelId: 'claude-opus-4-7' }),
    }).kwargsFor({ messages: MESSAGES, reasoningEffort: 'xhigh' })

    expect(adaptive).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    })
    expect(summarized).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
    })
    expect(adaptive).not.toHaveProperty('temperature')
    expect(summarized).not.toHaveProperty('temperature')
  })

  it('caps budget reasoning within profile output and keeps none non-reasoning', () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude-3-7-sonnet',
      profile: profile('anthropic', {
        modelId: 'claude-3-7-sonnet',
        maxTokens: 20_000,
      }),
    })

    const high = prov.kwargsFor({
      messages: MESSAGES,
      maxTokens: 2_000,
      temperature: 0.25,
      reasoningEffort: 'high',
    })
    const max = prov.kwargsFor({
      messages: MESSAGES,
      maxTokens: 40_000,
      reasoningEffort: 'max',
    })
    const none = prov.kwargsFor({
      messages: MESSAGES,
      temperature: 0.25,
      reasoningEffort: 'none',
    })

    expect(high).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 9_999 },
      max_tokens: 10_000,
    })
    expect(high).not.toHaveProperty('temperature')
    expect(max).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 19_999 },
      max_tokens: 20_000,
    })
    expect(none).not.toHaveProperty('thinking')
    expect(none).toMatchObject({ temperature: 0.25, max_tokens: 20_000 })
  })

  it('gates tools and images from the resolved profile without dropping text', () => {
    const disabled = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude',
      profile: profile('anthropic', { toolCall: false, vision: false }),
    }).kwargsFor({ messages: [IMAGE_MESSAGE], tools: [TOOL] })
    const enabled = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude',
      profile: profile('anthropic', { toolCall: true, vision: true }),
    }).kwargsFor({ messages: [IMAGE_MESSAGE], tools: [TOOL] })

    expect(disabled).not.toHaveProperty('tools')
    expect(disabled).not.toHaveProperty('tool_choice')
    expect(disabled.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'parsed attachment text' }],
      },
    ])
    expect(enabled).toHaveProperty('tools')
    expect(enabled.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'parsed attachment text' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
    ])
  })
})

// ── PROV-003 OpenAI-compat ──

describe('OpenAICompatProvider', () => {
  it('temperature forbidden for gpt-5/o1/o3/o4 or with reasoning', () => {
    const prov = new OpenAICompatProvider({
      apiKey: 'test',
      spec: undefined,
      defaultModel: 'o1',
      profile: profile('openai', { modelId: 'gpt-4o', reasoning: true }),
    })
    expect(prov.temperatureForbidden('o1', null)).toBe(true)
    expect(prov.temperatureForbidden('gpt-4o', 'medium')).toBe(true)
    expect(prov.temperatureForbidden('gpt-4o', null)).toBe(false)
    expect(prov.temperatureForbidden('photo1-model', null)).toBe(false)
  })

  it('usage parsing handles cached tokens', () => {
    const usage = OpenAICompatProvider.parseUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: {
        cached_tokens: 300,
        cache_creation_input_tokens: 100,
      },
    })
    expect(usage).toEqual({
      input: 600,
      output: 200,
      cache_read: 300,
      cache_create: 100,
    })
  })

  it('enables retries from the shared constant', () => {
    const prov = new OpenAICompatProvider({
      apiKey: 'test',
      spec: undefined,
      defaultModel: 'gpt-x',
    })
    expect(prov.client.maxRetries).toBe(DEFAULT_MAX_RETRIES)
  })

  it('normalizes a full Chat Completions resource URL before SDK path handling', () => {
    const prov = new OpenAICompatProvider({
      apiKey: 'test',
      spec: undefined,
      apiBase: 'https://proxy.example.com/gateway/v1/chat/completions/',
      defaultModel: 'x',
      profile: profile('openai'),
    })

    expect(prov.client.baseURL).toBe('https://proxy.example.com/gateway/v1')
  })

  it('emits profile reasoning effort at top level and caps max output', () => {
    const prov = new OpenAICompatProvider({
      apiKey: 'test',
      spec: findByName('openai'),
      defaultModel: 'gpt-5.2',
      profile: profile('openai', {
        provider: 'openai',
        modelId: 'gpt-5.2',
        maxTokens: 12_000,
      }),
    })

    const kwargs = prov.kwargsFor(
      {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50_000,
        temperature: 0.8,
        reasoningEffort: 'xhigh',
      },
      false,
    )

    expect(kwargs).toMatchObject({
      reasoning_effort: 'xhigh',
      max_completion_tokens: 12_000,
    })
    expect(kwargs).not.toHaveProperty('temperature')
    expect(kwargs).not.toHaveProperty('extra_body')
  })

  it('does not add vendor reasoning history fields for OpenAI effort models', () => {
    const prov = new OpenAICompatProvider({
      apiKey: 'test',
      spec: findByName('openai'),
      defaultModel: 'gpt-5.2',
      profile: profile('openai', {
        provider: 'openai',
        modelId: 'gpt-5.2',
      }),
    })

    const kwargs = prov.kwargsFor(
      {
        messages: [
          { role: 'assistant', content: 'previous answer' },
          { role: 'user', content: 'continue' },
        ],
        reasoningEffort: 'high',
      },
      false,
    )

    expect(kwargs.messages).toEqual([
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'continue' },
    ])
  })

  it.each([
    ['deepseek', 'deepseek-reasoner', 'thinking', { type: 'disabled' }, { type: 'enabled' }],
    ['dashscope', 'qwen3-thinking', 'enable_thinking', false, true],
    ['minimax', 'MiniMax-M2', 'reasoning_split', false, true],
  ] as const)(
    'emits %s reasoning toggle values directly in the request body',
    (provider, modelId, key, disabled, enabled) => {
      const prov = new OpenAICompatProvider({
        apiKey: 'test',
        spec: findByName(provider),
        defaultModel: modelId,
        profile: profile('openai', { provider, modelId }),
      })

      const none = prov.kwargsFor(
        {
          messages: [{ role: 'user', content: 'hi' }],
          reasoningEffort: 'none',
        },
        false,
      )
      const high = prov.kwargsFor(
        {
          messages: [{ role: 'user', content: 'hi' }],
          reasoningEffort: 'high',
        },
        false,
      )

      expect(none[key]).toEqual(disabled)
      expect(none).toHaveProperty('temperature')
      expect(high[key]).toEqual(enabled)
      expect(high).not.toHaveProperty('temperature')
      expect(none).not.toHaveProperty('extra_body')
      expect(high).not.toHaveProperty('extra_body')
    },
  )

  it('omits unsupported reasoning and keeps temperature for ordinary models', () => {
    const prov = new OpenAICompatProvider({
      apiKey: 'test',
      defaultModel: 'ordinary-model',
      profile: profile('openai', { reasoning: false }),
    })
    const kwargs = prov.kwargsFor(
      {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.35,
        reasoningEffort: 'high',
      },
      false,
    )

    expect(kwargs).toMatchObject({ temperature: 0.35 })
    expect(kwargs).not.toHaveProperty('reasoning_effort')
    expect(kwargs).not.toHaveProperty('thinking')
    expect(kwargs).not.toHaveProperty('enable_thinking')
    expect(kwargs).not.toHaveProperty('reasoning_split')
  })

  it('does not backfill reasoning history when the profile disables reasoning', () => {
    const prov = new OpenAICompatProvider({
      apiKey: 'test',
      spec: findByName('deepseek'),
      defaultModel: 'deepseek-reasoner',
      profile: profile('openai', {
        provider: 'deepseek',
        modelId: 'deepseek-reasoner',
        reasoning: false,
      }),
    })

    const kwargs = prov.kwargsFor(
      {
        messages: [
          { role: 'assistant', content: 'previous answer' },
          { role: 'user', content: 'continue' },
        ],
        reasoningEffort: 'high',
      },
      false,
    )

    expect(kwargs).not.toHaveProperty('thinking')
    expect(kwargs.messages).toEqual([
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'continue' },
    ])
  })

  it('gates tools and images from the resolved profile without dropping text', () => {
    const disabled = new OpenAICompatProvider({
      apiKey: 'test',
      defaultModel: 'ordinary-model',
      profile: profile('openai', { toolCall: false, vision: false }),
    }).kwargsFor({ messages: [IMAGE_MESSAGE], tools: [TOOL] }, false)
    const enabled = new OpenAICompatProvider({
      apiKey: 'test',
      defaultModel: 'ordinary-model',
      profile: profile('openai', { toolCall: true, vision: true }),
    }).kwargsFor({ messages: [IMAGE_MESSAGE], tools: [TOOL] }, false)

    expect(disabled).not.toHaveProperty('tools')
    expect(disabled).not.toHaveProperty('tool_choice')
    expect(disabled.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'parsed attachment text' }],
      },
    ])
    expect(enabled).toHaveProperty('tools')
    expect(enabled.messages).toEqual([IMAGE_MESSAGE])
  })

  it('preserves legacy extra body keys but strips UI/profile-only fields', () => {
    const prov = new OpenAICompatProvider({
      apiKey: 'test',
      defaultModel: 'ordinary-model',
      profile: profile('openai'),
      extraBody: {
        top_k: 20,
        entryId: 'entry-1',
        provider: 'custom',
        protocol: 'anthropic',
        modelId: 'ui-model-id',
        displayName: 'UI model',
        apiBase: 'https://leak.invalid',
        apiKey: 'leak',
        capabilityOverrides: { vision: true },
        toolCall: true,
        vision: true,
        reasoning: true,
        sources: { reasoning: 'override' },
        contextWindowTokens: 123,
        maxTokens: 456,
        reasoningEffort: 'high',
        reasoningEfforts: ['high'],
        reasoningAdapter: 'openai_effort',
        profile: { vision: true },
      },
    })

    const kwargs = prov.kwargsFor(
      { messages: [{ role: 'user', content: 'hi' }] },
      false,
    )

    expect(kwargs).toMatchObject({ top_k: 20 })
    expect(kwargs).not.toHaveProperty('extra_body')
    for (const key of [
      'entryId',
      'provider',
      'protocol',
      'modelId',
      'displayName',
      'apiBase',
      'apiKey',
      'capabilityOverrides',
      'toolCall',
      'vision',
      'reasoning',
      'sources',
      'contextWindowTokens',
      'maxTokens',
      'reasoningEffort',
      'reasoningEfforts',
      'reasoningAdapter',
      'profile',
    ])
      expect(kwargs).not.toHaveProperty(key)
  })
})

// ── Wave1.1 AbortSignal 透传 ──

describe('AbortSignal forwarding', () => {
  const fakeFinal = {
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }

  it('AnthropicProvider.chatStream passes signal in request options', async () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude',
    })
    let receivedOptions: unknown = null
    ;(prov.client as any).messages = {
      stream: (_body: unknown, options: unknown) => {
        receivedOptions = options
        return { on: () => undefined, finalMessage: async () => fakeFinal }
      },
    }
    const controller = new AbortController()
    await prov.chatStream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })
    expect((receivedOptions as { signal?: AbortSignal })?.signal).toBe(
      controller.signal,
    )
  })

  it('AnthropicProvider.chat passes signal in request options', async () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude',
    })
    let receivedOptions: unknown = null
    ;(prov.client as any).messages = {
      create: async (_body: unknown, options: unknown) => {
        receivedOptions = options
        return fakeFinal
      },
    }
    const controller = new AbortController()
    await prov.chat({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })
    expect((receivedOptions as { signal?: AbortSignal })?.signal).toBe(
      controller.signal,
    )
  })

  it('AnthropicProvider omits request options when no signal given', async () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude',
    })
    let receivedOptions: unknown = 'sentinel'
    ;(prov.client as any).messages = {
      stream: (_body: unknown, options: unknown) => {
        receivedOptions = options
        return { on: () => undefined, finalMessage: async () => fakeFinal }
      },
    }
    await prov.chatStream({ messages: [{ role: 'user', content: 'hi' }] })
    expect(receivedOptions).toBeUndefined()
  })

})

// ── Wave5 onToolCallComplete ──

describe('onToolCallComplete streaming (Wave5)', () => {
  it('AnthropicProvider fires onToolCallComplete for each tool_use content block', async () => {
    const prov = new AnthropicProvider({
      apiKey: 'test',
      defaultModel: 'claude',
    })
    const handlers: Record<string, (arg: unknown) => void> = {}
    const final = {
      content: [
        { type: 'text', text: 'ok' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_file',
          input: { path: 'a.ts' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    ;(prov.client as any).messages = {
      stream: () => ({
        on: (event: string, cb: (arg: unknown) => void) => {
          handlers[event] = cb
        },
        finalMessage: async () => {
          handlers.contentBlock?.({ type: 'text', text: 'ok' })
          handlers.contentBlock?.({
            type: 'tool_use',
            id: 'toolu_1',
            name: 'read_file',
            input: { path: 'a.ts' },
          })
          return final
        },
      }),
    }
    const completed: Array<{ id: string; name: string }> = []
    const resp = await prov.chatStream({
      messages: [{ role: 'user', content: 'hi' }],
      onToolCallComplete: (call) => {
        completed.push({ id: call.id, name: call.name })
      },
    })
    expect(completed).toEqual([{ id: 'toolu_1', name: 'read_file' }])
    expect(resp.toolCalls).toHaveLength(1)
  })

  it('OpenAICompatProvider assembleStreamingToolCall fires a completed call once its index finalizes', () => {
    const fired: Array<{ id: string; name: string }> = []
    const buf = { id: 'call_x', name: 'grep', arguments: '{"pattern":"x"}' }
    OpenAICompatProvider.fireCompletedToolChunk(buf, (call) => {
      fired.push({ id: call.id, name: call.name })
    })
    expect(fired).toEqual([{ id: 'call_x', name: 'grep' }])
  })
})

// ── PROV-006 Factory ──

describe('createProvider', () => {
  const profileFor = (protocol: 'openai' | 'anthropic') =>
    resolveModelProfile({
      provider: 'custom',
      protocol,
      modelId: 'model-x',
    })

  it('routes exclusively by the explicit protocol', () => {
    expect(
      createProvider({
        protocol: 'anthropic',
        profile: profileFor('anthropic'),
        apiKey: 'k',
        defaultModel: 'x',
        spec: findByName('deepseek'),
      }),
    ).toBeInstanceOf(AnthropicProvider)
    expect(
      createProvider({
        protocol: 'openai',
        profile: profileFor('openai'),
        apiKey: 'k',
        defaultModel: 'x',
        spec: findByName('anthropic'),
      }),
    ).toBeInstanceOf(OpenAICompatProvider)
  })

  it('uses the selected protocol default API base when none is supplied', () => {
    const prov = createProvider({
      protocol: 'anthropic',
      profile: profileFor('anthropic'),
      apiKey: 'k',
      defaultModel: 'x',
      spec: findByName('deepseek'),
    })

    expect(prov).toBeInstanceOf(AnthropicProvider)
    expect((prov as AnthropicProvider).client.baseURL).toBe(
      'https://api.deepseek.com/anthropic',
    )
  })

  it('requires custom providers to select one of the two protocols', () => {
    expect(
      createProvider({
        protocol: 'anthropic',
        profile: profileFor('anthropic'),
        apiKey: 'k',
        defaultModel: 'x',
        spec: findByName('custom'),
      }),
    ).toBeInstanceOf(AnthropicProvider)

    expect(() =>
      createProvider({
        protocol: 'bedrock' as never,
        profile: profileFor('openai'),
        apiKey: 'k',
        defaultModel: 'x',
        spec: findByName('custom'),
      }),
    ).toThrow(/protocol/i)
  })
})
