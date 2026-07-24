import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../memory/store'
import {
  ConversationStore,
  ProjectSessionMemoryStore,
  SessionMemoryStore,
} from './conversation'
import { migrateLegacyMainlineToDefaultSession } from './migrate'
import { SessionStore } from './store'
import { fallbackSessionTitle, sanitizeSessionTitle } from './title'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('ConversationStore (test_conversation_store.py)', () => {
  it('keeps separate session histories isolated', () => {
    const root = tmp('emperor-session-conv-')
    const a = new ConversationStore(join(root, 'a'))
    const b = new ConversationStore(join(root, 'b'))

    a.appendHistory('user', 'hello a')
    b.appendHistory('user', 'hello b')

    expect(a.loadUnarchivedHistory().map((r) => r.content)).toContain('hello a')
    expect(a.loadUnarchivedHistory().map((r) => r.content)).not.toContain(
      'hello b',
    )
    expect(b.loadUnarchivedHistory().map((r) => r.content)).toContain('hello b')
  })

  it('round-trips history rows, checkpoints, and turn ids', () => {
    const store = new ConversationStore(
      join(tmp('emperor-session-round-'), 's1'),
    )
    store.appendHistory('user', 'hi', { extra: { turn_id: 't1' } })
    store.appendHistory('assistant', 'hello', { extra: { turn_id: 't1' } })
    store.appendHistory('user', 'hidden', {
      extra: { turn_id: 'hidden', hidden: true },
    })
    store.appendHistory('assistant', 'hidden reply', {
      extra: { turn_id: 'hidden' },
    })

    expect(store.loadUnarchivedHistory()).toEqual([
      { role: 'user', content: 'hi', seq: 1, turn_id: 't1' },
      { role: 'assistant', content: 'hello', seq: 2, turn_id: 't1' },
    ])
    expect(store.loadUnarchivedTurnIds()).toEqual(['t1'])

    expect(store.readCheckpoint()).toBeNull()
    store.writeCheckpoint(
      [{ role: 'user', content: 'in-flight', turn_id: 'turn_checkpoint' }],
      {
        sessionId: 'session_1',
        turnId: 'turn_checkpoint',
        phase: 'tool_calls_pending',
        baseHistorySeq: 2,
      },
    )
    expect(store.readCheckpoint()).toEqual([
      { role: 'user', content: 'in-flight', turn_id: 'turn_checkpoint' },
    ])
    const checkpoint = JSON.parse(readFileSync(store.checkpointFile, 'utf8'))
    expect(checkpoint).toMatchObject({
      schemaVersion: 'emperor.turn-checkpoint.v1',
      sessionId: 'session_1',
      turnId: 'turn_checkpoint',
      baseHistorySeq: 2,
      phase: 'tool_calls_pending',
      partialMessages: [
        { role: 'user', content: 'in-flight', turn_id: 'turn_checkpoint' },
      ],
    })
    store.clearCheckpoint()
    expect(store.readCheckpoint()).toBeNull()
  })

  it('binds checkpoints to the owning session when callers omit sessionId', () => {
    const store = new ConversationStore(
      join(tmp('emperor-session-checkpoint-owner-'), 'session_bound'),
    )
    store.writeCheckpoint([
      { role: 'user', content: 'in-flight', turn_id: 'turn_bound' },
    ])

    expect(
      JSON.parse(readFileSync(store.checkpointFile, 'utf8')),
    ).toMatchObject({
      sessionId: 'session_bound',
      turnId: 'turn_bound',
    })
  })

  it('writes new history through the V2 message graph sidecar without changing V1 replay', () => {
    const store = new ConversationStore(
      join(tmp('emperor-session-message-graph-'), 's1'),
    )

    store.appendHistory('user', 'hello graph', {
      extra: { turn_id: 'turn_graph' },
    })
    store.appendHistory('assistant', 'hello branch', {
      extra: { turn_id: 'turn_graph' },
    })
    store.appendCompactMarker()

    const rawRows = readFileSync(store.historyFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rawRows.slice(0, 2)).toEqual([
      expect.objectContaining({
        seq: 1,
        role: 'user',
        content: 'hello graph',
        message_id: expect.any(String),
      }),
      expect.objectContaining({
        seq: 2,
        role: 'assistant',
        content: 'hello branch',
        message_id: expect.any(String),
      }),
    ])
    expect(store.loadUnarchivedHistory()).toEqual([
      { role: 'user', content: 'hello graph', seq: 1, turn_id: 'turn_graph' },
      {
        role: 'assistant',
        content: 'hello branch',
        seq: 2,
        turn_id: 'turn_graph',
      },
    ])
    expect(store.messageGraph.snapshot()).toMatchObject({
      leafId: rawRows[1]!.message_id,
      nodes: [
        { id: rawRows[0]!.message_id, parentId: null, status: 'committed' },
        {
          id: rawRows[1]!.message_id,
          parentId: rawRows[0]!.message_id,
          status: 'committed',
        },
      ],
      compactBoundaries: [
        {
          parentLeafId: rawRows[1]!.message_id,
          compactedUntilHistorySeq: 3,
        },
      ],
    })
  })

  it('SessionMemoryStore delegates history to conversation and memory to shared store', () => {
    const root = tmp('emperor-session-memory-')
    const userFile = join(root, 'templates', 'USER.local.md')
    const shared = new MemoryStore(join(root, 'memory'), userFile)
    const conversation = new ConversationStore(join(root, 'sessions', 's1'))
    const scoped = new SessionMemoryStore(shared, conversation)

    scoped.writeMemory('# Shared\n')
    scoped.appendHistory('user', 'session message')

    expect(shared.readMemory()).toContain('Shared')
    expect(shared.loadUnarchivedHistory()).toEqual([])
    expect(scoped.loadUnarchivedHistory()).toEqual([
      { role: 'user', content: 'session message', seq: 1 },
    ])
  })

  it('ProjectSessionMemoryStore writes project memory without touching global memory', () => {
    const root = tmp('emperor-project-session-memory-')
    const userFile = join(root, 'templates', 'USER.local.md')
    const shared = new MemoryStore(join(root, 'memory'), userFile)
    shared.writeMemory('# Global\n\nOriginal global memory')
    const conversation = new ConversationStore(join(root, 'sessions', 's1'))
    const projectStore = {
      memory: '',
      readManagedMemory: () => projectStore.memory,
      updateMemory: (_projectId: string, content: string) => {
        projectStore.memory = content
      },
    }
    const scoped = new ProjectSessionMemoryStore(
      shared,
      conversation,
      projectStore,
      'project_1',
    )

    scoped.writeMemory('## 项目情况\n\n- 项目使用 Electron + Vue。')
    scoped.writeUser('# User\n\nShould not overwrite')
    scoped.appendEpisode('Should not create global episode')

    expect(shared.readMemory()).toContain('Original global memory')
    expect(projectStore.memory).toContain('项目使用 Electron')
    expect(scoped.readTodayEpisode()).toBe('')
  })
})

describe('SessionStore (test_session_store.py)', () => {
  it('creates, lists, renames, touches, archives, restores, and deletes sessions', () => {
    const root = tmp('emperor-session-store-')
    const store = new SessionStore(root)
    const keeper = store.create('Keeper')
    const session = store.create('First Session', {
      mode: 'build',
      project: {
        project_id: 'abc123',
        project_path: join(root, 'project'),
        project_name: 'project',
      },
    })

    expect(existsSync(join(root, 'sessions', session.id))).toBe(true)
    expect(session.mode).toBe('build')
    expect(session.project_id).toBe('abc123')
    expect(store.rename(session.id, 'New Title')).toBe(true)
    expect(
      store.touch(session.id, 'hello world', { incrementMessages: true })
        ?.preview,
    ).toBe('hello world')
    expect(store.get(session.id)?.message_count).toBe(1)
    expect(store.archive(session.id)?.archived_at).toBeTruthy()
    expect(store.list().map((s) => s.id)).toEqual([keeper.id])
    expect(store.restore(session.id)?.archived_at).toBeNull()
    expect(store.delete(session.id)).toBe(true)
    expect(existsSync(join(root, 'sessions', session.id))).toBe(false)
    expect(store.delete(keeper.id)).toBe(false)
  })

  it('writes authoritative metadata snapshots for created and mutated sessions', () => {
    const root = tmp('emperor-session-meta-')
    const store = new SessionStore(root)
    const session = store.create('First Session', {
      mode: 'build',
      project: {
        project_id: 'project_1',
        project_path: '/tmp/project',
        project_name: 'project',
      },
    })
    const metaPath = join(root, 'sessions', session.id, 'meta.jsonl')

    expect(existsSync(metaPath)).toBe(true)

    store.rename(session.id, 'Renamed Session')
    store.touch(session.id, 'latest preview', { incrementMessages: true })

    const events = readFileSync(metaPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events).toHaveLength(3)
    expect(events.map((event) => event.type)).toEqual([
      'session_snapshot',
      'session_snapshot',
      'session_snapshot',
    ])
    expect(events.at(-1)?.session).toMatchObject({
      id: session.id,
      title: 'Renamed Session',
      preview: 'latest preview',
      message_count: 1,
      mode: 'build',
      project_id: 'project_1',
      project_path: '/tmp/project',
      project_name: 'project',
    })
  })

  it('rebuilds the session index from authoritative metadata when the cache is deleted', () => {
    const root = tmp('emperor-session-index-rebuild-')
    const store = new SessionStore(root)
    const first = store.create('First')
    const second = store.create('Second')
    store.touch(first.id, 'older preview', { incrementMessages: true })
    store.touch(second.id, 'newer preview', { incrementMessages: true })

    unlinkSync(join(root, 'sessions', 'index.json'))

    const recovered = new SessionStore(root).list()
    expect(recovered.map((item) => item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    )
    expect(recovered.find((item) => item.id === second.id)?.preview).toBe(
      'newer preview',
    )
  })

  it('normalizes legacy entries and quarantines corrupt index files', () => {
    const root = tmp('emperor-session-legacy-')
    const sessionsDir = join(root, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      join(sessionsDir, 'index.json'),
      JSON.stringify([
        { id: 'legacy', title: 'Old', updated_at: '2026-01-01T00:00:00+0800' },
      ]),
      'utf8',
    )

    const item = new SessionStore(root).list()[0]!
    expect(item.mode).toBe('chat')
    expect(item.project_id).toBeNull()
    expect(item.archived_at).toBeNull()
    expect(item.control_pending).toBeNull()
    expect(existsSync(join(sessionsDir, 'legacy', 'meta.jsonl'))).toBe(true)

    writeFileSync(join(sessionsDir, 'index.json'), 'not valid json{{{', 'utf8')
    const rebuiltStore = new SessionStore(root)
    expect(rebuiltStore.list().map((s) => s.id)).toEqual(['legacy'])
    expect(rebuiltStore.diagnostics().sessionIndexSource).toBe('rebuilt')
    expect(rebuiltStore.diagnostics().rebuildReasons).toContain('index_corrupt')
    expect(
      readdirSync(sessionsDir).some(
        (name) => name.startsWith('index.corrupt-') && name.endsWith('.json'),
      ),
    ).toBe(true)
    expect(existsSync(join(sessionsDir, 'index.json'))).toBe(true)
  })

  it('backs up a valid legacy index once when materializing metadata', () => {
    const root = tmp('emperor-session-legacy-backup-')
    const sessionsDir = join(root, 'sessions')
    const indexPath = join(sessionsDir, 'index.json')
    const backupPath = join(sessionsDir, 'index.legacy-backup.json')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      indexPath,
      JSON.stringify(
        [
          {
            id: 'legacy',
            title: 'Legacy Title',
            updated_at: '2026-01-01T00:00:00+0800',
          },
        ],
        null,
        2,
      ) + '\n',
      'utf8',
    )
    const store = new SessionStore(root)

    expect(store.list().map((item) => item.id)).toEqual(['legacy'])
    expect(readFileSync(backupPath, 'utf8')).toContain('Legacy Title')
    expect(store.diagnostics()).toMatchObject({
      sessionIndexSource: 'rebuilt',
      repairedSessions: 1,
      legacyBackupPath: backupPath,
    })

    const metaPath = join(sessionsDir, 'legacy', 'meta.jsonl')
    const linesAfterFirstRun = readFileSync(metaPath, 'utf8').trim().split('\n')
    writeFileSync(backupPath, 'keep-existing-backup\n', 'utf8')
    expect(store.list().map((item) => item.id)).toEqual(['legacy'])
    expect(readFileSync(backupPath, 'utf8')).toBe('keep-existing-backup\n')
    expect(readFileSync(metaPath, 'utf8').trim().split('\n')).toHaveLength(
      linesAfterFirstRun.length,
    )
  })

  it('recovers history-only session directories and writes recovered metadata', () => {
    const root = tmp('emperor-session-history-only-')
    const sessionDir = join(root, 'sessions', 'history_only')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'history.jsonl'),
      [
        JSON.stringify({
          ts: '2026-01-01T10:00:00+0800',
          role: 'user',
          content: '请帮我恢复这个会话标题',
        }),
        JSON.stringify({
          ts: '2026-01-01T10:01:00+0800',
          role: 'assistant',
          content: '已经恢复 preview',
        }),
        'not-json',
        JSON.stringify({
          ts: '2026-01-01T10:02:00+0800',
          role: 'tool',
          content: 'hidden',
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const recovered = new SessionStore(root).list()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      id: 'history_only',
      title: '请帮我恢复这个会话标题',
      preview: '已经恢复 preview',
      message_count: 2,
      mode: 'chat',
      project_id: null,
    })
    expect(existsSync(join(sessionDir, 'meta.jsonl'))).toBe(true)
  })

  it('does not convert project registry records into build sessions during repair', () => {
    const root = tmp('emperor-session-project-registry-')
    mkdirSync(join(root, 'memory', 'projects'), { recursive: true })
    writeFileSync(
      join(root, 'memory', 'projects', 'index.json'),
      JSON.stringify([
        {
          project_id: 'project_1',
          project_path: '/tmp/project',
          project_name: 'project',
          updated_at: '2026-01-01T00:00:00+0800',
        },
      ]),
      'utf8',
    )

    expect(new SessionStore(root).list({ includeArchived: true })).toEqual([])
  })

  it('ignores malformed metadata lines and falls back to the latest valid snapshot', () => {
    const root = tmp('emperor-session-bad-meta-')
    const sessionDir = join(root, 'sessions', 'meta_bad')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.jsonl'),
      [
        'not-json',
        JSON.stringify({
          type: 'session_snapshot',
          ts: '2026-01-01T10:00:00+0800',
          session: {
            id: 'meta_bad',
            title: 'Recovered From Meta',
            created_at: '2026-01-01T10:00:00+0800',
            updated_at: '2026-01-01T10:00:00+0800',
            preview: 'metadata preview',
            message_count: 4,
            title_status: 'manual',
            mode: 'chat',
            project_id: null,
            project_path: null,
            project_name: null,
            archived_at: null,
            control_pending: null,
            version: 1,
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    expect(new SessionStore(root).list()[0]).toMatchObject({
      id: 'meta_bad',
      title: 'Recovered From Meta',
      preview: 'metadata preview',
      message_count: 4,
    })
  })

  it('persists and normalizes lightweight control pending summaries', () => {
    const root = tmp('emperor-session-control-pending-')
    const store = new SessionStore(root)
    const ask = store.create('Ask Session')
    const plan = store.create('Plan Session')

    expect(
      store.setControlPending(ask.id, {
        kind: 'ask',
        label: '需要用户输入',
        tone: 'blue',
        interaction_id: 'ask_123',
        updated_at: 123,
      })?.control_pending,
    ).toEqual({
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: 'ask_123',
      updated_at: 123,
    })
    expect(
      store.setControlPending(plan.id, {
        kind: 'plan',
        label: '计划需要用户确认',
        tone: 'green',
        interaction_id: 'plan_123',
        updated_at: 456,
      })?.control_pending,
    ).toMatchObject({ kind: 'plan', tone: 'green' })

    expect(store.get(ask.id)?.control_pending).toMatchObject({
      kind: 'ask',
      label: '需要用户输入',
    })
    expect(store.clearControlPending(ask.id)?.control_pending).toBeNull()
    expect(store.get(plan.id)?.control_pending).toMatchObject({
      kind: 'plan',
      label: '计划需要用户确认',
    })
  })

  it('reconciles stale control pending summaries against the authoritative pending interaction', () => {
    const root = tmp('emperor-session-control-reconcile-')
    const store = new SessionStore(root)
    const current = store.create('Current')
    const stale = store.create('Stale')

    store.setControlPending(current.id, {
      kind: 'plan',
      label: '计划需要用户确认',
      tone: 'green',
      interaction_id: 'plan_current',
      updated_at: 1,
    })
    store.setControlPending(stale.id, {
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: 'ask_stale',
      updated_at: 2,
    })

    store.reconcileControlPending({
      kind: 'plan',
      label: '计划需要用户确认',
      tone: 'green',
      interaction_id: 'plan_current',
      updated_at: 3,
    })

    expect(store.get(current.id)?.control_pending).toMatchObject({
      interaction_id: 'plan_current',
    })
    expect(store.get(stale.id)?.control_pending).toBeNull()

    store.reconcileControlPending(null)

    expect(store.get(current.id)?.control_pending).toBeNull()
    expect(store.get(stale.id)?.control_pending).toBeNull()
  })
})

describe('session migration (test_loop_sessions.py)', () => {
  it('moves legacy mainline history, checkpoint, and runtime events into a default session once', () => {
    const root = tmp('emperor-session-migrate-')
    const memoryDir = join(root, 'memory')
    rmSync(memoryDir, { recursive: true, force: true })
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(
      join(memoryDir, 'history.jsonl'),
      '{"ts":"2026-01-01","role":"user","content":"old"}\n',
      { encoding: 'utf8', flag: 'w' },
    )
    writeFileSync(
      join(memoryDir, '_checkpoint.json'),
      '{"history":[{"role":"user","content":"ck"}]}',
      { encoding: 'utf8', flag: 'w' },
    )
    mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
    writeFileSync(
      join(memoryDir, 'runtime', 'events.jsonl'),
      '{"type":"ready"}\n',
      'utf8',
    )

    const migrated = migrateLegacyMainlineToDefaultSession(root)
    const again = migrateLegacyMainlineToDefaultSession(root)

    expect(migrated).not.toBeNull()
    expect(again).toBeNull()
    expect(existsSync(join(memoryDir, 'history.jsonl'))).toBe(false)
    expect(
      existsSync(join(root, 'sessions', migrated!.id, 'history.jsonl')),
    ).toBe(true)
    expect(
      existsSync(join(root, 'sessions', migrated!.id, '_checkpoint.json')),
    ).toBe(true)
    expect(
      existsSync(
        join(root, 'sessions', migrated!.id, 'runtime', 'events.jsonl'),
      ),
    ).toBe(true)
    expect(existsSync(join(root, 'sessions', migrated!.id, 'meta.jsonl'))).toBe(
      true,
    )
  })
})

describe('session title (test_session_title.py)', () => {
  it('sanitizes boilerplate, punctuation, and fallback titles', () => {
    expect(sanitizeSessionTitle('《关于 帮我优化 Codex UI！》')).toBe(
      'Codex UI',
    )
    expect(sanitizeSessionTitle('如何实现真实会话路由？')).toBe('真实会话路由')
    expect(sanitizeSessionTitle('"配置 MCP 工具"')).toBe('配置 MCP 工具')
    expect(fallbackSessionTitle('请帮我实现真实懒创建会话，需要同步标题')).toBe(
      '真实懒创建会话',
    )
    expect(fallbackSessionTitle('   !!!   ')).toBe('新会话')
  })
})
