import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskKind, TaskRecord, TaskStatus } from './models'
import { TaskManager } from './manager'
import { SidechainTranscript } from './sidechain'
import { TaskStore } from './store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function rec(i: number, status = TaskStatus.COMPLETED): TaskRecord {
  return new TaskRecord({
    id: `t${i}`,
    kind: TaskKind.SUBAGENT,
    status,
    title: 'x',
    source: 'test',
    started_at: i,
  })
}

describe('TaskStore (test_tasks_store.py)', () => {
  it('round-trips records and quarantines corrupt indexes', () => {
    const root = tmp('emperor-task-store-')
    const store = new TaskStore(root)
    const record = new TaskRecord({
      id: 'task_1',
      kind: TaskKind.SUBAGENT,
      status: TaskStatus.RUNNING,
      title: 'inspect files',
      source: 'dispatch_subagent',
      turn_id: 'turn_1',
      started_at: 123,
    })

    store.upsert(record)
    expect(store.get('task_1')?.toDict()).toEqual(record.toDict())
    expect(store.list()[0]!.id).toBe('task_1')

    writeFileSync(join(root, 'memory', 'tasks', 'index.json'), '{bad json', 'utf8')
    expect(store.list()).toEqual([])
    expect(existsSync(join(root, 'memory', 'tasks', 'index.json'))).toBe(true)
    expect(readdirSync(join(root, 'memory', 'tasks')).some((name) => name.startsWith('index.json.corrupt-'))).toBe(true)
  })

  it('round-trips session ownership and tolerates legacy records without it', () => {
    const root = tmp('emperor-task-session-')
    const store = new TaskStore(root)
    const owned = new TaskRecord({
      id: 'task_owned',
      kind: TaskKind.SUBAGENT,
      status: TaskStatus.RUNNING,
      title: 'owned task',
      source: 'dispatch_subagent',
      started_at: 123,
      session_id: 'sess_a',
    })
    store.upsert(owned)
    expect(store.get('task_owned')?.session_id).toBe('sess_a')
    expect(store.get('task_owned')?.toDict().session_id).toBe('sess_a')

    // legacy 记录（磁盘上无 session_id 字段）宽容加载为 null
    const legacy = TaskRecord.fromDict({
      id: 'task_legacy', kind: 'subagent', status: 'completed',
      title: 'legacy', source: 'dispatch_subagent', started_at: 1,
    })
    expect(legacy.session_id).toBeNull()
  })

  it('archives only terminal tasks over cap and preserves archived lookup', () => {
    const root = tmp('emperor-task-archive-')
    const store = new TaskStore(root, { maxTerminal: 5 })
    store.upsert(rec(100, TaskStatus.QUEUED))
    store.upsert(rec(101, TaskStatus.PENDING))
    store.upsert(rec(102, TaskStatus.RUNNING))
    for (let i = 0; i < 20; i++) store.upsert(rec(i))

    expect(store.list().filter((task) => task.status === TaskStatus.COMPLETED)).toHaveLength(5)
    expect(store.get('t0')?.status).toBe(TaskStatus.COMPLETED)
    const hotIds = new Set(store.list().map((task) => task.id))
    expect(hotIds.has('t100')).toBe(true)
    expect(hotIds.has('t101')).toBe(true)
    expect(hotIds.has('t102')).toBe(true)
  })
})

describe('TaskManager and SidechainTranscript (test_task_runtime_api.py)', () => {
  it('starts, updates, completes, fails, cancels, and reads sidechain transcripts', () => {
    const root = tmp('emperor-task-manager-')
    const manager = new TaskManager(root)
    const task = manager.startTask({
      kind: TaskKind.SUBAGENT,
      title: 'Inspect files'.repeat(20),
      source: 'dispatch_subagent',
      turnId: 'turn_1',
      toolCallId: 'call_1',
      metadata: { agent_type: 'reviewer' },
    })

    expect(task.id.startsWith('subagent_')).toBe(true)
    expect(task.title.length).toBeLessThanOrEqual(160)
    expect(task.toRuntimeDict().turnId).toBe('turn_1')
    manager.appendSidechain(task.id, { role: 'user', content: 'inspect' })
    manager.appendSidechain(task.id, { role: 'assistant', content: 'done' })
    expect(manager.readSidechain(task.id, { offset: 0, limit: 1 }).messages[0]!.content).toBe('inspect')
    expect(manager.readSidechain(task.id, { offset: 0, limit: 1 }).nextOffset).toBe(1)
    expect(manager.completeTask(task.id, { summary: 'done' })?.status).toBe(TaskStatus.COMPLETED)
    expect(manager.failTask(task.id, { error: 'boom' })?.progress.error).toBe('boom')
    expect(manager.cancelTask(task.id, { reason: 'stop' })?.progress.reason).toBe('stop')
  })

  it('stamps session ownership onto started tasks', () => {
    const manager = new TaskManager(tmp('emperor-task-manager-session-'))
    const record = manager.startTask({
      kind: TaskKind.SUBAGENT,
      title: 'owned',
      source: 'dispatch_subagent',
      sessionId: 'sess_m',
    })
    expect(manager.store.get(record.id)?.session_id).toBe('sess_m')
  })

  it('sidechain transcript skips bad lines and returns absolute path', () => {
    const root = tmp('emperor-sidechain-')
    const transcript = new SidechainTranscript(root, 'task_1')
    transcript.append({ role: 'user', content: 'a' })
    writeFileSync(transcript.path, readFileSync(transcript.path, 'utf8') + '{bad json\n', 'utf8')
    transcript.append({ role: 'assistant', content: 'b' })
    const payload = transcript.read({ offset: 0, limit: 10 })
    expect(payload.messages.map((m) => m.content)).toEqual(['a', 'b'])
    expect(payload.path).toBe(transcript.path)
  })
})

describe('ProjectStore (test_project_store.py)', () => {
  it('resolves a project path and stores managed memory outside the user project', async () => {
    const { ProjectStore, PROJECT_MEMORY_START, PROJECT_MEMORY_END } = await import('../projects/store')
    const stateRoot = tmp('emperor-project-store-state-')
    const projectDir = tmp('emperor-project-store-workspace-')
    const store = new ProjectStore(stateRoot)

    const entry = store.resolve(projectDir)

    const expectedId = createHash('sha256').update(resolve(projectDir), 'utf8').digest('hex').slice(0, 16)
    expect(entry.project_id).toBe(expectedId)
    expect(entry.project_path).toBe(resolve(projectDir))
    expect(entry.project_name).toBe(projectDir.split('/').at(-1))
    const agentsPath = join(projectDir, 'AGENTS.md')
    expect(existsSync(agentsPath)).toBe(false)
    expect(entry.agents_path).toBe(join(stateRoot, 'projects', expectedId, 'AGENTS.local.md'))
    expect(readFileSync(entry.agents_path, 'utf8')).toContain(PROJECT_MEMORY_START)
    expect(readFileSync(entry.agents_path, 'utf8')).toContain(PROJECT_MEMORY_END)

    const updated = store.updateMemory(entry.project_id, '## 项目情况\n\n- 使用 Vue + Python。\n- 最近在做 Build 模式。')
    const text = readFileSync(entry.agents_path, 'utf8')
    expect(text).toContain('使用 Vue + Python')
    expect(updated.summary).toBe('使用 Vue + Python；最近在做 Build 模式')
    expect(store.readManagedMemory(entry.project_id)).toContain('最近在做 Build 模式')
    expect(store.summaryForChat()).toContain(entry.project_name)
    expect(existsSync(agentsPath)).toBe(false)
  })

  it('imports a legacy managed AGENTS.md block without mutating the project file', async () => {
    const { ProjectStore, PROJECT_MEMORY_START, PROJECT_MEMORY_END } = await import('../projects/store')
    const stateRoot = tmp('emperor-project-store-state-')
    const projectDir = tmp('emperor-project-store-legacy-workspace-')
    const agentsPath = join(projectDir, 'AGENTS.md')
    const legacyText = [
      '# Existing AGENTS',
      '',
      'Keep this user-authored section.',
      '',
      PROJECT_MEMORY_START,
      '## Legacy Project Memory',
      '',
      '- 从旧托管块迁移。',
      PROJECT_MEMORY_END,
      '',
    ].join('\n')
    writeFileSync(agentsPath, legacyText, 'utf8')
    const store = new ProjectStore(stateRoot)

    const entry = store.resolve(projectDir)

    expect(readFileSync(agentsPath, 'utf8')).toBe(legacyText)
    expect(readFileSync(entry.agents_path, 'utf8')).toContain('从旧托管块迁移')
    expect(store.readManagedMemory(entry.project_id)).toContain('从旧托管块迁移')
  })

  it('rejects missing project directories', async () => {
    const { ProjectStore } = await import('../projects/store')
    const root = tmp('emperor-project-missing-')
    const store = new ProjectStore(root)
    expect(() => store.resolve(join(root, 'missing'))).toThrow(/project path must be an existing directory/)
  })
})
