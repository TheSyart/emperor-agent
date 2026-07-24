/**
 * TokenTracker 契约 (MIG-MEM-004)。
 * 移植 Python tests/unit/test_token_usage.py 的 tracker 部分。
 */
import { describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { TokenTracker } from './token-tracker'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ── test_token_usage.py (TokenTracker) ──

describe('TokenTracker (test_token_usage.py)', () => {
  it('recent_calls normalizes legacy cache rows', () => {
    const root = tmp('emperor-token-legacy-')
    const logFile = join(root, 'tokens.jsonl')
    mkdirSync(root, { recursive: true })
    const rows = [
      {
        ts: '2026-05-01T10:00:00',
        model: 'legacy',
        prompt_tokens: 10,
        completion_tokens: 2,
      },
      {
        ts: '2026-05-01T10:01:00',
        provider: 'anthropic',
        model: 'claude',
        usage_type: 'main_agent',
        input: 7,
        output: 1,
        cache_read: 3,
      },
    ]
    writeFileSync(
      logFile,
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    )

    const tracker = new TokenTracker(logFile)
    expect(tracker.lastInputTokensValue()).toBe(10)
    expect(tracker.recentCalls(1)[0]).toEqual({
      ts: '2026-05-01T10:01:00',
      provider: 'anthropic',
      model: 'claude',
      model_entry_id: 'unknown',
      usage_type: 'main_agent',
      input: 7,
      output: 1,
      cache_read: 3,
      cache_create: 0,
      total: 11,
    })
    expect(tracker.recentCacheCalls().map((r) => r.model)).toEqual(['claude'])
  })

  it('writes model_entry_id and never writes legacy role/fallback fields', () => {
    const root = tmp('emperor-token-route-')
    const tracker = new TokenTracker(join(root, 'tokens.jsonl'))
    tracker.record(
      'cheap',
      { input: 5, output: 2 },
      {
        provider: 'fake',
        usageType: 'subagent:sili_suitang',
        modelEntryId: 'active-entry',
        routeReason: 'subagent',
        estimatedInputTokens: 42,
        routeEstimatedTokens: 9,
      },
    )
    const row = tracker.recentCalls(1)[0]!
    expect(row.model_entry_id).toBe('active-entry')
    expect(row.route_reason).toBe('subagent')
    expect(row).not.toHaveProperty('model_role')
    expect(row).not.toHaveProperty('used_fallback')
    expect(row).not.toHaveProperty('fallback_reason')
    expect(row.estimated_input_tokens).toBe(42)
    expect(row.route_estimated_tokens).toBe(9)
  })

  it('aggregates provider/model, date/model, hour, streak, and session metrics', () => {
    const root = tmp('emperor-token-aggregates-')
    const logFile = join(root, 'tokens.jsonl')
    mkdirSync(root, { recursive: true })
    const rows = [
      {
        ts: '2026-05-01T10:00:00',
        provider: 'openai',
        model: 'gpt-4.1',
        input: 10,
        output: 2,
      },
      {
        ts: '2026-05-01T10:20:00',
        provider: 'openai',
        model: 'gpt-4.1',
        input: 5,
        output: 1,
        cache_read: 3,
      },
      {
        ts: '2026-05-02T11:10:00',
        provider: 'anthropic',
        model: 'claude',
        input: 7,
        output: 4,
      },
      {
        ts: '2026-05-02T11:30:01',
        provider: 'anthropic',
        model: 'claude',
        input: 1,
        output: 1,
      },
    ]
    writeFileSync(
      logFile,
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    )

    const tracker = new TokenTracker(logFile)

    expect(tracker.statsByProviderModel()['openai/gpt-4.1']).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
      calls: 2,
      total: 21,
    })
    expect(
      tracker.statsByDateModel()['2026-05-01']?.['openai/gpt-4.1'],
    ).toMatchObject({ total: 21 })
    expect(tracker.statsByHour()['10']).toMatchObject({ calls: 2, total: 21 })
    expect(tracker.streakMetrics()).toMatchObject({
      active_days: 2,
      current_streak: 0,
      longest_streak: 2,
    })
    expect(tracker.sessionCount()).toBe(2)
  })

  it('should_compact triggers at 0.7 threshold', () => {
    const root = tmp('emperor-token-compact-')
    const tracker = new TokenTracker(join(root, 'tokens.jsonl'))
    tracker.record('m', { input: 100 })
    expect(tracker.shouldCompact(100, 0.7)).toBe(true) // 100 > 70
    expect(tracker.shouldCompact(200, 0.7)).toBe(false) // 100 < 140
  })

  it('archives old hot rows by month while aggregate stats still include archived history', () => {
    const root = tmp('emperor-token-archive-')
    const logFile = join(root, 'tokens.jsonl')
    mkdirSync(root, { recursive: true })
    const rows = [
      {
        ts: '2026-04-01T10:00:00',
        provider: 'openai',
        model: 'gpt-4.1',
        input: 10,
        output: 1,
      },
      {
        ts: '2026-04-02T10:00:00',
        provider: 'openai',
        model: 'gpt-4.1',
        input: 20,
        output: 2,
      },
      {
        ts: '2026-05-01T10:00:00',
        provider: 'anthropic',
        model: 'claude',
        input: 30,
        output: 3,
      },
      {
        ts: '2026-05-02T10:00:00',
        provider: 'anthropic',
        model: 'claude',
        input: 40,
        output: 4,
      },
    ]
    writeFileSync(
      logFile,
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    )

    const tracker = new TokenTracker(logFile, { maxHotRows: 2 })

    expect(readFileSync(logFile, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(readdirSync(join(root, 'tokens_archive'))).toEqual([
      '2026-04.jsonl.gz',
    ])
    const archived = gunzipSync(
      readFileSync(join(root, 'tokens_archive', '2026-04.jsonl.gz')),
    ).toString('utf8')
    expect(archived).toContain('"input":10')
    expect(archived).toContain('"input":20')
    expect(tracker.totals()).toMatchObject({
      calls: 4,
      input: 100,
      output: 10,
      total: 110,
    })
    expect(tracker.statsByProviderModel()['openai/gpt-4.1']).toMatchObject({
      calls: 2,
      total: 33,
    })
    expect(tracker.recentCalls(3).map((row) => row.input)).toEqual([40, 30, 20])
  })
})
