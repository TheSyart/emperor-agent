import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SNAPSHOT_PROVIDERS } from './providers'
import { modelsDevSnapshotSchema, modelMetadataManifestSchema } from './schema'
import {
  projectModelsDev,
  runModelMetadataSync,
  serializeSnapshot,
} from './sync'

const here = import.meta.dirname
const repoRoot = resolve(here, '../../../../..')
const NOW = new Date('2026-10-19T00:00:00.000Z')

/** A models.dev-shaped document: every kept provider, a few models, one stray provider. */
function rawCatalog(): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const id of SNAPSHOT_PROVIDERS)
    raw[id] = { id, name: id.toUpperCase(), env: [], models: {} }
  const model = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    description: 'dropped by the projection',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    release_date: '2026-10-17',
    last_updated: '2026-10-17',
    modalities: { input: ['text', 'image'], output: ['text'] },
    open_weights: true,
    limit: { context: 1_000_000, output: 393_216 },
    cost: { input: 0.15, output: 0.6, cache_read: 0.003, tiers: [] },
    ...extra,
  })
  ;(raw.deepseek as { models: Record<string, unknown> }).models = {
    'deepseek-v4-pro': model('deepseek-v4-pro', {
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'high', 'max'] },
        { type: 'future_kind' },
      ],
    }),
    'deepseek-flash': model('deepseek-flash', {
      canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
    }),
  }
  ;(raw['alibaba-cn'] as { models: Record<string, unknown> }).models = {
    'qwen3.8-max': model('qwen3.8-max', { cost: { input: 1.77, output: 5.3 } }),
  }
  raw['nano-gpt'] = {
    id: 'nano-gpt',
    name: 'NanoGPT',
    models: { 'deepseek-chat': model('deepseek-chat') },
  }
  return raw
}

const temporaries: string[] = []
function workspace(): { dir: string; input: string } {
  const dir = mkdtempSync(join(tmpdir(), 'emperor-model-metadata-'))
  temporaries.push(dir)
  const input = join(dir, 'api.json')
  writeFileSync(input, JSON.stringify(rawCatalog()))
  return { dir, input }
}

const quiet = { log: () => {}, error: () => {}, now: () => NOW }

afterEach(() => {
  for (const dir of temporaries.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('projectModelsDev', () => {
  it('keeps mapped providers, projects fields, sorts, and drops CNY prices', () => {
    const snapshot = projectModelsDev(rawCatalog())
    expect(Object.keys(snapshot.providers)).toEqual(
      [...SNAPSHOT_PROVIDERS].sort(),
    )
    expect(snapshot.providers['nano-gpt']).toBeUndefined()
    const deepseek = snapshot.providers.deepseek!
    expect(Object.keys(deepseek.models)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
    expect(deepseek.models['deepseek-flash']).toEqual({
      name: 'deepseek-flash',
      release_date: '2026-10-17',
      limit: { context: 1_000_000, output: 393_216 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      tool_call: true,
      reasoning: true,
      temperature: true,
      cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
      canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
    })
    expect(deepseek.models['deepseek-v4-pro']!.reasoning_options).toEqual([
      { type: 'toggle' },
      { type: 'effort', values: ['low', 'high', 'max'] },
    ])
    expect(
      snapshot.providers['alibaba-cn']!.models['qwen3.8-max']!.cost,
    ).toBeUndefined()
    expect(() => modelsDevSnapshotSchema.parse(snapshot)).not.toThrow()
  })

  it('refuses a document that lost a provider Emperor maps to', () => {
    const raw = rawCatalog()
    delete raw.deepseek
    expect(() => projectModelsDev(raw)).toThrow(/deepseek/)
  })
})

describe('runModelMetadataSync', () => {
  it('12 · --check exits 1 when the committed snapshot was tampered with', async () => {
    const { dir, input } = workspace()
    const args = ['--input', input, '--out-dir', dir]
    expect(await runModelMetadataSync(args, quiet)).toBe(0)
    expect(await runModelMetadataSync(['--check', ...args], quiet)).toBe(0)

    const snapshotPath = join(dir, 'models-dev.snapshot.json')
    const original = readFileSync(snapshotPath, 'utf8')
    writeFileSync(snapshotPath, original.replace('393216', '393217'))
    expect(await runModelMetadataSync(['--check', ...args], quiet)).toBe(1)

    // The snapshot alone is intact but the manifest no longer describes it.
    writeFileSync(snapshotPath, original)
    const manifestPath = join(dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }, null, 2) + '\n',
    )
    expect(await runModelMetadataSync(['--check', ...args], quiet)).toBe(1)
  })

  it('--check exits 1 and writes nothing when upstream changed', async () => {
    const { dir, input } = workspace()
    const args = ['--input', input, '--out-dir', dir]
    await runModelMetadataSync(args, quiet)
    const before = readFileSync(join(dir, 'models-dev.snapshot.json'), 'utf8')
    const raw = rawCatalog()
    ;(raw.deepseek as { models: Record<string, { limit: object }> }).models[
      'deepseek-flash'
    ]!.limit = { context: 1_048_576, output: 393_216 }
    writeFileSync(input, JSON.stringify(raw))
    const lines: string[] = []
    const code = await runModelMetadataSync(['--check', ...args], {
      ...quiet,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    })
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('deepseek: changed deepseek-flash')
    expect(readFileSync(join(dir, 'models-dev.snapshot.json'), 'utf8')).toBe(
      before,
    )
  })

  it('writes a manifest with the hash, the counts and when it was fetched', async () => {
    const { dir, input } = workspace()
    await runModelMetadataSync(['--input', input, '--out-dir', dir], quiet)
    const text = readFileSync(join(dir, 'models-dev.snapshot.json'), 'utf8')
    const manifest = modelMetadataManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
    )
    expect(manifest.fetchedAt).toBe(NOW.toISOString())
    expect(manifest.sha256).toBe(
      createHash('sha256').update(text).digest('hex'),
    )
    expect(manifest.modelCount).toBe(3)
    expect(manifest.providers.deepseek).toBe(2)
    expect(manifest.providerCount).toBe(SNAPSHOT_PROVIDERS.length)

    // An unchanged refresh leaves both files alone, fetchedAt included.
    const later = { ...quiet, now: () => new Date('2026-11-01T00:00:00.000Z') }
    expect(
      await runModelMetadataSync(['--input', input, '--out-dir', dir], later),
    ).toBe(0)
    expect(
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).fetchedAt,
    ).toBe(NOW.toISOString())
  })

  it('exits 2 on bad input', async () => {
    const { dir } = workspace()
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{"deepseek": 1}')
    expect(
      await runModelMetadataSync(['--input', broken, '--out-dir', dir], quiet),
    ).toBe(2)
    expect(await runModelMetadataSync(['--bogus'], quiet)).toBe(2)
  })

  it('the script itself exits 1 on a tampered snapshot', async () => {
    const { dir, input } = workspace()
    await runModelMetadataSync(['--input', input, '--out-dir', dir], quiet)
    const snapshotPath = join(dir, 'models-dev.snapshot.json')
    writeFileSync(
      snapshotPath,
      readFileSync(snapshotPath, 'utf8').replace(
        '"deepseek-flash"',
        '"deepseek-fla5h"',
      ),
    )
    const result = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'node_modules/vite-node/vite-node.mjs'),
        resolve(repoRoot, 'scripts/sync-model-metadata.ts'),
        '--',
        '--check',
        '--input',
        input,
        '--out-dir',
        dir,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    )
    expect(result.status, result.stderr).toBe(1)
  }, 60_000)
})

describe('the committed snapshot', () => {
  const snapshotText = readFileSync(
    join(here, 'models-dev.snapshot.json'),
    'utf8',
  )
  const manifest = modelMetadataManifestSchema.parse(
    JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')),
  )

  it('matches its manifest and the schema', () => {
    expect(createHash('sha256').update(snapshotText).digest('hex')).toBe(
      manifest.sha256,
    )
    const snapshot = modelsDevSnapshotSchema.parse(JSON.parse(snapshotText))
    expect(Object.keys(snapshot.providers)).toEqual(
      [...SNAPSHOT_PROVIDERS].sort(),
    )
    const counts = Object.fromEntries(
      Object.entries(snapshot.providers).map(([id, p]) => [
        id,
        Object.keys(p.models).length,
      ]),
    )
    expect(manifest.providers).toEqual(counts)
    expect(manifest.modelCount).toBe(
      Object.values(counts).reduce((sum, count) => sum + count, 0),
    )
  })

  it('carries the models.dev licence notice, with the full text alongside', () => {
    expect(JSON.parse(snapshotText).license).toMatch(
      /^MIT License, Copyright \(c\) 2025 models\.dev/,
    )
    expect(
      readFileSync(join(here, 'models-dev.LICENSE.txt'), 'utf8'),
    ).toContain('Copyright (c) 2025 models.dev')
  })

  it('is exactly what the serializer writes (not edited by hand)', () => {
    expect(
      serializeSnapshot(
        modelsDevSnapshotSchema.parse(JSON.parse(snapshotText)),
      ),
    ).toBe(snapshotText)
  })
})
