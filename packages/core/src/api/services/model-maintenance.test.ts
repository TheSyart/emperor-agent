// MOD-05 (PLAN-V020): what Settings › 模型 needs to look after saved
// models — the catalog's lifecycle on every entry, replacing a retired model
// in place of its references, the last connection test of each entry, and
// single-entry saves that carry the temperature and the fields the user set.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LlmClient } from '../../llm/client'
import { ScriptedAdapter } from '../../harness/testing'
import { CoreModelService } from './model-service'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-model-maintenance-'))
}

function setup(
  root = tmp(),
  adapter: () => ScriptedAdapter = () => new ScriptedAdapter([]),
) {
  const refreshModelConfig = vi.fn()
  const service = new CoreModelService(root, {
    createLlm: (images) =>
      new LlmClient({ adapterFor: () => adapter(), images }),
    refreshModelConfig,
  })
  return { root, service, refreshModelConfig }
}

function disk(root: string) {
  return JSON.parse(readFileSync(join(root, 'model_config.json'), 'utf8'))
}

/** A DeepSeek connection with the retired chat model active and a backup. */
function writeRetired(root: string, extra: Record<string, unknown> = {}) {
  const base = {
    provider: 'deepseek',
    protocol: 'openai',
    apiBase: 'https://api.deepseek.com',
    apiKey: 'sk-deepseek-old',
    connectionId: 'conn-ds',
    reasoningEffort: null,
  }
  writeFileSync(
    join(root, 'model_config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeModelId: 'chat',
      models: [
        {
          ...base,
          entryId: 'chat',
          modelId: 'deepseek-chat',
          displayName: '我的 DeepSeek',
          contextWindowTokens: 64_000,
          maxTokens: 6_000,
          metadata: {
            source: 'catalog',
            userLocked: ['displayName', 'maxTokens'],
          },
          ...extra,
        },
        {
          ...base,
          entryId: 'pro',
          modelId: 'deepseek-v4-pro',
          contextWindowTokens: 1_000_000,
          maxTokens: 32_000,
        },
      ],
      policy: {
        fallback: { enabled: true, entryId: 'pro', triggerOn: ['rate_limit'] },
        cost: { maxUsdPerAgentTurn: null },
      },
    }),
  )
}

describe('entry lifecycle from the catalog', () => {
  it('marks a retired model with its replacement, a current one with nothing', async () => {
    const f = setup()
    writeRetired(f.root)
    const config = await f.service.getConfig()
    const chat = config.models.find((entry) => entry.entryId === 'chat')!
    expect(chat.lifecycle).toMatchObject({
      status: 'retired',
      replacement: 'deepseek-flash',
    })
    const pro = config.models.find((entry) => entry.entryId === 'pro')!
    expect(pro.lifecycle?.status ?? 'active').toBe('active')
  })
})

describe('model.replaceEntry', () => {
  it('replaces a retired model, keeps what the user set and moves its references (MOD-05 4)', async () => {
    const f = setup()
    writeRetired(f.root, {
      sampling: { temperature: 0.3 },
    })
    // The backup points at the retired one too.
    const raw = disk(f.root)
    raw.activeModelId = 'pro'
    raw.policy.fallback.entryId = 'chat'
    writeFileSync(join(f.root, 'model_config.json'), JSON.stringify(raw))

    const result = await f.service.replaceEntry({
      entryId: 'chat',
      modelId: 'deepseek-flash',
    })
    const next = result.models.find(
      (entry) => entry.entryId === result.replacedEntryId,
    )!
    expect(result.replacedEntryId).not.toBe('chat')
    expect(next.modelId).toBe('deepseek-flash')
    // Locked: kept. Not locked: the new model's catalog facts.
    expect(next.displayName).toBe('我的 DeepSeek')
    expect(next.maxTokens).toBe(6_000)
    expect(next.contextWindowTokens).toBe(1_048_576)
    expect(next.sampling).toEqual({ temperature: 0.3 })
    // Same connection and key, same place in the list.
    const saved = disk(f.root)
    expect(saved.models.map((m: { modelId: string }) => m.modelId)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
    expect(saved.models[0].connectionId).toBe('conn-ds')
    expect(saved.models[0].apiKey).toBe(saved.models[1].apiKey)
    expect(saved.policy.fallback.entryId).toBe(result.replacedEntryId)
    expect(result.models.some((entry) => entry.entryId === 'chat')).toBe(false)
    expect(f.refreshModelConfig).toHaveBeenCalledOnce()
  })

  it('moves the active model to the replacement', async () => {
    const f = setup()
    writeRetired(f.root)
    const result = await f.service.replaceEntry({
      entryId: 'chat',
      modelId: 'deepseek-flash',
    })
    expect(result.activeModelId).toBe(result.replacedEntryId)
    expect(disk(f.root).activeModelId).toBe(result.replacedEntryId)
  })

  it('refuses a replacement that is already saved on the connection, or an unknown entry', async () => {
    const f = setup()
    writeRetired(f.root)
    await expect(
      f.service.replaceEntry({ entryId: 'chat', modelId: 'deepseek-v4-pro' }),
    ).rejects.toThrow('已经添加')
    await expect(
      f.service.replaceEntry({ entryId: 'nope', modelId: 'deepseek-flash' }),
    ).rejects.toThrow()
    expect(disk(f.root).models[0].modelId).toBe('deepseek-chat')
  })
})

describe('the last connection test of an entry', () => {
  it('is kept with the entry, and a rejected key reads as auth', async () => {
    const root = tmp()
    let fail = true
    const f = setup(
      root,
      () =>
        new ScriptedAdapter([
          fail ? { error: '401 Unauthorized', code: 'AUTH' } : { text: 'pong' },
        ]),
    )
    writeRetired(root)
    const failed = await f.service.test({ entryId: 'pro', kind: 'text' })
    expect(failed.ok).toBe(false)
    let pro = (await f.service.getConfig()).models.find(
      (entry) => entry.entryId === 'pro',
    )!
    expect(pro.lastTest).toMatchObject({ ok: false, failure: 'auth' })
    expect(Date.parse(pro.lastTest!.testedAt)).toBeGreaterThan(0)

    fail = false
    await f.service.test({ entryId: 'pro', kind: 'text' })
    // A new service (restart) still knows it.
    const again = setup(root)
    pro = (await again.service.getConfig()).models.find(
      (entry) => entry.entryId === 'pro',
    )!
    expect(pro.lastTest).toMatchObject({ ok: true })
    expect(pro.lastTest?.failure).toBeUndefined()
    const chat = (await again.service.getConfig()).models.find(
      (entry) => entry.entryId === 'chat',
    )!
    expect(chat.lastTest).toBeUndefined()
  })
})

describe('model.saveEntry from the simplified editor', () => {
  it('saves the temperature and locks the fields the user changed', async () => {
    const f = setup()
    writeRetired(f.root)
    await f.service.saveEntry({
      entryId: 'pro',
      contextWindowTokens: 200_000,
      sampling: { temperature: 0.7 },
      lockFields: ['contextWindowTokens'],
    })
    let saved = disk(f.root).models[1]
    expect(saved.contextWindowTokens).toBe(200_000)
    expect(saved.sampling).toEqual({ temperature: 0.7 })
    expect(saved.metadata?.userLocked ?? []).toContain('contextWindowTokens')
    // The key and the connection stay as they were.
    expect(saved.connectionId).toBe('conn-ds')
    expect(saved.apiBase).toBe('https://api.deepseek.com')

    await f.service.saveEntry({
      entryId: 'pro',
      sampling: { temperature: null },
    })
    saved = disk(f.root).models[1]
    expect(saved.sampling?.temperature).toBeUndefined()
  })
})
