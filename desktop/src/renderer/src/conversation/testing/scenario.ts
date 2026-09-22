// Test-only loader for recorded reference scenarios (`testing/scenarios/*.jsonl`,
// ported from the dsh web snapshot suite). The recordings use a compressed
// chunk encoding and a few older payload shapes; this adapter expands them
// into Emperor raw `SessionEvent`s (seq from 0, synthetic clock).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WireSessionEvent } from '@emperor/core/runtime-contract'

type Json = Record<string, unknown>

const BASE_TIME = 1_784_000_000_000

function source(raw: unknown): Json {
  const value = (raw ?? {}) as Json
  if (value.kind === 'user') return { kind: 'user' }
  if (value.kind === 'tool') return value
  if (value.kind === 'context') return value
  const producer =
    typeof value.plugin === 'string'
      ? value.plugin
      : typeof value.producer === 'string'
        ? value.producer
        : 'unknown'
  return { kind: 'context', producer }
}

/** Expand one recorded scenario into raw events. */
export function loadScenario(name: string): WireSessionEvent[] {
  const text = readFileSync(
    resolve(__dirname, 'scenarios', `${name}.jsonl`),
    'utf8',
  )
  const events: WireSessionEvent[] = []
  let time = BASE_TIME
  const push = (type: string, data: unknown, extra: Json = {}): void => {
    time += 10
    events.push({
      type,
      seq: events.length,
      time,
      data,
      ...extra,
    } as unknown as WireSessionEvent)
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const record = JSON.parse(line) as { type: string; data?: Json } & Json
    if (record.type === 'session') continue
    const data = (record.data ?? {}) as Json
    const extra: Json = {}
    if (record.surfaceOp !== undefined) extra.surfaceOp = record.surfaceOp
    if (record.sourceEventSeqs !== undefined)
      extra.sourceEventSeqs = record.sourceEventSeqs
    switch (record.type) {
      case 'reasoning-chunks':
      case 'text-chunks': {
        const texts = data.texts as string[]
        const dt = (data.dt as number[] | undefined) ?? []
        texts.forEach((piece, index) => {
          time += dt[index - 1] ?? 0
          push('assistant/chunk', {
            turn: data.turn,
            step: data.step,
            chunk: {
              type:
                record.type === 'text-chunks'
                  ? 'text-delta'
                  : 'reasoning-delta',
              index: data.index,
              text: piece,
            },
          })
        })
        break
      }
      case 'tool-call-chunks': {
        const args = data.args as string[]
        const dt = (data.dt as number[] | undefined) ?? []
        args.forEach((piece, index) => {
          time += dt[index - 1] ?? 0
          push('assistant/chunk', {
            turn: data.turn,
            step: data.step,
            chunk: {
              type: 'tool-call-delta',
              index: data.index,
              id: data.id,
              ...(index === 0 ? { name: data.name } : {}),
              argumentsDelta: piece,
            },
          })
        })
        break
      }
      case 'assistant/message': {
        const message = (data.message ?? {
          content: data.content,
        }) as Json
        const provenance = (data.provenance ?? message.source ?? {}) as Json
        push(
          'assistant/message',
          {
            turn: data.turn,
            step: data.step,
            message: {
              id: message.id ?? `assistant-${events.length}`,
              role: 'assistant',
              content: message.content,
              source: {
                kind: 'model',
                provider: provenance.provider ?? 'unknown',
                model: provenance.model ?? 'unknown',
              },
            },
            ...(data.usage === undefined ? {} : { usage: data.usage }),
          },
          extra,
        )
        break
      }
      case 'user/message': {
        push(
          'user/message',
          {
            id: data.id ?? `user-${events.length}`,
            role: 'user',
            content: data.content,
            source: source(data.source),
          },
          extra,
        )
        break
      }
      case 'tool/result': {
        const message =
          (data.message as Json | undefined) ??
          ({
            source: { kind: 'tool', callId: data.callId },
            content: [
              {
                type: 'tool-result',
                toolCallId: data.callId,
                content: data.content,
                isError: data.isError,
              },
            ],
          } as Json)
        push(
          'tool/result',
          {
            turn: data.turn,
            step: data.step,
            message: {
              id: message.id ?? `tool-${events.length}`,
              role: 'user',
              ...message,
            },
            ...(data.meta === undefined ? {} : { meta: data.meta }),
          },
          extra,
        )
        break
      }
      case 'request/header': {
        const header = data.header as Json
        push('request/header', {
          ...data,
          header: {
            ...header,
            tools: Array.isArray(header.tools) ? header.tools : [],
          },
        })
        break
      }
      default:
        push(record.type, data, extra)
    }
  }
  return events
}
