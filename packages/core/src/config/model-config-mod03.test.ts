// MOD-03 (PLAN-V020): model_config v2 gains optional connection, limits,
// detected facts, metadata and sampling fields; one bad entry no longer
// isolates the whole file; older builds can still read what we write.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routeFromEntry } from '../llm/route'
import { resolveModelProfile } from '../model/profile'
import { normalizeV2From01 } from './compat/model-config-0.1'
import {
  ALL_METADATA_FIELDS,
  compatibilityEntryForTest,
  discardRejectedModelEntry,
  effectiveDisplayName,
  effectiveMetadata,
  loadModelConfig,
  saveModelEntry,
  type ModelEntryV2,
} from './model-config'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-model-mod03-'))
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    entryId: 'e1',
    provider: 'openai',
    protocol: 'openai',
    modelId: 'gpt-5.2',
    apiBase: 'https://api.openai.com/v1',
    apiKey: 'sk-test-1',
    contextWindowTokens: 128_000,
    maxTokens: 16_000,
    reasoningEffort: null,
    ...overrides,
  }
}

function write(root: string, models: unknown[], activeModelId = 'e1'): string {
  const path = join(root, 'model_config.json')
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 2, activeModelId, models }, null, 2),
  )
  return path
}

describe('model_config v2 extensions', () => {
  it('keeps the new optional fields through load and save', async () => {
    const root = tmp()
    write(root, [
      base({
        connectionId: 'conn-openai',
        limits: { maxInputTokens: 100_000, maxOutputTokens: 12_000 },
        detected: {
          toolCall: true,
          vision: true,
          reasoning: true,
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
          reasoningControl: 'effort',
          acceptsTemperature: false,
          modalities: ['text', 'image'],
          kind: 'chat',
        },
        metadata: {
          name: 'GPT 5.2',
          source: 'vendor_api',
          catalogKey: 'openai/gpt-5.2',
          checkedAt: '2026-10-19T00:00:00.000Z',
          userLocked: ['maxTokens'],
          pricingSource: 'catalog',
          lifecycle: { status: 'active' },
        },
        sampling: { temperature: 0.4, topP: null },
      }),
    ])
    const config = await loadModelConfig(root)
    const entry = config.raw.models[0]!
    expect(entry.connectionId).toBe('conn-openai')
    expect(entry.limits).toEqual({
      maxInputTokens: 100_000,
      maxOutputTokens: 12_000,
    })
    expect(entry.detected?.reasoningEfforts).toEqual(['low', 'high'])
    expect(entry.metadata).toMatchObject({
      source: 'vendor_api',
      userLocked: ['maxTokens'],
    })
    expect(entry.sampling).toEqual({ temperature: 0.4, topP: null })
    await saveModelEntry(root, { entryId: 'e1', displayName: 'Renamed' })
    const disk = JSON.parse(
      readFileSync(join(root, 'model_config.json'), 'utf8'),
    )
    expect(disk.models[0].detected.acceptsTemperature).toBe(false)
    expect(disk.models[0].metadata.catalogKey).toBe('openai/gpt-5.2')
  })

  it('reads an old entry without metadata as manual and fully locked (6)', async () => {
    const root = tmp()
    write(root, [base()])
    const config = await loadModelConfig(root)
    // Not written to the file: an old entry only reads this way.
    expect(config.raw.models[0]!.metadata).toBeUndefined()
    expect(effectiveMetadata(config.raw.models[0]!)).toEqual({
      source: 'manual',
      userLocked: [...ALL_METADATA_FIELDS],
    })
  })

  it('drops malformed optional fields instead of the entry', async () => {
    const root = tmp()
    write(root, [
      base({
        limits: { maxInputTokens: -3 },
        detected: { kind: 'spaceship', reasoningEfforts: 'high' },
        metadata: { source: 'rumour', userLocked: ['nonsense', 'maxTokens'] },
        sampling: { temperature: 'hot' },
      }),
    ])
    const config = await loadModelConfig(root)
    const entry = config.raw.models[0]!
    expect(config.rejectedEntries).toEqual([])
    expect(entry.limits).toBeUndefined()
    expect(entry.detected?.kind).toBeUndefined()
    expect(entry.detected?.reasoningEfforts).toBeUndefined()
    expect(entry.metadata).toEqual({
      source: 'manual',
      userLocked: ['maxTokens'],
    })
    expect(entry.sampling).toBeUndefined()
  })

  it('names an entry displayName, then metadata.name, then its model id', () => {
    const entry = base() as unknown as ModelEntryV2
    expect(effectiveDisplayName(entry)).toBe('gpt-5.2')
    expect(
      effectiveDisplayName({
        ...entry,
        metadata: { source: 'catalog', name: 'GPT' },
      }),
    ).toBe('GPT')
    expect(
      effectiveDisplayName({
        ...entry,
        displayName: 'Mine',
        metadata: { source: 'catalog', name: 'GPT' },
      }),
    ).toBe('Mine')
  })
})

describe('one bad entry (9)', () => {
  it('keeps the other entries usable and reports the bad one, without quarantine', async () => {
    const root = tmp()
    write(root, [base(), base({ entryId: 'bad', protocol: 'smoke-signal' })])
    const config = await loadModelConfig(root)
    expect(config.raw.models.map((entry) => entry.entryId)).toEqual(['e1'])
    expect(config.rejectedEntries).toEqual([
      expect.objectContaining({
        index: 1,
        entryId: 'bad',
        modelId: 'gpt-5.2',
        reason: expect.stringContaining('protocol'),
      }),
    ])
    expect(
      readdirSync(root).filter((name) => name.includes('corrupt')),
    ).toEqual([])
  })

  it('keeps the bad entry on disk through other saves until it is discarded', async () => {
    const root = tmp()
    const path = write(root, [
      base(),
      base({ entryId: 'bad', protocol: 'smoke-signal' }),
    ])
    await saveModelEntry(root, { entryId: 'e1', displayName: 'Still here' })
    let disk = JSON.parse(readFileSync(path, 'utf8'))
    expect(
      disk.models.map((item: { entryId: string }) => item.entryId),
    ).toEqual(['e1', 'bad'])
    await discardRejectedModelEntry(root, 'bad')
    disk = JSON.parse(readFileSync(path, 'utf8'))
    expect(
      disk.models.map((item: { entryId: string }) => item.entryId),
    ).toEqual(['e1'])
    expect((await loadModelConfig(root)).rejectedEntries).toEqual([])
  })
})

describe('older builds read new files (11)', () => {
  it('parses a file written with every new field using the 0.1 reader', async () => {
    const root = tmp()
    const path = write(root, [
      base({
        connectionId: 'conn-1',
        limits: { maxInputTokens: 1000 },
        detected: { reasoningEfforts: ['high'], acceptsTemperature: false },
        metadata: { source: 'catalog', userLocked: ['displayName'] },
        sampling: { temperature: 0.2 },
      }),
    ])
    await saveModelEntry(root, { entryId: 'e1', displayName: 'Saved by 0.2' })
    const written = JSON.parse(readFileSync(path, 'utf8'))
    const old = normalizeV2From01(written)
    expect(old.models[0]).toMatchObject({
      entryId: 'e1',
      modelId: 'gpt-5.2',
      displayName: 'Saved by 0.2',
    })
  })
})

describe('profile and route use detected facts (7, 8)', () => {
  it('takes reasoning efforts from detected facts (8)', () => {
    const profile = resolveModelProfile({
      provider: 'custom',
      protocol: 'openai',
      modelId: 'acme-thinker-7',
      detected: {
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        vision: true,
      },
    })
    expect(profile.reasoning).toBe(true)
    expect(profile.reasoningEfforts).toEqual(['low', 'high'])
    expect(profile.vision).toBe(true)
    expect(profile.sources.reasoning).toBe('detected')
    // The user's override still wins over what was detected.
    const overridden = resolveModelProfile({
      provider: 'custom',
      protocol: 'openai',
      modelId: 'acme-thinker-7',
      capabilityOverrides: { vision: false },
      detected: { vision: true },
    })
    expect(overridden.vision).toBe(false)
    expect(overridden.sources.vision).toBe('override')
  })

  it('sends a temperature only when the model accepts one (7)', () => {
    const entry = (extra: Partial<ModelEntryV2>) =>
      routeFromEntry(
        compatibilityEntryForTest({
          ...(base() as unknown as ModelEntryV2),
          ...extra,
        }),
      )
    expect(
      entry({
        sampling: { temperature: 0.5 },
        detected: { acceptsTemperature: false },
      }).temperature,
    ).toBeUndefined()
    expect(entry({ sampling: { temperature: 0.5 } }).temperature).toBe(0.5)
    expect(entry({ legacy: { temperature: 0.3 } }).temperature).toBe(0.3)
    expect(entry({}).temperature).toBeUndefined()
  })
})

describe('the shipped example', () => {
  it('loads with no rejected entries, in this build and in 0.1', async () => {
    const example = readFileSync(
      join(__dirname, '../../../../config/examples/model_config.example.json'),
      'utf8',
    )
    const root = tmp()
    writeFileSync(join(root, 'model_config.json'), example)
    const config = await loadModelConfig(root)
    expect(config.rejectedEntries).toEqual([])
    expect(config.raw.models[0]).toMatchObject({
      connectionId: 'conn-example-deepseek',
      metadata: { source: 'catalog' },
    })
    expect(normalizeV2From01(JSON.parse(example)).models).toHaveLength(1)
  })
})
