// Browser-safe raw session-log builder for the dev chat gallery
// (`?chat-gallery`) and the ChatTimeline mount test. Emits the same event
// shapes the kernel logs (see conversation/testing/fixtures.ts LogBuilder),
// including streamed chunks so TTFT / tok/s and streaming states render.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'

export type ShowcaseBlock =
  | { reasoning: string }
  | { text: string }
  | { tool: { id: string; name: string; args: unknown } }

export interface ShowcaseResult {
  isError?: boolean
  meta?: unknown
  error?: { name: string; code: string }
}

/** Split text into streaming deltas of a few characters. */
function pieces(text: string, size = 6): string[] {
  const out: string[] = []
  for (let index = 0; index < text.length; index += size)
    out.push(text.slice(index, index + size))
  return out.length === 0 ? [''] : out
}

export class ShowcaseLog {
  readonly events: WireSessionEvent[] = []
  private seq = 0
  private messages = 0

  constructor(
    private time: number,
    private readonly route = { provider: 'deepseek', model: 'deepseek-v4' },
  ) {}

  tick(ms: number): this {
    this.time += ms
    return this
  }

  add(
    type: string,
    data: unknown,
    extra: Record<string, unknown> = {},
  ): WireSessionEvent {
    this.time += 40
    const event = {
      type,
      seq: this.seq++,
      time: this.time,
      data,
      ...extra,
    } as unknown as WireSessionEvent
    this.events.push(event)
    return event
  }

  user(
    text: string,
    meta: {
      attachments?: Record<string, unknown>[]
      display?: string
      source?: string
    } = {},
  ): string {
    const id = `user-${++this.messages}`
    if (meta.attachments || meta.display || meta.source)
      this.add('host/user-meta', {
        messageId: id,
        ...(meta.display === undefined ? {} : { displayContent: meta.display }),
        ...(meta.attachments === undefined
          ? {}
          : { attachments: meta.attachments }),
        ...(meta.source === undefined ? {} : { source: meta.source }),
      })
    this.add(
      'user/message',
      {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    )
    return id
  }

  context(
    producer: string,
    text: string,
    extra: { form?: string; summary?: string } = {},
  ): void {
    this.add(
      'user/message',
      {
        id: `ctx-${++this.messages}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'context', producer, ...extra },
      },
      { surfaceOp: 'append' },
    )
  }

  turnStart(turn: number): void {
    this.add('turn/start', { turn })
  }

  turnEnd(turn: number, reason: unknown = { kind: 'completed' }): void {
    this.add('turn/end', { turn, reason })
  }

  stepStart(turn: number, step: number): void {
    this.add('step/start', { turn, step })
  }

  stepEnd(turn: number, step: number): void {
    this.add('step/end', { turn, step })
  }

  /** Stream the blocks as chunks (optionally stopping before the message). */
  stream(
    turn: number,
    step: number,
    blocks: readonly ShowcaseBlock[],
    options: {
      settle?: boolean
      firstTokenMs?: number
      outputTokens?: number
    } = {},
  ): void {
    this.tick(options.firstTokenMs ?? 700)
    const chunk = (value: unknown): void => {
      this.add('assistant/chunk', { turn, step, chunk: value })
    }
    const content: unknown[] = []
    blocks.forEach((block, index) => {
      if ('reasoning' in block) {
        chunk({ type: 'block-start', index, blockType: 'reasoning' })
        for (const text of pieces(block.reasoning, 14))
          chunk({ type: 'reasoning-delta', index, text })
        const done = { type: 'reasoning', text: block.reasoning }
        chunk({ type: 'block-end', index, block: done })
        content.push(done)
      } else if ('text' in block) {
        chunk({ type: 'block-start', index, blockType: 'text' })
        for (const text of pieces(block.text, 10))
          chunk({ type: 'text-delta', index, text })
        const done = { type: 'text', text: block.text }
        chunk({ type: 'block-end', index, block: done })
        content.push(done)
      } else {
        const args = JSON.stringify(block.tool.args)
        chunk({ type: 'block-start', index, blockType: 'tool-call' })
        chunk({
          type: 'tool-call-delta',
          index,
          id: block.tool.id,
          name: block.tool.name,
          argumentsDelta: args,
        })
        const done = {
          type: 'tool-call',
          id: block.tool.id,
          name: block.tool.name,
          arguments: args,
        }
        chunk({ type: 'block-end', index, block: done })
        content.push(done)
      }
    })
    if (options.settle === false) return
    const usage = {
      inputTokens: 1800 + step * 420,
      outputTokens: options.outputTokens ?? 180,
      cacheReadTokens: 1200,
    }
    chunk({ type: 'usage', usage })
    const toolCalls = blocks.some((block) => 'tool' in block)
    chunk({
      type: 'finish',
      reason: { kind: toolCalls ? 'tool-calls' : 'stop' },
    })
    this.add(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: `assistant-${turn}-${step}`,
          role: 'assistant',
          content,
          source: { kind: 'model', ...this.route },
        },
        usage,
      },
      { surfaceOp: 'append' },
    )
  }

  call(
    turn: number,
    step: number,
    callId: string,
    name: string,
    args: unknown,
  ): void {
    this.add('tool/call', {
      turn,
      step,
      callId,
      name,
      arguments: JSON.stringify(args),
    })
  }

  result(
    turn: number,
    step: number,
    callId: string,
    text: string,
    extra: ShowcaseResult = {},
  ): void {
    this.tick(300)
    this.add(
      'tool/result',
      {
        turn,
        step,
        message: {
          id: `result-${callId}`,
          role: 'user',
          source: { kind: 'tool', callId },
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              content: [{ type: 'text', text }],
              ...(extra.isError === undefined
                ? {}
                : { isError: extra.isError }),
            },
          ],
        },
        ...(extra.meta === undefined ? {} : { meta: extra.meta }),
        ...(extra.error === undefined ? {} : { error: extra.error }),
      },
      { surfaceOp: 'append' },
    )
  }

  /** One settled tool step: stream the calls, then call + result each. */
  toolStep(
    turn: number,
    step: number,
    lead: readonly ShowcaseBlock[],
    calls: readonly {
      id: string
      name: string
      args: unknown
      result?: string
      extra?: ShowcaseResult
      between?: (log: ShowcaseLog) => void
    }[],
  ): void {
    this.stepStart(turn, step)
    this.stream(turn, step, [
      ...lead,
      ...calls.map((call) => ({
        tool: { id: call.id, name: call.name, args: call.args },
      })),
    ])
    for (const call of calls) {
      this.call(turn, step, call.id, call.name, call.args)
      call.between?.(this)
      if (call.result !== undefined)
        this.result(turn, step, call.id, call.result, call.extra)
    }
    if (calls.every((call) => call.result !== undefined))
      this.stepEnd(turn, step)
  }
}
