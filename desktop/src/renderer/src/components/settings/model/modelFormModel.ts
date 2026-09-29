/**
 * Model settings form model: the pure draft / validation / payload logic
 * behind Settings › 模型 (ModelSection, ModelEntryEditor, ModelPolicyGroup).
 * Nothing here touches the DOM or the Core bridge.
 */
import type {
  ModelCapabilityOverrides,
  ModelEntry,
  ModelEntrySaveInput,
  ModelExecutionPolicy,
  ModelFallbackTrigger,
  ModelPricing,
  ModelTestResult,
  ProviderOption,
  ResolvedModelProfile,
} from '../../../types'

/**
 * One line for a model test: the latency on success, otherwise why it
 * failed. A reply that misses the probe (no API error) is named as such,
 * with the start of the reply, instead of a bare "failed".
 */
export function modelTestSummary(result: ModelTestResult): string {
  if (result.ok) return `通过 · ${result.latencyMs || 0}ms`
  if (result.error) return result.error
  const sample = result.sample?.trim() ?? ''
  const reply = sample
    ? `（回答：${sample.slice(0, 40)}${sample.length > 40 ? '…' : ''}）`
    : ''
  return result.kind === 'vision'
    ? `没有认出测试图片，这个模型可能看不到图片${reply}`
    : `没有按要求回答${reply}`
}

export type ModelProtocol = 'openai' | 'anthropic'

export type CapabilityControl = 'auto' | 'on' | 'off'

export interface ModelEntryDraft {
  entryId?: string
  provider: string
  protocol: 'openai' | 'anthropic'
  modelId: string
  displayName: string
  displayNameCustomized: boolean
  apiBase: string
  apiKey: string
  clearApiKey: boolean
  capabilityControls: {
    toolCall: CapabilityControl
    vision: CapabilityControl
    reasoning: CapabilityControl
  }
  contextWindowTokens: number
  maxTokens: number
  reasoningEffort: string | null
  pricingEnabled: boolean
  pricing: ModelPricing
  resolvedProfile?: ModelEntry['resolvedProfile']
  savedIdentity?: {
    provider: string
    protocol: 'openai' | 'anthropic'
    apiBase: string
  }
  /**
   * New entries under an existing provider: the saved entry whose key is
   * reused while the key field stays empty and the endpoint is unchanged.
   */
  credentialsFrom?: {
    entryId: string
    label: string
    provider: string
    protocol: 'openai' | 'anthropic'
    apiBase: string
  }
}

export function providerProtocols(
  provider: ProviderOption,
): readonly ('openai' | 'anthropic')[] {
  return provider.protocols?.length
    ? provider.protocols
    : [provider.defaultProtocol ?? 'openai']
}

export function capabilityControlValue(
  value: boolean | undefined,
): CapabilityControl {
  if (value === true) return 'on'
  if (value === false) return 'off'
  return 'auto'
}

function capabilityOverride(control: CapabilityControl): boolean | undefined {
  if (control === 'on') return true
  if (control === 'off') return false
  return undefined
}

export function canonicalModelApiBase(
  protocol: 'openai' | 'anthropic',
  value: string,
): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const resource = protocol === 'openai' ? '/chat/completions' : '/v1/messages'
  return trimmed.toLowerCase().endsWith(resource)
    ? trimmed.slice(0, -resource.length).replace(/\/+$/, '')
    : trimmed
}

function savedIdentityChanged(
  draft: ModelEntryDraft,
  provider: string,
  protocol: 'openai' | 'anthropic',
  apiBase: string,
): boolean {
  const saved = draft.savedIdentity
  if (!saved) return false
  return (
    saved.provider !== provider ||
    saved.protocol !== protocol ||
    canonicalModelApiBase(protocol, saved.apiBase) !==
      canonicalModelApiBase(protocol, apiBase)
  )
}

export function createModelEntryDraft(
  provider: ProviderOption,
  entry?: ModelEntry | null,
): ModelEntryDraft {
  const protocols = providerProtocols(provider)
  const requestedProtocol = entry?.protocol
  const protocol =
    requestedProtocol && protocols.includes(requestedProtocol)
      ? requestedProtocol
      : provider.defaultProtocol && protocols.includes(provider.defaultProtocol)
        ? provider.defaultProtocol
        : (protocols[0] ?? 'openai')
  const overrides = entry?.capabilityOverrides ?? {}
  return {
    ...(entry?.entryId ? { entryId: entry.entryId } : {}),
    provider: provider.name,
    protocol,
    modelId: String(entry?.modelId ?? ''),
    displayName: String(entry?.displayName ?? entry?.modelId ?? ''),
    displayNameCustomized: Boolean(entry?.displayName),
    apiBase: String(entry?.apiBase || provider.apiBases?.[protocol] || ''),
    apiKey: '',
    clearApiKey: false,
    capabilityControls: {
      toolCall: capabilityControlValue(overrides.toolCall),
      vision: capabilityControlValue(overrides.vision),
      reasoning: capabilityControlValue(overrides.reasoning),
    },
    contextWindowTokens: Number(entry?.contextWindowTokens || 128_000),
    maxTokens: Number(entry?.maxTokens || 8_000),
    reasoningEffort: entry?.reasoningEffort ?? null,
    pricingEnabled: Boolean(entry?.pricing),
    pricing: {
      inputUsdPerMillionTokens: entry?.pricing?.inputUsdPerMillionTokens ?? 0,
      outputUsdPerMillionTokens: entry?.pricing?.outputUsdPerMillionTokens ?? 0,
      cacheReadUsdPerMillionTokens:
        entry?.pricing?.cacheReadUsdPerMillionTokens ?? 0,
      cacheWriteUsdPerMillionTokens:
        entry?.pricing?.cacheWriteUsdPerMillionTokens ?? 0,
    },
    ...(entry?.resolvedProfile
      ? { resolvedProfile: entry.resolvedProfile }
      : {}),
    ...(entry
      ? {
          savedIdentity: {
            provider: entry.provider,
            protocol: entry.protocol,
            apiBase: entry.apiBase,
          },
        }
      : {}),
  }
}

/**
 * A new entry under the same provider as `source`: same protocol and API
 * base, and — when `source` has a saved key — that key is reused until the
 * user types another one or changes the endpoint.
 */
export function createSiblingEntryDraft(
  provider: ProviderOption,
  source: ModelEntry,
): ModelEntryDraft {
  const draft = createModelEntryDraft(provider)
  const protocols = providerProtocols(provider)
  if (protocols.includes(source.protocol)) draft.protocol = source.protocol
  draft.apiBase = source.apiBase || provider.apiBases?.[draft.protocol] || ''
  if (source.apiKey)
    draft.credentialsFrom = {
      entryId: source.entryId,
      label: modelEntryLabel(source),
      provider: source.provider,
      protocol: source.protocol,
      apiBase: source.apiBase,
    }
  return draft
}

/** The inherited key applies: nothing typed and the same endpoint. */
export function credentialsInherited(draft: ModelEntryDraft): boolean {
  const source = draft.credentialsFrom
  if (!source || draft.entryId || draft.apiKey.trim()) return false
  return (
    source.provider === draft.provider &&
    source.protocol === draft.protocol &&
    canonicalModelApiBase(draft.protocol, source.apiBase) ===
      canonicalModelApiBase(draft.protocol, draft.apiBase)
  )
}

export function applyProviderSelection(
  draft: ModelEntryDraft,
  provider: ProviderOption,
  requestedProtocol?: 'openai' | 'anthropic',
): ModelEntryDraft {
  const protocols = providerProtocols(provider)
  const protocol =
    requestedProtocol && protocols.includes(requestedProtocol)
      ? requestedProtocol
      : provider.defaultProtocol && protocols.includes(provider.defaultProtocol)
        ? provider.defaultProtocol
        : (protocols[0] ?? 'openai')
  const apiBase = provider.apiBases?.[protocol] ?? ''
  const identityChanged = savedIdentityChanged(
    draft,
    provider.name,
    protocol,
    apiBase,
  )
  return {
    ...draft,
    provider: provider.name,
    protocol,
    apiBase,
    apiKey: '',
    clearApiKey: draft.clearApiKey || identityChanged,
    modelId: '',
    displayName: draft.displayNameCustomized ? draft.displayName : '',
    reasoningEffort: null,
    resolvedProfile: undefined,
  }
}

export function updateModelDraftId(
  draft: ModelEntryDraft,
  modelId: string,
): void {
  draft.modelId = modelId
  if (!draft.displayNameCustomized) draft.displayName = modelId
}

export function updateModelDraftDisplayName(
  draft: ModelEntryDraft,
  displayName: string,
): void {
  if (!displayName.trim()) {
    draft.displayNameCustomized = false
    draft.displayName = draft.modelId
    return
  }
  draft.displayNameCustomized = true
  draft.displayName = displayName
}

export function reasoningChoices(
  values: readonly string[] | null | undefined,
): string[] {
  const allowed = new Set([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  return [...new Set(values ?? [])]
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => allowed.has(value))
}

export function toModelEntrySaveInput(
  draft: ModelEntryDraft,
): ModelEntrySaveInput {
  const capabilityOverrides: ModelCapabilityOverrides = {}
  const toolCall = capabilityOverride(draft.capabilityControls.toolCall)
  const vision = capabilityOverride(draft.capabilityControls.vision)
  const reasoning = capabilityOverride(draft.capabilityControls.reasoning)
  if (toolCall !== undefined) capabilityOverrides.toolCall = toolCall
  if (vision !== undefined) capabilityOverrides.vision = vision
  if (reasoning !== undefined) capabilityOverrides.reasoning = reasoning

  const submittedApiKey = draft.apiKey.trim()
  const identityChanged = savedIdentityChanged(
    draft,
    draft.provider,
    draft.protocol,
    draft.apiBase,
  )
  const apiKey = submittedApiKey
    ? submittedApiKey
    : draft.clearApiKey || identityChanged
      ? null
      : undefined
  return {
    ...(draft.entryId ? { entryId: draft.entryId } : {}),
    provider: draft.provider,
    protocol: draft.protocol,
    modelId: draft.modelId.trim(),
    displayName: draft.displayNameCustomized ? draft.displayName.trim() : '',
    apiBase: draft.apiBase.trim(),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(credentialsInherited(draft)
      ? { credentialsFrom: draft.credentialsFrom!.entryId }
      : {}),
    capabilityOverrides,
    contextWindowTokens: Math.max(1, Math.trunc(draft.contextWindowTokens)),
    maxTokens: Math.max(1, Math.trunc(draft.maxTokens)),
    reasoningEffort: draft.reasoningEffort,
    pricing: draft.pricingEnabled
      ? {
          inputUsdPerMillionTokens: Number(
            draft.pricing.inputUsdPerMillionTokens,
          ),
          outputUsdPerMillionTokens: Number(
            draft.pricing.outputUsdPerMillionTokens,
          ),
          cacheReadUsdPerMillionTokens: Number(
            draft.pricing.cacheReadUsdPerMillionTokens,
          ),
          cacheWriteUsdPerMillionTokens: Number(
            draft.pricing.cacheWriteUsdPerMillionTokens,
          ),
        }
      : null,
  }
}

// ── editor copy & presets ──────────────────────────────────────────────────

export const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  openai: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
}

export { PROTOCOL_SHORT_LABELS } from '../../../model/providerGroups'

export const CAPABILITY_ROWS = [
  { key: 'toolCall', label: '工具调用' },
  { key: 'vision', label: '图片输入' },
  { key: 'reasoning', label: '思考模式' },
] as const

export type CapabilityKey = (typeof CAPABILITY_ROWS)[number]['key']

export const CAPABILITY_OPTIONS: ReadonlyArray<{
  value: CapabilityControl
  label: string
}> = [
  { value: 'auto', label: '自动识别' },
  { value: 'on', label: '强制开启' },
  { value: 'off', label: '强制关闭' },
]

export const INPUT_TOKEN_PRESETS = [32_000, 64_000, 128_000, 256_000] as const
export const OUTPUT_TOKEN_PRESETS = [8_000, 16_000, 32_000, 64_000] as const

export function formatTokenPreset(value: number): string {
  return `${value / 1000}K`
}

/** Compact token count for model rows: 8K, 128K, 1M, 1.05M. */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  return `${Math.round(value / 1000)}K`
}

/** Short capability tags of a model row, in CAPABILITY_ROWS order. */
export const CAPABILITY_TAGS: Record<CapabilityKey, string> = {
  toolCall: '工具',
  vision: '识图',
  reasoning: '思考',
}

/** 「支持 · 已识别」 status line of one capability, from the resolved profile. */
export function capabilityStatus(
  profile: ResolvedModelProfile | undefined,
  key: CapabilityKey,
): string {
  if (!profile) return '保存后识别'
  const source = profile.sources?.[key]
  const sourceLabel =
    source === 'override' ? '已覆盖' : source === 'inferred' ? '已识别' : '默认'
  return `${profile[key] ? '支持' : '不支持'} · ${sourceLabel}`
}

// ── validation ─────────────────────────────────────────────────────────────

export type ModelDraftField =
  | 'provider'
  | 'apiBase'
  | 'modelId'
  | 'contextWindowTokens'
  | 'maxTokens'
  | 'pricing'

export type ModelDraftErrors = Partial<Record<ModelDraftField, string>>

const PRICING_LABELS: Record<keyof ModelPricing, string> = {
  inputUsdPerMillionTokens: '普通输入',
  outputUsdPerMillionTokens: '模型输出',
  cacheReadUsdPerMillionTokens: '缓存读取',
  cacheWriteUsdPerMillionTokens: '缓存写入',
}

/** Field-level problems that block saving (empty object = valid). */
export function validateModelDraft(draft: ModelEntryDraft): ModelDraftErrors {
  const errors: ModelDraftErrors = {}
  if (!draft.provider.trim()) errors.provider = '请选择 Provider'
  if (!draft.apiBase.trim()) errors.apiBase = '请填写 API 地址'
  if (!draft.modelId.trim()) errors.modelId = '请填写模型 ID'
  if (!(Number(draft.contextWindowTokens) >= 1))
    errors.contextWindowTokens = '输入上限必须大于 0'
  if (!(Number(draft.maxTokens) >= 1)) errors.maxTokens = '输出上限必须大于 0'
  if (draft.pricingEnabled) {
    for (const [key, value] of Object.entries(draft.pricing) as [
      keyof ModelPricing,
      unknown,
    ][]) {
      const amount = Number(value)
      if (value === '' || !Number.isFinite(amount) || amount < 0) {
        errors.pricing = `成本单价「${PRICING_LABELS[key]}」必须是非负数`
        break
      }
    }
  }
  return errors
}

// ── execution policy ───────────────────────────────────────────────────────

/** Editable copy of the execution policy (the cost cap stays text). */
export interface ModelPolicyDraft {
  fallbackEnabled: boolean
  fallbackEntryId: string
  onRateLimit: boolean
  onTransient: boolean
  /** Text of the cap input (Vue may cast it to a number). */
  costCapUsd: string | number
}

export function policyDraftFrom(
  policy: ModelExecutionPolicy | null | undefined,
): ModelPolicyDraft {
  const cap = policy?.cost.maxUsdPerAgentTurn
  return {
    fallbackEnabled: policy?.fallback.enabled ?? false,
    fallbackEntryId: policy?.fallback.entryId ?? '',
    onRateLimit: policy?.fallback.triggerOn.includes('rate_limit') ?? true,
    onTransient: policy?.fallback.triggerOn.includes('transient') ?? false,
    costCapUsd: cap === null || cap === undefined ? '' : String(cap),
  }
}

export function policyDraftsEqual(
  left: ModelPolicyDraft,
  right: ModelPolicyDraft,
): boolean {
  return (
    left.fallbackEnabled === right.fallbackEnabled &&
    left.fallbackEntryId === right.fallbackEntryId &&
    left.onRateLimit === right.onRateLimit &&
    left.onTransient === right.onTransient &&
    String(left.costCapUsd).trim() === String(right.costCapUsd).trim()
  )
}

/**
 * The `model.savePolicy` payload of a draft.
 * @throws Error with the user-facing reason when the draft is invalid.
 */
export function buildModelPolicy(
  draft: ModelPolicyDraft,
): ModelExecutionPolicy {
  const triggerOn: ModelFallbackTrigger[] = []
  if (draft.onRateLimit) triggerOn.push('rate_limit')
  if (draft.onTransient) triggerOn.push('transient')
  if (!triggerOn.length) throw new Error('请至少选择一种备用模型触发条件')
  if (draft.fallbackEnabled && !draft.fallbackEntryId)
    throw new Error('请选择备用模型')
  // A type="number" input may hand back a number: normalise to text first.
  const capText = String(draft.costCapUsd ?? '').trim()
  const maxUsdPerAgentTurn = capText ? Number(capText) : null
  if (
    maxUsdPerAgentTurn !== null &&
    (!Number.isFinite(maxUsdPerAgentTurn) || maxUsdPerAgentTurn <= 0)
  )
    throw new Error('每 Agent 轮成本上限必须是正数')
  return {
    fallback: {
      enabled: draft.fallbackEnabled,
      entryId: draft.fallbackEntryId || null,
      triggerOn,
    },
    cost: { maxUsdPerAgentTurn },
  }
}

/** Visible label of a saved entry. */
export function modelEntryLabel(entry: ModelEntry): string {
  return entry.effectiveDisplayName || entry.displayName || entry.modelId
}
