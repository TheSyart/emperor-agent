// History pagination (message-boundary pages, beforeSeq cursor, hasMore,
// in-flight tail, fork seed hidden) and the wire sanitizer.
import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  userText,
} from '../llm/message'
import {
  historyFloor,
  historyPage,
  paginate,
  sanitizeForWire,
  WIRE_TOOL_ARGUMENTS_MAX_BYTES,
  WIRE_TOOL_RESULT_MAX_BYTES,
} from './history'
import type { Session } from './session'
import { SessionLogStore } from './store'
import { testSession } from './test-helpers'
import type { SessionEvent } from './types'

function runTurn(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', userText(text), { surfaceOp: 'append' })
  const chunkSeqs: number[] = []
  for (const piece of ['a', 'b']) {
    chunkSeqs.push(
      session.append('assistant/chunk', {
        turn,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: piece },
      }).seq,
    )
  }
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'ab' }],
        source: { provider: 'p', model: 'm' },
      }),
    },
    { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
  )
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('paginate', () => {
  it('returns everything when the log holds fewer messages than a page', () => {
    const session = testSession('s')
    runTurn(session, 1, 'one')
    const page = paginate(session.events, undefined, 50)
    expect(page.events).toHaveLength(session.events.length)
    expect(page.hasMore).toBe(false)
  })

  it('cuts at a message boundary and pulls in the chunks that built it', () => {
    const session = testSession('s')
    runTurn(session, 1, 'one')
    runTurn(session, 2, 'two')
    // 2 messages per turn: the last message is turn 2's assistant message,
    // whose group starts at its first chunk.
    const tail = paginate(session.events, undefined, 1)
    expect(tail.hasMore).toBe(true)
    expect(types(tail.events)).toEqual([
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const two = paginate(session.events, undefined, 2)
    expect(two.events[0]?.type).toBe('user/message')
    expect(two.events.every((event) => event.seq >= 10)).toBe(true)
  })

  it('pages backwards with beforeSeq until hasMore is false', () => {
    const session = testSession('s')
    for (let turn = 1; turn <= 3; turn++) runTurn(session, turn, `t${turn}`)
    const seen: SessionEvent[] = []
    let beforeSeq: number | undefined
    let pages = 0
    for (;;) {
      const page = paginate(session.events, beforeSeq, 2)
      pages++
      seen.unshift(...page.events)
      if (!page.hasMore) break
      beforeSeq = page.events[0]!.seq
    }
    // 3 message pages plus the leading turn/start + step/start of turn 1.
    expect(pages).toBe(4)
    expect(seen.map((event) => event.seq)).toEqual(
      session.events.map((event) => event.seq),
    )
  })

  it('keeps the in-flight partial on the tail page', () => {
    const session = testSession('s')
    runTurn(session, 1, 'one')
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('user/message', userText('two'), { surfaceOp: 'append' })
    session.append('assistant/chunk', {
      turn: 2,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'par' },
    })
    const page = paginate(session.events, undefined, 1)
    expect(types(page.events)).toEqual(['user/message', 'assistant/chunk'])
    expect(page.hasMore).toBe(true)
  })
})

describe('historyPage', () => {
  it('hides a fork child seed and its end-seed marker', () => {
    const store = new SessionLogStore({ root: '/tmp/unused', persist: false })
    const parent = store.create({ id: 'parent' })
    runTurn(parent, 1, 'parent turn')
    const child = store.fork('parent', 'child', { origin: 'subagent' })
    expect(child.header.seedLength).toBe(parent.events.length)
    expect(historyFloor(child.header, child.events)).toBe(
      parent.events.length + 1,
    )
    child.append('subagent/descriptor', {
      parentSession: 'parent',
      description: 'd',
      mode: 'fork',
    })
    runTurn(child, 2, 'child turn')
    const page = historyPage(child.header, child.events)
    expect(page.hasMore).toBe(false)
    expect(page.events[0]?.type).toBe('subagent/descriptor')
    expect(
      page.events.some(
        (event) =>
          event.type === 'user/message' &&
          JSON.stringify(event.data).includes('parent turn'),
      ),
    ).toBe(false)
    expect(page.lastSeq).toBe(child.events.at(-1)!.seq)
    // A cut that reaches the floor reports no older page.
    const small = historyPage(child.header, child.events, { maxMessages: 1 })
    expect(small.hasMore).toBe(true)
    const floor = parent.events.length + 1
    let beforeSeq = small.events[0]!.seq
    const older: SessionEvent[] = []
    for (;;) {
      const page = historyPage(child.header, child.events, {
        maxMessages: 1,
        beforeSeq,
      })
      older.unshift(...page.events)
      if (!page.hasMore) break
      beforeSeq = page.events[0]!.seq
    }
    expect(older[0]?.seq).toBe(floor)
    expect(older.every((event) => event.seq >= floor)).toBe(true)
  })

  it('reports lastSeq -1 for an empty log', () => {
    const session = testSession('empty')
    expect(historyPage(session.header, session.events)).toEqual({
      header: session.header,
      events: [],
      hasMore: false,
      lastSeq: -1,
    })
  })
})

describe('sanitizeForWire', () => {
  it('leaves small events untouched (same reference)', () => {
    const session = testSession('s')
    runTurn(session, 1, 'one')
    for (const event of session.events)
      expect(sanitizeForWire(event)).toBe(event)
  })

  it('truncates large tool/call arguments with a marker', () => {
    const session = testSession('s')
    const args = JSON.stringify({ content: 'x'.repeat(100_000) })
    const event = session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'write',
      arguments: args,
    })
    const wire = sanitizeForWire(event)
    expect(wire).not.toBe(event)
    expect(wire.wire).toMatchObject({
      truncated: true,
      field: 'arguments',
      bytes: args.length,
    })
    const data = wire.data as { arguments: string }
    expect(data.arguments.length).toBeLessThan(WIRE_TOOL_ARGUMENTS_MAX_BYTES)
    expect(args.startsWith(data.arguments)).toBe(true)
    // The log event itself is never mutated.
    expect(event.data.arguments).toBe(args)
  })

  it('truncates large settled tool results but keeps non-text blocks', () => {
    const session = testSession('s')
    const text = '日志'.repeat(60_000) // 6 bytes per repeat → 360KB
    const message = createToolResultMessage({
      callId: 'c1',
      isError: false,
      content: [
        { type: 'text', text },
        {
          type: 'image',
          attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 9 },
        },
      ],
    })
    const event = session.append(
      'tool/result',
      { turn: 1, step: 1, message },
      { surfaceOp: 'append' },
    )
    const wire = sanitizeForWire(event)
    expect(wire.wire).toMatchObject({ truncated: true, field: 'result' })
    expect(wire.wire!.bytes).toBeGreaterThan(WIRE_TOOL_RESULT_MAX_BYTES)
    const block = (wire as SessionEvent<'tool/result'>).data.message.content[0]
    expect(block.toolCallId).toBe('c1')
    expect(block.content[0]).toMatchObject({ type: 'text' })
    const head = (block.content[0] as { text: string }).text
    expect(head.includes('�')).toBe(false)
    expect(text.startsWith(head)).toBe(true)
    expect(block.content[1]).toMatchObject({ type: 'image' })
  })

  it('never touches assistant chunks', () => {
    const session = testSession('s')
    const event = session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'y'.repeat(400_000) },
    })
    expect(sanitizeForWire(event)).toBe(event)
  })
})
