import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateLegacyStateRoot } from './migrate-state-root'
import { ensureRuntimeStateDirs, resolveRuntimePaths } from './paths'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('migrateLegacyStateRoot', () => {
  it('copies legacy memory, sessions, and team state into .emperor once without deleting old data', () => {
    const root = tmp('emperor-legacy-state-')
    const paths = resolveRuntimePaths(root, { stateRoot: join(root, '.emperor') })
    mkdirSync(join(root, 'memory'), { recursive: true })
    mkdirSync(join(root, 'sessions', 'legacy-session'), { recursive: true })
    mkdirSync(join(root, '.team'), { recursive: true })
    writeFileSync(join(root, 'memory', 'MEMORY.local.md'), '# Legacy memory\n', 'utf8')
    writeFileSync(join(root, 'sessions', 'legacy-session', 'history.jsonl'), '{"role":"user","content":"old"}\n', 'utf8')
    writeFileSync(join(root, '.team', 'config.json'), '{"members":[]}\n', 'utf8')

    ensureRuntimeStateDirs(paths)
    const first = migrateLegacyStateRoot(paths)
    const second = migrateLegacyStateRoot(paths)

    expect(first.copied).toBe(3)
    expect(second.copied).toBe(0)
    expect(readFileSync(join(paths.memoryRoot, 'MEMORY.local.md'), 'utf8')).toContain('Legacy memory')
    expect(readFileSync(join(paths.sessionsRoot, 'legacy-session', 'history.jsonl'), 'utf8')).toContain('old')
    expect(readFileSync(join(paths.teamRoot, 'config.json'), 'utf8')).toContain('members')
    expect(existsSync(join(root, 'memory', 'MEMORY.local.md'))).toBe(true)
    expect(existsSync(join(root, 'sessions', 'legacy-session', 'history.jsonl'))).toBe(true)
    expect(existsSync(join(root, '.team', 'config.json'))).toBe(true)
    expect(readFileSync(join(paths.stateRoot, 'migration-log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3)
    expect(first.reportPath).toBe(join(paths.stateRoot, 'migrations', 'state-root-migration.json'))
    const report = JSON.parse(readFileSync(first.reportPath, 'utf8'))
    expect(report).toMatchObject({
      copied: 3,
      skipped: 0,
      logPath: join(paths.stateRoot, 'migration-log.jsonl'),
    })
    expect(report.legacyStateRoots).toEqual(first.legacyStateRoots)
  })

  it('copies ancient bare runtime state for control, scheduler, tasks, external, and tokens', () => {
    const runtimeRoot = tmp('emperor-legacy-bare-runtime-')
    const stateRoot = tmp('emperor-legacy-bare-state-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    mkdirSync(join(runtimeRoot, 'control'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'scheduler'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'tasks'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'external'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'tokens'), { recursive: true })
    writeFileSync(join(runtimeRoot, 'control', 'state.json'), '{"pending":null}\n', 'utf8')
    writeFileSync(join(runtimeRoot, 'scheduler', 'jobs.json'), '{"jobs":[]}\n', 'utf8')
    writeFileSync(join(runtimeRoot, 'tasks', 'index.json'), '{"tasks":[]}\n', 'utf8')
    writeFileSync(join(runtimeRoot, 'external', 'inbound.json'), '{"queue":[]}\n', 'utf8')
    writeFileSync(join(runtimeRoot, 'tokens', 'tokens.jsonl'), '{"model":"x"}\n', 'utf8')

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(result.copied).toBe(5)
    expect(readFileSync(join(paths.controlRoot, 'state.json'), 'utf8')).toContain('pending')
    expect(readFileSync(join(paths.schedulerRoot, 'jobs.json'), 'utf8')).toContain('jobs')
    expect(readFileSync(join(paths.tasksRoot, 'index.json'), 'utf8')).toContain('tasks')
    expect(readFileSync(join(paths.externalRoot, 'inbound.json'), 'utf8')).toContain('queue')
    expect(readFileSync(join(stateRoot, 'tokens', 'tokens.jsonl'), 'utf8')).toContain('model')
    expect(existsSync(join(runtimeRoot, 'control', 'state.json'))).toBe(true)
  })

  it('copies previous memory-scoped control/scheduler/tasks/external state into top-level state dirs', () => {
    const runtimeRoot = tmp('emperor-legacy-memory-subdirs-runtime-')
    const stateRoot = tmp('emperor-legacy-memory-subdirs-state-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    const previous = join(runtimeRoot, '.emperor')
    mkdirSync(join(previous, 'memory', 'control'), { recursive: true })
    mkdirSync(join(previous, 'memory', 'scheduler'), { recursive: true })
    mkdirSync(join(previous, 'memory', 'tasks', 'task_1'), { recursive: true })
    mkdirSync(join(previous, 'memory', 'external'), { recursive: true })
    writeFileSync(join(previous, 'memory', 'control', 'state.json'), '{"pending":{"id":"ask_1"}}\n', 'utf8')
    writeFileSync(join(previous, 'memory', 'scheduler', 'jobs.json'), '{"jobs":[{"id":"job_1"}]}\n', 'utf8')
    writeFileSync(join(previous, 'memory', 'tasks', 'index.json'), '{"task_1":{"id":"task_1"}}\n', 'utf8')
    writeFileSync(join(previous, 'memory', 'tasks', 'task_1', 'transcript.jsonl'), '{"task_id":"task_1"}\n', 'utf8')
    writeFileSync(join(previous, 'memory', 'external', 'state.json'), '{"outbox":[]}\n', 'utf8')

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(readFileSync(join(paths.controlRoot, 'state.json'), 'utf8')).toContain('ask_1')
    expect(readFileSync(join(paths.schedulerRoot, 'jobs.json'), 'utf8')).toContain('job_1')
    expect(readFileSync(join(paths.tasksRoot, 'index.json'), 'utf8')).toContain('task_1')
    expect(readFileSync(join(paths.tasksRoot, 'task_1', 'transcript.jsonl'), 'utf8')).toContain('task_1')
    expect(readFileSync(join(paths.externalRoot, 'state.json'), 'utf8')).toContain('outbox')
    expect(result.entries.map((entry) => entry.legacy)).toEqual(expect.arrayContaining([
      'memory-control',
      'memory-scheduler',
      'memory-tasks',
      'memory-external',
    ]))
    expect(existsSync(join(stateRoot, 'memory', 'control', 'state.json'))).toBe(false)
    expect(existsSync(join(stateRoot, 'memory', 'scheduler', 'jobs.json'))).toBe(false)
    expect(existsSync(join(stateRoot, 'memory', 'tasks', 'index.json'))).toBe(false)
    expect(existsSync(join(stateRoot, 'memory', 'external', 'state.json'))).toBe(false)
    expect(existsSync(join(previous, 'memory', 'control', 'state.json'))).toBe(true)
  })

  it('copies legacy top-level config files into stateRoot without overwriting existing config', () => {
    const runtimeRoot = tmp('emperor-legacy-config-runtime-')
    const stateRoot = tmp('emperor-legacy-config-state-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    writeFileSync(join(runtimeRoot, 'model_config.json'), '{"models":[{"name":"legacy"}]}\n', 'utf8')
    writeFileSync(join(runtimeRoot, 'mcp_config.json'), '{"servers":{}}\n', 'utf8')
    writeFileSync(join(runtimeRoot, 'emperor.local.json'), '{"prompt":{"profile":"classic"}}\n', 'utf8')
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(join(stateRoot, 'mcp_config.json'), '{"servers":{"kept":{}}}\n', 'utf8')

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(readFileSync(join(stateRoot, 'model_config.json'), 'utf8')).toContain('legacy')
    expect(readFileSync(join(stateRoot, 'emperor.local.json'), 'utf8')).toContain('classic')
    expect(readFileSync(join(stateRoot, 'mcp_config.json'), 'utf8')).toContain('kept')
    expect(existsSync(join(runtimeRoot, 'model_config.json'))).toBe(true)
    expect(result.entries.filter((entry) => entry.legacy === 'config')).toHaveLength(2)
  })

  it('skips corrupt legacy json indexes and records the reason', () => {
    const root = tmp('emperor-legacy-state-corrupt-')
    const paths = resolveRuntimePaths(root, { stateRoot: join(root, '.emperor') })
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(join(root, 'sessions', 'index.json'), '{bad json\n', 'utf8')

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(result.skipped).toBe(1)
    expect(existsSync(join(paths.sessionsRoot, 'index.json'))).toBe(false)
    const log = readFileSync(join(paths.stateRoot, 'migration-log.jsonl'), 'utf8')
    expect(log).toContain('skipped_corrupt_json')
    expect(log).toContain('sessions/index.json')
  })

  it('migrates an entire previous runtimeRoot/.emperor state root (incl. control/scheduler/tasks/external/tokens) into the new global stateRoot', () => {
    const runtimeRoot = tmp('emperor-legacy-dotemperor-runtime-')
    const stateRoot = tmp('emperor-legacy-dotemperor-newstate-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    const previous = join(runtimeRoot, '.emperor')

    mkdirSync(join(previous, 'memory'), { recursive: true })
    mkdirSync(join(previous, 'sessions', 's1'), { recursive: true })
    mkdirSync(join(previous, 'control'), { recursive: true })
    mkdirSync(join(previous, 'scheduler'), { recursive: true })
    mkdirSync(join(previous, 'tasks'), { recursive: true })
    mkdirSync(join(previous, 'external'), { recursive: true })
    mkdirSync(join(previous, 'tokens'), { recursive: true })
    writeFileSync(join(previous, 'memory', 'MEMORY.local.md'), '# Previous default memory\n', 'utf8')
    writeFileSync(join(previous, 'sessions', 's1', 'history.jsonl'), '{"role":"user","content":"prev"}\n', 'utf8')
    writeFileSync(join(previous, 'control', 'state.json'), '{"pending":null}\n', 'utf8')
    writeFileSync(join(previous, 'scheduler', 'jobs.json'), '{"jobs":[]}\n', 'utf8')
    writeFileSync(join(previous, 'tasks', 'index.json'), '{"tasks":[]}\n', 'utf8')
    writeFileSync(join(previous, 'external', 'inbound.json'), '{"queue":[]}\n', 'utf8')
    writeFileSync(join(previous, 'tokens', 'tokens.jsonl'), '{"model":"x"}\n', 'utf8')

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(readFileSync(join(stateRoot, 'memory', 'MEMORY.local.md'), 'utf8')).toContain('Previous default memory')
    expect(readFileSync(join(stateRoot, 'sessions', 's1', 'history.jsonl'), 'utf8')).toContain('prev')
    expect(readFileSync(join(stateRoot, 'control', 'state.json'), 'utf8')).toContain('pending')
    expect(readFileSync(join(stateRoot, 'scheduler', 'jobs.json'), 'utf8')).toContain('jobs')
    expect(readFileSync(join(stateRoot, 'tasks', 'index.json'), 'utf8')).toContain('tasks')
    expect(readFileSync(join(stateRoot, 'external', 'inbound.json'), 'utf8')).toContain('queue')
    expect(readFileSync(join(stateRoot, 'tokens', 'tokens.jsonl'), 'utf8')).toContain('model')
    // Old data is never deleted.
    expect(existsSync(join(previous, 'memory', 'MEMORY.local.md'))).toBe(true)
    expect(existsSync(join(previous, 'control', 'state.json'))).toBe(true)

    const emperorEntries = result.entries.filter((entry) => entry.legacy === 'emperor-state-root')
    expect(emperorEntries.length).toBeGreaterThanOrEqual(7)

    // Re-running does not re-copy or duplicate log entries.
    const second = migrateLegacyStateRoot(paths)
    expect(second.entries.filter((entry) => entry.legacy === 'emperor-state-root')).toHaveLength(0)
  })

  it('moves USER.local.md from the previous templates/ path to the new memory/profile/ path, without a straight tree copy landing a stale duplicate', () => {
    const runtimeRoot = tmp('emperor-legacy-userprofile-runtime-')
    const stateRoot = tmp('emperor-legacy-userprofile-newstate-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    const previous = join(runtimeRoot, '.emperor')
    mkdirSync(join(previous, 'templates'), { recursive: true })
    writeFileSync(join(previous, 'templates', 'USER.local.md'), '# customized profile\n', 'utf8')

    ensureRuntimeStateDirs(paths)
    migrateLegacyStateRoot(paths)

    expect(readFileSync(join(stateRoot, 'memory', 'profile', 'USER.local.md'), 'utf8')).toContain('customized profile')
    // The old relative path (templates/USER.local.md) must not also get a stale copy under
    // the new stateRoot — copyTree excludes `templates/` precisely to avoid this duplicate.
    expect(existsSync(join(stateRoot, 'templates', 'USER.local.md'))).toBe(false)
    // Old data is never deleted.
    expect(existsSync(join(previous, 'templates', 'USER.local.md'))).toBe(true)
  })

  it('reports which legacy state roots were detected, whether or not they had anything to copy', () => {
    const runtimeRoot = tmp('emperor-legacy-detect-runtime-')
    const stateRoot = tmp('emperor-legacy-detect-newstate-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    mkdirSync(join(runtimeRoot, '.emperor'), { recursive: true })
    // No ancient bare-runtimeRoot memory/sessions/.team dirs exist in this fixture.

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    const byPath = new Map(result.legacyStateRoots.map((entry) => [entry.path, entry]))
    expect(byPath.get(join(runtimeRoot, 'memory'))).toMatchObject({ kind: 'ancient-bare-runtime-root', existed: false })
    expect(byPath.get(join(runtimeRoot, '.emperor'))).toMatchObject({ kind: 'previous-dotemperor-root', existed: true })
  })
})
