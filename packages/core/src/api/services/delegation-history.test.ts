import { it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DelegationHistory } from './delegation-history'
import {
  fixtureDelegationRecord,
  fixtureDelegationRun,
} from '../../harness/delegation/testing'
import type { DelegationState } from '../../harness/delegation/fold'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

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
        write({ type: 'public_prompt', text: 'secret' }),
        write({
          type: 'public_prompt',
          messageId: 'dgm-unowned',
          text: 'secret',
        }),
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
it('retains accepted same-run steer instructions at durable output positions across catchup and reload', async () => {
  const { fixture, spec } =
    await import('../../harness/delegation/service-test-fixture')
  const { vi } = await import('vitest')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(async function* (turn, open) {
    const identity = {
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
    }
    yield { ...identity, type: 'text_delta', text: 'before correction' }
    await gate
    yield { ...identity, type: 'text_delta', text: 'after correction' }
    yield { ...identity, type: 'turn_finished', status: 'completed' }
  })
  try {
    const record = await f.service.start(f.owner, spec)
    const runId = record.currentRunId!
    const history = new DelegationHistory(f.root)
    await vi.waitFor(
      () =>
        expect(
          history.read(f.service.inspect(record.id)).entries.at(-1)?.text,
        ).toBe('before correction'),
      LOADED,
    )
    const first = history.read(f.service.inspect(record.id))
    let atNotification: ReturnType<DelegationHistory['read']> | undefined
    f.options.onState = (state, event) => {
      if (
        event.type === 'message-delivery' &&
        event.messageId === 'dgm-correct' &&
        event.status === 'accepted'
      )
        atNotification = new DelegationHistory(f.root).read(state, {
          after: first.after!,
        })
    }
    await f.service.send(record.id, {
      messageId: 'dgm-correct',
      text: 'accepted correction',
      delivery: 'steer',
      expectedRunId: runId,
    })
    const correction = history.read(f.service.inspect(record.id), {
      after: first.after!,
    })
    expect(atNotification?.entries).toEqual(correction.entries)
    expect(correction.entries).toEqual([
      expect.objectContaining({
        type: 'prompt',
        runId,
        messageId: 'dgm-correct',
        status: 'accepted',
        chronology: 'recorded',
        text: 'accepted correction',
      }),
    ])
    expect(
      new DelegationHistory(f.root).read(f.service.inspect(record.id), {
        after: first.after!,
      }).entries,
    ).toEqual(correction.entries)
    release()
    await f.service.wait(record.id, runId)
    const next = history.read(f.service.inspect(record.id), {
      after: correction.after!,
    })
    expect(next.entries[0]?.text).toBe('after correction')
    expect(next.entries.some((e) => e.messageId === 'dgm-correct')).toBe(false)
    expect(
      new DelegationHistory(f.root)
        .read(f.service.inspect(record.id))
        .entries.map((e) => e.id),
    ).toEqual(
      history.read(f.service.inspect(record.id)).entries.map((e) => e.id),
    )
  } finally {
    release()
    await f.service.shutdown()
    f.cleanup()
  }
})
it('reconstructs legacy accepted steer linkage without inventing its order among transcript outputs', async () => {
  const { DelegationJournal } = await import('../../harness/delegation/journal')
  const root = mkdtempSync(join(tmpdir(), 'history-legacy-instructions-'))
  try {
    const record = fixtureDelegationRecord(),
      run = fixtureDelegationRun(),
      journal = new DelegationJournal(root, record.id)
    await journal.append({ type: 'created', record })
    await journal.append({
      type: 'message-enqueued',
      message: { id: run.messageId, text: 'initial', status: 'accepted' },
    })
    await journal.append({ type: 'run-created', run })
    await journal.append({
      type: 'run-changed',
      runId: run.id,
      patch: { phase: 'preparing' },
    })
    await journal.append({
      type: 'run-changed',
      runId: run.id,
      patch: { phase: 'running' },
    })
    for (const [id, text, status] of [
      ['dgm-old-one', 'legacy one', 'accepted'],
      ['dgm-old-two', 'legacy two', 'accepted'],
      ['dgm-unknown', 'unknown delivery', 'delivery_unknown'],
    ] as const) {
      await journal.append({
        type: 'message-enqueued',
        message: { id, text, status: 'queued' },
      })
      await journal.append({
        type: 'send-intent',
        runId: run.id,
        messageId: id,
      })
      await journal.append({ type: 'message-delivery', messageId: id, status })
    }
    const dir = join(root, 'conversations', record.id, 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, run.id + '.jsonl'),
      JSON.stringify({
        delegationId: record.id,
        runId: run.id,
        type: 'text_delta',
        text: 'historical output',
      }) + '\n',
    )
    const history = new DelegationHistory(root),
      page = history.read(journal.load())
    expect(
      page.entries.filter((e) => e.type === 'prompt').map((e) => e.text),
    ).toEqual(['initial', 'legacy one', 'legacy two'])
    const outputId = page.entries.find((e) => e.type === 'text')!.id
    const oldCursor = Buffer.from(
      JSON.stringify([
        record.id,
        outputId,
        createHash('sha256')
          .update(record.id + '\0' + outputId)
          .digest('hex')
          .slice(0, 16),
      ]),
    ).toString('base64url')
    expect(
      history
        .read(journal.load(), { after: oldCursor })
        .entries.filter((e) => e.messageId)
        .map((e) => e.text),
    ).toEqual(['legacy one', 'legacy two'])
    const corrections = page.entries.filter((e) => e.messageId)
    expect(corrections).toEqual([
      expect.objectContaining({
        messageId: 'dgm-old-one',
        status: 'accepted',
        chronology: 'unknown',
      }),
      expect.objectContaining({
        messageId: 'dgm-old-two',
        status: 'accepted',
        chronology: 'unknown',
      }),
    ])
    expect(new DelegationHistory(root).read(journal.load()).entries).toEqual(
      page.entries,
    )
    expect(
      history.read(journal.load(), { after: page.after! }).entries,
    ).toEqual([])
    appendFileSync(
      join(dir, run.id + '.jsonl'),
      JSON.stringify({
        delegationId: record.id,
        runId: run.id,
        type: 'text_delta',
        text: 'later observed output',
      }) + '\n',
    )
    expect(
      history
        .read(journal.load(), { after: page.after! })
        .entries.map((e) => e.text),
    ).toEqual(['later observed output'])
    expect(
      new DelegationHistory(root)
        .read(journal.load(), { after: page.after! })
        .entries.map((e) => e.text),
    ).toEqual(['later observed output'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('pages each legacy instruction part without acknowledging undisplayed parts or losing later output', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-legacy-parts-'))
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
    const path = join(dir, run.id + '.jsonl')
    const output = (text: string) =>
      JSON.stringify({
        delegationId: record.id,
        runId: run.id,
        type: 'text_delta',
        text,
      }) + '\n'
    writeFileSync(path, output('before'))
    const history = new DelegationHistory(root),
      first = history.read(state)
    state.messages['dgm-long'] = {
      id: 'dgm-long',
      runId: run.id,
      sendIntentSeq: 2,
      acceptedSeq: 3,
      seq: 1,
      status: 'accepted',
      text: 'X'.repeat(10000),
    }
    let next = history.read(state, { after: first.after!, limit: 1 })
    let text = next.entries[0]!.text!
    appendFileSync(path, output('later'))
    let later = false
    for (let i = 0; i < 5 && (next.hasAfter || i === 0); i++) {
      next = history.read(state, { after: next.after!, limit: 1 })
      if (next.entries[0]?.type === 'prompt') text += next.entries[0].text
      if (next.entries[0]?.text === 'later') later = true
      if (!next.hasAfter) break
    }
    expect(text.length).toBe(10000)
    expect([...text].every((c) => c === 'X')).toBe(true)
    expect(later).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([
  'missing',
  'empty-terminal',
  'invalid-json',
  'foreign-identity',
  'partial-terminal',
])(
  'reports %s public logs without disguising retained journal facts as complete output',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'history-unavailable-'))
    try {
      const record = fixtureDelegationRecord(),
        run = {
          ...fixtureDelegationRun(),
          phase: 'completed' as const,
          summary: 'retained result',
        }
      const state: DelegationState = {
        record,
        runs: { [run.id]: run },
        messages: {
          [run.messageId]: {
            id: run.messageId,
            text: 'retained request',
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
      if (kind === 'empty-terminal') writeFileSync(path, '')
      if (kind === 'invalid-json')
        writeFileSync(path, '{invalid secret payload}\n')
      if (kind === 'foreign-identity')
        writeFileSync(
          path,
          JSON.stringify({
            delegationId: 'dlg-foreign',
            runId: run.id,
            type: 'text_delta',
            text: 'foreign secret',
          }) + '\n',
        )
      if (kind === 'partial-terminal')
        writeFileSync(path, '{"type":"text_delta"')
      const result = new DelegationHistory(root).read(state)
      expect(result.unavailable).toEqual([
        {
          runId: run.id,
          reason:
            kind === 'missing' || kind === 'empty-terminal'
              ? 'missing_public_log'
              : 'corrupt_public_log',
        },
      ])
      expect(result.entries.map((entry) => entry.text)).toEqual([
        'retained request',
        'retained result',
      ])
      expect(JSON.stringify(result)).not.toContain('secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
it.each(['queued', 'preparing', 'running'] as const)(
  'does not invent missing history for a %s run before any output',
  (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'history-pending-'))
    try {
      const record = fixtureDelegationRecord(),
        run = { ...fixtureDelegationRun(), phase }
      const state: DelegationState = {
        record,
        runs: { [run.id]: run },
        messages: {},
        interactions: {},
        outbox: {},
        lastSeq: 1,
      }
      const result = new DelegationHistory(root).read(state)
      expect(result.unavailable ?? []).toEqual([])
      expect(result.entries).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
it('bounds missing-log diagnostics together with retained entries and reports the total', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-diagnostics-budget-'))
  try {
    const runs = Array.from({ length: 600 }, (_, index) => ({
      ...fixtureDelegationRun(`dgr-${index}`),
      phase: 'completed' as const,
    }))
    const state: DelegationState = {
      record: fixtureDelegationRecord(),
      runs: Object.fromEntries(runs.map((run) => [run.id, run])),
      messages: {},
      interactions: {},
      outbox: {},
      lastSeq: 1,
    }
    const result = new DelegationHistory(root).read(state, { limit: 500 })
    expect(result.unavailableCount).toBe(600)
    expect(result.unavailable).toHaveLength(200)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(240 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('reports corruption of an already indexed public row without exposing replacement contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-cached-corrupt-'))
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
    const path = join(dir, run.id + '.jsonl')
    const raw =
      JSON.stringify({
        delegationId: record.id,
        runId: run.id,
        type: 'text_delta',
        text: 'safe',
      }) + '\n'
    writeFileSync(path, raw)
    const history = new DelegationHistory(root)
    expect(history.read(state).entries[0]?.text).toBe('safe')
    writeFileSync(path, '{'.repeat(Buffer.byteLength(raw) - 1) + '\n')
    const page = history.read(state)
    expect(page.unavailable).toEqual([
      { runId: run.id, reason: 'corrupt_public_log' },
    ])
    expect(page.entries).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('keeps a missing-log diagnostic when refreshing with a cursor into the removed transcript', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-missing-cursor-'))
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
    const path = join(dir, run.id + '.jsonl')
    writeFileSync(
      path,
      JSON.stringify({
        delegationId: record.id,
        runId: run.id,
        type: 'text_delta',
        text: 'safe',
      }) + '\n',
    )
    const history = new DelegationHistory(root)
    const first = history.read(state)
    rmSync(path)
    const page = history.read(state, { after: first.after! })
    expect(page.unavailable).toEqual([
      { runId: run.id, reason: 'missing_public_log' },
    ])
    expect(page.hasAfter).toBe(false)
    expect(() => history.read(state, { after: 'invalid' })).toThrow(
      'HISTORY_CURSOR_INVALID',
    )
    const payload = [
      record.id,
      `${run.id}:not-an-offset`,
      `${run.id}:not-an-offset`,
      0,
    ]
    const forged = Buffer.from(
      JSON.stringify([
        ...payload,
        createHash('sha256')
          .update(JSON.stringify(payload))
          .digest('hex')
          .slice(0, 16),
      ]),
    ).toString('base64url')
    expect(() => history.read(state, { after: forged })).toThrow(
      'HISTORY_CURSOR_INVALID',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
