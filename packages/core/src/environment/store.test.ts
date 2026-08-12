import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EnvironmentStore } from './store'
import type { EnvironmentJobRecord, EnvironmentReceipt } from './models'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-environment-store-'))
}

function job(): EnvironmentJobRecord {
  return {
    schemaVersion: 1,
    jobId: 'job_01',
    planId: 'plan_01',
    catalogRevision: 'a'.repeat(64),
    projectFingerprint: 'b'.repeat(64),
    projectRoot: '/workspace',
    status: 'planned',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    currentStepId: null,
    steps: [],
    error: null,
  }
}

function receipt(): EnvironmentReceipt {
  return {
    schemaVersion: 1,
    jobId: 'job_01',
    planId: 'plan_01',
    catalogRevision: 'a'.repeat(64),
    appVersion: '0.1.0',
    runtimeRevision: 'b'.repeat(64),
    platform: 'darwin',
    arch: 'arm64',
    startedAt: '2026-07-11T00:00:00.000Z',
    finishedAt: '2026-07-11T00:01:00.000Z',
    status: 'completed',
    steps: [],
  }
}

describe('EnvironmentStore', () => {
  it('initializes only bootstrap managed roots and leaves tool/data roots lazy', () => {
    const store = new EnvironmentStore(root())

    store.initialize()

    expect(store.paths).toMatchObject({
      bin: join(store.paths.root, 'bin'),
      tools: join(store.paths.root, 'tools'),
      data: join(store.paths.root, 'data'),
      registry: join(store.paths.root, 'registry.v1.json'),
    })
    expect(lstatSync(store.paths.bin).isDirectory()).toBe(true)
    expect(existsSync(store.paths.tools)).toBe(false)
    expect(existsSync(store.paths.data)).toBe(false)
    expect(JSON.parse(readFileSync(store.paths.registry, 'utf8'))).toEqual({
      schemaVersion: 1,
      tools: {},
    })
  })

  it('atomically writes and strictly reads jobs and receipts', async () => {
    const store = new EnvironmentStore(root(), {
      now: () => '2026-07-11T00:00:00.000Z',
    })
    await store.saveJob(job())
    await store.saveReceipt(receipt())

    await expect(store.getJob('job_01')).resolves.toEqual(job())
    await expect(store.getReceipt('job_01')).resolves.toEqual(receipt())
    expect(
      readdirSync(store.paths.jobs).some((name) => name.includes('.tmp-')),
    ).toBe(false)
    expect(() => store.jobPath('../escape')).toThrow(/job id/i)
    await expect(
      store.saveJob({ ...job(), command: 'untrusted' } as EnvironmentJobRecord),
    ).rejects.toThrow()

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.saveJob({
          ...job(),
          status: index === 19 ? 'completed' : 'running',
          updatedAt: `2026-07-11T00:00:${String(index).padStart(2, '0')}.000Z`,
        }),
      ),
    )
    await expect(store.getJob('job_01')).resolves.toMatchObject({
      status: 'completed',
      updatedAt: '2026-07-11T00:00:19.000Z',
    })
    expect(
      readdirSync(store.paths.jobs).some(
        (name) => name.includes('.tmp-') || name.includes('.replace-backup'),
      ),
    ).toBe(false)
  })

  it('isolates malformed or schema-invalid JSON and exposes diagnostics', async () => {
    const store = new EnvironmentStore(root(), {
      now: () => '2026-07-11T00:00:00.000Z',
    })
    await store.saveJob(job())
    writeFileSync(store.jobPath('job_01'), '{broken', 'utf8')

    await expect(store.getJob('job_01')).resolves.toBeNull()
    const diagnostics = store.diagnostics()
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'corrupt_job',
        jobId: 'job_01',
        backupPath: expect.stringContaining('.corrupt-'),
      }),
    ])
    expect(existsSync(diagnostics[0]!.backupPath)).toBe(true)
    expect(existsSync(store.jobPath('job_01'))).toBe(false)
  })

  it('redacts secrets, HOME, usernames, and URL queries in bounded JSONL logs', async () => {
    const stateRoot = root()
    const store = new EnvironmentStore(stateRoot, {
      now: () => '2026-07-11T00:00:00.000Z',
      homeDir: '/Users/private-user',
      username: 'private-user',
    })
    await store.appendLog('job_01', {
      level: 'info',
      kind: 'download',
      message:
        'Bearer secret-token --password "value with spaces" --token cli-secret Cookie: session=secret; csrf=def Authorization: Basic dXNlcjpwYXNz Proxy-Authorization: Bearer proxy-secret /Users/private-user https://example.com/file?token=abc',
      details: {
        authorization: 'Bearer secret-token',
        cookie: 'session=secret',
        proxyPassword: 'secret',
        path: '/Users/private-user/downloads/tool.zip',
      },
    })
    const page = await store.readLog('job_01', { cursor: 0, limit: 20 })
    const serialized = JSON.stringify(page)

    expect(page.records).toHaveLength(1)
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).not.toMatch(
      /private-user|secret-token|value with spaces|dXNlcjpwYXNz|proxy-secret|session=secret|csrf=def|cli-secret|token=abc/i,
    )
    expect(readFileSync(store.logPath('job_01'), 'utf8').length).toBeLessThan(
      20_000,
    )
  })

  it('reports malformed JSONL lines without returning them as records', async () => {
    const store = new EnvironmentStore(root(), {
      homeDir: '/Users/private-user',
      username: 'private-user',
    })
    await store.appendLog('job_01', {
      level: 'info',
      kind: 'probe',
      message: 'ok',
      details: {},
    })
    writeFileSync(
      store.logPath('job_01'),
      '{bad Bearer secret-token /Users/private-user https://example.com?a=secret}\n',
      { flag: 'a' },
    )

    const page = await store.readLog('job_01', { cursor: 0, limit: 20 })
    expect(page.records).toHaveLength(1)
    expect(page.badLines).toEqual([
      {
        line: 2,
        raw: '{bad Bearer [REDACTED] [HOME] https://example.com/',
      },
    ])
    expect(JSON.stringify(page.badLines)).not.toMatch(/secret|private-user/i)
    expect(store.diagnostics()).toEqual([
      expect.objectContaining({ kind: 'corrupt_log', jobId: 'job_01' }),
    ])
  })

  it('serializes concurrent JSONL appends into complete records', async () => {
    const store = new EnvironmentStore(root())
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        store.appendLog('job_01', {
          level: 'info',
          kind: 'probe',
          message: `record-${index}`,
          details: { index },
        }),
      ),
    )

    const page = await store.readLog('job_01', { limit: 100 })
    expect(page.records).toHaveLength(30)
    expect(page.badLines).toEqual([])
    expect(new Set(page.records.map((record) => record.message)).size).toBe(30)
  })

  it('caps each job log without writing partial JSONL records', async () => {
    const store = new EnvironmentStore(root(), { maxLogBytes: 1_500 })
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.appendLog('job_01', {
          level: 'info',
          kind: 'installer_output',
          message: `${index}:${'x'.repeat(500)}`,
          details: {},
        }),
      ),
    )

    expect(
      readFileSync(store.logPath('job_01')).byteLength,
    ).toBeLessThanOrEqual(1_500)
    const page = await store.readLog('job_01', { limit: 100 })
    expect(page.records.length).toBeGreaterThan(0)
    expect(page.badLines).toEqual([])
  })

  it('never follows a symlinked installation log', async () => {
    const stateRoot = root()
    const store = new EnvironmentStore(stateRoot)
    await store.appendLog('job_01', {
      level: 'info',
      kind: 'probe',
      message: 'initial',
      details: {},
    })
    const outside = join(stateRoot, 'outside.log')
    writeFileSync(outside, 'outside\n')
    rmSync(store.logPath('job_01'))
    symlinkSync(outside, store.logPath('job_01'))

    await expect(
      store.appendLog('job_01', {
        level: 'info',
        kind: 'probe',
        message: 'must not escape',
        details: {},
      }),
    ).rejects.toThrow(/unsafe|symbolic/i)
    expect(readFileSync(outside, 'utf8')).toBe('outside\n')

    const page = await store.readLog('job_01')
    expect(page.records).toEqual([])
    expect(readFileSync(outside, 'utf8')).toBe('outside\n')
    expect(store.diagnostics()).toEqual([
      expect.objectContaining({ kind: 'corrupt_log', jobId: 'job_01' }),
    ])
  })

  it('rejects symlinked managed directories before reads or isolation', async () => {
    const stateRoot = root()
    const outside = root()
    const store = new EnvironmentStore(stateRoot)
    await store.saveJob(job())
    rmSync(store.paths.jobs, { recursive: true })
    symlinkSync(outside, store.paths.jobs)
    const outsideJob = join(outside, 'job_01.json')
    writeFileSync(outsideJob, '{broken', 'utf8')

    await expect(store.getJob('job_01')).rejects.toThrow(/unsafe|symbolic/i)
    expect(readFileSync(outsideJob, 'utf8')).toBe('{broken')
  })

  it('isolates symlinked job entries discovered during recovery scans', async () => {
    const stateRoot = root()
    const store = new EnvironmentStore(stateRoot)
    store.initialize()
    const outsideJob = join(stateRoot, 'outside-job.json')
    writeFileSync(outsideJob, JSON.stringify(job()), 'utf8')
    symlinkSync(outsideJob, store.jobPath('job_link'))

    await expect(store.listJobs()).resolves.toEqual([])
    expect(readFileSync(outsideJob, 'utf8')).toBe(JSON.stringify(job()))
    expect(store.diagnostics()).toEqual([
      expect.objectContaining({ kind: 'corrupt_job', jobId: 'job_link' }),
    ])
  })

  it('recovers an interrupted Windows-style replacement backup on read', async () => {
    const store = new EnvironmentStore(root())
    await store.saveJob(job())
    const path = store.jobPath('job_01')
    const backup = `${path}.replace-backup`
    renameSync(path, backup)

    await expect(store.getJob('job_01')).resolves.toEqual(job())
    expect(existsSync(path)).toBe(true)
    expect(existsSync(backup)).toBe(false)
  })

  it('serializes reads with writes for the same atomic JSON path', async () => {
    const store = new EnvironmentStore(root())
    await store.saveJob(job())
    const operations: Array<Promise<unknown>> = []
    for (let index = 1; index <= 20; index += 1) {
      operations.push(
        store.saveJob({
          ...job(),
          status: 'running',
          updatedAt: `2026-07-11T00:00:${String(index).padStart(2, '0')}.000Z`,
        }),
      )
      operations.push(store.getJob('job_01'))
    }

    const results = await Promise.all(operations)
    const reads = results.filter(
      (value): value is EnvironmentJobRecord => value !== undefined,
    )
    expect(reads).toHaveLength(20)
    expect(reads.every((value) => value !== null)).toBe(true)
  })
})
