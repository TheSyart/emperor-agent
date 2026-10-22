// Session projector units that the golden scripts do not isolate.
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import { SessionProjector, type UiEvent } from './projector'

function log(): {
  events: SessionEvent[]
  add(type: string, data: unknown): void
  chunk(chunk: StreamChunk): void
} {
  const events: SessionEvent[] = []
  const add = (type: string, data: unknown): void => {
    events.push({
      type,
      seq: events.length,
      time: 1_700_000_000_000 + events.length,
      data,
    } as unknown as SessionEvent)
  }
  return {
    events,
    add,
    chunk: (chunk) => add('assistant/chunk', { turn: 1, step: 1, chunk }),
  }
}

const retry = (retryId: string) => ({
  retryId,
  turn: 1,
  step: 1,
  provider: 'test-route',
  mode: 'normal',
  policyKey: 'normal',
  retry: 1,
  maxRetries: 2,
  delayMs: 1,
  failure: { message: 'socket closed', code: 'TRANSPORT' },
})

function project(events: SessionEvent[]): UiEvent[] {
  return SessionProjector.projectAll(events, { sessionId: 's' })
}

describe('SessionProjector', () => {
  it('tells the user when automatic compaction keeps failing (KRN-05)', () => {
    const l = log()
    l.add('turn/start', { turn: 1 })
    l.add('compaction/warning', { failures: 3 })
    const thought = project(l.events).find(
      (event) => event.event === 'agent_thought',
    )
    expect(thought).toMatchObject({
      thought_id: 'compaction-warning:1',
      stage: 'compaction',
      status: 'error',
      label: '上下文接近上限',
    })
    expect(String(thought?.summary)).toContain('建议 /compact 或新开会话')
  })

  it('drops a failed attempt’s streamed text on llm/retry and says so with assistant_reset', () => {
    const l = log()
    l.add('turn/start', { turn: 1 })
    l.add('step/start', { turn: 1, step: 1 })
    l.chunk({ type: 'block-start', index: 0, blockType: 'text' })
    l.chunk({ type: 'text-delta', index: 0, text: 'Half an ans' })
    l.add('llm/retry', retry('r1'))
    l.add('llm/retry-started', { retryId: 'r1', turn: 1, step: 1 })
    l.chunk({ type: 'block-start', index: 0, blockType: 'text' })
    l.chunk({ type: 'text-delta', index: 0, text: 'The answer.' })
    l.add('step/end', { turn: 1, step: 1 })
    l.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const out = project(l.events)
    const names = out.map((event) => event.event)
    const reset = names.indexOf('assistant_reset')
    expect(reset).toBeGreaterThan(names.indexOf('message_delta'))
    expect(out[reset]).toMatchObject({ content: '', turn_id: 's:1' })
    expect(out.find((event) => event.event === 'assistant_done')).toMatchObject(
      { content: 'The answer.' },
    )
  })

  it('keeps text from earlier steps of the turn and drops only the failed attempt', () => {
    const l = log()
    l.add('turn/start', { turn: 1 })
    l.add('step/start', { turn: 1, step: 1 })
    l.chunk({ type: 'text-delta', index: 0, text: 'Checking. ' })
    l.add('step/end', { turn: 1, step: 1 })
    l.add('step/start', { turn: 1, step: 2 })
    l.add('assistant/chunk', {
      turn: 1,
      step: 2,
      chunk: { type: 'text-delta', index: 0, text: 'Bro' },
    })
    l.add('llm/fallback', {
      fallbackId: 'f1',
      turn: 1,
      step: 2,
      from: 'test-route',
      to: 'backup',
      trigger: 'transient',
      failure: { message: 'socket closed', code: 'TRANSPORT' },
    })
    l.add('assistant/chunk', {
      turn: 1,
      step: 2,
      chunk: { type: 'text-delta', index: 0, text: 'Done.' },
    })
    l.add('step/end', { turn: 1, step: 2 })
    l.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const out = project(l.events)
    expect(
      out.filter((event) => event.event === 'assistant_reset'),
    ).toMatchObject([{ content: 'Checking. ' }])
    expect(out.find((event) => event.event === 'assistant_done')).toMatchObject(
      { content: 'Checking. Done.' },
    )
  })

  it('emits no assistant_reset when the failed attempt streamed no text', () => {
    const l = log()
    l.add('turn/start', { turn: 1 })
    l.add('step/start', { turn: 1, step: 1 })
    l.add('llm/retry', retry('r1'))
    l.chunk({ type: 'text-delta', index: 0, text: 'ok' })
    l.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(project(l.events).map((event) => event.event)).not.toContain(
      'assistant_reset',
    )
  })
})
