import type {
  ModelCapabilityOverrides,
  ModelEntryV2,
  ModelProtocol,
} from '../config/model-config'
import { findByName } from '../providers/registry'

export const REASONING_EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningEffort = (typeof REASONING_EFFORT_ORDER)[number]
export type CapabilitySource = 'override' | 'inferred' | 'default'

export type ModelReasoningAdapter =
  | 'none'
  | 'openai_effort'
  | 'anthropic_adaptive'
  | 'anthropic_adaptive_summarized'
  | 'anthropic_budget'
  | 'thinking_toggle'
  | 'enable_thinking_toggle'
  | 'reasoning_split_toggle'

export interface ModelProfileEntry extends Pick<
  ModelEntryV2,
  'provider' | 'protocol' | 'modelId'
> {
  capabilityOverrides?: ModelCapabilityOverrides
  contextWindowTokens?: number
  maxTokens?: number
}

export interface ResolvedModelProfile {
  toolCall: boolean
  vision: boolean
  reasoning: boolean
  sources: Readonly<{
    toolCall: CapabilitySource
    vision: CapabilitySource
    reasoning: CapabilitySource
  }>
  contextWindowTokens: number
  maxTokens: number
  reasoningEfforts: readonly ReasoningEffort[]
  reasoningAdapter: ModelReasoningAdapter
}

interface InferredCapabilities {
  toolCall?: boolean
  vision?: boolean
  reasoning?: boolean
}

interface ResolvedCapability {
  value: boolean
  source: CapabilitySource
}

const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

const BASE_GPT5_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
const GPT5_1_EFFORTS = ['none', 'low', 'medium', 'high'] as const
const GPT5_2_PLUS_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const GPT5_PRO_EFFORTS = ['high'] as const
const GPT5_VERSIONED_PRO_EFFORTS = ['medium', 'high', 'xhigh'] as const
const GPT5_CHAT_EFFORTS = ['medium'] as const
const GPT5_CODEX_EFFORTS = ['low', 'medium', 'high'] as const
const GPT5_CODEX_XHIGH_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
const GPT5_CODEX_3_PLUS_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
] as const
const CLAUDE_ADAPTIVE_EFFORTS = ['low', 'medium', 'high', 'max'] as const
const CLAUDE_ADAPTIVE_NEW_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
const CLAUDE_BUDGET_EFFORTS = ['none', 'high', 'max'] as const
const TOGGLE_EFFORTS = ['none', 'high'] as const
const GENERIC_OPENAI_EFFORTS = ['none', 'low', 'medium', 'high'] as const

/**
 * Reasoning effort families are a stable local subset of OpenCode commit
 * cb8be9ba1217c2e7a2b93cf513eb21b41a7f5365; no runtime dependency is used.
 */
export function resolveModelProfile(
  entry: ModelProfileEntry,
): ResolvedModelProfile {
  const id = entry.modelId.trim().toLowerCase()
  const inferred = inferCapabilities(id)
  const toolCall = resolveCapability(
    entry.capabilityOverrides?.toolCall,
    inferred.toolCall,
    true,
  )
  const vision = resolveCapability(
    entry.capabilityOverrides?.vision,
    inferred.vision,
    false,
  )
  const reasoning = resolveCapability(
    entry.capabilityOverrides?.reasoning,
    inferred.reasoning,
    false,
  )
  const contextWindowTokens = positiveTokenLimit(
    entry.contextWindowTokens,
    128_000,
  )
  const maxTokens = positiveTokenLimit(entry.maxTokens, 8_000)
  const reasoningConfig = reasoning.value
    ? resolveReasoningConfig(entry.provider, entry.protocol, id)
    : { adapter: 'none' as const, efforts: [] as const }

  return {
    toolCall: toolCall.value,
    vision: vision.value,
    reasoning: reasoning.value,
    sources: {
      toolCall: toolCall.source,
      vision: vision.source,
      reasoning: reasoning.source,
    },
    contextWindowTokens,
    maxTokens,
    reasoningEfforts: reasoningConfig.efforts,
    reasoningAdapter: reasoningConfig.adapter,
  }
}

export function reasoningPayload(
  profile: ResolvedModelProfile,
  effort: ReasoningEffort,
): Record<string, unknown> {
  if (
    !profile.reasoning ||
    !profile.reasoningEfforts.includes(effort) ||
    profile.reasoningAdapter === 'none'
  )
    return {}

  switch (profile.reasoningAdapter) {
    case 'openai_effort':
      return { reasoning_effort: effort }
    case 'thinking_toggle':
      return {
        thinking: { type: effort === 'none' ? 'disabled' : 'enabled' },
      }
    case 'enable_thinking_toggle':
      return { enable_thinking: effort !== 'none' }
    case 'reasoning_split_toggle':
      return { reasoning_split: effort !== 'none' }
    case 'anthropic_adaptive':
      return {
        thinking: { type: 'adaptive' },
        output_config: { effort },
      }
    case 'anthropic_adaptive_summarized':
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort },
      }
    case 'anthropic_budget': {
      if (effort === 'none') return {}
      const budget =
        effort === 'high'
          ? Math.min(16_000, Math.floor(profile.maxTokens / 2 - 1))
          : Math.min(31_999, profile.maxTokens - 1)
      return budget > 0
        ? { thinking: { type: 'enabled', budget_tokens: budget } }
        : {}
    }
  }
}

function resolveCapability(
  override: boolean | undefined,
  inferred: boolean | undefined,
  fallback: boolean,
): ResolvedCapability {
  if (override !== undefined) return { value: override, source: 'override' }
  if (inferred !== undefined) return { value: inferred, source: 'inferred' }
  return { value: fallback, source: 'default' }
}

function inferCapabilities(id: string): InferredCapabilities {
  const result: InferredCapabilities = {}
  const isGpt5 = GPT5_FAMILY_RE.test(id)
  const isClaude = /(?:^|[/_-])claude(?:[._-]|$)/.test(id)
  const isDeepSeekReasoning =
    id.includes('deepseek-reasoner') ||
    id.includes('deepseek-r1') ||
    /deepseek[-_.]?v[34](?:[._-]|$)/.test(id)
  const isQwenReasoning =
    (id.includes('qwen') &&
      (id.includes('thinking') || /qwen[-_.]?3/.test(id))) ||
    id.includes('qwq')
  const isMiniMaxReasoning =
    id.includes('minimax') && /(?:^|[-_.])m[23](?:[-_.]|$)/.test(id)

  if (isGpt5 || isClaude) {
    result.toolCall = true
    result.vision = true
    result.reasoning = true
  } else if (isDeepSeekReasoning || isQwenReasoning || isMiniMaxReasoning) {
    result.toolCall = true
    result.reasoning = true
  }
  if (
    id.includes('vision') ||
    id.includes('multimodal') ||
    /(?:^|[-_.])vl(?:[-_.]|$)/.test(id) ||
    ['gpt-4o', 'gemini', 'pixtral', 'llava'].some((keyword) =>
      id.includes(keyword),
    )
  )
    result.vision = true
  return result
}

function positiveTokenLimit(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback
}

function resolveReasoningConfig(
  provider: string,
  protocol: ModelProtocol,
  id: string,
): {
  adapter: ModelReasoningAdapter
  efforts: readonly ReasoningEffort[]
} {
  if (protocol === 'anthropic') return resolveAnthropicReasoning(id)

  const providerAdapter = findByName(provider)?.reasoningAdapter.openai
  if (
    providerAdapter === 'thinking_toggle' ||
    providerAdapter === 'enable_thinking_toggle' ||
    providerAdapter === 'reasoning_split_toggle'
  )
    return { adapter: providerAdapter, efforts: TOGGLE_EFFORTS }

  return {
    adapter: 'openai_effort',
    efforts: gpt5ReasoningEfforts(id) ?? GENERIC_OPENAI_EFFORTS,
  }
}

function gpt5ReasoningEfforts(
  id: string,
): readonly ReasoningEffort[] | undefined {
  if (!GPT5_FAMILY_RE.test(id)) return undefined
  const version = Number(GPT5_VERSION_RE.exec(id)?.[1]) || undefined
  if (id.includes('-chat') && version !== undefined) return GPT5_CHAT_EFFORTS
  if (GPT5_PRO_RE.test(id)) return GPT5_PRO_EFFORTS
  if (id.includes('codex')) {
    if (version !== undefined && version >= 3) return GPT5_CODEX_3_PLUS_EFFORTS
    if (id.includes('codex-max') || (version !== undefined && version >= 2))
      return GPT5_CODEX_XHIGH_EFFORTS
    return GPT5_CODEX_EFFORTS
  }
  if (GPT5_VERSIONED_PRO_RE.test(id)) return GPT5_VERSIONED_PRO_EFFORTS
  if (version === 1) return GPT5_1_EFFORTS
  if (version !== undefined && version >= 2) return GPT5_2_PLUS_EFFORTS
  return BASE_GPT5_EFFORTS
}

function resolveAnthropicReasoning(id: string): {
  adapter: ModelReasoningAdapter
  efforts: readonly ReasoningEffort[]
} {
  const opus = claudeFamilyVersion(id, 'opus')
  const sonnet = claudeFamilyVersion(id, 'sonnet')
  if (
    (opus && (opus.major > 4 || (opus.major === 4 && opus.minor >= 7))) ||
    (sonnet && sonnet.major >= 5)
  )
    return {
      adapter: 'anthropic_adaptive_summarized',
      efforts: CLAUDE_ADAPTIVE_NEW_EFFORTS,
    }
  if (
    (opus && opus.major === 4 && opus.minor === 6) ||
    (sonnet && sonnet.major === 4 && sonnet.minor === 6)
  )
    return {
      adapter: 'anthropic_adaptive',
      efforts: CLAUDE_ADAPTIVE_EFFORTS,
    }
  return { adapter: 'anthropic_budget', efforts: CLAUDE_BUDGET_EFFORTS }
}

function claudeFamilyVersion(
  id: string,
  family: 'opus' | 'sonnet',
): { major: number; minor: number } | undefined {
  const forward = new RegExp(`${family}[-_.](\\d+)(?:[-_.](\\d+))?`).exec(id)
  const inverted = new RegExp(
    `claude[-_.](\\d+)(?:[-_.](\\d+))?[-_.]${family}`,
  ).exec(id)
  const match = forward ?? inverted
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) }
}
