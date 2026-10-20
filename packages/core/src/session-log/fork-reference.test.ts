// KRN-12 (CORE-37): a fork child's log no longer copies its parent's prefix.
// The header says how many of the parent's events the child starts from
// (`seedLength`) and what the last of them is (`seedRef`); opening the child
// reads them from the parent — live, on disk, or in the trash. A child
// written by an older build (the prefix copied into its own log) still opens.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordedDescendants } from '../harness/host/task-tree'
import { createAssistantMessage, userText } from '../llm/message'
import { historyFloor, historyPage } from './history'
import type { Session } from './session'
import {
  LOG_FILE,
  SessionLogStore,
  SessionLogUnrecoverableError,
  type SessionLogState,
} from './store'

function store(root = mkdtempSync(join(tmpdir(), 'session-fork-ref-'))) {
  const states: SessionLogState[] = []
  const logs = new SessionLogStore({
    root,
    writeBatchMaxDelayMs: 5,
    onLogState: (state) => states.push(state),
  })
  return { logs, root, states }
}

function runTurn(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', userText(text), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `答复 ${text}` }],
        source: { provider: 'p', model: 'm' },
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function logBytes(root: string, id: string): number {
  return statSync(join(root, id, LOG_FILE)).size
}

function plain(events: Session['events']): unknown[] {
  return events.map((event) => JSON.parse(JSON.stringify(event)))
}

const LONG = '很长的上下文'.repeat(400)

describe('fork children refer to their parent (KRN-12)', () => {
  it('a new fork child does not grow with its parent history (4)', () => {
    const { logs, root } = store()
    const parent = logs.create({ id: 'parent', cwd: '/w' })
    runTurn(parent, 1, LONG)
    const early = logs.fork('parent', 'sub-early', { origin: 'subagent' })
    for (let turn = 2; turn <= 40; turn += 1) runTurn(parent, turn, LONG)
    const late = logs.fork('parent', 'sub-late', { origin: 'subagent' })
    logs.flush(undefined, { sync: true })
    const parentBytes = logBytes(root, 'parent')
    expect(parentBytes).toBeGreaterThan(40 * Buffer.byteLength(LONG))
    expect(logBytes(root, 'sub-late')).toBeLessThan(1024)
    expect(
      logBytes(root, 'sub-late') - logBytes(root, 'sub-early'),
    ).toBeLessThan(64)
    expect(
      readFileSync(join(root, 'sub-late', LOG_FILE), 'utf8'),
    ).not.toContain('很长的上下文')
    // In memory the child starts from the whole prefix, as before.
    expect(late.header.seedLength).toBe(parent.events.length)
    expect(late.deriveMessages()).toHaveLength(80)
    expect(early.deriveMessages()).toHaveLength(2)
  })

  it('reopens a fork child with the same events, appends included', () => {
    const { logs, root } = store()
    const parent = logs.create({ id: 'parent', cwd: '/w' })
    runTurn(parent, 1, 'one')
    runTurn(parent, 2, 'two')
    const child = logs.fork('parent', 'sub-1', {
      origin: 'subagent',
      delegationDepth: 1,
    })
    child.append('subagent/descriptor', {
      parentSession: 'parent',
      description: 'd',
      mode: 'fork',
    })
    runTurn(child, 3, 'child')
    runTurn(parent, 3, 'parent after the fork')
    const before = plain(child.events)
    logs.closeAll()

    const again = store(root).logs
    const reopened = again.open('sub-1')
    expect(plain(reopened.events)).toEqual(before)
    expect(reopened.header).toMatchObject({
      parentSession: 'parent',
      seedLength: 12,
      origin: 'subagent',
      delegationDepth: 1,
    })
    expect(historyFloor(reopened.header, reopened.events)).toBe(13)
    expect(historyPage(reopened.header, reopened.events).events[0]?.type).toBe(
      'subagent/descriptor',
    )
    runTurn(reopened, 4, 'after reopening')
    again.closeAll()
    const third = store(root).logs.readSnapshot('sub-1')
    expect(third.events).toHaveLength(before.length + 6)
    expect(third.deriveMessages().at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('a child of a fork child reopens through both', () => {
    const { logs, root } = store()
    const parent = logs.create({ id: 'parent' })
    runTurn(parent, 1, 'root turn')
    const child = logs.fork('parent', 'sub-a', { origin: 'subagent' })
    runTurn(child, 2, 'child turn')
    const grandchild = logs.fork('sub-a', 'sub-b', { origin: 'subagent' })
    const before = plain(grandchild.events)
    logs.closeAll()
    expect(logBytes(root, 'sub-b')).toBeLessThan(1024)
    expect(plain(store(root).logs.open('sub-b').events)).toEqual(before)
  })

  it('reads the prefix from a parent in the trash', () => {
    const { logs, root } = store()
    const parent = logs.create({ id: 'parent' })
    runTurn(parent, 1, 'one')
    const child = logs.fork('parent', 'sub-1', { origin: 'subagent' })
    const before = plain(child.events)
    logs.closeAll()
    mkdirSync(join(root, '.trash'), { recursive: true })
    renameSync(join(root, 'parent'), join(root, '.trash', 'parent'))
    expect(plain(store(root).logs.open('sub-1').events)).toEqual(before)
  })

  it('lets a purge find a forked child and its own child while the root is in the trash', () => {
    const { logs, root } = store()
    const parent = logs.create({ id: 'root-session' })
    runTurn(parent, 1, 'one')
    const child = logs.fork('root-session', 'sub-child', { origin: 'subagent' })
    parent.append('subagent/started', {
      subagentId: 'sub-child',
      description: 'child',
      mode: 'fork',
      background: true,
    })
    runTurn(child, 2, 'child turn')
    logs.fork('sub-child', 'sub-grandchild', { origin: 'subagent' })
    child.append('subagent/started', {
      subagentId: 'sub-grandchild',
      description: 'grandchild',
      mode: 'fork',
      background: true,
    })
    logs.closeAll()
    mkdirSync(join(root, '.trash'), { recursive: true })
    renameSync(join(root, 'root-session'), join(root, '.trash', 'root-session'))
    const again = store(root).logs
    const trashed = join(root, '.trash', 'root-session', LOG_FILE)
    // What host.forgetSessionTree reads before the purge (KRN-03).
    expect(
      recordedDescendants(
        again.readEventsAt('root-session', trashed),
        (id) => again.readSnapshot(id).events,
      ),
    ).toEqual(['sub-child', 'sub-grandchild'])
  })

  it('cannot open a child whose parent is gone or changed, and says so', () => {
    const { logs, root } = store()
    const parent = logs.create({ id: 'parent' })
    runTurn(parent, 1, 'one')
    logs.fork('parent', 'sub-1', { origin: 'subagent' })
    logs.closeAll()
    // The parent's log lost its last turn (a repair kept less of it).
    const lines = readFileSync(join(root, 'parent', LOG_FILE), 'utf8')
      .trim()
      .split('\n')
    writeFileSync(
      join(root, 'parent', LOG_FILE),
      `${lines.slice(0, 3).join('\n')}\n`,
    )
    const changed = store(root)
    expect(() => changed.logs.open('sub-1')).toThrow(
      SessionLogUnrecoverableError,
    )
    expect(changed.states).toContainEqual(
      expect.objectContaining({ sessionId: 'sub-1', state: 'unrecoverable' }),
    )
    renameSync(join(root, 'parent'), join(root, 'parent-moved'))
    expect(() => store(root).logs.open('sub-1')).toThrow(/parent/)
  })

  it('still opens a child an older build wrote with the prefix copied (5)', () => {
    const { logs, root } = store()
    const parent = logs.create({ id: 'parent', cwd: '/w' })
    runTurn(parent, 1, LONG)
    runTurn(parent, 2, 'two')
    // What fork() wrote before KRN-12: create() with the prefix as the seed.
    const old = logs.create(
      {
        id: 'sub-old',
        cwd: '/w',
        parentSession: 'parent',
        seedLength: parent.events.length,
        origin: 'subagent',
      },
      parent.events,
    )
    runTurn(old, 3, 'old child turn')
    const before = plain(old.events)
    logs.closeAll()
    expect(readFileSync(join(root, 'sub-old', LOG_FILE), 'utf8')).toContain(
      '很长的上下文',
    )
    // It does not need the parent any more.
    renameSync(join(root, 'parent'), join(root, 'parent-moved'))
    const reopened = store(root).logs.open('sub-old')
    expect(plain(reopened.events)).toEqual(before)
    expect(historyFloor(reopened.header, reopened.events)).toBe(
      parent.events.length + 1,
    )
  })
})
