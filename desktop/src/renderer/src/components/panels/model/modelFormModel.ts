import type {
  ModelCapabilityOverrides,
  ModelEntry,
  ModelEntrySaveInput,
  ProviderOption,
} from '../../../types'

export type CapabilityControl = 'auto' | 'on' | 'off'

export interface ModelEntryDraft {
  entryId?: string
  provider: string
  protocol: 'openai' | 'anthropic'
  modelId: string
  displayName: string
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
  resolvedProfile?: ModelEntry['resolvedProfile']
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

function capabilityOverride(
  control: CapabilityControl,
): boolean | undefined {
  if (control === 'on') return true
  if (control === 'off') return false
  return undefined
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
        : protocols[0] ?? 'openai'
  const overrides = entry?.capabilityOverrides ?? {}
  return {
    ...(entry?.entryId ? { entryId: entry.entryId } : {}),
    provider: provider.name,
    protocol,
    modelId: String(entry?.modelId ?? ''),
    displayName: String(entry?.displayName ?? ''),
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
    ...(entry?.resolvedProfile
      ? { resolvedProfile: entry.resolvedProfile }
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
        : protocols[0] ?? 'openai'
  return {
    ...draft,
    provider: provider.name,
    protocol,
    apiBase: provider.apiBases?.[protocol] ?? '',
    modelId: '',
    reasoningEffort: null,
    resolvedProfile: undefined,
  }
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

  const apiKey = draft.clearApiKey
    ? null
    : draft.apiKey.trim()
      ? draft.apiKey.trim()
      : undefined
  return {
    ...(draft.entryId ? { entryId: draft.entryId } : {}),
    provider: draft.provider,
    protocol: draft.protocol,
    modelId: draft.modelId.trim(),
    ...(draft.displayName.trim()
      ? { displayName: draft.displayName.trim() }
      : {}),
    apiBase: draft.apiBase.trim(),
    ...(apiKey !== undefined ? { apiKey } : {}),
    capabilityOverrides,
    contextWindowTokens: Math.max(1, Math.trunc(draft.contextWindowTokens)),
    maxTokens: Math.max(1, Math.trunc(draft.maxTokens)),
    reasoningEffort: draft.reasoningEffort,
  }
}
