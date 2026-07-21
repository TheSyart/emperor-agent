import type {
  ModelCapabilityOverrides,
  ModelEntry,
  ModelEntrySaveInput,
  ModelPricing,
  ProviderOption,
} from '../../../types'

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
}

function providerProtocols(
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
