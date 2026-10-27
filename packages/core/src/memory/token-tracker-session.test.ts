// SET-01: each ledger row remembers the session it was spent for and where
// it came from (a model call, a scheduled turn, a Claude Code or Codex run);
// the tracker keeps per-day, per-session, per-source totals for 用量与费用.
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
    expect(days[today!]!['s1']!.model).toMatchObject({
      calls: 2,
      total: 240,
      cost_usd_nanos: 750_000_000,
    })
    expect(days[today!]!['s2']!.model).toMatchObject({
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
    expect(days['2026-10-20']!['']!.model).toMatchObject({ calls: 1, total: 6 })
  })

  it('rebuilds the per-session totals from the ledger after a restart', () => {
    const file = ledger()
    const first = new TokenTracker(file)
    first.record('m', USAGE, { sessionId: 's1', costUsd: 0.5 })
    const again = new TokenTracker(file)
    const [day] = Object.keys(again.statsByDateSession())
    expect(again.statsByDateSession()[day!]!['s1']!.model).toMatchObject({
      calls: 1,
    })
  })

  it('hands out copies, so a caller cannot change the totals', () => {
    const tracker = new TokenTracker(ledger())
    tracker.record('m', USAGE, { sessionId: 's1' })
    const days = tracker.statsByDateSession()
    const [day] = Object.keys(days)
    days[day!]!['s1']!.model!.calls = 99
    expect(tracker.statsByDateSession()[day!]!['s1']!.model!.calls).toBe(1)
  })

  it('accepts the snake_case option like the other options', () => {
    const tracker = new TokenTracker(ledger())
    tracker.record('m', USAGE, { session_id: 's-snake' })
    expect(tracker.recentCalls(1)[0]).toMatchObject({ session_id: 's-snake' })
  })

  it('files a scheduled turn’s calls under the scheduler', () => {
    const tracker = new TokenTracker(ledger())
    tracker.record('m', USAGE, { sessionId: 's1', source: 'scheduler' })
    tracker.record('m', USAGE, { sessionId: 's1' })
    const [day] = Object.keys(tracker.statsByDateSession())
    const s1 = tracker.statsByDateSession()[day!]!['s1']!
    expect(s1.scheduler).toMatchObject({ calls: 1 })
    expect(s1.model).toMatchObject({ calls: 1 })
    expect(tracker.recentCalls(2)[1]).toMatchObject({ source: 'scheduler' })
  })

  it('records an external run without moving the context reading', () => {
    const file = ledger()
    const tracker = new TokenTracker(file)
    tracker.record('m', { ...USAGE, input: 1234 }, { sessionId: 's1' })
    tracker.record(
      'gpt-5-codex',
      { input: 90_000, output: 1000 },
      { sessionId: 's1', source: 'codex', usageType: 'executor', costUsd: 0.4 },
    )
    expect(tracker.lastInputTokensValue()).toBe(1234)
    // Nor after a restart, when the last row is the external one.
    expect(new TokenTracker(file).lastInputTokensValue()).toBe(1234)
    const [day] = Object.keys(tracker.statsByDateSession())
    expect(tracker.statsByDateSession()[day!]!['s1']!.codex).toMatchObject({
      calls: 1,
      cost_usd_nanos: 400_000_000,
    })
  })

  it('counts a subscription run’s tokens with no cost, and says so', () => {
    const file = ledger()
    const tracker = new TokenTracker(file)
    tracker.record(
      'sonnet',
      { input: 500, output: 100 },
      { sessionId: 's1', source: 'claude-code', subscription: true },
    )
    const [day] = Object.keys(tracker.statsByDateSession())
    const bucket = tracker.statsByDateSession()[day!]!['s1']!['claude-code']!
    expect(bucket).toMatchObject({
      calls: 1,
      total: 600,
      cost_usd_nanos: 0,
      subscription_tokens: 600,
      cost_incomplete_calls: 0,
    })
    expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({
      source: 'claude-code',
      subscription: true,
      cost_usd_nanos: 0,
      cost_complete: true,
    })
  })

  it('ignores a source it does not know (a newer Emperor’s) as a model call', () => {
    const file = ledger()
    writeFileSync(
      file,
      JSON.stringify({
        ts: '2026-10-21T10:00:00',
        model: 'm',
        input: 5,
        output: 1,
        session_id: 's9',
        source: 'robot-arm',
      }) + '\n',
    )
    const days = new TokenTracker(file).statsByDateSession()
    expect(days['2026-10-21']!['s9']!.model).toMatchObject({ calls: 1 })
  })
})
