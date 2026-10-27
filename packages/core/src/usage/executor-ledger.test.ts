// SET-01: a settled Claude Code or Codex run becomes one ledger row under
// the root session, filed by backend; a subscription run at no cost.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DelegationOwner } from '../harness/delegation/types'
import { TokenTracker } from '../memory/token-tracker'
import { recordExecutorSpend } from './executor-ledger'

const owner = { rootSessionId: 's-build' } as DelegationOwner
function tracker(): { tracker: TokenTracker; file: string } {
  const file = join(
    mkdtempSync(join(tmpdir(), 'emperor-executor-ledger-')),
    'tokens.jsonl',
  )
  return { tracker: new TokenTracker(file), file }
}
const lastRow = (file: string) =>
  JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)!)

describe('recordExecutorSpend', () => {
  it('writes an API run with its cost under the root session and backend', () => {
    const { tracker: t, file } = tracker()
    recordExecutorSpend(t, {
      owner,
      backend: 'claude-code',
      usage: {
        billing: 'api',
        inputTokens: 100,
        cacheReadTokens: 400,
        outputTokens: 50,
        totalTokens: 550,
        estimatedUsd: 0.25,
      },
    })
    expect(lastRow(file)).toMatchObject({
      provider: 'claude-code',
      model: 'claude-code',
      usage_type: 'executor',
      session_id: 's-build',
      source: 'claude-code',
      input: 100,
      cache_read: 400,
      output: 50,
      cost_usd_nanos: 250_000_000,
      cost_complete: true,
    })
  })

  it('keeps the ledger total equal to the run’s (reasoning is inside output)', () => {
    const { tracker: t } = tracker()
    recordExecutorSpend(t, {
      owner,
      backend: 'codex',
      usage: {
        billing: 'api',
        inputTokens: 10,
        outputTokens: 30,
        reasoningTokens: 20,
        totalTokens: 40,
        estimatedUsd: 0.01,
      },
    })
    expect(t.recentCalls(1)[0]).toMatchObject({ total: 40 })
  })

  it('records a subscription run’s tokens at no cost', () => {
    const { tracker: t, file } = tracker()
    recordExecutorSpend(t, {
      owner,
      backend: 'codex',
      usage: {
        billing: 'subscription',
        inputTokens: 5,
        outputTokens: 5,
        nominalUsd: 3,
      },
    })
    expect(lastRow(file)).toMatchObject({
      subscription: true,
      cost_usd_nanos: 0,
      source: 'codex',
    })
  })

  it('marks an API run without a price as cost unknown', () => {
    const { tracker: t, file } = tracker()
    recordExecutorSpend(t, {
      owner,
      backend: 'codex',
      usage: { billing: 'api', inputTokens: 5, outputTokens: 5 },
    })
    const row = lastRow(file)
    expect(row.cost_complete).toBe(false)
    expect(row.cost_usd_nanos).toBeUndefined()
  })

  it('names the model a run switched to', () => {
    const { tracker: t } = tracker()
    recordExecutorSpend(t, {
      owner,
      backend: 'codex',
      model: 'gpt-5.1-codex',
      usage: { billing: 'api', inputTokens: 1, outputTokens: 1 },
    })
    expect(t.recentCalls(1)[0]).toMatchObject({ model: 'gpt-5.1-codex' })
  })
})
