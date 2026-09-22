import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TokenTracker } from '../memory/token-tracker'
import { LlmClient } from '../llm/client'
import { ScriptedAdapter, testRoute } from '../harness/testing'
import { parseWatchlistDecision, WatchlistDecision } from './models'
import { WatchlistService } from './service'
import { WatchlistStore } from './store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('WatchlistStore', () => {
  it('creates default watchlist, extracts active items, and writes last decision', () => {
    const root = tmp('emperor-watchlist-store-')
    const store = new WatchlistStore(root)
    expect(existsSync(store.path)).toBe(true)
    store.write(`# Watchlist

- [ ] 检查项目 A
- 示例：跳过
<!-- - hidden -->
- 跟进 PR
plain text
`)
    expect(store.activeItems()).toEqual(['检查项目 A', '跟进 PR'])
    store.writeDecision(
      new WatchlistDecision({
        action: 'run',
        reason: 'timely',
        message: 'Do it',
        checked_at: 10,
      }),
    )
    expect(store.payload().lastDecision).toMatchObject({
      action: 'run',
      message: 'Do it',
    })

    writeFileSync(store.statePath, '{bad', 'utf8')
    expect(store.readState()).toEqual({})
    // 审计 P1-5：损坏状态文件应先隔离备份，不能静默丢弃。
    const dir = join(root, 'memory')
    expect(
      readdirSync(dir).some((f) =>
        f.startsWith('watchlist_state.json.corrupt-'),
      ),
    ).toBe(true)
  })
})

describe('WatchlistDecision and service', () => {
  it('parses strict or fenced JSON decisions and validates run messages', () => {
    expect(
      parseWatchlistDecision(
        'prefix {"action":"run","reason":" now ","message":" ping user "} suffix',
      ).toDict(),
    ).toMatchObject({
      action: 'run',
      reason: 'now',
      message: 'ping user',
    })
    expect(
      parseWatchlistDecision('{"action":"run","reason":"missing"}').action,
    ).toBe('skip')
    expect(parseWatchlistDecision('not json').reason).toBe(
      'watchlist model returned non-JSON decision',
    )
  })

  it('skips empty lists and uses injected decider for active items', async () => {
    const root = tmp('emperor-watchlist-service-')
    const service = new WatchlistService(root)
    expect((await service.check()).reason).toBe('watchlist has no active items')

    service.write('- Review dashboard alerts')
    service.decider = (_content, items) =>
      new WatchlistDecision({
        action: 'run',
        reason: items[0],
        message: 'Check alerts',
      })
    const decision = await service.check()
    expect(decision.action).toBe('run')
    expect(decision.message).toBe('Check alerts')
    expect(
      JSON.parse(
        readFileSync(join(root, 'memory', 'watchlist_state.json'), 'utf8'),
      ).lastDecision.action,
    ).toBe('run')
  })

  it('uses the active model once and records model_entry_id', async () => {
    const root = tmp('emperor-watchlist-model-')
    const tracker = new TokenTracker(join(root, 'memory', 'token_ledger.jsonl'))
    const service = new WatchlistService(root, {
      llm: fakeLlm(),
      tokenTracker: tracker,
    })
    service.write('- Check incident queue')

    const decision = await service.check()
    expect(decision.action).toBe('run')
    expect(decision.model).toBe('active-model')
    expect(decision.model_entry_id).toBe('active-entry')
    expect(decision.provider).toBe('active-entry')
    expect(decision.model_role).toBeNull()
    const ledger = readFileSync(tracker.logFile, 'utf8')
    expect(ledger).toContain('"usage_type":"watchlist_check"')
    expect(ledger).toContain('"model_entry_id":"active-entry"')
    expect(ledger).not.toContain('"used_fallback"')
  })
})

function fakeLlm(): LlmClient {
  const adapter = new ScriptedAdapter([
    {
      text: '{"action":"run","reason":"timely","message":"Check incident queue"}',
    },
  ])
  const llm = new LlmClient({ adapterFor: () => adapter })
  llm.setRoutes(
    [testRoute({ id: 'active-entry', modelId: 'active-model' })],
    'active-entry',
  )
  return llm
}
