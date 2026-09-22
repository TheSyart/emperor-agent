/**
 * Test harness for the agent kernel: a scripted model adapter plus an
 * in-memory session store. Each scripted reply is either a list of stream
 * chunks, a shorthand ({ text } / { tools } / { error }), or a function that
 * produces chunks from the request (to assert what the model saw).
 */

import type { LlmAdapter } from '../llm/adapter'
import { LlmClient } from '../llm/client'
import { resolveRetryPolicy } from '../llm/retry-policy'
import type { RouteSpec } from '../llm/route'
import type { GenerateOptions, StreamChunk, TokenUsage } from '../llm/types'
import { SessionLogStore } from '../session-log/store'
import { Agent, type AgentOptions } from './agent/agent'
import { createMiddleware, type AgentMiddleware } from './agent/middleware'
import { retryMiddleware } from './agent/retry'
import { SystemPromptAssembler } from './prompt/assembler'
import { assertRequestInvariant } from './agent/invariant'
import { ToolRegistry } from './tools/registry'

export type ScriptedReply =
  | StreamChunk[]
  | {
      text?: string
      reasoning?: string
      tools?: Array<{ id?: string; name: string; args?: unknown }>
      usage?: TokenUsage
      finish?: 'stop' | 'tool-calls' | 'max-tokens'
    }
  | { error: string; code?: string }
  | ((request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>)
  | { hang: true }

let callCounter = 0

/** Expand a shorthand reply into protocol chunks. */
export function replyChunks(
  reply: Exclude<
    ScriptedReply,
    ((request: GenerateOptions) => unknown) | { hang: true }
  >,
): StreamChunk[] {
  if (Array.isArray(reply)) return reply
  if ('error' in reply) {
    return [
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: reply.error, code: reply.code ?? 'SERVER' },
        },
      },
    ]
  }
  const chunks: StreamChunk[] = []
  let index = 0
  if (reply.reasoning !== undefined) {
    chunks.push({ type: 'block-start', index, blockType: 'reasoning' })
    chunks.push({ type: 'reasoning-delta', index, text: reply.reasoning })
    chunks.push({
      type: 'block-end',
      index,
      block: { type: 'reasoning', text: reply.reasoning },
    })
    index++
  }
  if (reply.text !== undefined) {
    chunks.push({ type: 'block-start', index, blockType: 'text' })
    for (const piece of reply.text.match(/.{1,4}/gs) ?? [''])
      chunks.push({ type: 'text-delta', index, text: piece })
    chunks.push({
      type: 'block-end',
      index,
      block: { type: 'text', text: reply.text },
    })
    index++
  }
  for (const tool of reply.tools ?? []) {
    const id = tool.id ?? `call-${++callCounter}`
    const args = JSON.stringify(tool.args ?? {})
    chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
    chunks.push({
      type: 'tool-call-delta',
      index,
      id,
      name: tool.name,
      argumentsDelta: args,
    })
    chunks.push({
      type: 'block-end',
      index,
      block: { type: 'tool-call', id, name: tool.name, arguments: args },
    })
    index++
  }
  chunks.push({
    type: 'usage',
    usage: reply.usage ?? { inputTokens: 10, outputTokens: 5 },
  })
  const finish =
    reply.finish ?? ((reply.tools?.length ?? 0) > 0 ? 'tool-calls' : 'stop')
  chunks.push({ type: 'finish', reason: { kind: finish } as { kind: 'stop' } })
  return chunks
}

export class ScriptedAdapter implements LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly replies: ScriptedReply[]

  constructor(replies: ScriptedReply[] = []) {
    this.replies = [...replies]
  }

  push(...replies: ScriptedReply[]): void {
    this.replies.push(...replies)
  }

  get remaining(): number {
    return this.replies.length
  }

  async *stream(
    _route: RouteSpec,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error('scripted adapter: no reply left')
    if (typeof reply === 'object' && !Array.isArray(reply) && 'hang' in reply) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        const signal = options.signal
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener(
          'abort',
          () => {
            reject(signal.reason)
          },
          { once: true },
        )
      })
      return
    }
    const chunks =
      typeof reply === 'function' ? await reply(options) : replyChunks(reply)
    for (const chunk of chunks) yield chunk
  }
}

export function testRoute(overrides: Partial<RouteSpec> = {}): RouteSpec {
  return {
    id: 'test-route',
    catalogProvider: 'test',
    displayName: 'Test',
    protocol: 'openai',
    adapter: 'pi-ai',
    modelId: 'test-model',
    baseURL: 'http://localhost',
    apiKey: 'k',
    contextWindow: 100_000,
    maxTokens: 4_096,
    vision: false,
    reasoning: false,
    reasoningEfforts: [],
    retryPolicy: resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 2,
      backoff: { initialDelayMs: 1, maxDelayMs: 2 },
    }),
    streamIdleTimeoutMs: 60_000,
    ...overrides,
  }
}

export interface TestHarness {
  adapter: ScriptedAdapter
  llm: LlmClient
  tools: ToolRegistry
  prompt: SystemPromptAssembler
  middleware: AgentMiddleware
  sessions: SessionLogStore
  agent(id?: string, options?: AgentOptions): Agent
}

export function createTestHarness(
  options: {
    replies?: ScriptedReply[]
    route?: Partial<RouteSpec>
    root?: string
  } = {},
): TestHarness {
  const adapter = new ScriptedAdapter(options.replies)
  const sessions = new SessionLogStore({
    root: options.root ?? '/tmp/emperor-test-sessions',
    persist: options.root !== undefined,
    writeBatchMaxDelayMs: 1,
  })
  // Every loop request must equal what the session log derives (dsh invariant).
  const llm = new LlmClient({
    adapterFor: () => adapter,
    onRequest: (request) => {
      assertRequestInvariant(request, (id) => sessions.get(id))
    },
  })
  llm.setRoutes([testRoute(options.route)], 'test-route')
  const tools = new ToolRegistry()
  const prompt = new SystemPromptAssembler()
  prompt.tools(({ agent }) => tools.schemas(agent))
  const middleware = createMiddleware()
  middleware.requestError.push(retryMiddleware(() => 0.5))
  let counter = 0
  return {
    adapter,
    llm,
    tools,
    prompt,
    middleware,
    sessions,
    agent(id?: string, agentOptions?: AgentOptions) {
      const sessionId = id ?? `session-${++counter}`
      const session =
        sessions.get(sessionId) ??
        sessions.tryOpen(sessionId) ??
        sessions.create({ id: sessionId, cwd: '/workspace' })
      return new Agent(
        session,
        { llm, tools, prompt, middleware },
        agentOptions,
      )
    },
  }
}
