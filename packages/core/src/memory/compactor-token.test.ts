/**
 * Compactor + TokenTracker 契约 (MIG-MEM-003/004)。
 * 移植 Python tests/unit/test_compactor.py + tests/unit/test_token_usage.py (tracker 部分)。
 */
import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { Compactor } from './compactor'
import { MemoryStore } from './store'
import { TokenTracker } from './token-tracker'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const VALID_COMPACTION = `
<episode>
## 12:00 测试压缩
- 已整理旧对话。
</episode>
<updated_memory>
# 长期记忆

已更新。
</updated_memory>
<updated_user>
# 用户偏好

保持简洁。
</updated_user>
`

function resp(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input: 3, output: 2 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

class QueueProvider extends LLMProvider {
  responses: Array<string | Error>
  prompts: string[] = []
  constructor(responses: Array<string | Error>) {
    super({ defaultModel: 'fake-model' })
    this.responses = responses
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.prompts.push(
      String((args.messages[0] as Record<string, unknown>).content),
    )
    const item = this.responses.shift()!
    if (item instanceof Error) throw item
    return resp(item)
  }
}

function makeMemory(root: string): MemoryStore {
  const userFile = join(root, 'templates', 'USER.local.md')
  mkdirSync(join(root, 'templates'), { recursive: true })
  writeFileSync(userFile, '# 用户偏好\n\n原始。\n', 'utf8')
  const store = new MemoryStore(join(root, 'memory'), userFile)
  store.writeMemory('# 长期记忆\n\n原始。\n')
  return store
}

function makeHistory(size = 12): Array<Record<string, unknown>> {
  return Array.from({ length: size }, (_, idx) => ({
    role: 'user',
    content: `turn ${idx}`,
  }))
}

// ── test_compactor.py ──

describe('Compactor (test_compactor.py)', () => {
  it('repairs missing xml tags before writing', async () => {
    const root = tmp('emperor-compact-repair-')
    const provider = new QueueProvider([
      '<episode>only episode</episode><updated_memory>new</updated_memory>',
      VALID_COMPACTION,
    ])
    const tracker = new TokenTracker(join(root, 'memory', 'tokens.jsonl'))
    const store = makeMemory(root)
    const compactor = new Compactor({
      provider,
      model: 'fake-model',
      memoryStore: store,
      docsDir: TEMPLATES_DIR,
      tokenTracker: tracker,
    })

    const recent = await compactor.compactAsync(makeHistory())
    expect(recent.length).toBe(Compactor.K)
    expect(provider.prompts.length).toBe(2)
    expect(provider.prompts[1]).toContain('Invalid response')
    expect(store.readMemory()).toContain('已更新')
    expect(store.readUser()).toContain('保持简洁')
    expect(store.readTodayEpisode()).toContain('测试压缩')
    const rows = readFileSync(join(root, 'memory', 'tokens.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(rows[rows.length - 1].route_reason).toBe('memory_compaction')
    expect(rows[rows.length - 1].estimated_input_tokens).toBeGreaterThan(0)
  })

  it('preserves memory when repair still invalid', async () => {
    const root = tmp('emperor-compact-fail-')
    const provider = new QueueProvider([
      '<episode>only episode</episode>',
      '<updated_memory>missing other tags</updated_memory>',
    ])
    const store = makeMemory(root)
    const compactor = new Compactor({
      provider,
      model: 'fake-model',
      memoryStore: store,
      docsDir: TEMPLATES_DIR,
    })
    const history = makeHistory()

    const result = await compactor.compactAsync(history)
    expect(result).toEqual(history)
    expect(store.readMemory()).toContain('原始')
    expect(store.readUser()).toContain('原始')
    const diagnostics = join(store.memoryDir, 'compact_diagnostics.jsonl')
    expect(existsSync(diagnostics)).toBe(true)
    const payload = JSON.parse(
      readFileSync(diagnostics, 'utf8').trim().split('\n').pop()!,
    )
    expect(payload.event).toBe('compact_parse_failed')
    expect(payload.missing_tags).toContain('episode')
  })

  it('prompt includes runtime context attachment', async () => {
    const root = tmp('emperor-compact-rt-')
    const provider = new QueueProvider([VALID_COMPACTION])
    const store = makeMemory(root)
    const compactor = new Compactor({
      provider,
      model: 'fake-model',
      memoryStore: store,
      docsDir: TEMPLATES_DIR,
      runtimeContextProvider: () => ({
        role: 'system',
        content: '[PLAN_RUNTIME_CONTEXT]\nplan_id: plan_1\nactive_step: step_1',
      }),
    })
    await compactor.compactAsync(makeHistory())
    expect(provider.prompts[0]).toContain('[PLAN_RUNTIME_CONTEXT]')
    expect(provider.prompts[0]).toContain('plan_id: plan_1')
  })

  it('caps long user and assistant text before sending the compaction prompt', async () => {
    const root = tmp('emperor-compact-long-text-')
    const provider = new QueueProvider([VALID_COMPACTION])
    const store = makeMemory(root)
    const longUser = `BEGIN_USER_${'u'.repeat(30_000)}_END_USER`
    const longAssistant = `BEGIN_ASSISTANT_${'a'.repeat(30_000)}_END_ASSISTANT`
    const history = [
      { role: 'user', content: longUser },
      { role: 'assistant', content: longAssistant },
      ...makeHistory(Compactor.K),
    ]
    const compactor = new Compactor({
      provider,
      model: 'fake-model',
      memoryStore: store,
      docsDir: TEMPLATES_DIR,
    })

    await compactor.compactAsync(history)

    const prompt = provider.prompts[0]!
    expect(prompt).toContain('BEGIN_USER_')
    expect(prompt).toContain('BEGIN_ASSISTANT_')
    expect(prompt).toContain('[truncated')
    expect(prompt).not.toContain('_END_USER')
    expect(prompt).not.toContain('_END_ASSISTANT')
    expect(prompt.length).toBeLessThan(25_000)
  })
})

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
      model_role: 'unknown',
      usage_type: 'main_agent',
      input: 7,
      output: 1,
      cache_read: 3,
      cache_create: 0,
      total: 11,
    })
    expect(tracker.recentCacheCalls().map((r) => r.model)).toEqual(['claude'])
  })

  it('records route observability fields', () => {
    const root = tmp('emperor-token-route-')
    const tracker = new TokenTracker(join(root, 'tokens.jsonl'))
    tracker.record(
      'cheap',
      { input: 5, output: 2 },
      {
        provider: 'fake',
        usageType: 'subagent:sili_suitang',
        modelRole: 'secondary',
        routeReason: 'subagent:sili_suitang:lightweight',
        usedFallback: true,
        fallbackReason: 'secondary down',
        estimatedInputTokens: 42,
        routeEstimatedTokens: 9,
      },
    )
    const row = tracker.recentCalls(1)[0]!
    expect(row.route_reason).toBe('subagent:sili_suitang:lightweight')
    expect(row.used_fallback).toBe(true)
    expect(row.fallback_reason).toBe('secondary down')
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
