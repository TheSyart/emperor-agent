import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import {
  activateModelEntry,
  activeEntry,
  defaultModelConfig,
  deleteModelEntry,
  findEntry,
  loadModelConfig,
  maskSecret,
  parseModelConfig,
  saveModelConfig,
  saveModelEntry,
  validateCompleteModelEntries,
  type ModelConfigV2,
} from './model-config'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'emperor-mc-v2-'))
})

const entry = (
  overrides: Partial<ModelConfigV2['models'][number]> = {},
): ModelConfigV2['models'][number] => ({
  entryId: 'entry-openai',
  provider: 'openai',
  protocol: 'openai',
  modelId: 'gpt-5',
  displayName: 'GPT-5',
  apiBase: 'https://api.openai.com/v1',
  apiKey: 'sk-secret',
  contextWindowTokens: 128_000,
  maxTokens: 8_192,
  reasoningEffort: 'medium',
  ...overrides,
})

describe('model_config v2 schema', () => {
  it('uses an empty single-active-model v2 document by default', () => {
    expect(defaultModelConfig()).toEqual({
      schemaVersion: 2,
      activeModelId: null,
      models: [],
    })
  })

  it('normalizes v2 entries and resolves the single active entry', () => {
    const config = parseModelConfig({
      schemaVersion: 2,
      activeModelId: ' entry-openai ',
      models: [
        entry({ modelId: ' gpt-5 ', apiBase: ' https://api.openai.com/v1 ' }),
      ],
    })

    expect(config.raw).toEqual({
      schemaVersion: 2,
      activeModelId: 'entry-openai',
      models: [entry()],
    })
    expect(activeEntry(config)?.modelId).toBe('gpt-5')
    expect(findEntry(config, 'entry-openai')?.displayName).toBe('GPT-5')
  })

  it.each([
    [{ ...entry(), protocol: 'responses' }, /protocol/i],
    [{ ...entry(), provider: '' }, /provider/i],
    [{ ...entry(), modelId: '' }, /modelId/i],
    [{ ...entry(), contextWindowTokens: 0 }, /contextWindowTokens/i],
    [{ ...entry(), maxTokens: -1 }, /maxTokens/i],
    [{ ...entry(), maxTokens: 1.5 }, /maxTokens/i],
    [{ ...entry(), contextWindowTokens: '128000junk' }, /contextWindowTokens/i],
    [{ ...entry(), provider: 'bedrock' }, /provider/i],
    [{ ...entry(), provider: 'Azure-OpenAI' }, /provider/i],
    [{ ...entry(), provider: 'OPENAI-CODEX' }, /provider/i],
  ])('rejects invalid v2 entries %#', (invalid, message) => {
    expect(() =>
      parseModelConfig({
        schemaVersion: 2,
        activeModelId: 'entry-openai',
        models: [invalid],
      }),
    ).toThrow(message)
  })

  it('requires a non-empty model list and an active id that exists', () => {
    expect(() => validateCompleteModelEntries(defaultModelConfig())).toThrow(
      ValidationError,
    )
    expect(() =>
      validateCompleteModelEntries({
        schemaVersion: 2,
        activeModelId: 'missing',
        models: [entry()],
      }),
    ).toThrow(/activeModelId/)
    expect(() =>
      validateCompleteModelEntries({
        schemaVersion: 2,
        activeModelId: 'entry-openai',
        models: [entry()],
      }),
    ).not.toThrow()
  })
})

describe('typed entry mutation', () => {
  it('generates and persists a stable id for a new entry', async () => {
    const saved = await saveModelEntry(dir, {
      provider: 'openai',
      protocol: 'openai',
      modelId: 'gpt-5-mini',
      apiBase: 'https://api.openai.com/v1',
      apiKey: 'sk-new',
      contextWindowTokens: 128_000,
      maxTokens: 8_192,
      reasoningEffort: null,
    })

    expect(saved.models[0]?.entryId).toMatch(/^model-/)
    expect(saved.activeModelId).toBe(saved.models[0]?.entryId)
    expect((await loadModelConfig(dir)).models[0]?.entryId).toBe(
      saved.models[0]?.entryId,
    )
  })

  it('preserves omitted or masked keys, replaces real keys, and clears null', async () => {
    await saveModelConfig(dir, {
      schemaVersion: 2,
      activeModelId: 'entry-openai',
      models: [entry({ legacy: { temperature: 0.2, extraBody: { seed: 7 } } })],
    })

    await saveModelConfig(dir, {
      schemaVersion: 2,
      activeModelId: 'entry-openai',
      models: [
        entry({
          apiKey: '***cret',
          displayName: 'Masked round trip',
          legacy: { temperature: 0.2, extraBody: { seed: 7 } },
        }),
      ],
    })
    expect((await loadModelConfig(dir)).models[0]?.apiKey).toBe('sk-secret')

    await saveModelEntry(dir, {
      ...entry({ apiKey: undefined as never, displayName: 'Renamed' }),
      apiKey: undefined,
    })
    expect((await loadModelConfig(dir)).models[0]).toMatchObject({
      apiKey: 'sk-secret',
      displayName: 'Renamed',
      legacy: { temperature: 0.2, extraBody: { seed: 7 } },
    })

    await saveModelEntry(dir, { entryId: 'entry-openai', apiKey: 'sk-***cret' })
    expect((await loadModelConfig(dir)).models[0]?.apiKey).toBe('sk-secret')

    await saveModelEntry(dir, {
      entryId: 'entry-openai',
      apiKey: 'sk-replaced',
    })
    expect((await loadModelConfig(dir)).models[0]?.apiKey).toBe('sk-replaced')

    await saveModelEntry(dir, { entryId: 'entry-openai', apiKey: null })
    expect((await loadModelConfig(dir)).models[0]?.apiKey).toBeNull()
  })

  it('activates entries and selects the first remaining entry after deleting active', async () => {
    await saveModelConfig(dir, {
      schemaVersion: 2,
      activeModelId: 'a',
      models: [
        entry({ entryId: 'a' }),
        entry({ entryId: 'b', modelId: 'gpt-5-mini' }),
      ],
    })

    expect((await activateModelEntry(dir, 'b')).activeModelId).toBe('b')
    const afterDelete = await deleteModelEntry(dir, 'b')
    expect(afterDelete.activeModelId).toBe('a')
    await expect(activateModelEntry(dir, 'missing')).rejects.toThrow(
      ValidationError,
    )
  })

  it('does not expose masked placeholders as secrets', () => {
    expect(maskSecret('sk-old-secret')).toBe('***cret')
    expect(maskSecret('abc')).toBe('***')
    expect(maskSecret('')).toBe('')
  })
})

describe('v1 migration', () => {
  const legacy = (secondaryModelId = 'gpt-4o-mini'): Record<string, any> => ({
    agents: {
      defaults: {
        model: 'work',
        provider: 'openai',
        maxTokens: 16_384,
        contextWindowTokens: 64_000,
        reasoningEffort: 'low',
        temperature: 0.15,
      },
    },
    models: [
      {
        name: 'work',
        label: 'Work',
        provider: 'openai',
        apiKey: 'sk-***cret',
        mainModelId: 'gpt-4o',
        secondaryModelId,
        extraBody: { seed: 9 },
      },
    ],
    providers: {
      openai: {
        apiKey: 'sk-provider-real',
        apiBase: 'https://api.openai.com/v1',
        extraHeaders: { 'X-Tenant': 'local' },
      },
    },
  })

  it('backs up v1 once and migrates distinct main and secondary models', async () => {
    const path = join(dir, 'model_config.json')
    const original = `${JSON.stringify(legacy(), null, 2)}\n`
    await writeFile(path, original, 'utf8')

    const migrated = await loadModelConfig(dir)

    expect(migrated.raw.schemaVersion).toBe(2)
    expect(migrated.models.map((item) => item.modelId)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ])
    expect(activeEntry(migrated)?.modelId).toBe('gpt-4o')
    expect(migrated.models[0]).toMatchObject({
      apiKey: 'sk-provider-real',
      apiBase: 'https://api.openai.com/v1',
      contextWindowTokens: 64_000,
      maxTokens: 16_384,
      reasoningEffort: 'low',
      legacy: {
        temperature: 0.15,
        extraHeaders: { 'X-Tenant': 'local' },
        extraBody: { seed: 9 },
      },
    })
    expect(
      await readFile(join(dir, 'model_config.v1-backup.json'), 'utf8'),
    ).toBe(original)
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(2)

    await writeFile(
      join(dir, 'model_config.v1-backup.json'),
      'sentinel',
      'utf8',
    )
    const ids = migrated.models.map((item) => item.entryId)
    expect(
      (await loadModelConfig(dir)).models.map((item) => item.entryId),
    ).toEqual(ids)
    expect(
      await readFile(join(dir, 'model_config.v1-backup.json'), 'utf8'),
    ).toBe('sentinel')
  })

  it('deduplicates equal main/secondary and creates unique ids for duplicate legacy records', async () => {
    const value = legacy('gpt-4o')
    value.models.push({ ...value.models[0], name: 'work', label: 'Work copy' })
    await writeFile(
      join(dir, 'model_config.json'),
      JSON.stringify(value),
      'utf8',
    )

    const migrated = await loadModelConfig(dir)

    expect(migrated.models).toHaveLength(2)
    expect(new Set(migrated.models.map((item) => item.entryId)).size).toBe(2)
    expect(migrated.models.every((item) => item.modelId === 'gpt-4o')).toBe(
      true,
    )
  })

  it('filters removed backends and leaves removed-only files unconfigured', async () => {
    await writeFile(
      join(dir, 'model_config.json'),
      JSON.stringify({
        agents: { defaults: { model: 'old' } },
        models: [
          { name: 'old', provider: 'BEDROCK', mainModelId: 'claude-old' },
          { name: 'oauth', provider: 'openai-codex', mainModelId: 'codex-old' },
        ],
      }),
      'utf8',
    )

    await expect(loadModelConfig(dir)).resolves.toMatchObject({
      activeModelId: null,
      models: [],
    })
  })

  it('falls through empty or invalid entry values to provider and defaults', async () => {
    const value = legacy()
    value.models[0] = {
      ...value.models[0],
      apiBase: '',
      maxTokens: '',
      contextWindowTokens: 'invalid',
      reasoningEffort: '',
      temperature: '',
      extraHeaders: null,
    }
    value.providers.openai.maxTokens = 12_000
    value.providers.openai.contextWindowTokens = 96_000
    value.providers.openai.reasoningEffort = 'high'
    value.providers.openai.temperature = 0.25
    await writeFile(
      join(dir, 'model_config.json'),
      JSON.stringify(value),
      'utf8',
    )

    const migrated = await loadModelConfig(dir)

    expect(migrated.models[0]).toMatchObject({
      apiBase: 'https://api.openai.com/v1',
      maxTokens: 12_000,
      contextWindowTokens: 96_000,
      reasoningEffort: 'high',
      legacy: {
        temperature: 0.25,
        extraHeaders: { 'X-Tenant': 'local' },
      },
    })
  })
})

describe('model-config IO recovery', () => {
  it('round-trips v2 with private permissions and accepts a direct file path', async () => {
    const path = join(dir, 'custom-models.json')
    const data: ModelConfigV2 = {
      schemaVersion: 2,
      activeModelId: 'entry-openai',
      models: [entry()],
    }
    await saveModelConfig(path, data, { validateComplete: true })

    expect((await loadModelConfig(path)).raw).toEqual(data)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('isolates malformed JSON and invalid v2 schema into corrupt backups', async () => {
    const path = join(dir, 'model_config.json')
    await writeFile(path, '{"models":[', 'utf8')
    expect((await loadModelConfig(dir)).raw).toEqual(defaultModelConfig())
    expect(existsSync(path)).toBe(false)
    expect(
      (await readdir(dir)).some((name) =>
        name.startsWith('model_config.json.corrupt-'),
      ),
    ).toBe(true)

    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 2, activeModelId: null, models: {} }),
      'utf8',
    )
    expect((await loadModelConfig(dir)).raw).toEqual(defaultModelConfig())
    expect(existsSync(path)).toBe(false)

    await writeFile(
      path,
      JSON.stringify({
        agents: { defaults: [] },
        models: [],
        providers: { openai: 'invalid' },
      }),
      'utf8',
    )
    expect((await loadModelConfig(dir)).raw).toEqual(defaultModelConfig())
    expect(existsSync(path)).toBe(false)
  })
})
