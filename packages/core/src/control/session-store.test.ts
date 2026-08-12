import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ControlManager } from './manager'
import { ControlStore } from './store'
import { createNodeSyncPersistenceAdapter } from '../store/persistence'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-session-control-'))
}

function question() {
  return {
    id: 'scope',
    header: '范围',
    question: '本次范围怎么定？',
    options: [
      { id: 'minimal', label: '最小', description: '只修当前问题' },
      { id: 'complete', label: '完整', description: '补齐状态闭环' },
    ],
  }
}

function legacyState(ownerSessionId?: string) {
  return {
    version: 3,
    mode: 'smart_auto',
    previous_mode: null,
    pending: {
      id: 'ask_legacy_owner',
      kind: 'ask',
      status: 'waiting',
      created_at: 1,
      updated_at: 1,
      parent_call_id: null,
      context: 'legacy pending',
      questions: [question()],
      answers: {},
      title: '',
      summary: '',
      plan_markdown: '',
      assumptions: [],
      risk_level: 'medium',
      comments: [],
      meta: ownerSessionId ? { control_session_id: ownerSessionId } : {},
    },
    last_interaction: null,
    updated_at: 1,
  }
}

function writeLegacy(root: string, state: Record<string, unknown>): string {
  const controlDir = join(root, 'control')
  const path = join(controlDir, 'state.json')
  mkdirSync(controlDir, { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
  return path
}

describe('session-owned ControlStore', () => {
  it('migrates a legacy pending interaction only into its declared owner', () => {
    const root = tempRoot()
    const legacyPath = writeLegacy(root, legacyState('session_a'))
    const before = readFileSync(legacyPath, 'utf8')

    const owner = new ControlStore(root, { sessionId: 'session_a' })
    const other = new ControlStore(root, { sessionId: 'session_b' })

    expect(owner.load()).toMatchObject({
      mode: 'smart_auto',
      pending: { id: 'ask_legacy_owner' },
    })
    expect(other.load()).toMatchObject({ mode: 'smart_auto', pending: null })
    expect(readFileSync(legacyPath, 'utf8')).toBe(before)
    expect(existsSync(owner.migrationReceiptFile)).toBe(true)
    expect(
      JSON.parse(readFileSync(owner.migrationReceiptFile, 'utf8')),
    ).toMatchObject({
      session_id: 'session_a',
      pending_disposition: 'migrated',
    })
  })

  it('fails closed when a legacy pending interaction has no owner', () => {
    const root = tempRoot()
    const legacyPath = writeLegacy(root, legacyState())
    const before = readFileSync(legacyPath, 'utf8')

    const first = new ControlStore(root, { sessionId: 'session_a' })
    const second = new ControlStore(root, { sessionId: 'session_b' })

    expect(first.load().pending).toBeNull()
    expect(second.load().pending).toBeNull()
    expect(readFileSync(legacyPath, 'utf8')).toBe(before)
    expect(
      JSON.parse(readFileSync(first.migrationReceiptFile, 'utf8')),
    ).toMatchObject({ pending_disposition: 'ambiguous' })
  })

  it('allows two session managers to hold and settle independent Ask interactions', () => {
    const root = tempRoot()
    const first = new ControlManager(root, { sessionId: 'session_a' })
    const second = new ControlManager(root, { sessionId: 'session_b' })

    const firstAsk = first.createAsk({
      questions: [question()],
      meta: { control_session_id: 'session_a' },
    })
    const secondAsk = second.createAsk({
      questions: [question()],
      meta: { control_session_id: 'session_b' },
    })

    expect(first.payload().pending).toMatchObject({ id: firstAsk.id })
    expect(second.payload().pending).toMatchObject({ id: secondAsk.id })

    first.answer(firstAsk.id, { scope: { option_id: 'minimal' } })
    expect(first.payload().pending).toBeNull()
    expect(second.payload().pending).toMatchObject({ id: secondAsk.id })
  })

  it('preserves the previous session state when durable rename fails', () => {
    const root = tempRoot()
    const healthy = new ControlStore(root, { sessionId: 'session_a' })
    const before = readFileSync(healthy.stateFile, 'utf8')
    const failing = new ControlStore(root, {
      sessionId: 'session_a',
      persistenceAdapter: createNodeSyncPersistenceAdapter({
        beforeOperation(operation) {
          if (operation === 'rename') throw new Error('injected rename')
        },
      }),
    })
    const state = failing.load()
    state.mode = 'ask_before_edit'

    expect(() => failing.save(state)).toThrow(
      expect.objectContaining({ code: 'persistence_io', operation: 'rename' }),
    )
    expect(readFileSync(healthy.stateFile, 'utf8')).toBe(before)
    expect(statSync(healthy.stateFile).mode & 0o777).toBe(0o600)
    expect(
      readdirSync(join(root, 'control', 'sessions', 'session_a')).filter(
        (name) => name.includes('.tmp-'),
      ),
    ).toEqual([])
  })
})
