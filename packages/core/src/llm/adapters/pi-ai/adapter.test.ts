import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { testRoute } from '../../../harness/testing'
import type { RouteSpec } from '../../route'
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

async function send(route: RouteSpec): Promise<string> {
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
