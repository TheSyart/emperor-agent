import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join, resolve } from 'node:path'
import { ValidationError } from '../errors'
import { PROVIDERS, findByName, normalizeApiBase } from '../llm/catalog'
import { isSealedSecret, type SecretSealer } from '../security/secret-sealer'
import { logger } from '../util/log'
import {
  AtomicSnapshot,
  type PersistenceAdapter,
  type SnapshotCodec,
  assertNotNewerSync,
} from '../store/persistence'

/** 单模型配置文件。磁盘只保存 schemaVersion=2；旧字段仅通过只读 adapter 暂时兼容。 */
export const MODEL_CONFIG_FILE = 'model_config.json'
export const MODEL_CONFIG_V1_BACKUP_FILE = 'model_config.v1-backup.json'
export const MODEL_CONFIG_EXAMPLE_FILE = 'model_config.example.json'
/** The copy of a file that still held plaintext keys, made before sealing them (SEC-06). */
export const MODEL_CONFIG_PRE_SEAL_PREFIX = `${MODEL_CONFIG_FILE}.pre-seal-`

/** What a model entry's sealed `apiKey` is bound to: it opens only there. */
export function modelApiKeyContext(entryId: string): string {
  return `${MODEL_CONFIG_FILE}#models/${entryId}/apiKey`
}

export type ModelProtocol = 'openai' | 'anthropic'

/**
 * How an entry's requests travel when its provider offers a choice (KRN-07).
 * DeepSeek's official host defaults to the Anthropic Messages API;
 * `chat-completions` keeps that entry on the OpenAI-compatible
 * `/chat/completions` endpoint. In a hand-edited file,
 * `"protocol": "chat-completions"` means the same and is read as protocol
 * `openai` with this transport.
 */
export type ModelTransport = 'chat-completions'

export interface ModelCapabilityOverrides {
  toolCall?: boolean
  vision?: boolean
  reasoning?: boolean
}

export interface ModelEntryLegacyData {
  temperature?: number | null
  extraHeaders?: Record<string, string> | null
  extraBody?: Record<string, unknown> | null
}

export interface ModelPricing {
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  cacheReadUsdPerMillionTokens: number
  cacheWriteUsdPerMillionTokens: number
}

export type ModelFallbackTrigger = 'rate_limit' | 'transient'

export interface ModelExecutionPolicy {
  fallback: {
    enabled: boolean
    entryId: string | null
    triggerOn: ModelFallbackTrigger[]
  }
  cost: { maxUsdPerAgentTurn: number | null }
}

export interface ModelUsageCost {
  costUsdNanos: number | null
  complete: boolean
}

/** Fields a user can lock against metadata refreshes (MOD-03). */
export type ModelMetadataField =
  | 'contextWindowTokens'
  | 'maxTokens'
  | 'pricing'
  | 'capabilities'
  | 'reasoningEffort'
  | 'displayName'

export const ALL_METADATA_FIELDS: readonly ModelMetadataField[] = [
  'contextWindowTokens',
  'maxTokens',
  'pricing',
  'capabilities',
  'reasoningEffort',
  'displayName',
]

export type ModelEntryKind =
  'chat' | 'embedding' | 'rerank' | 'image' | 'audio' | 'other'

export type ModelEntryReasoningControl =
  'effort' | 'toggle' | 'budget' | 'always'

export interface ModelEntryLimits {
  maxInputTokens?: number
  maxOutputTokens?: number
}

/** What discovery found out about the model (vendor API or catalog). */
export interface ModelEntryDetected {
  toolCall?: boolean
  vision?: boolean
  reasoning?: boolean
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
  reasoningControl?: ModelEntryReasoningControl
  acceptsTemperature?: boolean
  modalities?: string[]
  kind?: ModelEntryKind
}

export type ModelMetadataSource =
  'vendor_api' | 'catalog' | 'family_rule' | 'fallback' | 'manual'

export interface ModelEntryMetadata {
  name?: string
  source: ModelMetadataSource
  catalogKey?: string
  catalogVersion?: string
  checkedAt?: string
  userLocked?: ModelMetadataField[]
  pricingSource?: 'catalog' | 'vendor_api' | 'manual'
  lifecycle?: {
    status?: 'active' | 'deprecated' | 'retired'
    retiresAt?: string
    replacement?: string
  }
}

export interface ModelEntrySampling {
  temperature?: number | null
  topP?: number | null
}

export interface ModelEntryV2 {
  entryId: string
  provider: string
  protocol: ModelProtocol
  /** Keeps a DeepSeek entry on chat-completions (KRN-07); absent: the provider's default. */
  transport?: ModelTransport
  modelId: string
  displayName?: string
  apiBase: string
  apiKey: string | null
  capabilityOverrides?: ModelCapabilityOverrides
  contextWindowTokens: number
  maxTokens: number
  reasoningEffort: string | null
  pricing?: ModelPricing
  legacy?: ModelEntryLegacyData
  /** Entries on one connection share it; a key change updates them all. */
  connectionId?: string
  limits?: ModelEntryLimits
  detected?: ModelEntryDetected
  /** Where the entry's facts came from; old entries read as manual. */
  metadata?: ModelEntryMetadata
  sampling?: ModelEntrySampling
}

/** An entry in the file that failed validation (CORE-30): kept, reported. */
export interface RejectedModelEntry {
  index: number
  entryId: string | null
  modelId: string | null
  reason: string
  raw: Record<string, unknown>
}

export interface ModelConfigV2 {
  schemaVersion: 2
  activeModelId: string | null
  models: ModelEntryV2[]
  policy?: ModelExecutionPolicy
}

/** @deprecated Task 2 删除；只为旧 router/CoreApi 在迁移期间提供内存视图。 */
export interface AgentDefaults {
  model: string
  provider: string
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  contextWindowTokens: number
}

/** @deprecated Task 2 删除；不会写入 v2 磁盘。 */
export interface ProviderConfig {
  apiKey: string | null
  apiBase: string | null
  extraHeaders: Record<string, string> | null
  extraBody: Record<string, unknown> | null
}

/** @deprecated aliases 不会出现在 config.raw 或磁盘。 */
export interface ModelEntry {
  entryId?: string
  provider: string
  protocol?: ModelProtocol
  transport?: ModelTransport
  modelId?: string
  displayName?: string
  apiBase: string | null
  apiKey: string | null
  capabilityOverrides?: ModelCapabilityOverrides
  pricing?: ModelPricing
  contextWindowTokens: number | null
  maxTokens: number | null
  reasoningEffort: string | null
  legacy?: ModelEntryLegacyData
  connectionId?: string
  limits?: ModelEntryLimits
  detected?: ModelEntryDetected
  metadata?: ModelEntryMetadata
  sampling?: ModelEntrySampling
  name: string
  id: string
  mainModelId: string
  secondaryModelId: string
  label: string
  extraHeaders: Record<string, string> | null
  extraBody: Record<string, unknown> | null
  temperature: number | null
  supportsVision: boolean
}

export interface ModelConfig {
  schemaVersion: 2
  activeModelId: string | null
  models: ModelEntry[]
  policy: ModelExecutionPolicy
  raw: ModelConfigV2 & Record<string, unknown>
  /**
   * Entries whose sealed key cannot be opened (the local key file is gone
   * or was replaced): their `apiKey` reads as null and Settings asks for it
   * again. The sealed value stays on disk until re-entered or cleared.
   */
  credentialsNeedingReentry: string[]
  /**
   * Entries in the file that failed validation. They stay on disk (an
   * older or hand-edited file), out of `models`, until repaired (saved
   * again with the same entryId) or discarded.
   */
  rejectedEntries: RejectedModelEntry[]
  /** @deprecated compatibility view; never serialized. */
  defaults: AgentDefaults
  /** @deprecated compatibility view; never serialized. */
  providers: Record<string, ProviderConfig>
}

export interface WizardModelSettings {
  provider: string
  name: string
  label: string
  apiKey: string
  apiBase: string
  mainModelId: string
  secondaryModelId: string
  maxTokens: number
  temperature: number
  contextWindowTokens: number
  reasoningEffort?: string | null
}

export type ModelEntryUpdate = Omit<
  Partial<ModelEntryV2>,
  'pricing' | 'transport'
> & {
  apiKey?: string | null
  pricing?: ModelPricing | null
  /** null returns the entry to its provider's default transport. */
  transport?: ModelTransport | null
}

type RawRecord = Record<string, any>

export interface ModelConfigPersistenceOptions {
  persistenceAdapter?: PersistenceAdapter
  /**
   * SEC-06: opens sealed `apiKey` values on load and seals keys on save.
   * Absent: values stay as written, and a sealed one cannot be used.
   */
  sealer?: SecretSealer | null
}

const REMOVED_PROVIDERS = new Set([
  'azure_openai',
  'bedrock',
  'openai_codex',
  'github_copilot',
])

export function defaultModelConfig(): ModelConfigV2 {
  return { schemaVersion: 2, activeModelId: null, models: [] }
}

export function defaultModelExecutionPolicy(): ModelExecutionPolicy {
  return {
    fallback: {
      enabled: false,
      entryId: null,
      triggerOn: ['rate_limit'],
    },
    cost: { maxUsdPerAgentTurn: null },
  }
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalRecord(value: unknown): RawRecord | null {
  return isRecord(value) ? value : null
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function customDisplayName(value: unknown): string | null {
  const text = optionalString(value)
  if (!text) return null
  const normalized = text.toLowerCase()
  if (normalized === 'default' || normalized === 'default · secondary')
    return null
  return text
}

function positiveInteger(value: unknown, field: string): number {
  const text = typeof value === 'string' ? value.trim() : null
  const parsed =
    typeof value === 'number'
      ? value
      : text && /^\d+$/.test(text)
        ? Number(text)
        : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new ValidationError(`${field} 必须是正整数`)
  return parsed
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isMaskedSecret(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text.startsWith('***') || /^[A-Za-z0-9_-]+-\*{3}/.test(text)
}

export function maskSecret(value: string | null | undefined): string {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= 4) return '***'
  return `***${text.slice(-4)}`
}

function canonicalProviderName(value: unknown): string | null {
  const name = optionalString(value)
  if (!name) return null
  if (name.replace(/-/g, '_').toLowerCase() === 'custom') return 'custom'
  return findByName(name)?.name ?? null
}

function providerSpec(name: string): RawRecord | undefined {
  const canonical = canonicalProviderName(name)
  return canonical
    ? (findByName(canonical) as unknown as RawRecord | undefined)
    : undefined
}

function defaultApiBase(provider: string, protocol: ModelProtocol): string {
  const spec = providerSpec(provider)
  const apiBases = optionalRecord(spec?.apiBases)
  const protocolBase = optionalString(apiBases?.[protocol])
  if (protocolBase) return protocolBase
  const legacyBase = optionalString(spec?.defaultApiBase)
  if (legacyBase) return legacyBase
  return protocol === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1'
}

function normalizeCapabilityOverrides(
  value: unknown,
): ModelCapabilityOverrides | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value))
    throw new ValidationError('capabilityOverrides 必须是对象')
  const result: ModelCapabilityOverrides = {}
  for (const key of ['toolCall', 'vision', 'reasoning'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean')
      throw new ValidationError(`capabilityOverrides.${key} 必须是布尔值`)
    result[key] = value[key]
  }
  return Object.keys(result).length ? result : undefined
}

function normalizeLegacy(value: unknown): ModelEntryLegacyData | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new ValidationError('legacy 必须是对象')
  const result: ModelEntryLegacyData = {}
  if ('temperature' in value)
    result.temperature = optionalNumber(value.temperature) ?? null
  if ('extraHeaders' in value) {
    if (value.extraHeaders === null) result.extraHeaders = null
    else if (isRecord(value.extraHeaders)) {
      result.extraHeaders = Object.fromEntries(
        Object.entries(value.extraHeaders).map(([key, item]) => [
          key,
          String(item),
        ]),
      )
    } else throw new ValidationError('legacy.extraHeaders 必须是对象或 null')
  }
  if ('extraBody' in value) {
    if (value.extraBody === null) result.extraBody = null
    else if (isRecord(value.extraBody))
      result.extraBody = structuredClone(value.extraBody)
    else throw new ValidationError('legacy.extraBody 必须是对象或 null')
  }
  return Object.keys(result).length ? result : undefined
}

function normalizePricing(value: unknown): ModelPricing | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new ValidationError('pricing 必须是对象')
  const result = {} as ModelPricing
  for (const key of [
    'inputUsdPerMillionTokens',
    'outputUsdPerMillionTokens',
    'cacheReadUsdPerMillionTokens',
    'cacheWriteUsdPerMillionTokens',
  ] as const) {
    const parsed = Number(value[key])
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new ValidationError(`pricing.${key} 必须是非负有限数值`)
    result[key] = parsed
  }
  return result
}

export function newEntryId(): string {
  return `model-${randomUUID()}`
}

function newConnectionId(): string {
  return `conn-${randomUUID()}`
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? [...new Set(items)] : undefined
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function compact<T extends object>(value: T): T | undefined {
  return Object.values(value).some((item) => item !== undefined)
    ? (Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined),
      ) as T)
    : undefined
}

/*
 * The MOD-03 fields are optional and never reject an entry: a malformed
 * value is dropped, the rest of the entry stays usable.
 */
function normalizeLimits(value: unknown): ModelEntryLimits | undefined {
  if (!isRecord(value)) return undefined
  return compact({
    maxInputTokens: positiveIntegerOrUndefined(value.maxInputTokens),
    maxOutputTokens: positiveIntegerOrUndefined(value.maxOutputTokens),
  })
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeDetected(value: unknown): ModelEntryDetected | undefined {
  if (!isRecord(value)) return undefined
  return compact<ModelEntryDetected>({
    toolCall: booleanOrUndefined(value.toolCall),
    vision: booleanOrUndefined(value.vision),
    reasoning: booleanOrUndefined(value.reasoning),
    reasoningEfforts: stringList(value.reasoningEfforts),
    defaultReasoningEffort:
      optionalString(value.defaultReasoningEffort) ?? undefined,
    reasoningControl: oneOf(value.reasoningControl, [
      'effort',
      'toggle',
      'budget',
      'always',
    ] as const),
    acceptsTemperature: booleanOrUndefined(value.acceptsTemperature),
    modalities: stringList(value.modalities),
    kind: oneOf(value.kind, [
      'chat',
      'embedding',
      'rerank',
      'image',
      'audio',
      'other',
    ] as const),
  })
}

const METADATA_SOURCES = [
  'vendor_api',
  'catalog',
  'family_rule',
  'fallback',
  'manual',
] as const

/** Old entries (no metadata) read as manual and locked everywhere. */
export function effectiveMetadata(
  entry: Pick<ModelEntryV2, 'metadata'>,
): ModelEntryMetadata {
  return entry.metadata
    ? structuredClone(entry.metadata)
    : { source: 'manual', userLocked: [...ALL_METADATA_FIELDS] }
}

function normalizeMetadata(value: unknown): ModelEntryMetadata | undefined {
  if (!isRecord(value)) return undefined
  const source = oneOf(value.source, METADATA_SOURCES) ?? 'manual'
  const locked = Array.isArray(value.userLocked)
    ? ALL_METADATA_FIELDS.filter((field) =>
        (value.userLocked as unknown[]).includes(field),
      )
    : source === 'manual'
      ? [...ALL_METADATA_FIELDS]
      : undefined
  const lifecycle = isRecord(value.lifecycle)
    ? compact({
        status: oneOf(value.lifecycle.status, [
          'active',
          'deprecated',
          'retired',
        ] as const),
        retiresAt: optionalString(value.lifecycle.retiresAt) ?? undefined,
        replacement: optionalString(value.lifecycle.replacement) ?? undefined,
      })
    : undefined
  const result: ModelEntryMetadata = { source }
  const name = optionalString(value.name)
  if (name) result.name = name
  for (const key of ['catalogKey', 'catalogVersion', 'checkedAt'] as const) {
    const text = optionalString(value[key])
    if (text) result[key] = text
  }
  if (locked) result.userLocked = locked
  const pricingSource = oneOf(value.pricingSource, [
    'catalog',
    'vendor_api',
    'manual',
  ] as const)
  if (pricingSource) result.pricingSource = pricingSource
  if (lifecycle) result.lifecycle = lifecycle
  return result
}

function samplingNumber(
  value: unknown,
  min: number,
  max: number,
): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined
}

function normalizeSampling(value: unknown): ModelEntrySampling | undefined {
  if (!isRecord(value)) return undefined
  return compact<ModelEntrySampling>({
    temperature: samplingNumber(value.temperature, 0, 2),
    topP: samplingNumber(value.topP, 0, 1),
  })
}

/** displayName, else the catalog/vendor name, else the model id. */
export function effectiveDisplayName(
  entry: Pick<ModelEntryV2, 'displayName' | 'metadata' | 'modelId'>,
): string {
  return entry.displayName || entry.metadata?.name || entry.modelId
}

/**
 * The temperature a request carries: the entry's sampling setting (or the
 * old `legacy.temperature`), never for a model known not to accept one.
 */
export function entryTemperature(
  entry: Pick<ModelEntryV2, 'sampling' | 'legacy' | 'detected'>,
): number | null {
  if (entry.detected?.acceptsTemperature === false) return null
  const sampled = entry.sampling?.temperature
  if (typeof sampled === 'number') return sampled
  return entry.legacy?.temperature ?? null
}

/** Same provider, protocol and normalized address: one endpoint. */
function sameEndpoint(a: ModelEntryV2, b: ModelEntryV2): boolean {
  return (
    a.provider === b.provider &&
    a.protocol === b.protocol &&
    normalizeApiBase(a.protocol, a.apiBase) ===
      normalizeApiBase(b.protocol, b.apiBase)
  )
}

/**
 * Entries on one connection: the same connectionId, or the same endpoint
 * when either has none (files written before connection ids).
 */
export function sameConnection(a: ModelEntryV2, b: ModelEntryV2): boolean {
  if (a.connectionId && b.connectionId) return a.connectionId === b.connectionId
  return sameEndpoint(a, b)
}

function normalizeEntry(
  input: RawRecord,
  options: { allowMissingEntryId?: boolean } = {},
): ModelEntryV2 {
  const entryId = optionalString(input.entryId)
  if (!entryId && !options.allowMissingEntryId)
    throw new ValidationError('entryId 不能为空')
  const submittedProvider = optionalString(input.provider)
  const provider = canonicalProviderName(submittedProvider)
  if (!provider || REMOVED_PROVIDERS.has(provider))
    throw new ValidationError(`provider 无效: ${submittedProvider ?? ''}`)
  let protocol = optionalString(input.protocol)
  let transport = optionalString(input.transport)
  // KRN-07: the documented shorthand for an OpenAI-protocol entry that
  // stays on chat-completions.
  if (protocol === 'chat-completions') {
    protocol = 'openai'
    transport = 'chat-completions'
  }
  if (protocol !== 'openai' && protocol !== 'anthropic')
    throw new ValidationError(`protocol 无效: ${protocol ?? ''}`)
  if (transport !== null && transport !== 'chat-completions')
    throw new ValidationError(`transport 无效: ${transport}`)
  const protocols = findByName(provider)?.protocols ?? []
  if (!protocols.includes(protocol))
    throw new ValidationError(
      `provider ${provider} 不支持 protocol: ${protocol}`,
    )
  const modelId = optionalString(input.modelId)
  if (!modelId) throw new ValidationError('modelId 不能为空')
  const submittedApiBase = optionalString(input.apiBase)
  if (!submittedApiBase) throw new ValidationError('apiBase 不能为空')
  const apiBase = normalizeApiBase(protocol, submittedApiBase)
  if (!apiBase) throw new ValidationError('apiBase 规范化后不能为空')
  const apiKey =
    input.apiKey === null ||
    input.apiKey === undefined ||
    isMaskedSecret(input.apiKey)
      ? null
      : optionalString(input.apiKey)
  const displayName = customDisplayName(input.displayName)
  const capabilityOverrides = normalizeCapabilityOverrides(
    input.capabilityOverrides,
  )
  const legacy = normalizeLegacy(input.legacy)
  const pricing = normalizePricing(input.pricing)
  const result: ModelEntryV2 = {
    entryId: entryId ?? newEntryId(),
    provider,
    protocol,
    modelId,
    apiBase,
    apiKey,
    contextWindowTokens: positiveInteger(
      input.contextWindowTokens,
      'contextWindowTokens',
    ),
    maxTokens: positiveInteger(input.maxTokens, 'maxTokens'),
    reasoningEffort: optionalString(input.reasoningEffort),
  }
  if (transport) result.transport = transport
  if (displayName) result.displayName = displayName
  if (capabilityOverrides) result.capabilityOverrides = capabilityOverrides
  if (pricing) result.pricing = pricing
  if (legacy) result.legacy = legacy
  const connectionId = optionalString(input.connectionId)
  if (connectionId) result.connectionId = connectionId
  const limits = normalizeLimits(input.limits)
  if (limits) result.limits = limits
  const detected = normalizeDetected(input.detected)
  if (detected) result.detected = detected
  const metadata = normalizeMetadata(input.metadata)
  if (metadata) result.metadata = metadata
  const sampling = normalizeSampling(input.sampling)
  if (sampling) result.sampling = sampling
  return result
}

function normalizeExecutionPolicy(
  value: unknown,
  models: readonly ModelEntryV2[],
  activeModelId: string | null,
): ModelExecutionPolicy {
  const defaults = defaultModelExecutionPolicy()
  if (value === undefined) return defaults
  if (!isRecord(value)) throw new ValidationError('policy 必须是对象')
  const fallback = value.fallback
  const cost = value.cost
  if (fallback !== undefined && !isRecord(fallback))
    throw new ValidationError('policy.fallback 必须是对象')
  if (cost !== undefined && !isRecord(cost))
    throw new ValidationError('policy.cost 必须是对象')
  const fallbackRecord = fallback ?? {}
  const costRecord = cost ?? {}
  const enabled = fallbackRecord.enabled ?? defaults.fallback.enabled
  if (typeof enabled !== 'boolean')
    throw new ValidationError('policy.fallback.enabled 必须是布尔值')
  const entryId = optionalString(fallbackRecord.entryId)
  const rawTriggers = fallbackRecord.triggerOn ?? defaults.fallback.triggerOn
  if (!Array.isArray(rawTriggers) || !rawTriggers.length)
    throw new ValidationError('policy.fallback.triggerOn 必须是非空数组')
  const triggerSet = new Set<ModelFallbackTrigger>()
  for (const trigger of rawTriggers) {
    if (trigger !== 'rate_limit' && trigger !== 'transient')
      throw new ValidationError(
        'policy.fallback.triggerOn 只允许 rate_limit 或 transient',
      )
    triggerSet.add(trigger)
  }
  const triggerOn = (['rate_limit', 'transient'] as const).filter((trigger) =>
    triggerSet.has(trigger),
  )
  let maxUsdPerAgentTurn: number | null = null
  if (
    costRecord.maxUsdPerAgentTurn !== undefined &&
    costRecord.maxUsdPerAgentTurn !== null &&
    costRecord.maxUsdPerAgentTurn !== ''
  ) {
    const parsed = Number(costRecord.maxUsdPerAgentTurn)
    const nanos = Math.round(parsed * 1_000_000_000)
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(nanos))
      throw new ValidationError(
        'policy.cost.maxUsdPerAgentTurn 必须是可表示的正数',
      )
    maxUsdPerAgentTurn = parsed
  }
  const byId = new Map(models.map((entry) => [entry.entryId, entry]))
  if (enabled) {
    if (!entryId || !byId.has(entryId))
      throw new ValidationError('policy fallback entryId 必须指向现有模型条目')
    if (entryId === activeModelId)
      throw new ValidationError('policy fallback 不能指向 active 模型')
  }
  // A cost cap is kept even when a referenced model has no prices: it just
  // does not apply to that model (MOD-05).
  return {
    fallback: { enabled, entryId, triggerOn: [...triggerOn] },
    cost: { maxUsdPerAgentTurn },
  }
}

function normalizeV2(raw: RawRecord): ModelConfigV2 {
  if (raw.schemaVersion !== 2)
    throw new ValidationError('model_config schemaVersion 必须为 2')
  if (!Array.isArray(raw.models))
    throw new ValidationError("model_config: 'models' must be an array")
  const models = raw.models.map((item, index) => {
    if (!isRecord(item))
      throw new ValidationError(`第 ${index + 1} 个模型条目格式无效`)
    return normalizeEntry(item, { allowMissingEntryId: true })
  })
  const ids = new Set<string>()
  for (const item of models) {
    if (ids.has(item.entryId))
      throw new ValidationError(`entryId 重复: ${item.entryId}`)
    ids.add(item.entryId)
  }
  const activeModelId = optionalString(raw.activeModelId)
  const result: ModelConfigV2 = {
    schemaVersion: 2,
    activeModelId: models.length ? activeModelId : null,
    models,
  }
  const policy = normalizeExecutionPolicy(
    raw.policy,
    models,
    result.activeModelId,
  )
  if (raw.policy !== undefined) result.policy = policy
  return result
}

interface LenientV2 {
  config: ModelConfigV2
  rejected: RejectedModelEntry[]
  /** The file's models in order: normalized entries and rejected raw ones. */
  diskModels: unknown[]
}

/**
 * Read a v2 file entry by entry (CORE-30): a bad entry goes to `rejected`
 * and stays in `diskModels` at its place; the others load normally. A
 * policy that no longer validates (its fallback was rejected) is dropped.
 */
function normalizeV2Lenient(raw: RawRecord): LenientV2 {
  if (raw.schemaVersion !== 2)
    throw new ValidationError('model_config schemaVersion 必须为 2')
  if (!Array.isArray(raw.models))
    throw new ValidationError("model_config: 'models' must be an array")
  const models: ModelEntryV2[] = []
  const rejected: RejectedModelEntry[] = []
  const diskModels: unknown[] = []
  const ids = new Set<string>()
  raw.models.forEach((item: unknown, index: number) => {
    const record = isRecord(item) ? item : {}
    try {
      if (!isRecord(item))
        throw new ValidationError(`第 ${index + 1} 个模型条目格式无效`)
      const entry = normalizeEntry(item, { allowMissingEntryId: true })
      if (ids.has(entry.entryId))
        throw new ValidationError(`entryId 重复: ${entry.entryId}`)
      ids.add(entry.entryId)
      models.push(entry)
      diskModels.push(entry)
    } catch (error) {
      rejected.push({
        index,
        entryId: optionalString(record.entryId),
        modelId: optionalString(record.modelId),
        reason: error instanceof Error ? error.message : String(error),
        raw: structuredClone(record),
      })
      diskModels.push(item)
    }
  })
  const activeModelId = optionalString(raw.activeModelId)
  const config: ModelConfigV2 = {
    schemaVersion: 2,
    activeModelId: models.length ? activeModelId : null,
    models,
  }
  if (raw.policy !== undefined) {
    try {
      config.policy = normalizeExecutionPolicy(
        raw.policy,
        models,
        config.activeModelId,
      )
    } catch (error) {
      logger.warn('model_config policy dropped; it no longer validates', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { config, rejected, diskModels }
}

/** The rejected entries in a stored file (raw), or none. */
function storedRejected(stored: unknown): RejectedModelEntry[] {
  if (!isRecord(stored) || stored.schemaVersion !== 2) return []
  try {
    return normalizeV2Lenient(stored).rejected
  } catch {
    return []
  }
}

function providerNames(): string[] {
  return (PROVIDERS as readonly unknown[])
    .map((item) => (isRecord(item) ? optionalString(item.name) : null))
    .filter((name): name is string => Boolean(name))
}

function compatibilityEntry(entry: ModelEntryV2): ModelEntry {
  const name = effectiveDisplayName(entry)
  return {
    ...structuredClone(entry),
    name,
    id: entry.modelId,
    mainModelId: entry.modelId,
    secondaryModelId: entry.modelId,
    label: entry.displayName || entry.metadata?.name || '',
    extraHeaders: entry.legacy?.extraHeaders ?? null,
    extraBody: entry.legacy?.extraBody ?? null,
    temperature: entryTemperature(entry),
    supportsVision:
      entry.capabilityOverrides?.vision ?? entry.detected?.vision ?? false,
  }
}

/** Tests: the runtime view of one entry, as routes and profiles read it. */
export const compatibilityEntryForTest = compatibilityEntry

function runtimeConfig(
  raw: ModelConfigV2,
  unreadable: ReadonlyMap<string, string> = new Map(),
  rejected: readonly RejectedModelEntry[] = [],
): ModelConfig {
  const clean = structuredClone(raw)
  const needingReentry = new Set(unreadable.keys())
  // A sealed value that was not opened is never a usable key.
  for (const entry of clean.models)
    if (isSealedSecret(entry.apiKey)) {
      needingReentry.add(entry.entryId)
      entry.apiKey = null
    }
  const models = clean.models.map(compatibilityEntry)
  const active = clean.activeModelId
    ? models.find((entry) => entry.entryId === clean.activeModelId)
    : undefined
  const providers: Record<string, ProviderConfig> = {}
  for (const name of new Set([
    ...providerNames(),
    ...models.map((m) => m.provider),
  ])) {
    const model = models.find((entry) => entry.provider === name)
    providers[name] = {
      apiKey: model?.apiKey ?? null,
      apiBase:
        model?.apiBase ??
        defaultApiBase(name, findByName(name)?.defaultProtocol ?? 'openai'),
      extraHeaders: model?.legacy?.extraHeaders ?? null,
      extraBody: model?.legacy?.extraBody ?? null,
    }
  }
  return {
    schemaVersion: 2,
    activeModelId: clean.activeModelId,
    models,
    policy: normalizeExecutionPolicy(
      clean.policy,
      clean.models,
      clean.activeModelId,
    ),
    raw: clean as ModelConfigV2 & Record<string, unknown>,
    credentialsNeedingReentry: clean.models
      .map((entry) => entry.entryId)
      .filter((entryId) => needingReentry.has(entryId)),
    rejectedEntries: structuredClone([...rejected]),
    defaults: {
      model: active?.entryId ?? '',
      provider: active?.provider ?? 'auto',
      maxTokens: active?.maxTokens ?? 8192,
      temperature: active?.legacy?.temperature ?? 0.1,
      reasoningEffort: active?.reasoningEffort ?? null,
      contextWindowTokens: active?.contextWindowTokens ?? 128000,
    },
    providers,
  }
}

function legacyCandidates(
  entry: RawRecord,
  provider: RawRecord,
  defaults: RawRecord,
  key: string,
): unknown[] {
  return [entry[key], provider[key], defaults[key]]
}

function firstLegacyString(values: unknown[]): string | null {
  for (const value of values) {
    const text = optionalString(value)
    if (text) return text
  }
  return null
}

function firstLegacyPositiveInteger(
  values: unknown[],
  fallback: number,
): number {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : null
    const parsed =
      typeof value === 'number'
        ? value
        : text && /^\d+$/.test(text)
          ? Number(text)
          : Number.NaN
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return fallback
}

function firstLegacyNumber(values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function firstLegacyRecord(values: unknown[]): RawRecord | null {
  for (const value of values) {
    if (isRecord(value)) return value
  }
  return null
}

function realLegacySecret(...values: unknown[]): string | null {
  for (const value of values) {
    const text = optionalString(value)
    if (text && !isMaskedSecret(text)) return text
  }
  return null
}

function migrateV1(raw: RawRecord): ModelConfigV2 {
  const defaults = optionalRecord(optionalRecord(raw.agents)?.defaults) ?? {}
  const providerBlocks = optionalRecord(raw.providers) ?? {}
  const legacyModels = Array.isArray(raw.models)
    ? raw.models.filter(isRecord)
    : []
  const activeLegacyName = optionalString(defaults.model)
  const models: ModelEntryV2[] = []
  let activeModelId: string | null = null

  for (const legacyEntry of legacyModels) {
    let submittedProvider =
      optionalString(legacyEntry.provider) ??
      optionalString(defaults.provider) ??
      'custom'
    const mainModelId = optionalString(
      legacyEntry.mainModelId ?? legacyEntry.id ?? legacyEntry.modelId,
    )
    if (submittedProvider.toLowerCase() === 'auto' && mainModelId)
      submittedProvider = resolveProviderName('auto', mainModelId, {})
    const provider = canonicalProviderName(submittedProvider)
    if (!provider || REMOVED_PROVIDERS.has(provider)) continue
    if (!mainModelId) continue
    const protocol: ModelProtocol =
      findByName(provider)?.defaultProtocol ?? 'openai'
    const providerBlock = optionalRecord(providerBlocks[provider]) ?? {}
    const apiKey = realLegacySecret(
      legacyEntry.apiKey,
      providerBlock.apiKey,
      defaults.apiKey,
    )
    const apiBase = normalizeApiBase(
      protocol,
      firstLegacyString(
        legacyCandidates(legacyEntry, providerBlock, defaults, 'apiBase'),
      ) ?? defaultApiBase(provider, protocol),
    )
    const maxTokens = firstLegacyPositiveInteger(
      legacyCandidates(legacyEntry, providerBlock, defaults, 'maxTokens'),
      8192,
    )
    const contextWindowTokens = firstLegacyPositiveInteger(
      legacyCandidates(
        legacyEntry,
        providerBlock,
        defaults,
        'contextWindowTokens',
      ),
      128000,
    )
    const reasoningEffort = firstLegacyString(
      legacyCandidates(legacyEntry, providerBlock, defaults, 'reasoningEffort'),
    )
    const temperature = firstLegacyNumber(
      legacyCandidates(legacyEntry, providerBlock, defaults, 'temperature'),
    )
    const extraHeaders = firstLegacyRecord(
      legacyCandidates(legacyEntry, providerBlock, defaults, 'extraHeaders'),
    )
    const extraBody = firstLegacyRecord(
      legacyCandidates(legacyEntry, providerBlock, defaults, 'extraBody'),
    )
    const legacy: ModelEntryLegacyData = {
      temperature: temperature ?? null,
      extraHeaders: extraHeaders
        ? Object.fromEntries(
            Object.entries(extraHeaders).map(([key, value]) => [
              key,
              String(value),
            ]),
          )
        : null,
      extraBody: extraBody ? structuredClone(extraBody) : null,
    }
    const legacyLabel = customDisplayName(legacyEntry.label)
    const legacyName = customDisplayName(legacyEntry.name)
    const customName = legacyLabel ?? legacyName
    const modelIds = [mainModelId]
    const secondary = optionalString(legacyEntry.secondaryModelId)
    if (secondary && secondary !== mainModelId) modelIds.push(secondary)

    for (const [position, modelId] of modelIds.entries()) {
      const migrated: ModelEntryV2 = {
        entryId: newEntryId(),
        provider,
        protocol,
        modelId,
        apiBase,
        apiKey,
        contextWindowTokens,
        maxTokens,
        reasoningEffort,
        legacy: structuredClone(legacy),
      }
      if (customName)
        migrated.displayName =
          position === 0 ? customName : `${customName} · Secondary`
      if ('supportsVision' in legacyEntry)
        migrated.capabilityOverrides = {
          vision: Boolean(legacyEntry.supportsVision),
        }
      models.push(migrated)
      if (
        position === 0 &&
        activeLegacyName &&
        optionalString(legacyEntry.name) === activeLegacyName &&
        !activeModelId
      )
        activeModelId = migrated.entryId
    }
  }
  if (!activeModelId && models.length) activeModelId = models[0]!.entryId
  return { schemaVersion: 2, activeModelId, models }
}

export function parseModelConfig(raw: RawRecord): ModelConfig {
  if (!isRecord(raw)) throw new ValidationError('model_config 必须是对象')
  return runtimeConfig(
    raw.schemaVersion === 2 ? normalizeV2(raw) : migrateV1(raw),
  )
}

export function findEntry(
  config: ModelConfig,
  entryId: string | null | undefined,
): ModelEntry | undefined {
  if (!entryId) return undefined
  return config.models.find(
    (entry) =>
      entry.entryId === entryId ||
      entry.name === entryId ||
      entry.displayName === entryId,
  )
}

export function activeEntry(config: ModelConfig): ModelEntry | undefined {
  return findEntry(config, config.activeModelId)
}

/** @deprecated migration compatibility only. */
export function resolveProviderName(
  provider: string,
  model: string,
  providers: Record<string, ProviderConfig>,
): string {
  if (provider && !['auto', 'default'].includes(provider.toLowerCase())) {
    const canonical = canonicalProviderName(provider)
    if (!canonical || REMOVED_PROVIDERS.has(canonical)) {
      logger.warn("Unknown provider in defaults; falling back to 'custom'", {
        provider,
      })
      return 'custom'
    }
    return canonical
  }
  const normalizedModel = model.toLowerCase().replace(/_/g, '-')
  for (const spec of PROVIDERS as readonly unknown[]) {
    if (!isRecord(spec)) continue
    const name = optionalString(spec.name)
    const keywords = Array.isArray(spec.keywords) ? spec.keywords : []
    if (
      name &&
      !REMOVED_PROVIDERS.has(name) &&
      keywords.some((keyword) =>
        normalizedModel.includes(String(keyword).toLowerCase()),
      )
    )
      return name
  }
  for (const [name, config] of Object.entries(providers)) {
    const canonical = canonicalProviderName(name)
    if (config.apiKey && canonical && !REMOVED_PROVIDERS.has(canonical))
      return canonical
  }
  return 'deepseek'
}

export function validateCompleteModelEntries(
  raw: ModelConfigV2 | RawRecord,
): void {
  const config = raw.schemaVersion === 2 ? normalizeV2(raw) : migrateV1(raw)
  if (!config.models.length) throw new ValidationError('请至少添加一个模型条目')
  if (!config.activeModelId) throw new ValidationError('activeModelId 不能为空')
  if (!config.models.some((entry) => entry.entryId === config.activeModelId))
    throw new ValidationError('activeModelId 必须指向现有模型条目')
}

function configPath(rootOrFile: string): string {
  const path = resolve(rootOrFile)
  return extname(path).toLowerCase() === '.json'
    ? path
    : join(path, MODEL_CONFIG_FILE)
}

export async function ensureModelConfig(
  rootOrFile: string,
  opts: ModelConfigPersistenceOptions = {},
): Promise<string> {
  const path = configPath(rootOrFile)
  if (!existsSync(path))
    await writeModelConfigSnapshot(
      path,
      defaultModelConfig(),
      opts.persistenceAdapter,
    )
  return path
}

export async function ensureExampleConfig(
  root: string,
  opts: ModelConfigPersistenceOptions = {},
): Promise<string> {
  const path = join(resolve(root), MODEL_CONFIG_EXAMPLE_FILE)
  const desired = `${JSON.stringify(defaultModelConfig(), null, 2)}\n`
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== desired)
    await writeModelConfigSnapshot(
      path,
      defaultModelConfig(),
      opts.persistenceAdapter,
    )
  return path
}

function validateDiskConfig(value: unknown): RawRecord {
  if (!isRecord(value)) throw new Error('model_config must be an object')
  // Per-entry problems are reported, not fatal (normalizeV2Lenient).
  if (value.schemaVersion === 2) return normalizeV2Lenient(value) && value
  if (value.schemaVersion !== undefined)
    throw new Error(
      `unsupported model_config schemaVersion: ${value.schemaVersion}`,
    )
  if ('models' in value) {
    if (!Array.isArray(value.models))
      throw new Error("model_config: 'models' must be an array")
    if (value.models.some((entry) => !isRecord(entry)))
      throw new Error('model_config: every model must be an object')
  }
  if ('agents' in value && !isRecord(value.agents))
    throw new Error("model_config: 'agents' must be an object")
  if (
    isRecord(value.agents) &&
    'defaults' in value.agents &&
    !isRecord(value.agents.defaults)
  )
    throw new Error("model_config: 'agents.defaults' must be an object")
  if ('providers' in value) {
    if (!isRecord(value.providers))
      throw new Error("model_config: 'providers' must be an object")
    if (Object.values(value.providers).some((entry) => !isRecord(entry)))
      throw new Error('model_config: every provider must be an object')
  }
  return value
}

const MODEL_CONFIG_SNAPSHOT_CODEC: SnapshotCodec<RawRecord> = {
  schemaVersion: 2,
  versionKey: 'schemaVersion',
  encode(value) {
    return value
  },
  decode(input) {
    const value = validateDiskConfig(input)
    const current = value.schemaVersion === 2
    return {
      value,
      schemaVersion: current ? 2 : 1,
      migrated: !current,
    }
  },
}

function modelConfigSnapshot(
  path: string,
  adapter?: PersistenceAdapter,
): AtomicSnapshot<RawRecord> {
  return new AtomicSnapshot({
    path,
    codec: MODEL_CONFIG_SNAPSHOT_CODEC,
    adapter,
    fileMode: 0o600,
  })
}

async function writeModelConfigSnapshot(
  path: string,
  value: RawRecord,
  adapter?: PersistenceAdapter,
): Promise<void> {
  await modelConfigSnapshot(path, adapter).write(value)
}

async function backupV1(path: string, source: string): Promise<void> {
  const backupPath = join(dirname(path), MODEL_CONFIG_V1_BACKUP_FILE)
  if (existsSync(backupPath)) return
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(backupPath, 'wx', 0o600)
    await handle.writeFile(source, 'utf8')
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    await handle?.close()
  }
}

export async function loadModelConfig(
  rootOrFile: string,
  opts: { create?: boolean } & ModelConfigPersistenceOptions = {},
): Promise<ModelConfig> {
  // A load may rewrite the file (migration, normalization): it takes the
  // same lock as every load-modify-save.
  return withModelConfigLock(rootOrFile, () =>
    loadModelConfigLocked(rootOrFile, opts),
  )
}

async function loadModelConfigLocked(
  rootOrFile: string,
  opts: { create?: boolean } & ModelConfigPersistenceOptions,
): Promise<ModelConfig> {
  const path = configPath(rootOrFile)
  if (opts.create !== false && !existsSync(path))
    await writeModelConfigSnapshot(
      path,
      defaultModelConfig(),
      opts.persistenceAdapter,
    )
  if (!existsSync(path)) return runtimeConfig(defaultModelConfig())

  const source = await readFile(path, 'utf8')
  const loadedSnapshot = await modelConfigSnapshot(
    path,
    opts.persistenceAdapter,
  ).read({
    fallback: defaultModelConfig(),
  })
  if (loadedSnapshot.receipt.recoveryAction === 'quarantined_corrupt_snapshot')
    reportModelConfigRecovery({
      path,
      backupPath: loadedSnapshot.receipt.corruptionBackup ?? '',
      error: new Error('model config failed schema validation'),
    })
  const loaded = loadedSnapshot.value
  // AtomicSnapshot isolates invalid files by renaming them. Do not immediately
  // recreate the invalid path here; the next normal load/explicit save owns
  // creation, matching the existing recovery contract.
  if (!existsSync(path)) return runtimeConfig(defaultModelConfig())
  if (loaded.schemaVersion !== 2) {
    await backupV1(path, source)
    const migrated = migrateV1(loaded)
    // The v1 backup above is this file's copy from before sealing.
    await writeModelConfigSnapshot(
      path,
      sealKeysForDisk(migrated, new Map(), opts.sealer).raw,
      opts.persistenceAdapter,
    )
    return runtimeConfig(migrated)
  }
  const lenient = normalizeV2Lenient(loaded)
  const normalized = lenient.config
  const disk = { ...normalized, models: lenient.diskModels }
  // A newer Emperor's file (REL-03) is read as v2 and never rewritten.
  const newer =
    loadedSnapshot.receipt.recoveryAction === 'newer_version_read_only'
  try {
    // Keys are written back exactly as stored (sealed or not); plaintext
    // is sealed by the next save (SEC-06). Rejected entries stay in place.
    if (!newer && JSON.stringify(JSON.parse(source)) !== JSON.stringify(disk))
      await writeModelConfigSnapshot(path, disk, opts.persistenceAdapter)
  } catch {
    // AtomicSnapshot 已负责隔离畸形文件；这里不重复恢复。
  }
  const opened = openStoredKeys(normalized, opts.sealer)
  return runtimeConfig(opened.config, opened.unreadable, lenient.rejected)
}

export async function saveModelConfig(
  rootOrFile: string,
  data: ModelConfigV2 | RawRecord,
  opts: {
    validateComplete?: boolean
    /**
     * Entries whose key the user cleared on purpose in this save. Only these
     * drop a sealed key that cannot be opened; any other null keeps it.
     */
    clearedKeys?: readonly string[]
    /** Rejected entries to drop from the file (entryId, or `#<index>`). */
    discardRejected?: readonly string[]
  } & ModelConfigPersistenceOptions = {},
): Promise<ModelConfig> {
  const path = configPath(rootOrFile)
  assertNotNewerSync(path, 'schemaVersion', 2)
  const stored = await readStoredConfig(path)
  const merged = preserveStoredApiKeys(
    stored?.value,
    data,
    opts.sealer,
    opts.clearedKeys ?? [],
  )
  if (!isRecord(merged)) throw new ValidationError('model_config 必须是对象')
  const normalized =
    merged.schemaVersion === 2 ? normalizeV2(merged) : migrateV1(merged)
  const opened = openStoredKeys(normalized, opts.sealer)
  const config = runtimeConfig(opened.config, opened.unreadable)
  if (opts.validateComplete) validateCompleteModelEntries(config.raw)
  const disk = sealKeysForDisk(config.raw, opened.unreadable, opts.sealer)
  // Rejected entries stay on disk until repaired (an entry saved with the
  // same entryId) or discarded on purpose.
  const validIds = new Set(config.raw.models.map((entry) => entry.entryId))
  const discard = new Set(opts.discardRejected ?? [])
  const kept = storedRejected(stored?.value).filter(
    (item) =>
      !(item.entryId && validIds.has(item.entryId)) &&
      !discard.has(item.entryId ?? `#${item.index}`),
  )
  const diskRaw = kept.length
    ? {
        ...disk.raw,
        models: [...disk.raw.models, ...kept.map((item) => item.raw)],
      }
    : disk.raw
  if (disk.sealedPlaintext && stored && hasUnsealedKeys(stored.value))
    await backupBeforeSealing(path, stored.source)
  await writeModelConfigSnapshot(path, diskRaw, opts.persistenceAdapter)
  return { ...config, rejectedEntries: structuredClone(kept) }
}

async function readStoredConfig(
  path: string,
): Promise<{ source: string; value: unknown } | null> {
  if (!existsSync(path)) return null
  try {
    const source = await readFile(path, 'utf8')
    return { source, value: JSON.parse(source) as unknown }
  } catch {
    return null
  }
}

/** Open each sealed key; the ones that do not open are reported, not lost. */
function openStoredKeys(
  raw: ModelConfigV2,
  sealer: SecretSealer | null | undefined,
): { config: ModelConfigV2; unreadable: Map<string, string> } {
  const unreadable = new Map<string, string>()
  const models = raw.models.map((entry) => {
    if (!isSealedSecret(entry.apiKey)) return entry
    const opened = openKey(entry.apiKey, entry.entryId, sealer)
    if (opened !== null) return { ...entry, apiKey: opened }
    unreadable.set(entry.entryId, entry.apiKey)
    return { ...entry, apiKey: null }
  })
  return { config: { ...raw, models }, unreadable }
}

function openKey(
  sealed: string,
  entryId: string,
  sealer: SecretSealer | null | undefined,
): string | null {
  if (!sealer) return null
  try {
    return sealer.open(sealed, modelApiKeyContext(entryId))
  } catch {
    return null
  }
}

/**
 * The document to write: plaintext keys sealed (when the sealer can seal),
 * unreadable sealed keys put back as they were.
 */
function sealKeysForDisk(
  raw: ModelConfigV2,
  unreadable: ReadonlyMap<string, string>,
  sealer: SecretSealer | null | undefined,
): { raw: ModelConfigV2; sealedPlaintext: boolean } {
  let sealedPlaintext = false
  let warned = false
  const canSeal = Boolean(sealer?.available)
  const models = raw.models.map((entry) => {
    const kept = unreadable.get(entry.entryId)
    if (entry.apiKey === null)
      return kept === undefined ? entry : { ...entry, apiKey: kept }
    if (isSealedSecret(entry.apiKey) || !sealer) return entry
    if (canSeal)
      try {
        const sealed = sealer.seal(
          entry.apiKey,
          modelApiKeyContext(entry.entryId),
        )
        sealedPlaintext = true
        return { ...entry, apiKey: sealed }
      } catch {
        // Reported below; the key is kept rather than lost.
      }
    if (!warned) {
      warned = true
      logger.warn(
        'Model API keys stay unsealed: the local key is not available',
      )
    }
    return entry
  })
  return { raw: { ...raw, models }, sealedPlaintext }
}

/** Whether a stored document holds any key not yet sealed. */
function hasUnsealedKeys(stored: unknown): boolean {
  if (!isRecord(stored)) return false
  if (stored.schemaVersion !== 2) return true
  return (Array.isArray(stored.models) ? stored.models : []).some(
    (entry) =>
      isRecord(entry) &&
      typeof entry.apiKey === 'string' &&
      entry.apiKey.trim() !== '' &&
      !isSealedSecret(entry.apiKey) &&
      !isMaskedSecret(entry.apiKey),
  )
}

/** `model_config.json.pre-seal-<ts>`: the file as it was, plaintext keys and all. */
async function backupBeforeSealing(
  path: string,
  source: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(
    dirname(path),
    `${MODEL_CONFIG_PRE_SEAL_PREFIX}${stamp}`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(backupPath, 'wx', 0o600)
    await handle.writeFile(source, 'utf8')
    await handle.sync()
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    await handle?.close()
  }
}

function preserveStoredApiKeys(
  stored: unknown,
  data: ModelConfigV2 | RawRecord,
  sealer: SecretSealer | null | undefined,
  clearedKeys: readonly string[],
): ModelConfigV2 | RawRecord {
  if (!isRecord(data) || data.schemaVersion !== 2) return data
  if (!isRecord(stored) || stored.schemaVersion !== 2) return data
  const previous = new Map<string, RawRecord>()
  for (const item of Array.isArray(stored.models) ? stored.models : []) {
    if (!isRecord(item)) continue
    const entryId = optionalString(item.entryId)
    if (entryId) previous.set(entryId, item)
  }
  const next = structuredClone(data) as RawRecord
  for (const item of Array.isArray(next.models) ? next.models : []) {
    if (!isRecord(item)) continue
    const old = previous.get(optionalString(item.entryId) ?? '')
    if (!old) continue
    const submitted = Object.prototype.hasOwnProperty.call(item, 'apiKey')
      ? item.apiKey
      : undefined
    const entryId = optionalString(item.entryId) ?? ''
    if (
      submitted === undefined ||
      (typeof submitted === 'string' &&
        (!submitted.trim() || isMaskedSecret(submitted)))
    )
      item.apiKey = old.apiKey ?? null
    else if (
      submitted === null &&
      isSealedSecret(old.apiKey) &&
      !clearedKeys.includes(entryId) &&
      openKey(old.apiKey, entryId, sealer) === null
    )
      // It read as null because it cannot be opened: keep asking for it.
      item.apiKey = old.apiKey
  }
  return next
}

function mergeDefined(target: RawRecord, patch: RawRecord): RawRecord {
  const result = structuredClone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = structuredClone(value)
  }
  return result
}

export function upsertModelEntryConfig(
  config: ModelConfigV2,
  update: ModelEntryUpdate,
): ModelConfigV2 {
  const raw = normalizeV2(config as unknown as RawRecord)
  const requestedId = optionalString(update.entryId)
  const index = requestedId
    ? raw.models.findIndex((entry) => entry.entryId === requestedId)
    : -1
  const existing = index >= 0 ? raw.models[index]! : undefined
  if (requestedId && !existing)
    throw new ValidationError(
      `entry '${requestedId}' not found in model_config.json`,
    )
  const nextId = requestedId ?? newEntryId()
  const merged = mergeDefined(existing ?? {}, {
    ...update,
    entryId: nextId,
  })
  const hasSubmittedKey = Object.prototype.hasOwnProperty.call(update, 'apiKey')
  if (
    existing &&
    (!hasSubmittedKey ||
      update.apiKey === undefined ||
      isMaskedSecret(update.apiKey))
  )
    merged.apiKey = existing.apiKey
  else if (!existing && isMaskedSecret(update.apiKey)) merged.apiKey = null
  if (existing && update.legacy === undefined)
    merged.legacy = structuredClone(existing.legacy)
  else if (existing && isRecord(update.legacy))
    merged.legacy = mergeDefined(existing.legacy ?? {}, update.legacy)
  if (existing && update.capabilityOverrides === undefined)
    merged.capabilityOverrides = structuredClone(existing.capabilityOverrides)
  else if (existing && isRecord(update.capabilityOverrides))
    merged.capabilityOverrides = structuredClone(update.capabilityOverrides)
  const normalized = normalizeEntry(merged)
  const models = raw.models.slice()
  if (index >= 0) models[index] = normalized
  else models.push(normalized)
  return normalizeV2({
    schemaVersion: 2,
    activeModelId: raw.activeModelId ?? normalized.entryId,
    models,
    ...(raw.policy ? { policy: raw.policy } : {}),
  })
}

export function deleteModelEntryConfig(
  config: ModelConfigV2,
  entryId: string,
): ModelConfigV2 {
  const raw = normalizeV2(config as unknown as RawRecord)
  if (!raw.models.some((entry) => entry.entryId === entryId))
    throw new ValidationError(
      `entry '${entryId}' not found in model_config.json`,
    )
  if (raw.activeModelId === entryId)
    throw new ValidationError('该模型正在使用，请先切换到其他模型再删除')
  if (raw.policy?.fallback.enabled && raw.policy.fallback.entryId === entryId)
    throw new ValidationError(
      '该模型仍被 policy fallback 引用，请先关闭或修改 fallback',
    )
  const models = raw.models.filter((entry) => entry.entryId !== entryId)
  return normalizeV2({
    schemaVersion: 2,
    activeModelId:
      raw.activeModelId === entryId
        ? (models[0]?.entryId ?? null)
        : raw.activeModelId,
    models,
    ...(raw.policy ? { policy: raw.policy } : {}),
  })
}

export function activateModelEntryConfig(
  config: ModelConfigV2,
  entryId: string,
): ModelConfigV2 {
  const raw = normalizeV2(config as unknown as RawRecord)
  if (!raw.models.some((entry) => entry.entryId === entryId))
    throw new ValidationError(
      `entry '${entryId}' not found in model_config.json`,
    )
  return normalizeV2({ ...raw, activeModelId: entryId })
}

export function updateModelPolicyConfig(
  config: ModelConfigV2,
  policy: ModelExecutionPolicy,
): ModelConfigV2 {
  const raw = normalizeV2(config as unknown as RawRecord)
  return normalizeV2({ ...raw, policy })
}

export async function saveModelPolicy(
  rootOrFile: string,
  policy: ModelExecutionPolicy,
  opts: ModelConfigPersistenceOptions = {},
): Promise<ModelConfig> {
  return withModelConfigLock(rootOrFile, async () => {
    const current = await loadModelConfig(rootOrFile, opts)
    return saveModelConfig(
      rootOrFile,
      updateModelPolicyConfig(current.raw, policy),
      opts,
    )
  })
}

export async function saveModelEntry(
  rootOrFile: string,
  update: ModelEntryUpdate,
  opts: ModelConfigPersistenceOptions = {},
): Promise<ModelConfig> {
  return withModelConfigLock(rootOrFile, async () => {
    const current = await loadModelConfig(rootOrFile, opts)
    const cleared =
      update.entryId &&
      Object.prototype.hasOwnProperty.call(update, 'apiKey') &&
      update.apiKey === null
        ? [update.entryId]
        : []
    return saveModelConfig(
      rootOrFile,
      upsertModelEntryConfig(current.raw, update),
      {
        ...opts,
        clearedKeys: cleared,
      },
    )
  })
}

export async function deleteModelEntry(
  rootOrFile: string,
  entryId: string,
  opts: ModelConfigPersistenceOptions = {},
): Promise<ModelConfig> {
  return withModelConfigLock(rootOrFile, async () => {
    const current = await loadModelConfig(rootOrFile, opts)
    return saveModelConfig(
      rootOrFile,
      deleteModelEntryConfig(current.raw, entryId),
      opts,
    )
  })
}

export async function activateModelEntry(
  rootOrFile: string,
  entryId: string,
  opts: ModelConfigPersistenceOptions = {},
): Promise<ModelConfig> {
  return withModelConfigLock(rootOrFile, async () => {
    const current = await loadModelConfig(rootOrFile, opts)
    return saveModelConfig(
      rootOrFile,
      activateModelEntryConfig(current.raw, entryId),
      opts,
    )
  })
}

/** @deprecated onboarding Task 2 会改为 saveModelEntry。 */
export function buildWizardModelConfig(
  existingRaw: RawRecord | null | undefined,
  settings: WizardModelSettings,
): ModelConfigV2 {
  const current = parseModelConfig(existingRaw ?? defaultModelConfig())
  const existing = activeEntry(current)
  const provider = settings.provider || 'custom'
  return upsertModelEntryConfig(current.raw, {
    entryId: existing?.entryId,
    provider,
    protocol: provider === 'anthropic' ? 'anthropic' : 'openai',
    modelId: settings.mainModelId,
    displayName: settings.label || settings.name,
    apiBase:
      settings.apiBase ||
      defaultApiBase(
        provider,
        provider === 'anthropic' ? 'anthropic' : 'openai',
      ),
    apiKey: settings.apiKey || undefined,
    contextWindowTokens: settings.contextWindowTokens,
    maxTokens: settings.maxTokens,
    reasoningEffort: settings.reasoningEffort ?? null,
    legacy: { temperature: settings.temperature },
  })
}

/** @deprecated use capabilityOverrides through saveModelEntry. */
export async function markEntryVision(
  rootOrFile: string,
  entryId: string,
  value = true,
  opts: ModelConfigPersistenceOptions = {},
): Promise<ModelConfig> {
  return withModelConfigLock(rootOrFile, async () => {
    const config = await loadModelConfig(rootOrFile, opts)
    const found = findEntry(config, entryId)
    if (!found)
      throw new ValidationError(
        `entry '${entryId}' not found in model_config.json`,
      )
    return saveModelEntry(
      rootOrFile,
      {
        entryId: found.entryId,
        capabilityOverrides: {
          ...found.capabilityOverrides,
          vision: Boolean(value),
        },
      },
      opts,
    )
  })
}

/* ── Writes are serialized per file (MOD-03) ────────────────────────────── */

const lockChains = new Map<string, Promise<void>>()
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * Run `task` holding the model_config file's in-process lock. Every
 * load-modify-save goes through it, so two saves started at once both
 * land. Re-entrant: code already holding the lock runs directly.
 */
export async function withModelConfigLock<T>(
  rootOrFile: string,
  task: () => Promise<T>,
): Promise<T> {
  const path = configPath(rootOrFile)
  const held = heldLocks.getStore()
  if (held?.has(path)) return task()
  const previous = lockChains.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((done) => (release = done))
  const chain = previous.then(() => current)
  lockChains.set(path, chain)
  await previous
  try {
    return await heldLocks.run(new Set([...(held ?? []), path]), task)
  } finally {
    release()
    if (lockChains.get(path) === chain) lockChains.delete(path)
  }
}

/** One connection's settings shared by the entries saved with it. */
export interface ModelConnectionSettings {
  provider: string
  protocol: ModelProtocol
  apiBase: string
  /** Omitted, empty or masked: keep the connection's stored key. */
  apiKey?: string | null
}

/** One model in a batch save; the connection fields come from the batch. */
export type ModelEntryDraft = Omit<
  ModelEntryUpdate,
  'provider' | 'protocol' | 'apiBase' | 'apiKey' | 'connectionId'
> & { modelId: string }

/**
 * Save several entries of one connection with a single write (MOD-03).
 * Every entry is validated before anything is written; one bad entry
 * fails the batch with its position. An entryId that names an existing
 * entry updates it; one that names a rejected entry repairs it.
 */
export async function saveModelEntries(
  rootOrFile: string,
  input: {
    connection: ModelConnectionSettings
    entries: readonly ModelEntryDraft[]
    activateEntryId?: string | null
  },
  opts: ModelConfigPersistenceOptions = {},
): Promise<{ config: ModelConfig; savedEntryIds: string[] }> {
  if (!input.entries.length) throw new ValidationError('至少要保存一个模型')
  return withModelConfigLock(rootOrFile, async () => {
    const current = await loadModelConfig(rootOrFile, opts)
    const models = current.raw.models.slice()
    const probe = normalizeEntry({
      ...input.connection,
      entryId: 'probe',
      modelId: input.entries[0]!.modelId || 'probe',
      contextWindowTokens: 1,
      maxTokens: 1,
    })
    const peers = models.filter((entry) => sameEndpoint(entry, probe))
    const connectionId =
      peers.find((entry) => entry.connectionId)?.connectionId ??
      newConnectionId()
    const submittedKey = input.connection.apiKey
    const keepStoredKey =
      submittedKey === undefined ||
      submittedKey === null ||
      (typeof submittedKey === 'string' &&
        (!submittedKey.trim() || isMaskedSecret(submittedKey)))
    const storedKey = peers.find((entry) => entry.apiKey)?.apiKey ?? null
    const savedEntryIds: string[] = []
    input.entries.forEach((draft, index) => {
      const entryId = optionalString(draft.entryId) ?? newEntryId()
      const existingIndex = models.findIndex(
        (entry) => entry.entryId === entryId,
      )
      const existing = existingIndex >= 0 ? models[existingIndex] : undefined
      let normalized: ModelEntryV2
      try {
        normalized = normalizeEntry({
          ...(existing ?? {}),
          ...stripUndefined(draft as RawRecord),
          entryId,
          provider: input.connection.provider,
          protocol: input.connection.protocol,
          apiBase: input.connection.apiBase,
          apiKey: keepStoredKey
            ? (existing?.apiKey ?? storedKey)
            : submittedKey,
          connectionId,
        })
      } catch (error) {
        throw new ValidationError(
          `第 ${index + 1} 个模型（${draft.modelId || '未命名'}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      if (existing) models[existingIndex] = normalized
      else models.push(normalized)
      savedEntryIds.push(entryId)
    })
    const activateEntryId = optionalString(input.activateEntryId)
    if (
      activateEntryId &&
      !models.some((entry) => entry.entryId === activateEntryId)
    )
      throw new ValidationError(`entry '${activateEntryId}' not found`)
    const next = normalizeV2({
      schemaVersion: 2,
      activeModelId:
        activateEntryId ?? current.raw.activeModelId ?? savedEntryIds[0]!,
      models,
      ...(current.raw.policy ? { policy: current.raw.policy } : {}),
    })
    const config = await saveModelConfig(rootOrFile, next, opts)
    return { config, savedEntryIds }
  })
}

/**
 * Change the key and/or address of every entry on one connection with a
 * single write (MOD-03). The connection is named by connectionId, or by
 * an entry on it. Returns how many entries changed.
 */
export async function updateModelConnection(
  rootOrFile: string,
  input: {
    connectionId?: string | null
    entryId?: string | null
    apiKey?: string | null
    apiBase?: string | null
  },
  opts: ModelConfigPersistenceOptions = {},
): Promise<{ config: ModelConfig; updated: number }> {
  return withModelConfigLock(rootOrFile, async () => {
    const current = await loadModelConfig(rootOrFile, opts)
    const connectionId = optionalString(input.connectionId)
    const entryId = optionalString(input.entryId)
    const anchor = entryId
      ? current.raw.models.find((entry) => entry.entryId === entryId)
      : current.raw.models.find((entry) => entry.connectionId === connectionId)
    if (!anchor) throw new ValidationError('找不到这个连接的模型')
    const members = current.raw.models.filter((entry) =>
      sameConnection(entry, anchor),
    )
    const key = optionalString(input.apiKey)
    const setKey = key !== null && !isMaskedSecret(key)
    const apiBase = optionalString(input.apiBase)
    if (!setKey && !apiBase) return { config: current, updated: 0 }
    const unified = anchor.connectionId ?? newConnectionId()
    const memberIds = new Set(members.map((entry) => entry.entryId))
    const models = current.raw.models.map((entry) =>
      memberIds.has(entry.entryId)
        ? normalizeEntry({
            ...entry,
            connectionId: unified,
            ...(setKey ? { apiKey: key } : {}),
            ...(apiBase ? { apiBase } : {}),
          })
        : entry,
    )
    const config = await saveModelConfig(
      rootOrFile,
      normalizeV2({ ...current.raw, models }),
      opts,
    )
    return { config, updated: members.length }
  })
}

/** Drop a rejected entry from the file (by entryId, or `#<index>`). */
export async function discardRejectedModelEntry(
  rootOrFile: string,
  key: string,
  opts: ModelConfigPersistenceOptions = {},
): Promise<ModelConfig> {
  return withModelConfigLock(rootOrFile, async () => {
    const current = await loadModelConfig(rootOrFile, opts)
    if (
      !current.rejectedEntries.some(
        (item) => (item.entryId ?? `#${item.index}`) === key,
      )
    )
      throw new ValidationError('这个条目已经不在文件里了')
    return saveModelConfig(rootOrFile, current.raw, {
      ...opts,
      discardRejected: [key],
    })
  })
}

function stripUndefined(value: RawRecord): RawRecord {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  )
}

function reportModelConfigRecovery(info: {
  path: string
  backupPath: string
  error: unknown
}): void {
  logger.warn('Invalid model config isolated; using defaults', {
    path: info.path,
    backupPath: info.backupPath,
    error:
      info.error instanceof Error ? info.error.message : String(info.error),
  })
}
