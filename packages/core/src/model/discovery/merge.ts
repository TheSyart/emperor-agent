/**
 * Vendor facts over catalog facts, field by field: what the vendor's own
 * list reports wins, the bundled catalog (MOD-01 `lookupModelFacts`:
 * snapshot, overrides, family rules, fallback) fills the rest, and every
 * value keeps the source it came from.
 */
import type {
  CatalogModel,
  ModelFacts,
  ModelFactsQuery,
  ModelFactsSource,
} from '../metadata/lookup'
import type { DiscoveredFactField, DiscoveredModel, VendorModel } from './types'

export interface MergeContext {
  provider: string
  apiBase: string
  lookup: (query: ModelFactsQuery) => ModelFacts
  /** The provider's catalog entries by key, for family and release date. */
  catalogByKey: ReadonlyMap<string, CatalogModel>
  /**
   * Local servers (Ollama, LM Studio) run a model with the context they
   * loaded it with, not its trained maximum: the catalog's window and input
   * limit would overstate it, so only the server's own value is used.
   */
  runtimeContextOnly?: boolean
}

const VENDOR: ModelFactsSource = 'vendor_api'

export function mergeModel(
  vendor: VendorModel,
  context: MergeContext,
): DiscoveredModel {
  const facts = context.lookup({
    provider: context.provider,
    apiBase: context.apiBase,
    modelId: vendor.lookupId ?? vendor.id,
  })
  const catalog = facts.source
  const sources: DiscoveredModel['fieldSources'] = {}
  const pick = <T>(
    field: DiscoveredFactField,
    own: T | undefined,
    known: T | undefined,
  ): T | undefined => {
    if (own !== undefined) {
      sources[field] = VENDOR
      return own
    }
    if (known !== undefined) sources[field] = catalog
    return known
  }

  const out: DiscoveredModel = {
    id: vendor.id,
    kind: pick('kind', vendor.kind, facts.kind) ?? 'chat',
    capabilities: {
      toolCall: pick(
        'toolCall',
        vendor.capabilities?.toolCall,
        facts.capabilities.toolCall,
      ),
      vision: pick(
        'vision',
        vendor.capabilities?.vision,
        facts.capabilities.vision,
      ),
      reasoning: pick(
        'reasoning',
        vendor.capabilities?.reasoning,
        facts.capabilities.reasoning,
      ),
    },
    source: catalog,
    fieldSources: sources,
  }
  const set = <K extends keyof DiscoveredModel>(
    key: K,
    value: DiscoveredModel[K] | undefined,
  ) => {
    if (value !== undefined) out[key] = value
  }
  set('name', pick('name', vendor.name, facts.name))
  set('ownedBy', vendor.ownedBy)
  set('created', vendor.created)
  const runtimeOnly = context.runtimeContextOnly === true
  set(
    'contextWindowTokens',
    pick(
      'contextWindowTokens',
      vendor.contextWindowTokens,
      runtimeOnly ? undefined : facts.contextWindowTokens,
    ),
  )
  set(
    'maxInputTokens',
    pick(
      'maxInputTokens',
      vendor.maxInputTokens,
      runtimeOnly ? undefined : facts.maxInputTokens,
    ),
  )
  set(
    'maxOutputTokens',
    pick('maxOutputTokens', vendor.maxOutputTokens, facts.maxOutputTokens),
  )
  set('reasoning', mergeReasoning(vendor, facts, sources))
  set(
    'acceptsTemperature',
    pick(
      'acceptsTemperature',
      vendor.acceptsTemperature,
      facts.acceptsTemperature,
    ),
  )
  set('modalities', pick('modalities', vendor.modalities, facts.modalities))
  set(
    'pricingUsdPerMTok',
    pick('pricing', vendor.pricingUsdPerMTok, facts.pricingUsdPerMTok),
  )
  set('lifecycle', pick('lifecycle', vendor.lifecycle, facts.lifecycle))
  if (facts.source !== 'fallback') out.catalogKey = facts.key
  const entry = context.catalogByKey.get(facts.key)
  set('family', entry?.family)
  set('releaseDate', entry?.releaseDate)

  const vendorReported = (
    [
      'contextWindowTokens',
      'maxInputTokens',
      'maxOutputTokens',
      'toolCall',
      'vision',
      'reasoning',
      'reasoningEfforts',
    ] as const
  ).some((field) => sources[field] === VENDOR)
  if (vendorReported) out.source = VENDOR
  return out
}

/**
 * The vendor's efforts win; how thinking is controlled comes from the
 * vendor when it says, else from the catalog, else — efforts but no word
 * on switching off — `always`, so the UI never offers an "off" that the
 * vendor may reject (as MOD-01 does for models.dev gaps).
 */
function mergeReasoning(
  vendor: VendorModel,
  facts: ModelFacts,
  sources: DiscoveredModel['fieldSources'],
): ModelFacts['reasoning'] {
  const own = vendor.reasoning
  if (!own) {
    if (facts.reasoning) sources.reasoningEfforts = facts.source
    return facts.reasoning ? structuredClone(facts.reasoning) : undefined
  }
  sources.reasoningEfforts = VENDOR
  const control =
    own.control ??
    facts.reasoning?.control ??
    (own.efforts.length ? 'always' : 'toggle')
  const merged: NonNullable<ModelFacts['reasoning']> = {
    efforts: [...own.efforts],
    control,
  }
  const fallback = own.defaultEffort ?? facts.reasoning?.defaultEffort
  if (
    fallback &&
    (merged.efforts.length === 0 || merged.efforts.includes(fallback))
  )
    merged.defaultEffort = fallback
  return merged
}

/** A catalog recommendation (no list endpoint) in the listed-model shape. */
export function catalogModel(entry: CatalogModel): DiscoveredModel {
  const { facts } = entry
  const source = facts.source
  const sources: DiscoveredModel['fieldSources'] = { kind: source }
  const out: DiscoveredModel = {
    id: entry.modelId,
    kind: facts.kind,
    capabilities: { ...facts.capabilities },
    source,
    fieldSources: sources,
    catalogKey: facts.key,
  }
  const mark = (field: DiscoveredFactField, present: boolean) => {
    if (present) sources[field] = source
  }
  if (facts.name !== undefined) out.name = facts.name
  mark('name', facts.name !== undefined)
  if (facts.contextWindowTokens !== undefined)
    out.contextWindowTokens = facts.contextWindowTokens
  mark('contextWindowTokens', facts.contextWindowTokens !== undefined)
  if (facts.maxInputTokens !== undefined)
    out.maxInputTokens = facts.maxInputTokens
  mark('maxInputTokens', facts.maxInputTokens !== undefined)
  if (facts.maxOutputTokens !== undefined)
    out.maxOutputTokens = facts.maxOutputTokens
  mark('maxOutputTokens', facts.maxOutputTokens !== undefined)
  mark('toolCall', facts.capabilities.toolCall !== undefined)
  mark('vision', facts.capabilities.vision !== undefined)
  mark('reasoning', facts.capabilities.reasoning !== undefined)
  if (facts.reasoning) out.reasoning = structuredClone(facts.reasoning)
  mark('reasoningEfforts', facts.reasoning !== undefined)
  if (facts.acceptsTemperature !== undefined)
    out.acceptsTemperature = facts.acceptsTemperature
  mark('acceptsTemperature', facts.acceptsTemperature !== undefined)
  if (facts.modalities) out.modalities = [...facts.modalities]
  mark('modalities', facts.modalities !== undefined)
  if (facts.pricingUsdPerMTok)
    out.pricingUsdPerMTok = { ...facts.pricingUsdPerMTok }
  mark('pricing', facts.pricingUsdPerMTok !== undefined)
  if (facts.lifecycle) out.lifecycle = { ...facts.lifecycle }
  mark('lifecycle', facts.lifecycle !== undefined)
  if (entry.family) out.family = entry.family
  if (entry.releaseDate) out.releaseDate = entry.releaseDate
  return out
}
