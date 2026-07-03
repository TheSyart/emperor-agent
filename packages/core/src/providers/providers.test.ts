import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from './anthropic'
import { BedrockProvider } from './bedrock'
import { DEFAULT_MAX_RETRIES, parseJsonArgs } from './base'
import { classifyProviderError } from './errors'
import { createProvider } from './factory'
import { AzureOpenAIProvider, OpenAICompatProvider } from './openai-compat'
import { findByName } from './registry'

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
    expect(classifyProviderError(Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' })))
      .toBe('context_overflow')
    expect(classifyProviderError(new Error('This model context window is too small for the prompt')))
      .toBe('context_overflow')
  })
})

// ── PROV-004 Anthropic ──

describe('AnthropicProvider', () => {
  const MESSAGES = [
    { role: 'system', content: '稳定系统前缀' },
    { role: 'user', content: 'hi' },
  ]

  it('native endpoint caches system as block list + last tool', () => {
    const prov = new AnthropicProvider({ apiKey: 'test', defaultModel: 'claude-opus-4-8' })
    const kw = prov.kwargsFor({ messages: MESSAGES, tools: [{ name: 't1', description: 'd1' }] })
    expect(Array.isArray(kw.system)).toBe(true)
    const sys = kw.system as Array<Record<string, unknown>>
    expect(sys[0]!.text).toBe('稳定系统前缀')
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' })
    const tools = kw.tools as Array<Record<string, unknown>>
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('third-party proxy stays uncached (system as string)', () => {
    const prov = new AnthropicProvider({ apiKey: 'test', apiBase: 'https://proxy.example.com/v1', defaultModel: 'claude' })
    const kw = prov.kwargsFor({ messages: MESSAGES, tools: [{ name: 't1', description: 'd1' }] })
    expect(kw.system).toBe('稳定系统前缀')
    const tools = kw.tools as Array<Record<string, unknown>>
    expect(Object.keys(tools[tools.length - 1]!).includes('cache_control')).toBe(false)
  })

  it('enables retries from the shared constant', () => {
    const prov = new AnthropicProvider({ apiKey: 'test', defaultModel: 'claude' })
    expect(prov.client.maxRetries).toBe(DEFAULT_MAX_RETRIES)
  })
})

// ── PROV-003 OpenAI-compat ──

describe('OpenAICompatProvider', () => {
  it('temperature forbidden for gpt-5/o1/o3/o4 or with reasoning', () => {
    const prov = new OpenAICompatProvider({ apiKey: 'test', spec: undefined, defaultModel: 'o1' })
    expect(prov.temperatureForbidden('o1', null)).toBe(true)
    expect(prov.temperatureForbidden('gpt-4o', 'medium')).toBe(true)
    expect(prov.temperatureForbidden('gpt-4o', null)).toBe(false)
  })

  it('extraBody maps thinkingStyle to vendor-specific keys', () => {
    const deepseek = findByName('deepseek')!
    const dashscope = findByName('dashscope')!
    expect(new OpenAICompatProvider({ apiKey: 'test', spec: deepseek, defaultModel: 'x' }).extraBodyForReasoning('medium'))
      .toEqual({ thinking: { type: 'enabled' } })
    expect(new OpenAICompatProvider({ apiKey: 'test', spec: dashscope, defaultModel: 'x' }).extraBodyForReasoning('medium'))
      .toEqual({ enable_thinking: true })
    expect(new OpenAICompatProvider({ apiKey: 'test', spec: deepseek, defaultModel: 'x' }).extraBodyForReasoning('none'))
      .toEqual({ thinking: { type: 'disabled' } })
  })

  it('usage parsing handles cached tokens', () => {
    const usage = OpenAICompatProvider.parseUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 300, cache_creation_input_tokens: 100 },
    })
    expect(usage).toEqual({ input: 600, output: 200, cache_read: 300, cache_create: 100 })
  })

  it('enables retries from the shared constant', () => {
    const prov = new OpenAICompatProvider({ apiKey: 'test', spec: undefined, defaultModel: 'gpt-x' })
    expect(prov.client.maxRetries).toBe(DEFAULT_MAX_RETRIES)
  })

  it('AzureOpenAI suffixes apiBase with /openai/v1/', () => {
    const az = new AzureOpenAIProvider({ apiKey: 'test', spec: undefined, apiBase: 'https://res.openai.azure.com', defaultModel: 'x' })
    expect(az.client.baseURL).toContain('/openai/v1/')
  })
})

// ── PROV-005 Bedrock ──

describe('BedrockProvider', () => {
  const MESSAGES = [
    { role: 'system', content: '系统提示词' },
    { role: 'user', content: 'hello' },
  ]

  it('converseRequest carries system and strips system messages', () => {
    const req = BedrockProvider.converseRequest('model-x', MESSAGES, 100, 0.5)
    expect(req.system).toEqual([{ text: '系统提示词' }])
    const msgs = req.messages as Array<Record<string, unknown>>
    expect(msgs.every((m) => m.role !== 'system')).toBe(true)
  })

  it('omits system key when there are no system messages', () => {
    const req = BedrockProvider.converseRequest('model-x', [{ role: 'user', content: 'hi' }], 100, 0.5)
    expect('system' in req).toBe(false)
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
    const prov = new AnthropicProvider({ apiKey: 'test', defaultModel: 'claude' })
    let receivedOptions: unknown = null
    ;(prov.client as any).messages = {
      stream: (_body: unknown, options: unknown) => {
        receivedOptions = options
        return { on: () => undefined, finalMessage: async () => fakeFinal }
      },
    }
    const controller = new AbortController()
    await prov.chatStream({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
    expect((receivedOptions as { signal?: AbortSignal })?.signal).toBe(controller.signal)
  })

  it('AnthropicProvider.chat passes signal in request options', async () => {
    const prov = new AnthropicProvider({ apiKey: 'test', defaultModel: 'claude' })
    let receivedOptions: unknown = null
    ;(prov.client as any).messages = {
      create: async (_body: unknown, options: unknown) => {
        receivedOptions = options
        return fakeFinal
      },
    }
    const controller = new AbortController()
    await prov.chat({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
    expect((receivedOptions as { signal?: AbortSignal })?.signal).toBe(controller.signal)
  })

  it('AnthropicProvider omits request options when no signal given', async () => {
    const prov = new AnthropicProvider({ apiKey: 'test', defaultModel: 'claude' })
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

  it('BedrockProvider.sendOptions maps signal to abortSignal', () => {
    const controller = new AbortController()
    expect(BedrockProvider.sendOptions({ messages: [], signal: controller.signal })).toEqual({ abortSignal: controller.signal })
    expect(BedrockProvider.sendOptions({ messages: [] })).toBeUndefined()
  })
})

// ── PROV-006 Factory ──

describe('createProvider', () => {
  it('routes to the correct backend class', () => {
    expect(createProvider({ apiKey: 'k', defaultModel: 'x', spec: findByName('anthropic') })).toBeInstanceOf(AnthropicProvider)
    expect(createProvider({ apiKey: 'k', defaultModel: 'x', spec: findByName('openai') })).toBeInstanceOf(OpenAICompatProvider)
    expect(createProvider({ apiKey: 'k', defaultModel: 'x', spec: findByName('azure_openai')! })).toBeInstanceOf(AzureOpenAIProvider)
  })
})
