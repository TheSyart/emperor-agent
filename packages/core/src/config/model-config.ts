import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join, resolve } from 'node:path'
import { ValidationError } from '../errors'
import { PROVIDERS, findByName, normalizeApiBase } from '../providers/registry'
import { logger } from '../util/log'
import {
  readJson,
  writeJsonAtomic,
  type ConfigRecoveryInfo,
} from '../store/atomic-json'

/** 单模型配置文件。磁盘只保存 schemaVersion=2；旧字段仅通过只读 adapter 暂时兼容。 */
export const MODEL_CONFIG_FILE = 'model_config.json'
export const MODEL_CONFIG_V1_BACKUP_FILE = 'model_config.v1-backup.json'
export const MODEL_CONFIG_EXAMPLE_FILE = 'model_config.example.json'

export type ModelProtocol = 'openai' | 'anthropic'

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

export interface ModelEntryV2 {
  entryId: string
  provider: string
  protocol: ModelProtocol
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

export type ModelEntryUpdate = Omit<Partial<ModelEntryV2>, 'pricing'> & {
  apiKey?: string | null
  pricing?: ModelPricing | null
}

type RawRecord = Record<string, any>

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

function newEntryId(): string {
  return `model-${randomUUID()}`
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
  const protocol = optionalString(input.protocol)
  if (protocol !== 'openai' && protocol !== 'anthropic')
    throw new ValidationError(`protocol 无效: ${protocol ?? ''}`)
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
  if (displayName) result.displayName = displayName
  if (capabilityOverrides) result.capabilityOverrides = capabilityOverrides
  if (pricing) result.pricing = pricing
  if (legacy) result.legacy = legacy
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
  if (maxUsdPerAgentTurn !== null) {
    const active = activeModelId ? byId.get(activeModelId) : null
    if (!active?.pricing)
      throw new ValidationError(
        '启用 cost cap 前必须为 active 模型配置完整 pricing',
      )
    if (enabled && entryId && !byId.get(entryId)?.pricing)
      throw new ValidationError(
        '启用 cost cap 前必须为 fallback 模型配置完整 pricing',
      )
  }
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

function providerNames(): string[] {
  return (PROVIDERS as readonly unknown[])
    .map((item) => (isRecord(item) ? optionalString(item.name) : null))
    .filter((name): name is string => Boolean(name))
}

function compatibilityEntry(entry: ModelEntryV2): ModelEntry {
  const name = entry.displayName || entry.modelId
  return {
    ...structuredClone(entry),
    name,
    id: entry.modelId,
    mainModelId: entry.modelId,
    secondaryModelId: entry.modelId,
    label: entry.displayName ?? '',
    extraHeaders: entry.legacy?.extraHeaders ?? null,
    extraBody: entry.legacy?.extraBody ?? null,
    temperature: entry.legacy?.temperature ?? null,
    supportsVision: entry.capabilityOverrides?.vision ?? false,
  }
}

function runtimeConfig(raw: ModelConfigV2): ModelConfig {
  const clean = structuredClone(raw)
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

export async function ensureModelConfig(rootOrFile: string): Promise<string> {
  const path = configPath(rootOrFile)
  if (!existsSync(path))
    await writeJsonAtomic(path, defaultModelConfig(), { mode: 0o600 })
  return path
}

export async function ensureExampleConfig(root: string): Promise<string> {
  const path = join(resolve(root), MODEL_CONFIG_EXAMPLE_FILE)
  const desired = `${JSON.stringify(defaultModelConfig(), null, 2)}\n`
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== desired)
    await writeJsonAtomic(path, defaultModelConfig())
  return path
}

function validateDiskConfig(value: unknown): RawRecord {
  if (!isRecord(value)) throw new Error('model_config must be an object')
  if (value.schemaVersion === 2) return normalizeV2(value)
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
  opts: { create?: boolean } = {},
): Promise<ModelConfig> {
  const path = configPath(rootOrFile)
  if (opts.create !== false && !existsSync(path))
    await writeJsonAtomic(path, defaultModelConfig(), { mode: 0o600 })
  if (!existsSync(path)) return runtimeConfig(defaultModelConfig())

  const source = await readFile(path, 'utf8')
  const loaded = await readJson<RawRecord>(path, defaultModelConfig(), {
    validate: validateDiskConfig,
    onCorrupt: reportModelConfigRecovery,
  })
  // readJson isolates invalid files by renaming them. Do not immediately
  // recreate the invalid path here; the next normal load/explicit save owns
  // creation, matching the existing recovery contract.
  if (!existsSync(path)) return runtimeConfig(defaultModelConfig())
  if (loaded.schemaVersion !== 2) {
    await backupV1(path, source)
    const migrated = migrateV1(loaded)
    await writeJsonAtomic(path, migrated, { mode: 0o600 })
    return runtimeConfig(migrated)
  }
  const normalized = normalizeV2(loaded)
  try {
    if (JSON.stringify(JSON.parse(source)) !== JSON.stringify(normalized))
      await writeJsonAtomic(path, normalized, { mode: 0o600 })
  } catch {
    // readJson 已负责隔离畸形文件；这里不重复恢复。
  }
  return runtimeConfig(normalized)
}

export async function saveModelConfig(
  rootOrFile: string,
  data: ModelConfigV2 | RawRecord,
  opts: { validateComplete?: boolean } = {},
): Promise<ModelConfig> {
  const path = configPath(rootOrFile)
  const merged = await preserveStoredApiKeys(path, data)
  const config = parseModelConfig(merged)
  if (opts.validateComplete) validateCompleteModelEntries(config.raw)
  await writeJsonAtomic(path, config.raw, { mode: 0o600 })
  return config
}

async function preserveStoredApiKeys(
  path: string,
  data: ModelConfigV2 | RawRecord,
): Promise<ModelConfigV2 | RawRecord> {
  if (!isRecord(data) || data.schemaVersion !== 2 || !existsSync(path))
    return data
  let stored: unknown
  try {
    stored = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return data
  }
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
    if (
      submitted === undefined ||
      (typeof submitted === 'string' &&
        (!submitted.trim() || isMaskedSecret(submitted)))
    )
      item.apiKey = old.apiKey ?? null
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
): Promise<ModelConfig> {
  const current = await loadModelConfig(rootOrFile)
  return saveModelConfig(
    rootOrFile,
    updateModelPolicyConfig(current.raw, policy),
  )
}

export async function saveModelEntry(
  rootOrFile: string,
  update: ModelEntryUpdate,
): Promise<ModelConfig> {
  const current = await loadModelConfig(rootOrFile)
  return saveModelConfig(
    rootOrFile,
    upsertModelEntryConfig(current.raw, update),
  )
}

export async function deleteModelEntry(
  rootOrFile: string,
  entryId: string,
): Promise<ModelConfig> {
  const current = await loadModelConfig(rootOrFile)
  return saveModelConfig(
    rootOrFile,
    deleteModelEntryConfig(current.raw, entryId),
  )
}

export async function activateModelEntry(
  rootOrFile: string,
  entryId: string,
): Promise<ModelConfig> {
  const current = await loadModelConfig(rootOrFile)
  return saveModelConfig(
    rootOrFile,
    activateModelEntryConfig(current.raw, entryId),
  )
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
): Promise<ModelConfig> {
  const config = await loadModelConfig(rootOrFile)
  const found = findEntry(config, entryId)
  if (!found)
    throw new ValidationError(
      `entry '${entryId}' not found in model_config.json`,
    )
  return saveModelEntry(rootOrFile, {
    entryId: found.entryId,
    capabilityOverrides: {
      ...found.capabilityOverrides,
      vision: Boolean(value),
    },
  })
}

function reportModelConfigRecovery(info: ConfigRecoveryInfo): void {
  logger.warn('Invalid model config isolated; using defaults', {
    path: info.path,
    backupPath: info.backupPath,
    error:
      info.error instanceof Error ? info.error.message : String(info.error),
  })
}
