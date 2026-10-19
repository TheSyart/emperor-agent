// CORE-18: every model call lands in the token ledger with disjoint
// counts, its provider and its cost, so the usage page's hit rate is the
// provider's own.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replyChunks } from '../harness/testing'
import { calculateUsageCost } from '../model/execution-policy'
import type { CoreApi } from './core-api'
import { makeApi, tmp } from './test-helpers'

const apis: CoreApi[] = []

const PRICING = {
  inputUsdPerMillionTokens: 0.28,
  outputUsdPerMillionTokens: 0.42,
  cacheReadUsdPerMillionTokens: 0.028,
  cacheWriteUsdPerMillionTokens: 0,
}

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

function modelConfig(stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true })
  writeFileSync(
    join(stateRoot, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'test-route',
      models: [
        {
          entryId: 'test-route',
          provider: 'deepseek',
          protocol: 'openai',
          modelId: 'test-model',
          displayName: 'Test',
          apiBase: 'https://api.deepseek.com',
          apiKey: null,
          contextWindowTokens: 100000,
          maxTokens: 4096,
          pricing: PRICING,
        },
      ],
    }),
  )
}

describe('token ledger (KRN-05 #10)', () => {
  it('records cache reads, so the usage hit rate matches the provider', async () => {
    const root = tmp('emperor-token-ledger-')
    const stateRoot = join(root, 'home')
    modelConfig(stateRoot)
    const usage = {
      inputTokens: 200,
      cacheReadTokens: 800,
      outputTokens: 50,
      reasoningTokens: 10,
    }
    const { api } = await makeApi({
      root,
      stateRoot,
      replies: [() => replyChunks({ text: 'cached answer', usage })],
    })
    apis.push(api)
    const sessionId = String(api.sessions.create({ title: 'Chat' }).id)
    await api.chat.submit({ content: 'hi', sessionId })

    const stats = api.memory.tokens({ sessionId }) as {
      totals: Record<string, number>
      recentCalls: Array<Record<string, unknown>>
    }
    const row = stats.recentCalls.find(
      (call) => call.usage_type === 'main_agent',
    )!
    expect(row).toMatchObject({
      provider: 'deepseek',
      model: 'test-model',
      model_entry_id: 'test-route',
      input: 200,
      cache_read: 800,
      cache_create: 0,
      output: 40,
      reasoning: 10,
      total: 1050,
      // Output and reasoning both bill at the output price.
      cost_usd_nanos: calculateUsageCost(
        { input: 200, output: 50, cache_read: 800, cache_create: 0 },
        PRICING,
      ).costUsdNanos,
      cost_complete: true,
    })
    // The usage page: cache_read / (cache_read + input + cache_create).
    const totals = stats.totals
    const pageHitRate =
      totals.cache_read! /
      (totals.cache_read! + totals.input! + totals.cache_create!)
    const providerHitRate =
      usage.cacheReadTokens / (usage.cacheReadTokens + usage.inputTokens)
    expect(pageHitRate).toBeCloseTo(providerHitRate, 10)
    expect(pageHitRate).toBeCloseTo(0.8, 10)
  })
})
