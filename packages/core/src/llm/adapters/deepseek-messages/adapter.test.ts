// KRN-07: recorded-replay tests for the DeepSeek Messages adapter. Every
// exchange comes from a hand-written fixture in
// llm/fixtures/deepseek-messages/*.jsonl; nothing reaches the network.
import { describe, expect, it } from 'vitest'
import type { ModelEntry } from '../../../config/model-config'
import { ledgerUsage } from '../../../model/usage-cost'
import { BlockAssembler } from '../../assembler'
import { LlmClient } from '../../client'
import type { ImageResolver } from '../../content'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  userText,
  type Message,
} from '../../message'
import {
  resolveRetryPolicy,
  retryDelayMs,
  shouldRetry,
} from '../../retry-policy'
import { routeFromEntry, type RouteSpec } from '../../route'
import type {
  FinishReason,
  GenerateOptions,
  StreamChunk,
  ToolSchema,
} from '../../types'
import { DeepSeekMessagesAdapter } from './adapter'
import {
  loadExchanges,
  replayTransport,
  TINY_PNG,
  type FixtureExchange,
} from './testing'

const MESSAGES_URL = 'https://api.deepseek.com/anthropic/v1/messages'
const FILES_URL = 'https://api.deepseek.com/files'
/** Inside the fixture file's lifetime (created 1760950000, expires +1 day). */
const NOW = 1_760_950_000_000 + 5_000

function deepseekEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    entryId: 'ds-flash',
    provider: 'deepseek',
    protocol: 'openai',
    modelId: 'deepseek-flash',
    apiBase: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    contextWindowTokens: 1_048_576,
    maxTokens: 8_192,
    reasoningEffort: null,
    name: 'deepseek-flash',
    id: 'ds-flash',
    mainModelId: 'deepseek-flash',
    secondaryModelId: 'deepseek-flash',
    label: 'DeepSeek Flash',
    extraHeaders: null,
    extraBody: null,
    temperature: null,
    supportsVision: true,
    ...overrides,
  }
}

function messagesRoute(overrides: Partial<ModelEntry> = {}): RouteSpec {
  return {
    ...routeFromEntry(deepseekEntry(overrides)),
    retryPolicy: resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 2,
      backoff: { initialDelayMs: 1, maxDelayMs: 2_000, jitterRatio: 0 },
    }),
  }
}

function clientFor(
  adapter: DeepSeekMessagesAdapter,
  route: RouteSpec,
  images?: ImageResolver,
): LlmClient {
  const llm = new LlmClient({
    adapterFor: () => adapter,
    ...(images === undefined ? {} : { images }),
  })
  llm.setRoutes([route], route.id)
  return llm
}

interface TurnResult {
  chunks: StreamChunk[]
  finish: FinishReason
  message: Message
}

/** One model call as the agent loop makes it: stream, assemble, keep replay state. */
async function turn(
  llm: LlmClient,
  route: RouteSpec,
  options: Partial<GenerateOptions> & { messages: Message[] },
): Promise<TurnResult> {
  const chunks: StreamChunk[] = []
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: route.id,
    model: route.modelId,
    ...options,
  })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  const replayState = assembler.replayState
  const message = createAssistantMessage({
    content: assembler.blocks(),
    source: {
      provider: route.id,
      model: route.modelId,
      ...(replayState === undefined ? {} : { replayState }),
    },
  })
  // The session log stores messages as JSON; replay reads them back.
  return {
    chunks,
    finish: assembler.finish,
    message: JSON.parse(JSON.stringify(message)) as Message,
  }
}

const READ_TOOL: ToolSchema = {
  name: 'read',
  description: 'Read a file in the workspace.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

describe('DeepSeek Messages · recorded replay', () => {
  it('streams a plain text turn (1)', async () => {
    const transport = replayTransport(loadExchanges('text'))
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
    })
    const route = messagesRoute({ reasoningEffort: 'off' })
    const result = await turn(clientFor(adapter, route), route, {
      system: 'You are Emperor.',
      messages: [userText('你好')],
    })

    expect(result.chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'text-delta', index: 0, text: '，我在。' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '你好，我在。' },
      },
      {
        type: 'usage',
        usage: { inputTokens: 21, outputTokens: 6, cacheReadTokens: 0 },
      },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: {
            kind: 'deepseek-messages',
            version: 1,
            model: 'deepseek-flash',
            responseId: 'msg_text_1',
            stopReason: 'end_turn',
          },
          blocks: [{ type: 'text' }],
        },
      },
    ])
    expect(transport.pending()).toBe(0)
    const [call] = transport.calls
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe(MESSAGES_URL)
    expect(call?.headers).toMatchObject({
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    })
    expect(call?.headers).not.toHaveProperty('authorization')
    expect(call?.headers).not.toHaveProperty('anthropic-beta')
    expect(call?.body).toEqual({
      model: 'deepseek-flash',
      max_tokens: 8_192,
      system: 'You are Emperor.',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      thinking: { type: 'disabled' },
      stream: true,
    })
  })

  it('streams parallel tool calls and sends both results back in one user turn (2)', async () => {
    const transport = replayTransport(loadExchanges('tool-calls'))
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
    })
    const route = messagesRoute({ reasoningEffort: 'high' })
    const llm = clientFor(adapter, route)
    const ask = userText('读一下 src/a.ts 和 src/b.ts')
    const first = await turn(llm, route, {
      messages: [ask],
      tools: [READ_TOOL],
    })

    expect(first.finish).toEqual({ kind: 'tool-calls' })
    expect(first.message.content).toEqual([
      { type: 'reasoning', text: '两个文件互不依赖，可以一起读。' },
      { type: 'text', text: '我先看看这两个文件。' },
      {
        type: 'tool-call',
        id: 'call_00_a1',
        name: 'read',
        arguments: '{"path":"src/a.ts"}',
      },
      {
        type: 'tool-call',
        id: 'call_01_b2',
        name: 'read',
        arguments: '{"path":"src/b.ts"}',
      },
    ])
    // Each call shows up (id + name) as soon as its block opens.
    expect(first.chunks).toContainEqual({
      type: 'tool-call-delta',
      index: 2,
      id: 'call_00_a1',
      name: 'read',
      argumentsDelta: '',
    })
    expect(
      first.chunks.filter((chunk) => chunk.type === 'tool-call-delta'),
    ).toHaveLength(5)
    expect(transport.calls[0]?.body).toMatchObject({
      tools: [
        {
          name: 'read',
          description: 'Read a file in the workspace.',
          input_schema: READ_TOOL.parameters,
        },
      ],
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
    })

    const second = await turn(llm, route, {
      messages: [
        ask,
        first.message,
        createToolResultMessage({
          callId: 'call_00_a1',
          content: [{ type: 'text', text: 'export const a = 1' }],
          isError: false,
        }),
        createToolResultMessage({
          callId: 'call_01_b2',
          content: [{ type: 'text', text: 'ENOENT: src/b.ts' }],
          isError: true,
        }),
      ],
      tools: [READ_TOOL],
    })
    expect(second.message.content).toEqual([
      { type: 'text', text: '两个文件都读完了。' },
    ])
    const body = transport.calls[1]?.body as { messages: unknown[] }
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '读一下 src/a.ts 和 src/b.ts' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '两个文件互不依赖，可以一起读。',
            signature: 'sig-tools-7f3a',
          },
          { type: 'text', text: '我先看看这两个文件。' },
          {
            type: 'tool_use',
            id: 'call_00_a1',
            name: 'read',
            input: { path: 'src/a.ts' },
          },
          {
            type: 'tool_use',
            id: 'call_01_b2',
            name: 'read',
            input: { path: 'src/b.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_00_a1',
            content: [{ type: 'text', text: 'export const a = 1' }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_01_b2',
            content: [{ type: 'text', text: 'ENOENT: src/b.ts' }],
            is_error: true,
          },
        ],
      },
    ])
    expect(transport.pending()).toBe(0)
  })

  it('replays the thinking signature verbatim on the next turn (3)', async () => {
    const transport = replayTransport(loadExchanges('thinking-signature'))
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
    })
    const route = messagesRoute({ reasoningEffort: 'max' })
    const llm = clientFor(adapter, route)
    const ask = userText('2 加 2 等于几？')
    const first = await turn(llm, route, { messages: [ask] })
    expect(first.chunks.at(-1)).toMatchObject({
      type: 'finish',
      replayState: {
        blocks: [
          { type: 'reasoning', signature: 'EqQBCkgIBhABGAIiQHx9+/ds==' },
          { type: 'text' },
        ],
      },
    })

    await turn(llm, route, {
      messages: [ask, first.message, userText('再加 1 呢？')],
    })
    const body = transport.calls[1]?.body as {
      messages: Array<{ role: string; content: unknown[] }>
      output_config: unknown
    }
    expect(body.output_config).toEqual({ effort: 'max' })
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: '2 加 2，等于 4。',
          signature: 'EqQBCkgIBhABGAIiQHx9+/ds==',
        },
        { type: 'text', text: '答案是 4。' },
      ],
    })
  })

  it('uploads an image once through the Files API and reuses the file id (5)', async () => {
    const transport = replayTransport(loadExchanges('files-upload'))
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
      now: () => NOW,
    })
    const route = messagesRoute({ reasoningEffort: 'off' })
    let reads = 0
    const llm = clientFor(adapter, route, async () => {
      reads += 1
      return { data: TINY_PNG, mediaType: 'image/png' }
    })
    const ask = createUserMessage({
      content: [
        { type: 'text', text: '这是什么？' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'att-red-dot',
            mediaType: 'image/png',
            bytes: TINY_PNG.byteLength,
            width: 1,
            height: 1,
          },
        },
      ],
      source: { kind: 'user' },
    })
    const first = await turn(llm, route, { messages: [ask] })
    await turn(llm, route, {
      messages: [ask, first.message, userText('再看一眼。')],
    })

    expect(transport.calls.map((call) => `${call.method} ${call.url}`)).toEqual(
      [`POST ${FILES_URL}`, `POST ${MESSAGES_URL}`, `POST ${MESSAGES_URL}`],
    )
    expect(reads).toBe(1)
    const upload = transport.calls[0]!
    expect(upload.headers.authorization).toBe('Bearer sk-test')
    expect(upload.form).toEqual({
      purpose: 'user_data',
      'expires_after[anchor]': 'created_at',
      'expires_after[seconds]': '86400',
      file: {
        filename: expect.stringMatching(/^emperor-[0-9a-f]{24}\.png$/),
        type: 'image/png',
        size: TINY_PNG.byteLength,
      },
    })
    for (const call of transport.calls.slice(1)) {
      expect(call.headers['anthropic-beta']).toBe('files-api-2025-04-14')
      const body = call.body as {
        messages: Array<{ content: unknown[] }>
      }
      expect(body.messages[0]?.content).toEqual([
        { type: 'text', text: '这是什么？' },
        {
          type: 'image',
          source: { type: 'file', file_id: 'file-api-emp0001aa' },
        },
      ])
    }
  })

  it('falls back to an inline image when the upload fails, and stops retrying it for a while (6)', async () => {
    const transport = replayTransport(loadExchanges('files-fallback'))
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
      now: () => NOW,
    })
    const route = messagesRoute({ reasoningEffort: 'off' })
    const llm = clientFor(adapter, route, async () => ({
      data: TINY_PNG,
      mediaType: 'image/png',
    }))
    const ask = createUserMessage({
      content: [
        {
          type: 'image',
          attachment: {
            attachmentId: 'att-red-dot',
            mediaType: 'image/png',
            bytes: TINY_PNG.byteLength,
          },
        },
      ],
      source: { kind: 'user' },
    })
    const first = await turn(llm, route, { messages: [ask] })
    expect(first.finish).toEqual({ kind: 'stop' })
    await turn(llm, route, {
      messages: [ask, first.message, userText('好的？')],
    })

    expect(transport.calls.map((call) => `${call.method} ${call.url}`)).toEqual(
      [`POST ${FILES_URL}`, `POST ${MESSAGES_URL}`, `POST ${MESSAGES_URL}`],
    )
    const inline = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from(TINY_PNG).toString('base64'),
      },
    }
    for (const call of transport.calls.slice(1)) {
      expect(call.headers).not.toHaveProperty('anthropic-beta')
      const body = call.body as { messages: Array<{ content: unknown[] }> }
      expect(body.messages[0]?.content).toEqual([inline])
    }
  })

  it('continues a session that began on chat-completions (7)', async () => {
    const transport = replayTransport(loadExchanges('legacy-history'))
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
    })
    const route = messagesRoute({ reasoningEffort: 'high' })
    // Messages the chat-completions adapter left in the log: reasoning
    // blocks, no replay state.
    const history: Message[] = [
      userText('读一下 src/a.ts'),
      createAssistantMessage({
        content: [
          { type: 'reasoning', text: '需要先读文件。' },
          {
            type: 'tool-call',
            id: 'call_0',
            name: 'read',
            arguments: '{"path":"src/a.ts"}',
          },
        ],
        source: { provider: 'ds-flash', model: 'deepseek-flash' },
      }),
      createToolResultMessage({
        callId: 'call_0',
        content: [{ type: 'text', text: 'export const a = 1' }],
        isError: false,
      }),
      createAssistantMessage({
        content: [
          { type: 'reasoning', text: '换了模型之后的思考。' },
          { type: 'text', text: 'a.ts 导出 a。' },
        ],
        source: { provider: 'ds-pro', model: 'deepseek-v4-pro' },
      }),
      userText('继续'),
    ]
    const result = await turn(clientFor(adapter, route), route, {
      messages: history,
      tools: [READ_TOOL],
    })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([
      { type: 'reasoning', text: '接着上次的进度。' },
      { type: 'text', text: '继续：b.ts 依赖 a.ts。' },
    ])
    const body = transport.calls[0]?.body as { messages: unknown[] }
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '读一下 src/a.ts' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '需要先读文件。' },
          {
            type: 'tool_use',
            id: 'call_0',
            name: 'read',
            input: { path: 'src/a.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_0',
            content: [{ type: 'text', text: 'export const a = 1' }],
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a.ts 导出 a。' }],
      },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ])
  })

  it('maps usage with a cache hit into disjoint counts and the token ledger (10)', async () => {
    const transport = replayTransport(loadExchanges('usage-cache'))
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
    })
    const route = messagesRoute({ reasoningEffort: 'off' })
    const result = await turn(clientFor(adapter, route), route, {
      messages: [userText('again')],
    })
    const usage = result.chunks.find((chunk) => chunk.type === 'usage')
    expect(usage).toEqual({
      type: 'usage',
      usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800 },
    })
    const row = ledgerUsage(
      (usage as Extract<StreamChunk, { type: 'usage' }>).usage,
    )
    expect(row).toEqual({
      input: 200,
      output: 50,
      cache_read: 800,
      cache_create: 0,
      reasoning: 0,
    })
    // The usage page's hit rate: cache_read ÷ (cache_read + input + cache_create).
    expect(
      row.cache_read / (row.cache_read + row.input + row.cache_create),
    ).toBe(0.8)
  })
})

describe('DeepSeek Messages · failures and retries (11)', () => {
  function single(
    status: number,
    json: unknown,
    headers: Record<string, string> = {},
  ): FixtureExchange[] {
    return [
      {
        request: { method: 'POST', url: MESSAGES_URL },
        response: { status, headers, json },
      },
    ]
  }

  async function failureOf(exchanges: FixtureExchange[]) {
    const transport = replayTransport(exchanges)
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
    })
    const route = messagesRoute({ reasoningEffort: 'off' })
    const result = await turn(clientFor(adapter, route), route, {
      messages: [userText('ping')],
    })
    if (result.finish.kind !== 'error')
      throw new Error(`expected an error finish, got ${result.finish.kind}`)
    return { failure: result.finish.failure, chunks: result.chunks }
  }

  it('retries 429 and 503 under the route policy, then succeeds', async () => {
    const transport = replayTransport(loadExchanges('retry'))
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
    })
    const route = messagesRoute({ reasoningEffort: 'off' })
    const result = await clientFor(adapter, route).complete({
      provider: route.id,
      model: route.modelId,
      messages: [userText('ping')],
    })
    expect(result.text).toBe('pong')
    expect(transport.calls).toHaveLength(3)
  })

  it('reports 429 as RATE_LIMIT with the provider delay', async () => {
    const { failure } = await failureOf(
      single(
        429,
        {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Rate limit reached' },
        },
        { 'retry-after': '1', 'request-id': 'req_429' },
      ),
    )
    expect(failure).toMatchObject({
      code: 'RATE_LIMIT',
      status: 429,
      providerRetryAfterMs: 1_000,
      requestId: 'req_429',
      message: 'Rate limit reached',
    })
    const policy = resolveRetryPolicy(undefined)
    expect(shouldRetry(policy, failure, 1)).toBe(true)
    expect(retryDelayMs(policy, 1, failure)).toBe(1_000)
  })

  it('reports 5xx as retryable SERVER and 400 / 401 / 402 as final', async () => {
    const server = await failureOf(
      single(503, {
        error: { message: 'Server overloaded', type: 'server_error' },
      }),
    )
    expect(server.failure).toMatchObject({ code: 'SERVER', status: 503 })
    expect(shouldRetry(resolveRetryPolicy(undefined), server.failure, 1)).toBe(
      true,
    )

    const invalid = await failureOf(
      single(400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'max_tokens: too large',
        },
      }),
    )
    expect(invalid.failure).toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    })
    expect(shouldRetry(resolveRetryPolicy(undefined), invalid.failure, 1)).toBe(
      false,
    )
    const auth = await failureOf(
      single(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    )
    expect(auth.failure.code).toBe('AUTH')
    const balance = await failureOf(
      single(402, { error: { message: 'Insufficient Balance' } }),
    )
    expect(balance.failure.code).toBe('QUOTA')
  })

  it('turns an error event in the stream into a retryable failure', async () => {
    const { failure, chunks } = await failureOf(loadExchanges('stream-error'))
    expect(chunks).toContainEqual({
      type: 'text-delta',
      index: 0,
      text: 'Partial',
    })
    expect(failure).toMatchObject({ code: 'SERVER', message: 'Overloaded' })
    expect(shouldRetry(resolveRetryPolicy(undefined), failure, 1)).toBe(true)
  })

  it('treats a stream that ends before message_stop as a transport failure', async () => {
    const exchanges = loadExchanges('text')
    exchanges[0]!.response.sse = exchanges[0]!.response.sse!.slice(0, 5)
    const { failure } = await failureOf(exchanges)
    expect(failure.code).toBe('TRANSPORT')
  })
})

describe('DeepSeek Messages · one repair before giving up', () => {
  const okStream = loadExchanges('text')[0]!.response

  it('resends inline when the endpoint no longer knows a cached file id', async () => {
    const upload = loadExchanges('files-upload')[0]!
    const transport = replayTransport([
      upload,
      {
        request: { method: 'POST', url: MESSAGES_URL },
        response: {
          status: 400,
          headers: {},
          json: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'file not found: file-api-emp0001aa',
            },
          },
        },
      },
      { request: { method: 'POST', url: MESSAGES_URL }, response: okStream },
    ])
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
      now: () => NOW,
    })
    const route = messagesRoute({ reasoningEffort: 'off' })
    const llm = clientFor(adapter, route, async () => ({
      data: TINY_PNG,
      mediaType: 'image/png',
    }))
    const result = await turn(llm, route, {
      messages: [
        createUserMessage({
          content: [
            {
              type: 'image',
              attachment: {
                attachmentId: 'att-gone',
                mediaType: 'image/png',
                bytes: TINY_PNG.byteLength,
              },
            },
          ],
          source: { kind: 'user' },
        }),
      ],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    const retried = transport.calls[2]!
    expect(retried.headers).not.toHaveProperty('anthropic-beta')
    expect(
      (retried.body as { messages: Array<{ content: unknown[] }> }).messages[0]
        ?.content[0],
    ).toMatchObject({ type: 'image', source: { type: 'base64' } })
  })

  it('drops unsigned thinking once when the endpoint asks for a signature', async () => {
    const transport = replayTransport([
      {
        request: { method: 'POST', url: MESSAGES_URL },
        response: {
          status: 400,
          headers: {},
          json: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message:
                'messages.1.content.0.thinking.signature: Field required',
            },
          },
        },
      },
      { request: { method: 'POST', url: MESSAGES_URL }, response: okStream },
    ])
    const adapter = new DeepSeekMessagesAdapter({
      fetch: transport.fetch,
      transcoder: null,
    })
    const route = messagesRoute({ reasoningEffort: 'off' })
    const result = await turn(clientFor(adapter, route), route, {
      messages: [
        userText('hi'),
        createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'old thought' },
            { type: 'text', text: 'hello' },
          ],
          source: { provider: 'ds-flash', model: 'deepseek-flash' },
        }),
        userText('again'),
      ],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    const [first, second] = transport.calls as Array<{
      body: { messages: Array<{ content: unknown[] }> }
    }>
    expect(first!.body.messages[1]?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'old thought',
    })
    expect(second!.body.messages[1]?.content).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })
})
