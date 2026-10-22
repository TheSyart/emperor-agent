/**
 * Model settings form model: the pure labels, presets and policy logic
 * behind Settings › 模型 (ModelSection, ModelEntryEditor, ModelPolicyGroup).
 * Nothing here touches the DOM or the Core bridge. New models come from
 * AddModelDialog (addModelModel.ts), so there is no new-entry draft here.
 */
import type {
  ModelEntry,
  ModelExecutionPolicy,
  ModelFallbackTrigger,
  ModelTestResult,
  ResolvedModelProfile,
} from '../../../types'
import type { SelectOption } from '../../ui/inputTypes'

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

export function capabilityControlValue(
  value: boolean | undefined,
): CapabilityControl {
  if (value === true) return 'on'
  if (value === false) return 'off'
  return 'auto'
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
  return [
    ...new Set(
      (values ?? []).map((value) => String(value).trim().toLowerCase()),
    ),
  ].filter((value) => allowed.has(value))
}

// ── editor copy & presets ──────────────────────────────────────────────────

export const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  openai: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
}

export { PROTOCOL_SHORT_LABELS } from '../../../model/providerGroups'

// ── DeepSeek interface (KRN-07) ────────────────────────────────────────────

/**
 * Core sends DeepSeek entries on this host over Anthropic Messages unless
 * the entry keeps chat-completions (packages/core llm/route.ts); gateways
 * keep the protocol they were saved with.
 */
const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com'

export type ModelInterface = 'messages' | 'chat-completions'

function isOfficialDeepSeek(entry: Pick<ModelEntry, 'provider' | 'apiBase'>) {
  if (entry.provider !== 'deepseek') return false
  try {
    const url = new URL(entry.apiBase)
    return url.protocol === 'https:' && url.hostname === DEEPSEEK_OFFICIAL_HOST
  } catch {
    return false
  }
}

/** The interface of a DeepSeek entry on the official host; null for any other entry. */
export function deepseekInterface(
  entry: Pick<ModelEntry, 'provider' | 'apiBase' | 'transport'>,
): ModelInterface | null {
  if (!isOfficialDeepSeek(entry)) return null
  return entry.transport === 'chat-completions'
    ? 'chat-completions'
    : 'messages'
}

/** The interface an entry's requests actually use, as the editor names it. */
export function entryInterfaceLabel(
  entry: Pick<ModelEntry, 'provider' | 'apiBase' | 'protocol' | 'transport'>,
): string {
  switch (deepseekInterface(entry)) {
    case 'messages':
      return PROTOCOL_LABELS.anthropic
    case 'chat-completions':
      return `${PROTOCOL_LABELS.openai}（回退）`
    default:
      return PROTOCOL_LABELS[entry.protocol]
  }
}

/** The editor's 接口 choice for an official DeepSeek entry ('' = the default). */
export const INTERFACE_OPTIONS: ReadonlyArray<
  SelectOption<'' | 'chat-completions'>
> = [
  {
    value: '',
    label: 'Anthropic Messages（默认）',
    description: '思考签名回放、Files API 传图',
  },
  {
    value: 'chat-completions',
    label: 'OpenAI Chat Completions（回退）',
    description: '旧接口；Messages 出问题时再用',
  },
]

/** DeepSeek has three effort levels; Emperor's medium is sent as high. */
export const DEEPSEEK_EFFORT_HINT =
  'DeepSeek 只有 low / high / max 三档，medium 按 high 发送'

export function reasoningHint(
  entry: Pick<ModelEntry, 'provider'>,
): string | undefined {
  return entry.provider === 'deepseek' ? DEEPSEEK_EFFORT_HINT : undefined
}

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

export const INPUT_TOKEN_PRESETS = [
  32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000,
] as const
export const OUTPUT_TOKEN_PRESETS = [
  8_000, 16_000, 32_000, 64_000, 128_000,
] as const

export function formatTokenPreset(value: number): string {
  return value >= 1_000_000 ? `${value / 1_000_000}M` : `${value / 1000}K`
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
    throw new Error('每个任务的费用上限必须是正数')
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
