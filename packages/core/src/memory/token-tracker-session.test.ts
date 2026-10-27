// SET-01: each model call remembers the session it was spent for, and the
// tracker keeps per-day, per-session totals for 用量与费用's by-source view.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TokenTracker } from './token-tracker'

function ledger(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'emperor-ledger-session-')),
    'tokens.jsonl',
  )
}
const USAGE = {
  input: 100,
  output: 20,
  cache_read: 0,
  cache_create: 0,
  reasoning: 0,
}

describe('TokenTracker sessions', () => {
  it('writes the session id into the ledger row and the recent calls', () => {
    const file = ledger()
    const tracker = new TokenTracker(file)
    tracker.record('m', USAGE, { sessionId: 's-build', costUsd: 0.5 })
    expect(tracker.recentCalls(1)[0]).toMatchObject({ session_id: 's-build' })
    expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({
      session_id: 's-build',
    })
  })

  it('totals tokens and cost per day and session', () => {
    const tracker = new TokenTracker(ledger())
    tracker.record('m', USAGE, { sessionId: 's1', costUsd: 0.5 })
    tracker.record('m', USAGE, { sessionId: 's1', costUsd: 0.25 })
    tracker.record('m', USAGE, { sessionId: 's2', costUsd: 1 })
    const days = tracker.statsByDateSession()
    const [today] = Object.keys(days)
    expect(days[today!]!['s1']).toMatchObject({
      calls: 2,
      total: 240,
      cost_usd_nanos: 750_000_000,
    })
    expect(days[today!]!['s2']).toMatchObject({
      calls: 1,
      cost_usd_nanos: 1_000_000_000,
    })
  })

  it('files a row without a session (older ledgers) under the empty id', () => {
    const file = ledger()
    writeFileSync(
      file,
      JSON.stringify({
        ts: '2026-10-20T10:00:00',
        provider: 'p',
        model: 'm',
        model_entry_id: 'e',
        usage_type: 'main_agent',
        input: 5,
        output: 1,
        cache_read: 0,
        cache_create: 0,
      }) + '\n',
    )
    const days = new TokenTracker(file).statsByDateSession()
    expect(days['2026-10-20']!['']).toMatchObject({ calls: 1, total: 6 })
  })

  it('rebuilds the per-session totals from the ledger after a restart', () => {
    const file = ledger()
    const first = new TokenTracker(file)
    first.record('m', USAGE, { sessionId: 's1', costUsd: 0.5 })
    const again = new TokenTracker(file)
    const [day] = Object.keys(again.statsByDateSession())
    expect(again.statsByDateSession()[day!]!['s1']).toMatchObject({ calls: 1 })
  })

  it('hands out copies, so a caller cannot change the totals', () => {
    const tracker = new TokenTracker(ledger())
    tracker.record('m', USAGE, { sessionId: 's1' })
    const days = tracker.statsByDateSession()
    const [day] = Object.keys(days)
    days[day!]!['s1']!.calls = 99
    expect(tracker.statsByDateSession()[day!]!['s1']!.calls).toBe(1)
  })

  it('accepts the snake_case option like the other options', () => {
    const tracker = new TokenTracker(ledger())
    tracker.record('m', USAGE, { session_id: 's-snake' })
    expect(tracker.recentCalls(1)[0]).toMatchObject({ session_id: 's-snake' })
  })
})
