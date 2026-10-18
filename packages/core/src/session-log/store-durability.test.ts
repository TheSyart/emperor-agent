// SEC-02 (PLAN-V020, findings CORE-2/CORE-20): no crash, power loss or full
// disk may leave a session that cannot be opened, and the events a turn
// ends on reach the disk before anyone is told the turn is over.
import {
  appendFileSync,
  closeSync,
  fdatasyncSync,
  fstatSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from './types'
import {
  SessionLogStore,
  SessionLogUnrecoverableError,
  type SessionLogIo,
  type SessionLogState,
  type SessionLogStoreOptions,
} from './store'

const realIo: SessionLogIo = {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  ftruncateSync,
  fdatasyncSync,
}

function setup(options: Partial<SessionLogStoreOptions> = {}) {
  const states: SessionLogState[] = []
  const root = mkdtempSync(join(tmpdir(), 'session-log-durable-'))
  const s = new SessionLogStore({
    root,
    writeBatchMaxDelayMs: 5,
    retryDelayMs: 10,
    onLogState: (state) => states.push(state),
    ...options,
  })
  const log = (id: string) => join(root, id, 'log.jsonl')
  const backups = (id: string, kind: 'tail' | 'corrupt') =>
    readdirSync(join(root, id)).filter((name) =>
      name.startsWith(`log.jsonl.${kind}-`),
    )
  return { s, root, states, log, backups }
}

type AnySession = { append: (...args: never[]) => unknown }

function appendAny(session: AnySession, type: string, data: unknown): void {
  ;(session.append as (type: string, data: unknown) => void).call(
    session,
    type,
    data,
  )
}

function completedTurn(session: AnySession, turn: number) {
  const append = (type: string, data: unknown) => appendAny(session, type, data)
  append('turn/start', { turn })
  append('step/start', { turn, step: 1 })
  append('step/end', { turn, step: 1 })
  append('turn/end', { turn, reason: { kind: 'completed' } })
}

function seqs(events: readonly SessionEvent[]): number[] {
  return events.map((event) => event.seq)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('SessionLogStore durability', () => {
  it('cuts an unfinished last line back to the last newline and keeps it aside', () => {
    const { s, states, log, backups } = setup()
    completedTurn(s.create({ id: 'a' }), 1)
    s.close('a')
    const before = readFileSync(log('a'), 'utf8')
    appendFileSync(log('a'), '{"type":"turn/st')

    const session = new SessionLogStore({ root: s.root }).open('a')

    expect(session.events).toHaveLength(4)
    expect(readFileSync(log('a'), 'utf8')).toBe(before)
    const [tail] = backups('a', 'tail')
    expect(readFileSync(join(s.root, 'a', tail ?? ''), 'utf8')).toBe(
      '{"type":"turn/st',
    )
    void states
  })

  it('reports the tail repair to the host', () => {
    const { s, states, log } = setup()
    completedTurn(s.create({ id: 'a2' }), 1)
    s.close('a2')
    appendFileSync(log('a2'), '{"broken')
    s.open('a2')
    expect(states).toEqual([
      expect.objectContaining({
        sessionId: 'a2',
        state: 'repaired',
        kind: 'tail',
        droppedBytes: 8,
      }),
    ])
  })

  it('keeps a whole record that only lost its newline', () => {
    const { s, log, backups } = setup()
    const session = s.create({ id: 'b' })
    completedTurn(session, 1)
    s.close('b')
    const text = readFileSync(log('b'), 'utf8')
    writeFileSync(log('b'), text.slice(0, -1))
    const reopened = new SessionLogStore({ root: s.root }).open('b')
    expect(reopened.events).toEqual(session.events)
    expect(readFileSync(log('b'), 'utf8')).toBe(text)
    expect(backups('b', 'tail')).toEqual([])
  })

  it('appends after a tail repair and reopens with contiguous seqs', () => {
    const { s, log } = setup()
    completedTurn(s.create({ id: 'c' }), 1)
    s.close('c')
    appendFileSync(log('c'), '{"type":"tu')
    const reopened = s.open('c')
    completedTurn(reopened, 2)
    s.close('c')
    const again = s.open('c')
    expect(again.events).toHaveLength(8)
    expect(seqs(again.events)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('salvages the prefix before a corrupt middle line', () => {
    const { s, states, log, backups } = setup()
    const session = s.create({ id: 'd' })
    completedTurn(session, 1)
    completedTurn(session, 2)
    s.close('d')
    const original = readFileSync(log('d'), 'utf8')
    const lines = original.split('\n')
    // header, 4 events of turn 1, then turn 2: break turn 2's step/start.
    lines[6] = '{"type":"step/st@rt"'
    writeFileSync(log('d'), lines.join('\n'))

    const reopened = s.open('d')

    expect(seqs(reopened.events).slice(0, 5)).toEqual([0, 1, 2, 3, 4])
    expect(reopened.hasOpenTurn()).toBe(false)
    const [corrupt] = backups('d', 'corrupt')
    expect(readFileSync(join(s.root, 'd', corrupt ?? ''), 'utf8')).toBe(
      lines.join('\n'),
    )
    expect(states).toContainEqual(
      expect.objectContaining({
        sessionId: 'd',
        state: 'repaired',
        kind: 'corrupt',
        line: 7,
      }),
    )
    s.close('d')
    expect(s.open('d').events).toEqual(reopened.events)
  })

  it('reads a damaged log without writing to it', () => {
    const { s, log, backups } = setup()
    completedTurn(s.create({ id: 'e' }), 1)
    completedTurn(s.get('e')!, 2)
    s.close('e')
    const lines = readFileSync(log('e'), 'utf8').split('\n')
    lines[6] = 'not json'
    const damaged = `${lines.join('\n')}{"half`
    writeFileSync(log('e'), damaged)
    const snapshot = s.readSnapshot('e')
    expect(snapshot.events).toHaveLength(5)
    expect(readFileSync(log('e'), 'utf8')).toBe(damaged)
    expect(backups('e', 'corrupt')).toEqual([])
  })

  it('refuses a log whose header is unreadable and leaves it untouched', () => {
    const { s, states, log } = setup()
    completedTurn(s.create({ id: 'f' }), 1)
    s.close('f')
    const text = readFileSync(log('f'), 'utf8')
    const damaged = `{"type":"sess${text.slice(text.indexOf('\n'))}`
    writeFileSync(log('f'), damaged)
    expect(() => s.open('f')).toThrow(SessionLogUnrecoverableError)
    expect(readFileSync(log('f'), 'utf8')).toBe(damaged)
    expect(states).toContainEqual(
      expect.objectContaining({ sessionId: 'f', state: 'unrecoverable' }),
    )
    expect(s.tryOpen('f')).toBeUndefined()
  })

  it('rolls a partial write back so a retry cannot repeat a seq', async () => {
    let fail = true
    const io: SessionLogIo = {
      ...realIo,
      writeSync: ((
        fd: number,
        buffer: Buffer,
        offset = 0,
        length?: number,
        position?: number,
      ) => {
        if (!fail) return writeSync(fd, buffer, offset, length, position)
        fail = false
        const half = Math.max(1, Math.floor((length ?? buffer.length) / 2))
        writeSync(fd, buffer, offset, half, position)
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        })
      }) as SessionLogIo['writeSync'],
    }
    const { s, states, log } = setup({ io })
    const session = s.create({ id: 'g' })
    const headerBytes = readFileSync(log('g')).byteLength
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    s.flush('g')
    expect(readFileSync(log('g')).byteLength).toBe(headerBytes)
    expect(states).toContainEqual(
      expect.objectContaining({ sessionId: 'g', state: 'write_paused' }),
    )
    await wait(40)
    expect(states.at(-1)).toMatchObject({
      sessionId: 'g',
      state: 'write_resumed',
    })
    s.close('g')
    expect(seqs(s.open('g').events).slice(0, 2)).toEqual([0, 1])
    const lines = readFileSync(log('g'), 'utf8').trim().split('\n')
    expect(lines.filter((line) => line.includes('"seq":0'))).toHaveLength(1)
  })

  it('keeps events in memory while the disk is full and writes them later', async () => {
    let full = true
    const io: SessionLogIo = {
      ...realIo,
      writeSync: ((...args: Parameters<typeof writeSync>) => {
        if (full)
          throw Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
          })
        return (writeSync as (...a: unknown[]) => number)(...args)
      }) as SessionLogIo['writeSync'],
    }
    const { s, states, log } = setup({ io })
    const session = s.create({ id: 'h' })
    completedTurn(session, 1)
    await wait(30)
    expect(session.events).toHaveLength(4)
    expect(readFileSync(log('h'), 'utf8')).not.toContain('turn/start')
    expect(
      states.filter((state) => state.state === 'write_paused'),
    ).toHaveLength(1)
    full = false
    await wait(40)
    expect(readFileSync(log('h'), 'utf8')).toContain('turn/end')
    expect(states.at(-1)).toMatchObject({ state: 'write_resumed' })
    s.close('h')
  })

  it('syncs to disk when a turn ends or the user is asked, not on every chunk', () => {
    const fdatasync = vi.fn(fdatasyncSync)
    const { s, log } = setup({ io: { ...realIo, fdatasyncSync: fdatasync } })
    const session = s.create({ id: 'i' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    expect(fdatasync).not.toHaveBeenCalled()
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(fdatasync).toHaveBeenCalledTimes(1)
    // Written at once, not 200ms later.
    expect(readFileSync(log('i'), 'utf8')).toContain('turn/end')
    appendAny(session, 'question/asked', { id: 'q1', questions: [] })
    expect(fdatasync).toHaveBeenCalledTimes(2)
    s.close('i')
  })

  it('writes and syncs every pending event on a durable flush', () => {
    const fdatasync = vi.fn(fdatasyncSync)
    const { s, log } = setup({
      writeBatchMaxDelayMs: 60_000,
      io: { ...realIo, fdatasyncSync: fdatasync },
    })
    const one = s.create({ id: 'j1' })
    const two = s.create({ id: 'j2' })
    one.append('turn/start', { turn: 1 })
    two.append('turn/start', { turn: 1 })
    s.flush(undefined, { sync: true })
    expect(readFileSync(log('j1'), 'utf8')).toContain('turn/start')
    expect(readFileSync(log('j2'), 'utf8')).toContain('turn/start')
    expect(fdatasync).toHaveBeenCalledTimes(2)
    s.closeAll()
  })

  it('still lets repair contributors close interactions after a salvage', () => {
    const { s, log } = setup({
      repairContributors: [
        (events) =>
          events.some((event) => (event.type as string) === 'approval/asked') &&
          !events.some((event) => (event.type as string) === 'approval/decided')
            ? [
                {
                  type: 'approval/decided',
                  data: { id: 'p1', outcome: 'cancelled' },
                } as never,
              ]
            : [],
      ],
    })
    const session = s.create({ id: 'k' })
    const append = (type: string, data: unknown) =>
      appendAny(session, type, data)
    append('turn/start', { turn: 1 })
    append('approval/asked', { id: 'p1', request: {} })
    append('step/start', { turn: 1, step: 1 })
    append('step/end', { turn: 1, step: 1 })
    s.close('k')
    const lines = readFileSync(log('k'), 'utf8').split('\n')
    lines[3] = '{garbage'
    writeFileSync(log('k'), lines.join('\n'))
    const reopened = s.open('k')
    const types = reopened.events.map((event) => event.type as string)
    expect(types.slice(0, 2)).toEqual(['turn/start', 'approval/asked'])
    expect(types).toContain('approval/decided')
    expect(reopened.hasOpenTurn()).toBe(false)
  })

  it('drops bytes a failed earlier batch left past the last good write', () => {
    const { s, log } = setup()
    const session = s.create({ id: 'l' })
    completedTurn(session, 1)
    // Simulate a stray unfinished line appended behind the store's back.
    appendFileSync(log('l'), '{"seq":99')
    completedTurn(session, 2)
    s.close('l')
    const reopened = s.open('l')
    expect(seqs(reopened.events)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('opens a 10 000 line log quickly', () => {
    const { s, log } = setup()
    const session = s.create({ id: 'm' })
    for (let turn = 1; turn <= 2_500; turn++) completedTurn(session, turn)
    s.close('m')
    expect(readFileSync(log('m'), 'utf8').split('\n').length).toBeGreaterThan(
      10_000,
    )
    const started = performance.now()
    const reopened = new SessionLogStore({ root: s.root }).readSnapshot('m')
    expect(reopened.events).toHaveLength(10_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('never writes through a closed descriptor', () => {
    const closed = new Set<number>()
    const io: SessionLogIo = {
      ...realIo,
      closeSync: (fd: number) => {
        closed.add(fd)
        closeSync(fd)
      },
      writeSync: ((fd: number, ...rest: unknown[]) => {
        expect(closed.has(fd)).toBe(false)
        return (writeSync as (...a: unknown[]) => number)(fd, ...rest)
      }) as SessionLogIo['writeSync'],
    }
    const { s } = setup({ io })
    completedTurn(s.create({ id: 'n' }), 1)
    s.close('n')
    expect(s.open('n').events).toHaveLength(4)
    void openSync
  })
})
