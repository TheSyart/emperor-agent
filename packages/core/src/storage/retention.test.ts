// KRN-12 (CORE-37, the Core part of SUB-18): the retention sweep and the
// storage usage of 设置 › 高级 › 存储.
// - spill: a loose file (shell output, a result saved without a session) or
//   the folder of a session that no longer exists, live or trashed, goes once
//   it is 30 days old; a live or trashed session's folder stays (its purge
//   removes it, KRN-03).
// - memory versions: snapshot files the index does not list.
// - delegations: the isolated runtime home of a delegation that is idle or
//   closed and whose conversation is gone; one nothing knows, after 30 days;
//   probe folders of older builds and temp leftovers after a day. Worktrees
//   and refs in the user's repository are AGT-06's.
// - usage: one walk of Emperor Home by category, matching `du` within 5%.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spillSessionDir } from '../harness/tools/spill'
import { MemoryVersionStore } from '../memory/versions'
import { resolveRuntimePaths } from '../runtime/paths'
import { RetentionService, type RetentionDelegation } from './retention'

const DAY = 24 * 60 * 60 * 1000

function home() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-retention-'))
  const paths = resolveRuntimePaths(root, { stateRoot: join(root, 'home') })
  return { root, paths, spill: join(paths.stateRoot, 'spill') }
}

function file(path: string, bytes = 1024): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x'.repeat(bytes))
  return path
}

/** Backdate a path and everything under it. */
function age(path: string, days: number): void {
  const when = new Date(Date.now() - days * DAY)
  const visit = (current: string) => {
    if (statSync(current).isDirectory())
      for (const name of readdirSync(current)) visit(join(current, name))
    utimesSync(current, when, when)
  }
  visit(path)
}

function session(paths: { sessionsRoot: string }, id: string, trashed = false) {
  const dir = trashed
    ? join(paths.sessionsRoot, '.trash', id)
    : join(paths.sessionsRoot, id)
  file(join(dir, 'log.jsonl'), 64)
  return dir
}

describe('RetentionService.sweep (KRN-12)', () => {
  it('removes spill older than 30 days that no session owns (3)', async () => {
    const { paths, spill } = home()
    session(paths, 'live-session')
    session(paths, 'trashed-session', true)
    session(paths, 'sub-child-1')
    const live = spillSessionDir(spill, 'live-session')
    const trashed = spillSessionDir(spill, 'trashed-session')
    const child = spillSessionDir(spill, 'sub-child-1')
    const gone = spillSessionDir(spill, 'purged-long-ago')
    const goneRecently = spillSessionDir(spill, 'purged-yesterday')
    file(join(live, 'a-read.txt'), 4096)
    file(join(trashed, 'b-grep.txt'), 4096)
    file(join(child, 'c-bash.txt'), 4096)
    file(join(gone, 'd-bash.txt'), 8192)
    file(join(goneRecently, 'e-bash.txt'), 4096)
    const oldShell = file(join(spill, 'shell-1-1-aa-stdout.log'), 16_384)
    const newShell = file(join(spill, 'shell-1-2-bb-stdout.log'), 1024)
    const oldLoose = file(join(spill, '0123456789ab-glob.txt'), 2048)
    for (const path of [live, trashed, child, gone, oldShell, oldLoose])
      age(path, 40)
    age(goneRecently, 3)

    const report = await new RetentionService({ paths }).sweep()

    expect(existsSync(gone)).toBe(false)
    expect(existsSync(oldShell)).toBe(false)
    expect(existsSync(oldLoose)).toBe(false)
    for (const kept of [live, trashed, child, goneRecently, newShell])
      expect(existsSync(kept), kept).toBe(true)
    expect(report.spill.removed).toBe(3)
    expect(report.spill.bytes).toBeGreaterThanOrEqual(8192 + 16_384 + 2048)
    expect(report.freedBytes).toBeGreaterThanOrEqual(report.spill.bytes)
    expect(report.errors).toEqual([])
  })

  it('sweeps memory version snapshots the index does not list', async () => {
    const { paths } = home()
    const memoryFile = file(join(paths.memoryRoot, 'MEMORY.local.md'), 10)
    const versions = new MemoryVersionStore(
      paths.stateRoot,
      paths.memoryRoot,
      join(paths.stateRoot, 'USER.md'),
    )
    versions.snapshotPath(memoryFile)
    const orphan = file(
      join(versions.snapshotsDir, 'memv_1700000000000_deadbeef_abcdef.json'),
      512,
    )
    age(orphan, 2)

    const report = await new RetentionService({
      paths,
      memoryVersions: versions,
    }).sweep()

    expect(existsSync(orphan)).toBe(false)
    expect(report.memoryVersions.removed).toBe(1)
    expect(versions.list()).toHaveLength(1)
  })

  it('removes delegation leftovers whose conversation is gone, never a link target', async () => {
    const { root, paths } = home()
    session(paths, 'root-live')
    const runtime = join(paths.delegationsRoot, 'runtime', 'codex-default')
    const userAuth = file(join(root, 'user-codex', 'auth.json'), 128)
    const closedGone = join(runtime, 'dlg-closed-gone')
    file(join(closedGone, 'home', '.config', 'x'), 2048)
    file(join(closedGone, 'codex', 'config.toml'), 64)
    symlinkSync(userAuth, join(closedGone, 'codex', 'auth.json'))
    const idleGone = join(runtime, 'dlg-idle-gone')
    file(join(idleGone, 'codex', 'auth.json'), 128) // an older build's copy
    const activeGone = join(runtime, 'dlg-active-gone')
    file(join(activeGone, 'home', 'x'), 64)
    const idleLive = join(runtime, 'dlg-idle-live')
    file(join(idleLive, 'home', 'x'), 64)
    const unknownOld = join(runtime, 'dlg-unknown-old')
    file(join(unknownOld, 'home', 'x'), 64)
    const unknownNew = join(runtime, 'dlg-unknown-new')
    file(join(unknownNew, 'home', 'x'), 64)
    const probe = join(runtime, 'probe')
    file(join(probe, 'home', 'x'), 64)
    const oldProbe = join(runtime, 'dlg-probe-0f0f0f0f')
    file(join(oldProbe, 'codex', 'auth.json'), 128)
    const staleIndex = file(
      join(paths.delegationsRoot, 'indexes', 'aaaa.index'),
      256,
    )
    const liveIndex = file(
      join(paths.delegationsRoot, 'indexes', 'bbbb.index'),
      256,
    )
    const staleTemp = file(
      join(paths.delegationsRoot, 'snapshot-temp', 'cccc', 'x'),
      256,
    )
    const lease = file(join(paths.delegationsRoot, 'leases', 'dwl-1.json'), 64)
    for (const path of [unknownOld, dirname(staleTemp), lease]) age(path, 40)
    for (const path of [oldProbe, staleIndex]) age(path, 2)
    const delegations: RetentionDelegation[] = [
      {
        id: 'dlg-closed-gone',
        rootSessionId: 'root-gone',
        availability: 'closed',
      },
      { id: 'dlg-idle-gone', rootSessionId: 'root-gone', availability: 'idle' },
      {
        id: 'dlg-active-gone',
        rootSessionId: 'root-gone',
        availability: 'active',
      },
      { id: 'dlg-idle-live', rootSessionId: 'root-live', availability: 'idle' },
    ]

    const report = await new RetentionService({
      paths,
      delegations: () => delegations,
    }).sweep()

    for (const removed of [closedGone, idleGone, unknownOld, oldProbe])
      expect(existsSync(removed), removed).toBe(false)
    for (const kept of [
      activeGone,
      idleLive,
      unknownNew,
      probe,
      liveIndex,
      lease,
    ])
      expect(existsSync(kept), kept).toBe(true)
    expect(existsSync(staleIndex)).toBe(false)
    expect(existsSync(dirname(staleTemp))).toBe(false)
    // The link went, the user's own file did not.
    expect(existsSync(userAuth)).toBe(true)
    expect(report.delegations.removed).toBe(6)
    expect(report.errors).toEqual([])
  })

  it('purges expired deleted sessions through the session service', async () => {
    const { paths } = home()
    const dir = session(paths, 'expired', true)
    file(join(dir, 'attachments', 'a.bin'), 4096)
    let asked = 0
    const report = await new RetentionService({
      paths,
      sessions: {
        expired: () => ['expired'],
        purgeExpired: async () => {
          asked += 1
          return ['expired']
        },
      },
    }).sweep()
    expect(asked).toBe(1)
    expect(report.sessions.removed).toBe(1)
    expect(report.sessions.bytes).toBeGreaterThanOrEqual(4096)
  })

  it('collects a failure instead of throwing', async () => {
    const { paths, spill } = home()
    // A file where the spill folder should be.
    file(spill, 10)
    const report = await new RetentionService({
      paths,
      sessions: {
        expired: () => [],
        purgeExpired: async () => {
          throw new Error('trash is busy')
        },
      },
      delegations: () => {
        throw new Error('delegations unavailable')
      },
    }).sweep()
    expect(report.errors.join('\n')).toMatch(/trash is busy/)
    expect(report.errors.join('\n')).toMatch(/delegations unavailable/)
    expect(existsSync(spill)).toBe(true)
  })
})

describe('RetentionService.usage (KRN-12)', () => {
  it('splits Emperor Home by category and matches du within 5% (8)', async () => {
    const { paths, spill } = home()
    file(join(paths.sessionsRoot, 's1', 'log.jsonl'), 300_000)
    file(join(paths.sessionsRoot, '.trash', 's2', 'log.jsonl'), 100_000)
    file(join(paths.attachmentsRoot, '2026-10', 'a.png'), 200_000)
    file(join(paths.mediaRoot, 'b.mp4'), 50_000)
    file(join(spill, 'session-0123456789ab', 'x.txt'), 120_000)
    file(join(paths.memoryRoot, 'versions', 'snapshots', 'v.json'), 40_000)
    file(join(paths.memoryRoot, 'MEMORY.local.md'), 5_000)
    file(paths.tokensFile, 70_000)
    file(
      join(dirname(paths.tokensFile), 'tokens_archive', '2026-09.jsonl.gz'),
      9_000,
    )
    file(join(paths.delegationsRoot, 'runtime', 'p', 'd', 'x'), 80_000)
    file(join(paths.stateRoot, 'environment', 'tools', 'bin'), 500_000)
    const hard = file(join(paths.stateRoot, 'plugins', 'one.bin'), 60_000)
    linkSync(hard, join(paths.stateRoot, 'plugins', 'two.bin'))
    symlinkSync('/usr/bin', join(paths.stateRoot, 'environment', 'link'))

    const usage = await new RetentionService({ paths }).usage()

    const bytes = Object.fromEntries(
      usage.categories.map((item) => [item.id, item.bytes]),
    )
    expect(Object.keys(bytes)).toEqual([
      'sessions',
      'attachments',
      'spill',
      'memoryVersions',
      'ledger',
      'delegations',
      'other',
    ])
    expect(bytes.sessions).toBeGreaterThanOrEqual(400_000)
    expect(bytes.attachments).toBeGreaterThanOrEqual(250_000)
    expect(bytes.spill).toBeGreaterThanOrEqual(120_000)
    expect(bytes.memoryVersions).toBeGreaterThanOrEqual(40_000)
    expect(bytes.memoryVersions).toBeLessThan(45_000 + 16_384)
    expect(bytes.ledger).toBeGreaterThanOrEqual(79_000)
    expect(bytes.delegations).toBeGreaterThanOrEqual(80_000)
    // Other: the environment, plugins (the hard link once), memory files.
    expect(bytes.other).toBeGreaterThanOrEqual(565_000)
    expect(bytes.other).toBeLessThan(565_000 + 60_000)
    const sum = usage.categories.reduce((total, item) => total + item.bytes, 0)
    expect(usage.total).toBe(sum)
    const duKb = Number(
      execFileSync('du', ['-sk', paths.stateRoot], { encoding: 'utf8' }).split(
        /\s+/,
      )[0],
    )
    expect(Math.abs(usage.total - duKb * 1024) / (duKb * 1024)).toBeLessThan(
      0.05,
    )
  })

  it('reports zero for a home that has nothing yet', async () => {
    const { paths } = home()
    const usage = await new RetentionService({ paths }).usage()
    expect(usage.total).toBe(0)
    expect(usage.categories.every((item) => item.bytes === 0)).toBe(true)
  })
})
