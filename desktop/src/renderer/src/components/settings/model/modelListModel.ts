/**
 * Settings › 模型 list (MOD-05) — pure helpers, no Vue: what a provider
 * card's header says about its connection, which saved models share that
 * connection, how a model row reads, the retirement note and the models a
 * cost cap cannot cover.
 */
import type { ModelConfigPayload, ModelEntry } from '../../../types'
import type { ProviderGroup } from '../../../model/providerGroups'
import { canonicalModelApiBase, formatTokenCount } from './modelFormModel'

const DAY_MS = 24 * 60 * 60 * 1000

/** Entries on one connection: the same connectionId, else the same endpoint. */
export function sameConnection(a: ModelEntry, b: ModelEntry): boolean {
  if (a.connectionId && b.connectionId) return a.connectionId === b.connectionId
  return (
    a.provider === b.provider &&
    a.protocol === b.protocol &&
    canonicalModelApiBase(a.protocol, a.apiBase) ===
      canonicalModelApiBase(b.protocol, b.apiBase)
  )
}

/** The card's connection: its first model and every model sharing it. */
export function cardConnection(group: Pick<ProviderGroup, 'entries'>): {
  lead: ModelEntry
  entries: ModelEntry[]
} | null {
  const lead = group.entries[0]
  if (!lead) return null
  return {
    lead,
    entries: group.entries.filter((entry) => sameConnection(entry, lead)),
  }
}

/** `···1234` for a saved key (Core sends `***` + the last 4), else ''. */
export function keyTail(entries: readonly ModelEntry[]): string {
  for (const entry of entries) {
    const masked = entry.apiKey ?? ''
    if (masked.startsWith('***') && masked.length > 3)
      return `···${masked.slice(3, 7)}`
  }
  return ''
}

export function hostOf(apiBase: string): string {
  try {
    return new URL(apiBase).host
  } catch {
    return apiBase.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? ''
  }
}

export type ConnectionTone = 'ok' | 'warn' | 'error' | 'neutral'

/**
 * The card's status line from the newest test of its models:
 * 「已连接」, 「Key 无效 · N 天前测试」 (or 「连接失败 · …」), 「未测试」.
 */
export function connectionStatus(
  entries: readonly ModelEntry[],
  now = Date.now(),
): { text: string; tone: ConnectionTone } {
  const tested = entries
    .map((entry) => entry.lastTest)
    .filter((test): test is NonNullable<ModelEntry['lastTest']> =>
      Boolean(test && Number.isFinite(Date.parse(test.testedAt))),
    )
    .sort((a, b) => Date.parse(b.testedAt) - Date.parse(a.testedAt))
  const latest = tested[0]
  if (!latest) return { text: '未测试', tone: 'neutral' }
  if (latest.ok) return { text: '已连接', tone: 'ok' }
  const what = latest.failure === 'auth' ? 'Key 无效' : '连接失败'
  return {
    text: `${what} · ${testedAgo(latest.testedAt, now)}`,
    tone: latest.failure === 'auth' ? 'error' : 'warn',
  }
}

function testedAgo(testedAt: string, now: number): string {
  const days = Math.floor((now - Date.parse(testedAt)) / DAY_MS)
  return days <= 0 ? '今天测试' : `${days} 天前测试`
}

/** 「128K / 8K」: the context and each request's output. */
export function rowLimits(entry: ModelEntry): string {
  const context = formatTokenCount(
    entry.resolvedProfile?.contextWindowTokens || entry.contextWindowTokens,
  )
  const output = formatTokenCount(
    entry.resolvedProfile?.maxTokens || entry.maxTokens,
  )
  return [context, output].filter(Boolean).join(' / ')
}

/** The retirement note of a row, with the model to switch to (if any). */
export function lifecycleNote(entry: ModelEntry): {
  status: 'deprecated' | 'retired'
  text: string
  replacement: string | null
} | null {
  const lifecycle = entry.lifecycle
  if (!lifecycle || lifecycle.status === 'active' || !lifecycle.status)
    return null
  const when = lifecycle.retiresAt ?? ''
  const retired = lifecycle.status === 'retired'
  const text = retired
    ? when
      ? `已于 ${when} 退役，请求会失败`
      : '厂商已退役这个模型，请求会失败'
    : when
      ? `将于 ${when} 下线`
      : '厂商即将下线这个模型'
  return {
    status: lifecycle.status,
    text,
    replacement: lifecycle.replacement ?? null,
  }
}

/**
 * Models the per-turn cost cap cannot cover (no prices): the active one,
 * and the backup when it is on. Empty while no cap is set.
 */
export function unpricedUnderCap(payload: ModelConfigPayload): ModelEntry[] {
  const policy = payload.policy
  if (policy?.cost?.maxUsdPerAgentTurn == null) return []
  const ids = new Set<string>()
  if (payload.activeModelId) ids.add(payload.activeModelId)
  const fallback = policy.fallback
  if (fallback?.enabled && fallback.entryId) ids.add(fallback.entryId)
  return payload.models.filter(
    (entry) => ids.has(entry.entryId) && !entry.pricing,
  )
}

export type ValueField =
  'contextWindowTokens' | 'maxTokens' | 'reasoningEffort' | 'capabilities'

const SOURCE_LABELS: Record<string, string> = {
  vendor_api: '官方接口',
  catalog: '内置目录',
  family_rule: '推断',
  fallback: '默认值',
  manual: '手动',
}

/** Where a value of the editor came from: 手动 when the user set it. */
export function valueSource(entry: ModelEntry, field: ValueField): string {
  const metadata = entry.metadata
  if (!metadata || metadata.source === 'manual') return '手动'
  if (metadata.userLocked?.includes(field)) return '手动'
  return SOURCE_LABELS[metadata.source] ?? '未知'
}
