/**
 * TokenTracker 内存缓存回归测试 (audit P1-4)。
 * 审计发现：token_usage 日志永久追加、无归档，每次 stats 查询（totals/statsByDate/...）
 * 都要重新读盘+全量解析。归档能力由 compactor-token.test 覆盖；这里专门验证同一进程内
 * 多次查询复用已解析行，只有 record() 写入新行时才增量更新缓存。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const readCalls: string[] = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (
      path: Parameters<typeof actual.readFileSync>[0],
      ...rest: unknown[]
    ) => {
      readCalls.push(String(path))
      // @ts-expect-error -- forwarding varargs to the real implementation
      return actual.readFileSync(path, ...rest)
    },
  }
})

import { TokenTracker } from './token-tracker'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

beforeEach(() => {
  readCalls.length = 0
})

describe('TokenTracker read cache (audit P1-4)', () => {
  it('does not re-read the log file from disk on repeated stats queries', () => {
    const logFile = join(tmp('emperor-token-cache-'), 'tokens.jsonl')
    const tracker = new TokenTracker(logFile)
    tracker.record('gpt', { input: 10, output: 5 })
    tracker.record('gpt', { input: 20, output: 8 })

    readCalls.length = 0 // 只统计 record() 之后、稳定态下的查询开销
    tracker.totals()
    tracker.statsByDate()
    tracker.statsByModel()
    tracker.recentCalls()

    expect(readCalls.filter((p) => p === logFile)).toHaveLength(0)
  })

  it('reflects a new record() immediately without a stale cache', () => {
    const logFile = join(tmp('emperor-token-cache-'), 'tokens.jsonl')
    const tracker = new TokenTracker(logFile)
    tracker.record('gpt', { input: 10, output: 5 })
    expect(tracker.totals().calls).toBe(1)

    tracker.record('gpt', { input: 20, output: 8 })
    expect(tracker.totals().calls).toBe(2)
    expect(tracker.totals().input).toBe(30)
  })
})
