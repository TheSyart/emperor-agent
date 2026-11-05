import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { testRoute } from '../../../harness/testing'
import { routeFromEntry, type RouteSpec } from '../../route'
import type { GenerateOptions } from '../../types'
import type { StreamChunk } from '../../types'
import { PiAiAdapter } from './adapter'

let server: Server | null = null

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  )
  server = null
})

/** A local OpenAI-compatible server (Ollama, LM Studio) that needs no key. */
async function keylessServer(): Promise<{
  baseURL: string
  requests: Array<{ url: string; authorization: string | undefined }>
}> {
  const requests: Array<{ url: string; authorization: string | undefined }> = []
  server = createServer((req, res) => {
    requests.push({
      url: req.url ?? '',
      authorization: req.headers.authorization,
    })
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (value: unknown) =>
        res.write(`data: ${JSON.stringify(value)}\n\n`)
      chunk({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'qwen3:8b',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'pong' },
            finish_reason: null,
          },
        ],
      })
      chunk({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'qwen3:8b',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { baseURL: `http://127.0.0.1:${port}/v1`, requests }
}

async function send(
  route: RouteSpec,
  options: Partial<GenerateOptions> = {},
): Promise<string> {
  const chunks: StreamChunk[] = []
  for await (const chunk of new PiAiAdapter().stream(
    route,
    {
      provider: route.id,
      model: route.modelId,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: [{ type: 'text', text: 'ping' }],
          source: { kind: 'user' },
        },
      ],
      ...options,
    },
    {},
  ))
    chunks.push(chunk)
  return chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => (chunk as { text: string }).text)
    .join('')
}

describe('PiAiAdapter with a keyless local route (FIX-18)', () => {
  it('reaches the server and streams the reply', async () => {
    const { baseURL, requests } = await keylessServer()
    const text = await send(
      testRoute({
        catalogProvider: 'ollama',
        displayName: 'Ollama',
        modelId: 'qwen3:8b',
        baseURL,
        apiKey: null,
      }),
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('/v1/chat/completions')
    expect(text).toBe('pong')
  })

  it('keeps an auth header the route configures itself', async () => {
    const { baseURL, requests } = await keylessServer()
    await send(
      testRoute({
        catalogProvider: 'custom',
        modelId: 'qwen3:8b',
        baseURL,
        apiKey: null,
        extraHeaders: { Authorization: 'Bearer gateway-token' },
      }),
    )
    expect(requests[0]!.authorization).toBe('Bearer gateway-token')
  })
})

/** A local Anthropic Messages endpoint that captures the exact request body. */
async function anthropicServer(): Promise<{
  baseURL: string
  bodies: Array<Record<string, unknown>>
}> {
  const bodies: Array<Record<string, unknown>> = []
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type: string, data: unknown) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      event('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'kimi-for-coding',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      })
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'pong' },
      })
      event('content_block_stop', { type: 'content_block_stop', index: 0 })
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      })
      event('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { baseURL: `http://127.0.0.1:${port}`, bodies }
}

describe('PiAiAdapter Anthropic thinking control', () => {
  it('keeps thinking enabled for an always-thinking route during compaction', async () => {
    const { baseURL, bodies } = await anthropicServer()
    const route = testRoute({
      catalogProvider: 'moonshotai-cn',
      displayName: 'K3.1 Pro',
      protocol: 'anthropic',
      modelId: 'kimi-for-coding',
      baseURL,
      reasoning: true,
      reasoningEfforts: ['low', 'high', 'max'],
      defaultReasoningEffort: 'max',
      reasoningControl: 'always',
    })

    await send(route, { purpose: 'compaction', reasoningEffort: 'max' })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.thinking).toMatchObject({ type: 'enabled' })
    expect(bodies[0]!.thinking).not.toMatchObject({ type: 'disabled' })
  })

  it('still disables thinking for an optional route during compaction', async () => {
    const { baseURL, bodies } = await anthropicServer()
    const route = testRoute({
      protocol: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      baseURL,
      reasoning: true,
      reasoningEfforts: ['off', 'high'],
      defaultReasoningEffort: 'high',
      reasoningControl: 'toggle',
    })

    await send(route, { purpose: 'compaction', reasoningEffort: 'high' })

    expect(bodies[0]!.thinking).toEqual({ type: 'disabled' })
  })

  it('carries always-thinking metadata from a model entry into its route', () => {
    const route = routeFromEntry({
      entryId: 'kimi',
      provider: 'moonshotai-cn',
      protocol: 'anthropic',
      modelId: 'kimi-for-coding',
      apiBase: 'https://api.kimi.com/coding',
      apiKey: 'sk-test',
      contextWindowTokens: 262_144,
      maxTokens: 32_768,
      reasoningEffort: 'max',
      detected: {
        reasoning: true,
        reasoningControl: 'always',
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'max',
      },
      name: 'kimi-for-coding',
      id: 'kimi',
      mainModelId: 'kimi-for-coding',
      secondaryModelId: 'kimi-for-coding',
      label: 'K3.1 Pro',
      extraHeaders: null,
      extraBody: null,
      temperature: null,
      supportsVision: true,
    })

    expect(route.reasoningControl).toBe('always')
    expect(route.defaultReasoningEffort).toBe('max')
  })
})
