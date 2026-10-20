// KRN-12 (CORE-37): recording a call appends one line; it never re-reads the
// ledger. The hot file rotates with hysteresis (past 5000 rows, 4000 stay).
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TokenTracker } from './token-tracker'

function ledger(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'emperor-ledger-growth-')),
    'tokens.jsonl',
  )
}

function hotLines(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length
}

const usage = { input: 10, output: 2, cache_read: 0, cache_create: 0 }

describe('TokenTracker growth (KRN-12)', () => {
  it('keeps a record under 1 ms after 100,000 calls (6)', () => {
    const path = ledger()
    const tracker = new TokenTracker(path)
    for (let index = 0; index < 100_000; index += 1)
      tracker.record('m', usage, { provider: 'p', modelEntryId: 'e' })
    const times: number[] = []
    for (let index = 0; index < 1000; index += 1) {
      const started = performance.now()
      tracker.record('m', usage, { provider: 'p', modelEntryId: 'e' })
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    expect(times[500]!).toBeLessThan(1)
    expect(tracker.totals().calls).toBe(101_000)
  }, 120_000)

  it('rotates past 5000 hot rows and keeps 4000', () => {
    const path = ledger()
    const tracker = new TokenTracker(path)
    for (let index = 0; index < 5000; index += 1)
      tracker.record('m', usage, { provider: 'p', modelEntryId: 'e' })
    expect(hotLines(path)).toBe(5000)
    tracker.record('m', usage, { provider: 'p', modelEntryId: 'e' })
    expect(hotLines(path)).toBe(4000)
    // The next rotation waits for another 1000 rows.
    for (let index = 0; index < 999; index += 1)
      tracker.record('m', usage, { provider: 'p', modelEntryId: 'e' })
    expect(hotLines(path)).toBe(4999)
    expect(new TokenTracker(path).totals().calls).toBe(6000)
  })
})
