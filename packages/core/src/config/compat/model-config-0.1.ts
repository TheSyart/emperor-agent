/**
 * Frozen copy of the model_config v2 reader shipped in 0.1 (main 112f64d4:
 * normalizeV2 and the helpers it uses, unchanged). MOD-03 tests read files
 * written by newer builds with it: an older Emperor must still load them
 * (it drops the fields it does not know). Do not update this file.
 */
import { randomUUID } from 'node:crypto'
import { ValidationError } from '../../errors'
import { findByName, normalizeApiBase } from '../../llm/catalog'

type RawRecord = Record<string, any>
type ModelFallbackTrigger = 'rate_limit' | 'transient'

type ModelProtocol = 'openai' | 'anthropic'

interface ModelCapabilityOverrides {
  toolCall?: boolean
  vision?: boolean
  reasoning?: boolean
}

interface ModelEntryLegacyData {
  temperature?: number | null
  extraHeaders?: Record<string, string> | null
  extraBody?: Record<string, unknown> | null
}

interface ModelPricing {
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  cacheReadUsdPerMillionTokens: number
  cacheWriteUsdPerMillionTokens: number
}

interface ModelExecutionPolicy {
  fallback: {
    enabled: boolean
    entryId: string | null
    triggerOn: ModelFallbackTrigger[]
  }
  cost: { maxUsdPerAgentTurn: number | null }
}

interface ModelEntryV2 {
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

interface ModelConfigV2 {
  schemaVersion: 2
  activeModelId: string | null
  models: ModelEntryV2[]
  policy?: ModelExecutionPolicy
}

const REMOVED_PROVIDERS = new Set([
  'azure_openai',
  'bedrock',
  'openai_codex',
  'github_copilot',
])

function defaultModelExecutionPolicy(): ModelExecutionPolicy {
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

function canonicalProviderName(value: unknown): string | null {
  const name = optionalString(value)
  if (!name) return null
  if (name.replace(/-/g, '_').toLowerCase() === 'custom') return 'custom'
  return findByName(name)?.name ?? null
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

export { normalizeV2 as normalizeV2From01 }
export type { ModelConfigV2 as ModelConfigV2From01 }
