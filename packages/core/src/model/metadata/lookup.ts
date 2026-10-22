/**
 * The bundled model catalog: what Emperor knows about a model before (or
 * without) asking the vendor. Shared by the add-model flow, manual entry,
 * executor model pickers and cost calculation.
 *
 * `lookupModelFacts` is a pure function of its query and the snapshot:
 * the same input gives the same answer, every call returns fresh objects,
 * and `source` says honestly where the answer came from. Matching stops at
 * the first step that hits:
 *
 *   1. type check (vendor output modality, else id keywords);
 *   2. provider mapping (catalog name, refined by API host);
 *   3. exact id in that provider (case-insensitive);
 *   4. normalised id (no org path, routing/quantisation suffix, Bedrock or
 *      Vertex decoration, trailing date) — used only when it hits;
 *   5. longest known id the query extends at a boundary, never across a
 *      version digit or a tier word (`gpt-4` ≠ `gpt-4o`, `gpt-5.6-mini` ≠
 *      `gpt-5.6`);
 *   6. cross-provider: the lab's own entry (canonical id, org or id family),
 *      then OpenRouter, then any provider — or, for a truncated id, the one
 *      model that completes it. Price and lifecycle are not carried over:
 *      a gateway's are its own;
 *   7. family rules (chat models only);
 *   8. fallback: the type and nothing else.
 *
 * Overrides (`overrides.ts`) correct the matched entry whichever step found
 * it, so they always win over the snapshot.
 */
import manifestJson from './manifest.json'
import snapshotJson from './models-dev.snapshot.json'
import { FAMILY_RULES, type FamilyRule } from './family-rules'
import {
  detectModelKind,
  isSameModelExtension,
  modelOrg,
  normalizeModelId,
} from './model-id'
import { MODEL_OVERRIDES, type ModelOverride } from './overrides'
import {
  OFFICIAL_PROVIDERS,
  OFFICIAL_PROVIDERS_BY_LAB,
  labForCanonical,
  labForModelId,
  labForOrg,
  resolveCatalogProvider,
} from './providers'
import type {
  ModelMetadataManifest,
  ModelsDevSnapshot,
  SnapshotModel,
  SnapshotReasoningOption,
} from './schema'
import type { ModelFacts, ModelFactsPatch } from './types'

export type {
  ModelFacts,
  ModelFactsPatch,
  ModelFactsSource,
  ModelKind,
  ModelLifecycleStatus,
  ReasoningControl,
} from './types'
export { detectModelKind, normalizeModelId } from './model-id'
export type { ModelKindHints } from './model-id'

export interface ModelFactsQuery {
  provider: string
  apiBase?: string
  modelId: string
}

export interface CatalogModel {
  modelId: string
  family?: string
  releaseDate?: string
  facts: ModelFacts
}

export interface ModelFactsLookup {
  lookup(q: ModelFactsQuery): ModelFacts
  /** A provider's catalog, retired override-only entries included, sorted by id. */
  list(q: { provider: string; apiBase?: string }): CatalogModel[]
  /** One entry by models.dev provider id and exact id, with no matching. */
  peek(provider: string, modelId: string): ModelFacts | undefined
}

interface Entry {
  provider: string
  id: string
  lower: string
  normalized: string
  /** Undefined for an entry only an override defines. */
  model?: SnapshotModel
  overrides: ModelOverride[]
}

interface ProviderIndex {
  entries: Entry[]
  byLower: Map<string, Entry>
  byNormalized: Map<string, Entry>
}

const OPENROUTER = 'openrouter'

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function indexProvider(
  provider: string,
  models: Record<string, SnapshotModel>,
  overrides: readonly ModelOverride[],
): ProviderIndex {
  const entries = new Map<string, Entry>()
  for (const [id, model] of Object.entries(models)) {
    const lower = id.toLowerCase()
    entries.set(lower, {
      provider,
      id,
      lower,
      normalized: normalizeModelId(id),
      model,
      overrides: [],
    })
  }
  for (const override of overrides) {
    if (!override.providers.includes(provider)) continue
    const lower = override.modelId.toLowerCase()
    let entry = entries.get(lower)
    if (!entry) {
      entry = {
        provider,
        id: override.modelId,
        lower,
        normalized: normalizeModelId(override.modelId),
        overrides: [],
      }
      entries.set(lower, entry)
    }
    entry.overrides.push(override)
  }
  const sorted = [...entries.values()].sort((a, b) => byCodeUnit(a.id, b.id))
  const byNormalized = new Map<string, Entry>()
  for (const entry of sorted) {
    const current = byNormalized.get(entry.normalized)
    if (!current || prefer(entry, current))
      byNormalized.set(entry.normalized, entry)
  }
  return { entries: sorted, byLower: entries, byNormalized }
}

/** For one normalised id: catalog entries before override-only, the undecorated id first. */
function prefer(candidate: Entry, current: Entry): boolean {
  if (!!candidate.model !== !!current.model) return !!candidate.model
  const candidateExact = candidate.lower === candidate.normalized
  const currentExact = current.lower === current.normalized
  return candidateExact && !currentExact
}

function reasoningFromOptions(
  options: readonly SnapshotReasoningOption[] | undefined,
): NonNullable<ModelFacts['reasoning']> {
  const effort = options?.find((o) => o.type === 'effort')
  const toggle = options?.some((o) => o.type === 'toggle') ?? false
  const budget = options?.some((o) => o.type === 'budget_tokens') ?? false
  if (effort?.values?.length) {
    const canSwitchOff = toggle || effort.values.includes('none')
    return {
      efforts: [...effort.values],
      control: canSwitchOff ? 'effort' : 'always',
    }
  }
  if (toggle) return { efforts: [], control: 'toggle' }
  if (budget) return { efforts: [], control: 'budget' }
  return { efforts: [], control: 'always' }
}

function pricing(
  cost: SnapshotModel['cost'],
): ModelFacts['pricingUsdPerMTok'] | undefined {
  if (!cost) return undefined
  const out: NonNullable<ModelFacts['pricingUsdPerMTok']> = {}
  if (cost.input !== undefined) out.input = cost.input
  if (cost.output !== undefined) out.output = cost.output
  if (cost.cache_read !== undefined) out.cacheRead = cost.cache_read
  if (cost.cache_write !== undefined) out.cacheWrite = cost.cache_write
  return Object.keys(out).length > 0 ? out : undefined
}

function applyPatch(facts: ModelFacts, patch: ModelFactsPatch): void {
  const { capabilities, ...fields } = patch
  if (capabilities)
    facts.capabilities = { ...facts.capabilities, ...capabilities }
  for (const [field, value] of Object.entries(fields))
    if (value !== undefined)
      (facts as unknown as Record<string, unknown>)[field] =
        structuredClone(value)
}

function entryFacts(entry: Entry): ModelFacts {
  const model = entry.model
  const kind = detectModelKind(entry.id, {
    outputModalities: model?.modalities.output,
  })
  const facts: ModelFacts = {
    key: `${model ? 'models.dev' : 'emperor'}:${entry.provider}/${entry.id}`,
    kind,
    capabilities: {},
    source: 'catalog',
  }
  if (model) {
    if (model.name) facts.name = model.name
    if (model.limit.context > 0) facts.contextWindowTokens = model.limit.context
    if (model.limit.input) facts.maxInputTokens = model.limit.input
    // For embeddings models.dev's "output" is the vector size, not tokens.
    if (model.limit.output > 0 && kind !== 'embedding' && kind !== 'rerank')
      facts.maxOutputTokens = model.limit.output
    facts.capabilities = {
      toolCall: model.tool_call,
      vision: model.modalities.input.includes('image'),
      reasoning: model.reasoning,
    }
    if (model.reasoning)
      facts.reasoning = reasoningFromOptions(model.reasoning_options)
    if (model.temperature !== undefined)
      facts.acceptsTemperature = model.temperature
    facts.modalities = [...model.modalities.input]
    const price = pricing(model.cost)
    if (price) facts.pricingUsdPerMTok = price
    if (model.status === 'deprecated')
      facts.lifecycle = { status: 'deprecated' }
  }
  for (const override of entry.overrides) applyPatch(facts, override.patch)
  return facts
}

function familyFacts(rule: FamilyRule): ModelFacts {
  const facts: ModelFacts = {
    key: `family:${rule.id}`,
    kind: 'chat',
    capabilities: {},
    source: 'family_rule',
  }
  applyPatch(facts, rule.facts)
  return facts
}

function fallbackFacts(kind: ModelFacts['kind']): ModelFacts {
  return {
    key: 'fallback',
    kind,
    capabilities: {
      toolCall: undefined,
      vision: undefined,
      reasoning: undefined,
    },
    source: 'fallback',
  }
}

export function createModelFactsLookup(
  input: {
    snapshot?: ModelsDevSnapshot
    overrides?: readonly ModelOverride[]
    familyRules?: readonly FamilyRule[]
  } = {},
): ModelFactsLookup {
  const snapshot =
    input.snapshot ?? (snapshotJson as unknown as ModelsDevSnapshot)
  const overrides = input.overrides ?? MODEL_OVERRIDES
  const familyRules = input.familyRules ?? FAMILY_RULES

  const providers = new Map<string, ProviderIndex>()
  for (const id of Object.keys(snapshot.providers).sort(byCodeUnit))
    providers.set(
      id,
      indexProvider(id, snapshot.providers[id]!.models, overrides),
    )
  const providerIds = [...providers.keys()]

  /** Every catalog entry with this exact or normalised id, any provider. */
  const sameIdAnywhere = new Map<string, Entry[]>()
  for (const index of providers.values())
    for (const entry of index.entries) {
      if (!entry.model) continue
      for (const key of new Set([entry.lower, entry.normalized])) {
        const list = sameIdAnywhere.get(key) ?? []
        list.push(entry)
        sameIdAnywhere.set(key, list)
      }
    }

  function matchInProvider(
    index: ProviderIndex,
    raw: string,
  ): Entry | undefined {
    const lower = raw.trim().toLowerCase()
    const exact = index.byLower.get(lower)
    if (exact) return exact
    const normalized = normalizeModelId(raw)
    const byNormalized = index.byNormalized.get(normalized)
    if (byNormalized) return byNormalized
    let best: Entry | undefined
    let bestLength = 0
    for (const entry of index.entries) {
      const length = isSameModelExtension(lower, entry.lower)
        ? entry.lower.length
        : isSameModelExtension(normalized, entry.normalized)
          ? entry.normalized.length
          : 0
      if (length > bestLength) {
        best = entry
        bestLength = length
      }
    }
    return best
  }

  function tiersFor(lab: string | undefined): string[][] {
    const official = (
      lab ? OFFICIAL_PROVIDERS_BY_LAB[lab]! : OFFICIAL_PROVIDERS
    ).filter((id) => providers.has(id))
    const seen = new Set([...official, OPENROUTER])
    return [
      official,
      providers.has(OPENROUTER) ? [OPENROUTER] : [],
      providerIds.filter((id) => !seen.has(id)),
    ]
  }

  function crossProvider(raw: string): Entry | undefined {
    const normalized = normalizeModelId(raw)
    if (!normalized) return undefined
    const sameId = [
      ...(sameIdAnywhere.get(raw.trim().toLowerCase()) ?? []),
      ...(sameIdAnywhere.get(normalized) ?? []),
    ]
    const canonical = sameId
      .map((e) => e.model?.canonical_model_id?.toLowerCase())
      .find((id) => id !== undefined)
    const canonicalBare = canonical ? normalizeModelId(canonical) : undefined
    const org = modelOrg(raw)
    const lab =
      (canonical && labForCanonical(canonical)) ||
      (org && labForOrg(org)) ||
      labForModelId(normalized)
    const tiers = tiersFor(lab)

    for (const tier of tiers)
      for (const id of tier) {
        const index = providers.get(id)!
        const hit = index.byNormalized.get(normalized)
        if (hit?.model) return hit
        if (!canonical) continue
        const byCanonical =
          index.entries.find(
            (e) => e.model?.canonical_model_id?.toLowerCase() === canonical,
          ) ?? index.byNormalized.get(canonicalBare!)
        if (byCanonical?.model) return byCanonical
      }

    // A truncated id (`Qwen3-Coder-480B`) counts only when exactly one
    // model completes it within the first tier that has any completion.
    if (!/\d/.test(normalized)) return undefined
    for (const tier of tiers) {
      const completions = tier.flatMap((id) =>
        providers
          .get(id)!
          .entries.filter(
            (e) => e.model && isSameModelExtension(e.normalized, normalized),
          ),
      )
      if (completions.length === 0) continue
      const distinct = new Set(completions.map((e) => e.normalized))
      return distinct.size === 1 ? completions[0] : undefined
    }
    return undefined
  }

  function lookup(q: ModelFactsQuery): ModelFacts {
    const raw = q.modelId.trim()
    const kind = detectModelKind(raw)
    if (!raw) return fallbackFacts(kind)

    const providerId = resolveCatalogProvider(q)
    const index = providerId ? providers.get(providerId) : undefined
    const hit = index && matchInProvider(index, raw)
    if (hit) return entryFacts(hit)

    const foreign = crossProvider(raw)
    if (foreign) {
      const facts = entryFacts(foreign)
      delete facts.pricingUsdPerMTok
      delete facts.lifecycle
      return facts
    }

    if (kind === 'chat') {
      const normalized = normalizeModelId(raw)
      const rule = familyRules.find((r) => r.match.test(normalized))
      if (rule) return familyFacts(rule)
    }
    return fallbackFacts(kind)
  }

  function list(q: { provider: string; apiBase?: string }): CatalogModel[] {
    const providerId = resolveCatalogProvider(q)
    const index = providerId ? providers.get(providerId) : undefined
    if (!index) return []
    return index.entries.map((entry) => {
      const item: CatalogModel = { modelId: entry.id, facts: entryFacts(entry) }
      if (entry.model?.family) item.family = entry.model.family
      if (entry.model?.release_date) item.releaseDate = entry.model.release_date
      return item
    })
  }

  function peek(provider: string, modelId: string): ModelFacts | undefined {
    const entry = providers.get(provider)?.byLower.get(modelId.toLowerCase())
    return entry ? entryFacts(entry) : undefined
  }

  return { lookup, list, peek }
}

let bundled: ModelFactsLookup | undefined
function bundledLookup(): ModelFactsLookup {
  bundled ??= createModelFactsLookup()
  return bundled
}

/** What the bundled catalog knows about a model (see the module comment). */
export function lookupModelFacts(q: ModelFactsQuery): ModelFacts {
  return bundledLookup().lookup(q)
}

/** The bundled catalog's models for a connection; empty for unmapped providers. */
export function listCatalogModels(q: {
  provider: string
  apiBase?: string
}): CatalogModel[] {
  return bundledLookup().list(q)
}

/** Which snapshot the bundled catalog is (for `metadata.catalogVersion`). */
export const MODEL_CATALOG_INFO: Readonly<
  Pick<ModelMetadataManifest, 'fetchedAt' | 'sha256' | 'modelCount'>
> = {
  fetchedAt: (manifestJson as ModelMetadataManifest).fetchedAt,
  sha256: (manifestJson as ModelMetadataManifest).sha256,
  modelCount: (manifestJson as ModelMetadataManifest).modelCount,
}
