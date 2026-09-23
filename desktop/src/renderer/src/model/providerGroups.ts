/**
 * Provider grouping for Settings › 模型 and the composer model menu: saved
 * model entries grouped under their provider (first-appearance order, so the
 * list follows model_config.json), the provider catalog split into region
 * sections for the add-model picker, and the per-provider credential summary.
 * Pure data — no DOM, no Core bridge.
 */
import type { ModelEntry, ProviderOption, ProviderRegion } from '../types'

export const PROTOCOL_SHORT_LABELS: Record<ModelEntry['protocol'], string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
}

export interface ProviderGroup {
  /** Registry name (`ModelEntry.provider`). */
  provider: string
  option: ProviderOption | undefined
  label: string
  iconId: string
  entries: ModelEntry[]
}

export type ProviderCredentialState = 'ok' | 'missing' | 'keyless'

export interface ProviderSection {
  region: ProviderRegion
  label: string
  providers: ProviderOption[]
}

const REGION_SECTIONS: ReadonlyArray<{
  region: ProviderRegion
  label: string
}> = [
  { region: 'cn', label: '国内厂商' },
  { region: 'foreign', label: '海外厂商' },
  { region: 'aggregator', label: '聚合平台' },
  { region: 'cloud', label: '云平台' },
  { region: 'local', label: '本地部署' },
  { region: 'other', label: '自定义' },
]

export function providerDisplayName(
  name: string,
  option: ProviderOption | undefined,
): string {
  return option?.displayName || option?.name || name || 'Provider'
}

/**
 * Splits a catalog display name into its name and a parenthesised note:
 * 「SiliconFlow (硅基流动)」 → { name: 'SiliconFlow', note: '硅基流动' }.
 */
export function providerNameParts(displayName: string): {
  name: string
  note: string
} {
  const match = /^(.+?)\s*[（(]([^()（）]+)[)）]\s*$/.exec(displayName.trim())
  return match
    ? { name: match[1]!, note: match[2]! }
    : { name: displayName.trim(), note: '' }
}

export function groupEntriesByProvider(
  entries: readonly ModelEntry[],
  options: readonly ProviderOption[],
): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>()
  for (const entry of entries) {
    const existing = groups.get(entry.provider)
    if (existing) {
      existing.entries.push(entry)
      continue
    }
    const option = options.find(
      (candidate) => candidate.name === entry.provider,
    )
    groups.set(entry.provider, {
      provider: entry.provider,
      option,
      label: providerDisplayName(entry.provider, option),
      iconId: option?.iconId || entry.provider,
      entries: [entry],
    })
  }
  return [...groups.values()]
}

/**
 * The entry a new model under this provider copies its credential from: the
 * first one that has a saved key. Null when none has one.
 */
export function credentialSourceEntry(
  group: Pick<ProviderGroup, 'entries'> | undefined,
): ModelEntry | null {
  return group?.entries.find((entry) => Boolean(entry.apiKey)) ?? null
}

/**
 * `keyless` = a local server that needs no key and none is saved; `missing`
 * = at least one entry of a keyed provider has no saved key.
 */
export function providerCredentialState(
  group: Pick<ProviderGroup, 'entries' | 'option'>,
): ProviderCredentialState {
  const withKey = group.entries.filter((entry) => Boolean(entry.apiKey)).length
  if (withKey === group.entries.length) return 'ok'
  if (group.option?.isLocal && withKey === 0) return 'keyless'
  return 'missing'
}

function endpointHost(apiBase: string): string {
  try {
    return new URL(apiBase).host
  } catch {
    return apiBase.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  }
}

/** 「api.deepseek.com · OpenAI 兼容」 — distinct hosts and protocols. */
export function providerEndpointSummary(
  group: Pick<ProviderGroup, 'entries'>,
): string {
  const hosts = [
    ...new Set(group.entries.map((entry) => endpointHost(entry.apiBase))),
  ].filter(Boolean)
  const protocols = [
    ...new Set(
      group.entries.map((entry) => PROTOCOL_SHORT_LABELS[entry.protocol]),
    ),
  ]
  return [hosts.join('、'), protocols.join(' / ')].filter(Boolean).join(' · ')
}

export function providerSections(
  options: readonly ProviderOption[],
  query = '',
): ProviderSection[] {
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? options.filter((option) =>
        `${option.name} ${option.displayName ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    : options
  const known = new Set<string>(
    REGION_SECTIONS.map((section) => section.region),
  )
  const regionOf = (option: ProviderOption): ProviderRegion =>
    option.region && known.has(option.region) ? option.region : 'other'
  return REGION_SECTIONS.map(({ region, label }) => ({
    region,
    label,
    providers: visible.filter((option) => regionOf(option) === region),
  })).filter((section) => section.providers.length > 0)
}
