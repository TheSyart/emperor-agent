// MOD-03 (PLAN-V020): batch save, connection-level updates, metadata
// refresh and default lookup on the model service.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LlmClient } from '../../llm/client'
import { ScriptedAdapter } from '../../harness/testing'
import { createNodePersistenceAdapter } from '../../store/persistence'
import { CoreModelService } from './model-service'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-model-batch-'))
}

const connection = {
  provider: 'openai',
  protocol: 'openai' as const,
  apiBase: 'https://api.openai.com/v1',
  apiKey: 'sk-batch-1',
}

function draft(modelId: string, extra: Record<string, unknown> = {}) {
  return {
    modelId,
    contextWindowTokens: 128_000,
    maxTokens: 16_000,
    reasoningEffort: null,
    ...extra,
  }
}

function setup(root = tmp()) {
  const writes: string[] = []
  const refreshModelConfig = vi.fn()
  const service = new CoreModelService(root, {
    createLlm: (images) =>
      new LlmClient({ adapterFor: () => new ScriptedAdapter([]), images }),
    refreshModelConfig,
    persistenceAdapter: createNodePersistenceAdapter({
      beforeOperation: (operation, path) => {
        if (operation === 'rename' && path.includes('model_config.json'))
          writes.push(path)
      },
    }),
  })
  return { root, service, writes, refreshModelConfig }
}

function disk(root: string) {
  return JSON.parse(readFileSync(join(root, 'model_config.json'), 'utf8'))
}

describe('model.saveEntries', () => {
  it('saves five entries with one write and one refresh (1)', async () => {
    const f = setup()
    await f.service.getConfig()
    f.writes.length = 0
    const result = await f.service.saveEntries({
      connection,
      entries: ['a', 'b', 'c', 'd', 'e'].map((id) => draft(`gpt-${id}`)),
    })
    expect(f.writes).toHaveLength(1)
    expect(f.refreshModelConfig).toHaveBeenCalledOnce()
    expect(result.savedEntryIds).toHaveLength(5)
    const models = disk(f.root).models
    expect(models).toHaveLength(5)
    // One connection: every entry shares its id, and the key is sealed or kept.
    expect(
      new Set(models.map((m: { connectionId: string }) => m.connectionId)).size,
    ).toBe(1)
    expect(result.models.every((m) => m.apiKey !== 'sk-batch-1')).toBe(true)
  })

  it('writes nothing when the third entry is invalid (2)', async () => {
    const f = setup()
    await f.service.saveEntries({ connection, entries: [draft('gpt-keep')] })
    const before = readFileSync(join(f.root, 'model_config.json'), 'utf8')
    f.writes.length = 0
    await expect(
      f.service.saveEntries({
        connection,
        entries: [
          draft('gpt-1'),
          draft('gpt-2'),
          draft('gpt-3', { maxTokens: 0 }),
          draft('gpt-4'),
        ],
      }),
    ).rejects.toThrow(/第 3 个|maxTokens/)
    expect(f.writes).toHaveLength(0)
    expect(readFileSync(join(f.root, 'model_config.json'), 'utf8')).toBe(before)
  })

  it('activates the entry it was asked to', async () => {
    const f = setup()
    const result = await f.service.saveEntries({
      connection,
      entries: [draft('gpt-1', { entryId: 'pick-me' }), draft('gpt-2')],
      activateEntryId: 'pick-me',
    })
    expect(result.activeModelId).toBe('pick-me')
  })

  it('lets a saved entry with a rejected entry id replace it (9, repair)', async () => {
    const root = tmp()
    writeFileSync(
      join(root, 'model_config.json'),
      JSON.stringify({
        schemaVersion: 2,
        activeModelId: null,
        models: [
          {
            entryId: 'broken',
            provider: 'openai',
            protocol: 'carrier-pigeon',
            modelId: 'gpt-5.2',
          },
        ],
      }),
    )
    const f = setup(root)
    expect((await f.service.getConfig()).rejectedEntries).toHaveLength(1)
    await f.service.saveEntries({
      connection,
      entries: [draft('gpt-5.2', { entryId: 'broken' })],
    })
    const config = await f.service.getConfig()
    expect(config.rejectedEntries).toEqual([])
    expect(config.models.map((m) => m.entryId)).toEqual(['broken'])
  })
})

describe('model.updateConnection', () => {
  it('changes the key of every entry on the connection and counts them (3)', async () => {
    const f = setup()
    const saved = await f.service.saveEntries({
      connection,
      entries: ['a', 'b', 'c', 'd', 'e'].map((id) => draft(`gpt-${id}`)),
    })
    // An entry on another connection is left alone.
    await f.service.saveEntries({
      connection: { ...connection, apiBase: 'https://proxy.example.com/v1' },
      entries: [draft('gpt-other')],
    })
    f.writes.length = 0
    const result = await f.service.updateConnection({
      entryId: saved.savedEntryIds[2]!,
      apiKey: 'sk-rotated',
    })
    expect(result.updated).toBe(5)
    expect(f.writes).toHaveLength(1)
    const keys = await f.service.connectionKeysForTest()
    expect(keys.filter((key) => key === 'sk-rotated')).toHaveLength(5)
    expect(keys.filter((key) => key === 'sk-batch-1')).toHaveLength(1)
  })

  it('groups entries without a connection id by provider, protocol and address', async () => {
    const root = tmp()
    const base = {
      provider: 'openai',
      protocol: 'openai',
      apiBase: 'https://api.openai.com/v1/',
      apiKey: 'sk-old',
      contextWindowTokens: 1000,
      maxTokens: 100,
      reasoningEffort: null,
    }
    writeFileSync(
      join(root, 'model_config.json'),
      JSON.stringify({
        schemaVersion: 2,
        activeModelId: 'x1',
        models: [
          { ...base, entryId: 'x1', modelId: 'gpt-a' },
          {
            ...base,
            entryId: 'x2',
            modelId: 'gpt-b',
            apiBase: 'https://api.openai.com/v1',
          },
          {
            ...base,
            entryId: 'x3',
            modelId: 'gpt-c',
            apiBase: 'https://elsewhere.example.com/v1',
          },
        ],
      }),
    )
    const f = setup(root)
    const result = await f.service.updateConnection({
      entryId: 'x1',
      apiKey: 'sk-new',
    })
    expect(result.updated).toBe(2)
  })
})

describe('deleting the active entry (4)', () => {
  it('is refused while activeModelId points at it', async () => {
    const f = setup()
    const saved = await f.service.saveEntries({
      connection,
      entries: [draft('gpt-1'), draft('gpt-2')],
      activateEntryId: undefined,
    })
    const active = (await f.service.getConfig()).activeModelId!
    expect(saved.savedEntryIds).toContain(active)
    await expect(f.service.deleteEntry(active)).rejects.toThrow(/正在使用/)
    const other = saved.savedEntryIds.find((id) => id !== active)!
    await expect(f.service.deleteEntry(other)).resolves.toBeTruthy()
  })
})

describe('model.refreshMetadata (5)', () => {
  it('reports differences from the catalog, never for locked fields', async () => {
    const f = setup()
    const saved = await f.service.saveEntries({
      connection: {
        provider: 'deepseek',
        protocol: 'openai',
        apiBase: 'https://api.deepseek.com',
        apiKey: 'sk-ds',
      },
      entries: [
        draft('deepseek-flash', {
          contextWindowTokens: 64_000,
          maxTokens: 8_000,
          metadata: { source: 'manual', userLocked: ['contextWindowTokens'] },
        }),
      ],
    })
    const id = saved.savedEntryIds[0]!
    const preview = await f.service.refreshMetadata({ entryIds: [id] })
    const fields = preview.diffs[0]!.changes.map((change) => change.field)
    expect(fields).toContain('maxTokens')
    expect(fields).not.toContain('contextWindowTokens')
    expect(preview.applied).toBe(false)
    const applied = await f.service.refreshMetadata({
      entryIds: [id],
      apply: true,
    })
    expect(applied.applied).toBe(true)
    const entry = (await f.service.getConfig()).models.find(
      (m) => m.entryId === id,
    )!
    expect(entry.contextWindowTokens).toBe(64_000)
    expect(entry.maxTokens).toBe(393_216)
    expect(entry.metadata?.source).toBe('catalog')
    expect(entry.metadata?.userLocked).toEqual(['contextWindowTokens'])
  })
})

describe('concurrent saves (10)', () => {
  it('keeps both of two saves started at once', async () => {
    const f = setup()
    await Promise.all([
      f.service.saveEntries({ connection, entries: [draft('gpt-left')] }),
      f.service.saveEntries({ connection, entries: [draft('gpt-right')] }),
    ])
    const ids = (await f.service.getConfig()).models.map((m) => m.modelId)
    expect(ids.sort()).toEqual(['gpt-left', 'gpt-right'])
  })
})

describe('model.lookupDefaults (12)', () => {
  it('returns catalog facts and where they came from', () => {
    const f = setup()
    const result = f.service.lookupDefaults({
      provider: 'deepseek',
      protocol: 'openai',
      apiBase: 'https://api.deepseek.com',
      modelId: 'deepseek-flash',
    })
    expect(result.facts.contextWindowTokens).toBe(1_048_576)
    expect(result.source).toBe('catalog')
    const unknown = f.service.lookupDefaults({
      provider: 'custom',
      protocol: 'openai',
      apiBase: 'https://llm.example.com/v1',
      modelId: 'zz-unknown-9000',
    })
    expect(unknown.source).toBe('fallback')
  })
})
