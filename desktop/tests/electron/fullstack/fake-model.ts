/**
 * Scripted OpenAI-compatible model for the full-stack computer use suite.
 * `POST /v1/chat/completions` (stream) answers the Agent's requests from a
 * queue of steps; each step sees the request (so it can read refs out of the
 * last observation) and returns tool calls or text. Requests without the
 * browser tools (titles, summaries) get a short text and leave the queue alone.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ChatMessage {
  role: string
  content?: unknown
  tool_calls?: Array<{ function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: Array<{ function: { name: string } }>
}

export type StepReply =
  | { text: string }
  | { tools: Array<{ name: string; args: Record<string, unknown> }> }

export type Step = (request: ChatRequest) => StepReply

export interface FakeModel {
  readonly apiBase: string
  /** Steps still queued. */
  readonly pending: number
  /** Agent requests served (for the receipt). */
  readonly served: Array<{ step: number; reply: StepReply }>
  enqueue(...steps: Step[]): void
  /** Errors thrown by steps (a failed expectation inside a step). */
  readonly errors: unknown[]
  close(): Promise<void>
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('\n')
  return ''
}

/** Text of the last tool result the model received. */
export function lastToolResult(request: ChatRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]!
    if (message.role === 'tool') return textOf(message.content)
    if (message.role === 'user') break
  }
  return ''
}

/** Decode the untrusted envelope around page text (see external-content.ts). */
export function pageText(result: string): string {
  if (!result.includes('content_begin')) return result
  const body = result.split('content_begin\n')[1]?.split('\ncontent_end')[0]
  if (body === undefined) return result
  try {
    return JSON.parse(body) as string
  } catch {
    return body
  }
}

/** The ref of the element named `name` in the last observation. */
export function refIn(request: ChatRequest, name: string): string {
  const text = pageText(lastToolResult(request))
  const line = text.split('\n').find((row) => row.includes(`"${name}"`))
  if (line === undefined)
    throw new Error(
      `no element "${name}" in the last observation:\n${text.slice(0, 2000)}`,
    )
  return line.trim().split(' ')[0]!
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function chunk(
  delta: Record<string, unknown>,
  finish: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-cu',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function usage(): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-cu',
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  })}\n\n`
}

let callSeq = 0

function stream(reply: StepReply): string {
  let out = chunk({ role: 'assistant', content: '' })
  if ('text' in reply) {
    out += chunk({ content: reply.text })
    out += chunk({}, 'stop')
  } else {
    reply.tools.forEach((tool, index) => {
      callSeq += 1
      out += chunk({
        tool_calls: [
          {
            index,
            id: `call_fake_${callSeq}`,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ],
      })
    })
    out += chunk({}, 'tool_calls')
  }
  return out + usage() + 'data: [DONE]\n\n'
}

export async function startFakeModel(): Promise<FakeModel> {
  const queue: Step[] = []
  const served: FakeModel['served'] = []
  const errors: unknown[] = []
  let step = 0
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== 'POST' ||
        !request.url?.endsWith('/chat/completions')
      ) {
        response.statusCode = 404
        response.end('{}')
        return
      }
      const body = JSON.parse(await readBody(request)) as ChatRequest
      const agent = (body.tools ?? []).some(
        (tool) => tool.function?.name === 'browser_open',
      )
      let reply: StepReply
      if (!agent) reply = { text: '网页操作' }
      else {
        const next = queue.shift()
        if (next === undefined) reply = { text: '（脚本已结束）' }
        else {
          step += 1
          try {
            reply = next(body)
          } catch (error) {
            errors.push(error)
            reply = {
              text: `脚本步骤出错：${error instanceof Error ? error.message : String(error)}`,
            }
          }
          served.push({ step, reply })
        }
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.end(stream(reply))
    })().catch((error: unknown) => {
      errors.push(error)
      response.statusCode = 500
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    apiBase: `http://127.0.0.1:${port}/v1`,
    get pending() {
      return queue.length
    },
    served,
    errors,
    enqueue: (...steps) => {
      queue.push(...steps)
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
