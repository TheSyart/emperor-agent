import { it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DelegationHistory } from './delegation-history'
import {
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from '../../harness/delegation/testing'
import type { DelegationState } from '../../harness/delegation/fold'
it('pages durable public entries across repeated sequences, bounds bytes and validates cursors', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-'))
  try {
    const record = fixtureDelegationRecord(),
      run = fixtureDelegationRun()
    const state: DelegationState = {
      record,
      runs: { [run.id]: run },
      messages: {
        [run.messageId]: {
          id: run.messageId,
          text: 'task prompt',
          status: 'accepted',
        },
      },
      interactions: {},
      outbox: {},
      lastSeq: 3,
    }
    const dir = join(root, 'conversations', record.id, 'runs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, run.id + '.jsonl')
    const event = (e: object) =>
      JSON.stringify({
        delegationId: record.id,
        runId: run.id,
        journal_seq: 3,
        ...e,
      }) + '\n'
    writeFileSync(
      path,
      event({ type: 'text_delta', text: 'one' }) +
        event({ type: 'tool_started', id: 'tool-1', name: 'Read' }) +
        event({ type: 'thinking', text: 'private' }),
    )
    const history = new DelegationHistory(root)
    const first = history.read(state, { limit: 2 })
    expect(first.entries.map((e) => e.type)).toEqual(['text', 'tool'])
    expect(first.entries[1]?.toolId).toBe('tool-1')
    expect(first.hasBefore).toBe(true)
    expect(
      history.read(state, { before: first.before!, limit: 2 }).entries[0]?.text,
    ).toBe('task prompt')
    appendFileSync(path, event({ type: 'text_delta', text: 'two' }))
    const next = history.read(state, { after: first.after! })
    expect(next.entries.map((e) => e.text)).toEqual(['two'])
    expect(
      new DelegationHistory(root).read(state, { after: first.after! }).entries,
    ).toEqual(next.entries)
    expect(() =>
      history.read(state, { after: first.after!, before: first.before! }),
    ).toThrow()
    expect(() =>
      history.read(
        { ...state, record: { ...record, id: 'dlg-other' } },
        { after: first.after! },
      ),
    ).toThrow()
    expect(() => history.read(state, { after: 'invalid' })).toThrow()
    appendFileSync(
      path,
      event({ type: 'text_delta', text: '大'.repeat(300000) }),
    )
    let cursor = next.after!,
      count = 0
    for (
      let page = history.read(state, { after: cursor, limit: 500 });
      page.entries.length;
      page = history.read(state, { after: cursor, limit: 500 })
    ) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(300000)
      count += page.entries.reduce((n, e) => n + (e.text?.length ?? 0), 0)
      cursor = page.after!
    }
    expect(count).toBe(300000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('retains terminal result cursors across continuation runs and ignores incomplete append tails', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-runs-'))
  try {
    const record = fixtureDelegationRecord(),
      run = {
        ...fixtureDelegationRun(),
        phase: 'completed' as const,
        summary: 'first result',
      }
    const state: DelegationState = {
      record,
      runs: { [run.id]: run },
      messages: {
        [run.messageId]: {
          id: run.messageId,
          text: 'first prompt',
          status: 'accepted',
        },
      },
      interactions: {},
      outbox: {},
      lastSeq: 1,
    }
    const history = new DelegationHistory(root)
    const initial = history.read(state)
    expect(initial.entries.map((e) => e.type)).toEqual(['prompt', 'state'])
    const next = { ...fixtureDelegationRun('dgr-next'), messageId: 'dgm-next' }
    state.runs[next.id] = next
    state.messages[next.messageId] = {
      id: next.messageId,
      text: 'continue',
      status: 'accepted',
    }
    const dir = join(root, 'conversations', record.id, 'runs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, next.id + '.jsonl')
    const raw = JSON.stringify({
      type: 'text_delta',
      delegationId: record.id,
      runId: next.id,
      text: 'next result',
    })
    writeFileSync(path, raw.slice(0, -3))
    const during = history.read(state, { after: initial.after! })
    expect(during.entries.map((e) => e.text)).toEqual(['continue'])
    appendFileSync(path, raw.slice(-3) + '\n')
    const complete = history.read(state, { after: during.after! })
    expect(complete.entries.map((e) => e.text)).toEqual(['next result'])
    writeFileSync(path + '.public-index.json', 'damaged cache')
    expect(
      new DelegationHistory(root).read(state, { after: during.after! }).entries,
    ).toEqual(complete.entries)
    expect(
      history.read(state, { before: during.before!, limit: 500 }).entries,
    ).toEqual(initial.entries)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('defaults to a 200-entry tail, caps at 500 and exposes only public tool/question/permission fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-public-'))
  try {
    const record = fixtureDelegationRecord(),
      run = fixtureDelegationRun()
    const state: DelegationState = {
      record,
      runs: { [run.id]: run },
      messages: {},
      interactions: {},
      outbox: {},
      lastSeq: 1,
    }
    const dir = join(root, 'conversations', record.id, 'runs')
    mkdirSync(dir, { recursive: true })
    const write = (event: object) =>
      JSON.stringify({ delegationId: record.id, runId: run.id, ...event })
    writeFileSync(
      join(dir, run.id + '.jsonl'),
      [
        ...Array.from({ length: 505 }, (_, i) =>
          write({ type: 'text_delta', text: String(i), thinking: 'secret' }),
        ),
        write({
          type: 'question',
          requestId: 'question-one',
          questions: [
            {
              id: 'one',
              title: 'Choose',
              options: ['A', 'B'],
              private: 'secret',
            },
          ],
        }),
        write({
          type: 'permission_denied',
          requestId: 'permission-one',
          reason: 'Read only',
          raw: 'secret',
        }),
      ].join('\n') + '\n',
    )
    const history = new DelegationHistory(root)
    const tail = history.read(state)
    expect(tail.entries).toHaveLength(200)
    expect(history.read(state, { limit: 1000 }).entries).toHaveLength(500)
    expect(tail.entries.at(-2)).toMatchObject({
      type: 'question',
      requestId: 'question-one',
      text: 'Choose\n- A\n- B',
    })
    expect(tail.entries.at(-1)).toMatchObject({
      type: 'permission',
      requestId: 'permission-one',
      text: 'Read only',
    })
    expect(JSON.stringify(tail)).not.toContain('secret')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
