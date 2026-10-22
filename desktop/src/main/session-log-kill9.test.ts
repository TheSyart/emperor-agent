// SEC-02's kill -9 acceptance as a script the nightly runs (REL-04): a
// writer streams turns through the real SessionLogStore, is SIGKILLed at a
// random moment, and a fresh store must open the log with contiguous seqs
// and every turn closed. Here: a short run of each mode.
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const script = path.join(repoRoot, 'scripts', 'session-log-kill9.mjs')

function kill9(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [script, '--runs', '2', '--json', ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  )
  const last = result.stdout.trim().split('\n').at(-1) ?? '{}'
  return { result, summary: JSON.parse(last) }
}

describe('session log kill -9 acceptance script', () => {
  it('reopens the log after each SIGKILL with contiguous seqs', () => {
    const { result, summary } = kill9([])
    expect(result.status, result.stderr).toBe(0)
    expect(summary).toMatchObject({ runs: 2, recovered: 2, mode: 'sigkill' })
    expect(summary.events).toBeGreaterThan(0)
    for (const run of summary.results) {
      expect(run).toMatchObject({ ok: true, signal: 'SIGKILL' })
      expect(run.openTurns).toBe(0)
    }
  })

  it('also recovers when the tail is cut off after the kill (power loss)', () => {
    const { result, summary } = kill9(['--truncate-tail'])
    expect(result.status, result.stderr).toBe(0)
    expect(summary).toMatchObject({
      runs: 2,
      recovered: 2,
      mode: 'sigkill+truncate',
    })
    for (const run of summary.results)
      expect(run.truncatedBytes).toBeGreaterThan(0)
  })
})
