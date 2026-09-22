// SessionLogStore: JSONL persistence round-trip, write-behind flush, chunk
// packing, truncated-tail tolerance, crash repair on open, and fork rules.
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, userText } from '../llm/message'
import { SessionForkError, SessionLogStore } from './store'

function store(): SessionLogStore {
  return new SessionLogStore({
    root: mkdtempSync(join(tmpdir(), 'session-log-')),
    writeBatchMaxDelayMs: 5,
  })
}

function runTurn(
  session: ReturnType<SessionLogStore['create']>,
  turn: number,
  text: string,
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', userText(text), { surfaceOp: 'append' })
  for (const piece of ['a', 'b', 'c', 'd']) {
    session.append('assistant/chunk', {
      turn,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: piece },
    })
  }
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'abcd' }],
        source: { provider: 'p', model: 'm' },
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('SessionLogStore', () => {
  it('round-trips a session through the JSONL log with packed chunk runs', () => {
    const s = store()
    const session = s.create({ id: 's1', cwd: '/tmp' })
    runTurn(session, 1, 'hello')
    s.close('s1')
    const lines = readFileSync(join(s.root, 's1', 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      type: 'session',
      id: 's1',
      cwd: '/tmp',
    })
    expect(lines.some((line) => line.includes('"text-chunks"'))).toBe(true)
    const reopened = s.open('s1')
    expect(reopened.events).toHaveLength(session.events.length)
    expect(reopened.events).toEqual(session.events)
    expect(reopened.deriveMessages().map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ])
  })

  it('flushes pending events after the write-behind delay', async () => {
    const s = store()
    const session = s.create({ id: 's2' })
    session.append('turn/start', { turn: 1 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(readFileSync(join(s.root, 's2', 'log.jsonl'), 'utf8')).toContain(
      'turn/start',
    )
  })

  it('drops a truncated trailing line and repairs the open turn', () => {
    const s = store()
    const session = s.create({ id: 's3' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
          ],
          source: { provider: 'p', model: 'm' },
        }),
      },
      { surfaceOp: 'append' },
    )
    s.close('s3')
    appendFileSync(join(s.root, 's3', 'log.jsonl'), '{"type":"tool/ca')
    const reopened = s.open('s3')
    const types = reopened.events.slice(-3).map((event) => event.type)
    expect(types).toEqual(['tool/result', 'step/end', 'turn/end'])
    expect(reopened.hasOpenTurn()).toBe(false)
    expect(reopened.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'interrupted',
    })
  })

  it('forks at a completed turn boundary and refuses open turns', () => {
    const s = store()
    const parent = s.create({ id: 'p', cwd: '/w' })
    runTurn(parent, 1, 'one')
    const child = s.fork('p', 'c', { origin: 'subagent', delegationDepth: 1 })
    expect(child.header).toMatchObject({
      parentSession: 'p',
      cwd: '/w',
      origin: 'subagent',
      delegationDepth: 1,
    })
    expect(child.events.at(-1)?.type).toBe('session/end-seed')
    expect(child.deriveMessages()).toHaveLength(2)
    parent.append('turn/start', { turn: 2 })
    expect(() => s.fork('p', 'c2')).toThrow(SessionForkError)
    expect(() => s.fork('p', 'c')).toThrow(/already exists/)
  })

  it('lists stored sessions and deletes them', () => {
    const s = store()
    s.create({ id: 'x' })
    s.create({ id: 'y' })
    expect(s.listStored().sort()).toEqual(['x', 'y'])
    s.delete('x')
    expect(s.listStored()).toEqual(['y'])
  })
})
