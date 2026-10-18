/**
 * Regenerates the bundled snapshot from https://models.dev/api.json.
 * `scripts/sync-model-metadata.ts` is the command-line entry; the logic
 * lives here so the tests can drive it without the network.
 *
 * The projection keeps only providers `providers.ts` maps to, only the
 * fields the lookup reads, sorted by id, and no prices for CNY or plan
 * providers. Output is deterministic: an unchanged upstream rewrites
 * nothing, so `fetchedAt` moves only with the data.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SNAPSHOT_PROVIDERS, UNPRICED_PROVIDERS } from './providers'
import {
  modelMetadataManifestSchema,
  modelsDevSnapshotSchema,
  rawModelsDevProviderSchema,
  type ModelMetadataManifest,
  type ModelsDevSnapshot,
  type RawModelsDevProvider,
  type SnapshotModel,
  type SnapshotProvider,
  type SnapshotReasoningOption,
} from './schema'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const SNAPSHOT_FILE = 'models-dev.snapshot.json'
export const MANIFEST_FILE = 'manifest.json'
const LICENSE = {
  spdx: 'MIT',
  url: 'https://github.com/anomalyco/models.dev/blob/dev/LICENSE',
}
/** Full text in models-dev.LICENSE.txt next to the snapshot. */
export const SNAPSHOT_LICENSE = `MIT License, Copyright (c) 2025 models.dev (${LICENSE.url})`
const DEFAULT_OUT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REASONING_TYPES = new Set(['effort', 'toggle', 'budget_tokens'])

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

type RawModel = RawModelsDevProvider['models'][string]

/** Rebuilt in a fixed key order so the serialised snapshot is stable; zod checks the result. */
function projectModel(raw: RawModel, priced: boolean): SnapshotModel {
  const ordered: Record<string, unknown> = {}
  if (raw.name) ordered.name = raw.name
  if (raw.family) ordered.family = raw.family
  if (raw.release_date && /^\d{4}-\d{2}(?:-\d{2})?$/.test(raw.release_date))
    ordered.release_date = raw.release_date
  if (raw.status) ordered.status = raw.status
  ordered.limit = {
    context: raw.limit.context,
    ...(raw.limit.input !== undefined ? { input: raw.limit.input } : {}),
    output: raw.limit.output,
  }
  ordered.modalities = {
    input: [...(raw.modalities?.input ?? ['text'])],
    output: [...(raw.modalities?.output ?? ['text'])],
  }
  if (raw.tool_call !== undefined) ordered.tool_call = raw.tool_call
  if (raw.reasoning !== undefined) ordered.reasoning = raw.reasoning
  const options = (raw.reasoning_options ?? [])
    .filter((option) => REASONING_TYPES.has(option.type))
    .map((option) => {
      const out: Record<string, unknown> = { type: option.type }
      if (option.values) out.values = [...option.values]
      if (option.min !== undefined) out.min = option.min
      if (option.max !== undefined) out.max = option.max
      return out as SnapshotReasoningOption
    })
  if (options.length > 0) ordered.reasoning_options = options
  if (raw.temperature !== undefined) ordered.temperature = raw.temperature
  if (priced && raw.cost) {
    const cost: Record<string, number> = {}
    for (const field of [
      'input',
      'output',
      'cache_read',
      'cache_write',
    ] as const)
      if (raw.cost[field] !== undefined) cost[field] = raw.cost[field]
    if (Object.keys(cost).length > 0) ordered.cost = cost
  }
  if (raw.canonical_model_id)
    ordered.canonical_model_id = raw.canonical_model_id
  return ordered as SnapshotModel
}

/** Projects and validates a models.dev document. Throws on a missing provider or a bad shape. */
export function projectModelsDev(raw: unknown): ModelsDevSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('models.dev: expected an object of providers')
  const document = raw as Record<string, unknown>
  const providers: Record<string, SnapshotProvider> = {}
  for (const id of [...SNAPSHOT_PROVIDERS].sort(byCodeUnit)) {
    if (!(id in document))
      throw new Error(`models.dev no longer lists provider "${id}"`)
    const parsed = rawModelsDevProviderSchema.safeParse(document[id])
    if (!parsed.success)
      throw new Error(
        `models.dev provider "${id}": ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      )
    const provider = parsed.data
    const priced = !UNPRICED_PROVIDERS.has(id)
    const models: Record<string, SnapshotModel> = {}
    for (const modelId of Object.keys(provider.models).sort(byCodeUnit))
      models[modelId] = projectModel(provider.models[modelId]!, priced)
    providers[id] = {
      name: provider.name,
      ...(provider.api ? { api: provider.api } : {}),
      models,
    }
  }
  return modelsDevSnapshotSchema.parse({
    schemaVersion: 1,
    source: MODELS_DEV_URL,
    license: SNAPSHOT_LICENSE,
    providers,
  })
}

/** One model per line: small enough to bundle, readable as a refresh diff. */
export function serializeSnapshot(snapshot: ModelsDevSnapshot): string {
  const lines = [
    '{',
    `  "schemaVersion": ${JSON.stringify(snapshot.schemaVersion)},`,
    `  "source": ${JSON.stringify(snapshot.source)},`,
    `  "license": ${JSON.stringify(snapshot.license)},`,
    '  "providers": {',
  ]
  const providerIds = Object.keys(snapshot.providers).sort(byCodeUnit)
  providerIds.forEach((providerId, providerIndex) => {
    const provider = snapshot.providers[providerId]!
    lines.push(`    ${JSON.stringify(providerId)}: {`)
    lines.push(`      "name": ${JSON.stringify(provider.name)},`)
    if (provider.api)
      lines.push(`      "api": ${JSON.stringify(provider.api)},`)
    const modelIds = Object.keys(provider.models).sort(byCodeUnit)
    if (modelIds.length === 0) lines.push('      "models": {}')
    else {
      lines.push('      "models": {')
      modelIds.forEach((modelId, modelIndex) => {
        const comma = modelIndex < modelIds.length - 1 ? ',' : ''
        lines.push(
          `        ${JSON.stringify(modelId)}: ${JSON.stringify(provider.models[modelId])}${comma}`,
        )
      })
      lines.push('      }')
    }
    lines.push(`    }${providerIndex < providerIds.length - 1 ? ',' : ''}`)
  })
  lines.push('  }', '}', '')
  return lines.join('\n')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function counts(snapshot: ModelsDevSnapshot): Record<string, number> {
  return Object.fromEntries(
    Object.keys(snapshot.providers)
      .sort(byCodeUnit)
      .map((id) => [id, Object.keys(snapshot.providers[id]!.models).length]),
  )
}

export function buildManifest(
  snapshotText: string,
  snapshot: ModelsDevSnapshot,
  fetchedAt: Date,
): ModelMetadataManifest {
  const providers = counts(snapshot)
  return {
    schemaVersion: 1,
    source: MODELS_DEV_URL,
    license: LICENSE,
    fetchedAt: fetchedAt.toISOString(),
    snapshot: SNAPSHOT_FILE,
    sha256: sha256(snapshotText),
    bytes: Buffer.byteLength(snapshotText),
    providerCount: Object.keys(providers).length,
    modelCount: Object.values(providers).reduce((sum, n) => sum + n, 0),
    providers,
  }
}

/** Why a manifest does not describe this snapshot text; empty when it does. */
function manifestProblems(
  manifestText: string | undefined,
  snapshotText: string,
): string[] {
  if (manifestText === undefined) return [`${MANIFEST_FILE} is missing`]
  let snapshot: ModelsDevSnapshot
  try {
    snapshot = modelsDevSnapshotSchema.parse(JSON.parse(snapshotText))
  } catch {
    return [`${SNAPSHOT_FILE} is not a valid snapshot`]
  }
  let manifest: ModelMetadataManifest
  try {
    manifest = modelMetadataManifestSchema.parse(JSON.parse(manifestText))
  } catch {
    return [`${MANIFEST_FILE} is not a valid manifest`]
  }
  const expected = buildManifest(
    snapshotText,
    snapshot,
    new Date(manifest.fetchedAt),
  )
  const problems: string[] = []
  if (manifest.sha256 !== expected.sha256)
    problems.push(`${MANIFEST_FILE}: sha256 does not match ${SNAPSHOT_FILE}`)
  if (
    manifest.bytes !== expected.bytes ||
    manifest.modelCount !== expected.modelCount ||
    JSON.stringify(manifest.providers) !== JSON.stringify(expected.providers)
  )
    problems.push(`${MANIFEST_FILE}: counts do not match ${SNAPSHOT_FILE}`)
  return problems
}

/** Per-provider added / removed / changed model ids, for logs and review. */
export function describeChanges(
  before: ModelsDevSnapshot | undefined,
  after: ModelsDevSnapshot,
): string[] {
  const lines: string[] = []
  const list = (ids: string[]) =>
    ids.length > 12
      ? `${ids.slice(0, 12).join(', ')} … (+${ids.length - 12})`
      : ids.join(', ')
  const ids = new Set([
    ...Object.keys(before?.providers ?? {}),
    ...Object.keys(after.providers),
  ])
  for (const providerId of [...ids].sort(byCodeUnit)) {
    const old = before?.providers[providerId]?.models ?? {}
    const next = after.providers[providerId]?.models ?? {}
    const added = Object.keys(next).filter((id) => !(id in old))
    const removed = Object.keys(old).filter((id) => !(id in next))
    const changed = Object.keys(next).filter(
      (id) => id in old && JSON.stringify(old[id]) !== JSON.stringify(next[id]),
    )
    if (added.length) lines.push(`${providerId}: added ${list(added)}`)
    if (removed.length) lines.push(`${providerId}: removed ${list(removed)}`)
    if (changed.length) lines.push(`${providerId}: changed ${list(changed)}`)
  }
  return lines
}

export interface SyncIo {
  fetchText(url: string): Promise<string>
  log(line: string): void
  error(line: string): void
  now(): Date
}

const defaultIo: SyncIo = {
  async fetchText(url) {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok)
      throw new Error(`GET ${url}: ${response.status} ${response.statusText}`)
    return response.text()
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  now: () => new Date(),
}

const USAGE =
  'usage: sync-model-metadata [--check] [--input <api.json>] [--out-dir <dir>]'

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseSnapshot(
  text: string | undefined,
): ModelsDevSnapshot | undefined {
  if (text === undefined) return undefined
  try {
    return modelsDevSnapshotSchema.parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * `--check`: exit 1 when the committed snapshot or manifest differs from
 * what models.dev serves now (or `--input`), 0 when current. Otherwise
 * writes both files when the data changed. Exit 2 on usage, network or
 * validation errors.
 */
export async function runModelMetadataSync(
  argv: readonly string[],
  overrides: Partial<SyncIo> = {},
): Promise<number> {
  const io: SyncIo = { ...defaultIo, ...overrides }
  let check = false
  let input: string | undefined
  let outDir = DEFAULT_OUT_DIR
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--check') check = true
    else if ((arg === '--input' || arg === '--out-dir') && args[i + 1]) {
      if (arg === '--input') input = args[++i]
      else outDir = args[++i]!
    } else {
      io.error(USAGE)
      return 2
    }
  }

  let snapshot: ModelsDevSnapshot
  try {
    const text = input
      ? await readFile(input, 'utf8')
      : await io.fetchText(MODELS_DEV_URL)
    snapshot = projectModelsDev(JSON.parse(text))
  } catch (error) {
    io.error(`model metadata: ${(error as Error).message}`)
    return 2
  }

  const nextText = serializeSnapshot(snapshot)
  const snapshotPath = join(outDir, SNAPSHOT_FILE)
  const manifestPath = join(outDir, MANIFEST_FILE)
  const currentText = await readOptional(snapshotPath)
  const currentManifest = await readOptional(manifestPath)
  const summary = `${Object.keys(snapshot.providers).length} providers, ${
    buildManifest(nextText, snapshot, io.now()).modelCount
  } models, ${Buffer.byteLength(nextText)} bytes`

  if (check) {
    const problems: string[] = []
    if (currentText === undefined) problems.push(`${SNAPSHOT_FILE} is missing`)
    else {
      if (currentText !== nextText) {
        problems.push(
          `${SNAPSHOT_FILE} differs from ${input ?? MODELS_DEV_URL}`,
        )
        problems.push(...describeChanges(parseSnapshot(currentText), snapshot))
      }
      problems.push(...manifestProblems(currentManifest, currentText))
    }
    if (problems.length > 0) {
      for (const problem of problems) io.error(problem)
      return 1
    }
    io.log(`model metadata is current (${summary})`)
    return 0
  }

  if (
    currentText === nextText &&
    manifestProblems(currentManifest, currentText).length === 0
  ) {
    io.log(`model metadata unchanged (${summary})`)
    return 0
  }
  for (const line of describeChanges(parseSnapshot(currentText), snapshot))
    io.log(line)
  await writeFile(snapshotPath, nextText)
  await writeFile(
    manifestPath,
    JSON.stringify(buildManifest(nextText, snapshot, io.now()), null, 2) + '\n',
  )
  io.log(`wrote ${snapshotPath} (${summary})`)
  return 0
}
