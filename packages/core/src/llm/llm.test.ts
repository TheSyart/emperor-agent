// Emperor-side coverage for the ported LLM layer: DeepSeek serialization,
// pi-ai event translation, LlmClient failure normalization/config
// resolution/retry, and model_config entry → route mapping.
import { describe, expect, it } from 'vitest'
import type {
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
} from '@earendil-works/pi-ai'
import type { LlmAdapter } from './adapter'
import { serializeRequest } from './adapters/deepseek/serialize'
import { toStreamChunks } from './adapters/pi-ai/stream'
import { toPiContext } from './adapters/pi-ai/context'
import { LlmClient } from './client'
import { LlmError } from './error'
import {
  createAssistantMessage,
  createToolResultMessage,
  userText,
} from './message'
import { resolveRetryPolicy, retryDelayMs, shouldRetry } from './retry-policy'
import { routeFromEntry, type RouteSpec } from './route'
import type { ModelEntry } from '../config/model-config'
import type { GenerateOptions, StreamChunk } from './types'

function route(overrides: Partial<RouteSpec> = {}): RouteSpec {
  return {
    id: 'm1',
    catalogProvider: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    adapter: 'deepseek',
    modelId: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    contextWindow: 128_000,
    maxTokens: 8_192,
    vision: false,
    reasoning: true,
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    retryPolicy: resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 2,
      backoff: { initialDelayMs: 1, maxDelayMs: 2 },
    }),
    streamIdleTimeoutMs: 60_000,
    ...overrides,
  }
}

function entry(overrides: Partial<ModelEntry>): ModelEntry {
  return {
    entryId: 'e1',
    provider: 'openai',
    protocol: 'openai',
    modelId: 'gpt-4o',
    apiBase: 'https://api.openai.com/v1/',
    apiKey: 'sk',
    contextWindowTokens: null,
    maxTokens: null,
    reasoningEffort: null,
    name: 'gpt-4o',
    id: 'e1',
    mainModelId: 'gpt-4o',
    secondaryModelId: 'gpt-4o',
    label: 'GPT-4o',
    extraHeaders: null,
    extraBody: null,
    temperature: null,
    supportsVision: true,
    ...overrides,
  }
}

async function collect(
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('deepseek serializeRequest', () => {
  it('replays reasoning, tool calls, and tool results in wire shape', async () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'think' },
        {
          type: 'tool-call',
          id: 'c1',
          name: 'read',
          arguments: '{"file_path":"a"}',
        },
      ],
      source: { provider: 'm1', model: 'deepseek-chat' },
    })
    const body = await serializeRequest({
      provider: 'm1',
      model: 'deepseek-chat',
      system: 'sys',
      messages: [
        userText('hi'),
        assistant,
        createToolResultMessage({ callId: 'c1', content: [], isError: false }),
      ],
      tools: [
        { name: 'read', description: 'Read', parameters: { type: 'object' } },
      ],
      reasoningEffort: 'high',
      maxTokens: 100,
    })
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'think',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read', arguments: '{"file_path":"a"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '(no output)' },
    ])
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
    expect(body.max_tokens).toBe(100)
    expect(body.tools?.[0]?.function.name).toBe('read')
  })

  it('maps effort off to disabled thinking and disables thinking for titles', async () => {
    const base: GenerateOptions = {
      provider: 'm1',
      model: 'x',
      messages: [userText('q')],
    }
    expect(
      (await serializeRequest({ ...base, reasoningEffort: 'off' })).thinking,
    ).toEqual({ type: 'disabled' })
    const title = await serializeRequest({
      ...base,
      reasoningEffort: 'high',
      purpose: 'session-title',
    })
    expect(title.thinking).toEqual({ type: 'disabled' })
    expect(title.reasoning_effort).toBeUndefined()
  })

  it('inlines images through the resolver', async () => {
    const message = {
      ...userText('look'),
      content: [
        { type: 'text' as const, text: 'look' },
        {
          type: 'image' as const,
          attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 3 },
        },
      ],
    }
    const body = await serializeRequest(
      { provider: 'm1', model: 'x', messages: [message] },
      {},
      async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    )
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      ],
    })
  })
})

function piMessage(overrides: Partial<PiAssistantMessage>): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt',
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

async function* piEvents(
  ...events: AssistantMessageEvent[]
): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) yield event
}

describe('pi-ai toStreamChunks', () => {
  it('translates text and tool calls, re-encoding parsed arguments', async () => {
    const final = piMessage({
      content: [
        { type: 'text', text: 'ok' },
        {
          type: 'toolCall',
          id: 't1',
          name: 'grep',
          arguments: { pattern: 'x' },
        },
      ],
      stopReason: 'toolUse',
    })
    const partial = piMessage({
      content: [
        { type: 'text', text: 'ok' },
        { type: 'toolCall', id: 't1', name: 'grep', arguments: {} },
      ],
    })
    const chunks = await collect(
      toStreamChunks(
        piEvents(
          { type: 'text_start', contentIndex: 0, partial },
          { type: 'text_delta', contentIndex: 0, delta: 'ok', partial },
          { type: 'text_end', contentIndex: 0, content: 'ok', partial },
          { type: 'toolcall_start', contentIndex: 1, partial },
          {
            type: 'toolcall_delta',
            contentIndex: 1,
            delta: '{"pattern":"x"}',
            partial,
          },
          {
            type: 'toolcall_end',
            contentIndex: 1,
            toolCall: {
              type: 'toolCall',
              id: 't1',
              name: 'grep',
              arguments: { pattern: 'x' },
            },
            partial,
          },
          { type: 'done', reason: 'toolUse', message: final },
        ),
      ),
    )
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'block-start',
      'text-delta',
      'block-end',
      'block-start',
      'tool-call-delta',
      'block-end',
      'usage',
      'finish',
    ])
    expect(chunks[4]).toEqual({
      type: 'tool-call-delta',
      index: 1,
      id: 't1',
      name: 'grep',
      argumentsDelta: '{"pattern":"x"}',
    })
    expect(chunks[5]).toMatchObject({
      block: { type: 'tool-call', arguments: '{"pattern":"x"}' },
    })
    expect(chunks[6]).toEqual({
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 },
    })
    expect(chunks[7]).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
    })
  })

  it('classifies in-stream errors', async () => {
    const chunks = await collect(
      toStreamChunks(
        piEvents({
          type: 'error',
          reason: 'error',
          error: piMessage({
            stopReason: 'error',
            errorMessage: '429 rate limit exceeded',
          }),
        }),
      ),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } },
    })
  })

  it('builds context with tool result names recovered from tool calls', async () => {
    const assistant = createAssistantMessage({
      content: [
        {
          type: 'tool-call',
          id: 'c9',
          name: 'bash',
          arguments: '{"command":"ls"}',
        },
      ],
      source: { provider: 'e1', model: 'gpt' },
    })
    const context = await toPiContext(
      {
        provider: 'e1',
        model: 'gpt',
        system: 'sys',
        messages: [
          userText('go'),
          assistant,
          createToolResultMessage({
            callId: 'c9',
            content: [{ type: 'text', text: 'out' }],
            isError: true,
          }),
        ],
      },
      undefined,
    )
    expect(context.systemPrompt).toBe('sys')
    expect(context.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'c9',
      toolName: 'bash',
      isError: true,
    })
  })
})

function scripted(
  ...runs: (StreamChunk[] | Error)[]
): LlmAdapter & { calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  return {
    calls,
    async *stream(_route, options) {
      calls.push(options)
      const run = runs.shift()
      if (run === undefined) throw new Error('no scripted run')
      if (run instanceof Error) throw run
      yield* run
    },
  }
}

const okRun: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hello' },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('LlmClient', () => {
  it('normalizes adapter throws into a terminal error finish', async () => {
    const adapter = scripted(new LlmError('boom', 'SERVER', { status: 500 }))
    const client = new LlmClient({ adapterFor: () => adapter })
    client.setRoutes([route()], 'm1')
    const chunks = await collect(
      client.stream({ provider: 'm1', model: 'deepseek-chat', messages: [] }),
    )
    expect(chunks).toEqual([
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'boom', code: 'SERVER', status: 500 },
        },
      },
    ])
  })

  it('reports an unknown route as NO_ADAPTER', async () => {
    const client = new LlmClient({ adapterFor: () => scripted() })
    const chunks = await collect(
      client.stream({ provider: 'nope', model: 'x', messages: [] }),
    )
    expect(chunks[0]).toMatchObject({
      reason: { kind: 'error', failure: { code: 'NO_ADAPTER' } },
    })
  })

  it('materializes route defaults and rejects unsupported efforts', () => {
    const client = new LlmClient({ adapterFor: () => scripted() })
    client.setRoutes([route({ defaultReasoningEffort: 'high' })], 'm1')
    const prepared = client.prepareCall({
      provider: 'm1',
      model: 'deepseek-chat',
    })
    expect(prepared.config).toEqual({
      provider: 'm1',
      model: 'deepseek-chat',
      maxTokens: 8_192,
      reasoningEffort: 'high',
    })
    expect(prepared.adapterDefaults).toEqual({
      maxTokens: true,
      reasoningEffort: true,
    })
    expect(() =>
      client.prepareCall({
        provider: 'm1',
        model: 'deepseek-chat',
        reasoningEffort: 'medium',
      }),
    ).toThrow(/does not support reasoning effort/)
  })

  it('prepared calls dispatch once and only with their own config', () => {
    const client = new LlmClient({ adapterFor: () => scripted(okRun) })
    client.setRoutes([route()], 'm1')
    const prepared = client.prepareCall({
      provider: 'm1',
      model: 'deepseek-chat',
    })
    expect(() =>
      prepared.stream({ provider: 'm1', model: 'other', messages: [] }),
    ).toThrow(/config changed/)
    prepared.stream({ ...prepared.config, messages: [] })
    expect(() => prepared.stream({ ...prepared.config, messages: [] })).toThrow(
      /only be dispatched once/,
    )
  })

  it('complete() retries transient failures then assembles the message', async () => {
    const adapter = scripted(new LlmError('down', 'SERVER'), okRun)
    const client = new LlmClient({ adapterFor: () => adapter })
    client.setRoutes([route()], 'm1')
    const result = await client.complete({
      provider: 'm1',
      model: 'deepseek-chat',
      messages: [userText('q')],
    })
    expect(adapter.calls).toHaveLength(2)
    expect(result.text).toBe('hello')
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
  })

  it('complete() surfaces non-retryable failures', async () => {
    const client = new LlmClient({
      adapterFor: () =>
        scripted(new LlmError('bad key', 'AUTH', { status: 401 })),
    })
    client.setRoutes([route()], 'm1')
    await expect(
      client.complete({ provider: 'm1', model: 'deepseek-chat', messages: [] }),
    ).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('projects images to text for text-only routes', async () => {
    const adapter = scripted(okRun)
    const client = new LlmClient({ adapterFor: () => adapter })
    client.setRoutes([route({ vision: false })], 'm1')
    const message = {
      ...userText('x'),
      content: [
        {
          type: 'image' as const,
          attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1 },
        },
      ],
    }
    await collect(
      client.stream({
        provider: 'm1',
        model: 'deepseek-chat',
        messages: [message],
      }),
    )
    expect(adapter.calls[0]?.messages[0]?.content[0]).toMatchObject({
      type: 'text',
    })
  })
})

describe('retry arithmetic', () => {
  const policy = resolveRetryPolicy(undefined)
  it('backs off exponentially within the bound and honors Retry-After', () => {
    const failure = { message: 'x', code: 'SERVER' }
    expect(retryDelayMs(policy, 1, failure, () => 0.5)).toBe(500)
    expect(retryDelayMs(policy, 3, failure, () => 0.5)).toBe(2000)
    expect(retryDelayMs(policy, 10, failure, () => 0.5)).toBe(10_000)
    expect(
      retryDelayMs(policy, 1, { ...failure, providerRetryAfterMs: 1234 }),
    ).toBe(1234)
  })
  it('stops at the budget, on non-retryable codes, and on oversize Retry-After', () => {
    expect(shouldRetry(policy, { message: 'x', code: 'SERVER' }, 5)).toBe(true)
    expect(shouldRetry(policy, { message: 'x', code: 'SERVER' }, 6)).toBe(false)
    expect(shouldRetry(policy, { message: 'x', code: 'AUTH' }, 1)).toBe(false)
    expect(
      shouldRetry(
        policy,
        { message: 'x', code: 'RATE_LIMIT', providerRetryAfterMs: 60_000 },
        1,
      ),
    ).toBe(false)
  })
})

describe('routeFromEntry', () => {
  it('routes deepseek entries to the direct adapter with mapped efforts', () => {
    const r = routeFromEntry(
      entry({
        provider: 'deepseek',
        modelId: 'deepseek-chat',
        apiBase: null,
        reasoningEffort: 'medium',
      }),
    )
    expect(r.adapter).toBe('deepseek')
    expect(r.baseURL).toBe('https://api.deepseek.com')
    expect(r.defaultReasoningEffort).toBe('high')
  })
  it('routes other entries to pi-ai and trims the base URL', () => {
    const r = routeFromEntry(
      entry({
        protocol: 'anthropic',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        apiBase: 'https://api.anthropic.com/',
      }),
    )
    expect(r.adapter).toBe('pi-ai')
    expect(r.protocol).toBe('anthropic')
    expect(r.baseURL).toBe('https://api.anthropic.com')
    expect(r.id).toBe('e1')
  })
})
