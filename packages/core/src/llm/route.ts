/**
 * Model routes: the resolved connection facts of one `model_config.json`
 * entry. The model entry id is the route key every `GenerateOptions.provider`
 * names; the user-facing configuration stays `model_config.json` V2.
 */

import type { ModelEntry } from '../config/model-config'
import { resolveModelProfile } from '../model/profile'
import { resolveRetryPolicy, type ResolvedRetryPolicy } from './retry-policy'

/** Which transport implementation serves a route. */
export type RouteAdapterKind = 'deepseek' | 'pi-ai'

export interface RouteSpec {
  /** Route key: the model entry id. */
  id: string
  /** Catalog provider name (`deepseek`, `openai`, `anthropic`, `custom`, …). */
  catalogProvider: string
  displayName: string
  protocol: 'openai' | 'anthropic'
  adapter: RouteAdapterKind
  /** Wire model id. */
  modelId: string
  baseURL: string
  apiKey: string | null
  contextWindow: number
  /** Default per-request output cap. */
  maxTokens: number
  vision: boolean
  reasoning: boolean
  /** Selectable reasoning efforts in the adapter's vocabulary. */
  reasoningEfforts: readonly string[]
  /** Configured default effort, already mapped into {@link reasoningEfforts}. */
  defaultReasoningEffort?: string
  temperature?: number
  extraHeaders?: Readonly<Record<string, string>>
  extraBody?: Readonly<Record<string, unknown>>
  retryPolicy: ResolvedRetryPolicy
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_EFFORTS = ['off', 'low', 'high', 'max'] as const

/** Whether an entry should use the direct DeepSeek adapter. */
function isDeepSeekRoute(entry: ModelEntry): boolean {
  if (entry.protocol === 'anthropic') return false
  if (entry.provider === 'deepseek') return true
  try {
    return (
      entry.apiBase !== null &&
      new URL(entry.apiBase).hostname.endsWith('deepseek.com')
    )
  } catch {
    return false
  }
}

/** Map Emperor's effort vocabulary onto DeepSeek's off/low/high/max. */
export function deepseekEffort(
  effort: string | null | undefined,
): string | undefined {
  switch (effort) {
    case null:
    case undefined:
    case '':
      return undefined
    case 'none':
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return undefined
  }
}

/** Map Emperor's effort vocabulary onto pi-ai thinking levels (`none` → `off`). */
function piEffort(effort: string): string {
  return effort === 'none' ? 'off' : effort
}

/** Resolve one model entry into its route. */
export function routeFromEntry(entry: ModelEntry): RouteSpec {
  const id = entry.entryId ?? entry.id
  const modelId = entry.modelId ?? entry.name
  const protocol = entry.protocol ?? 'openai'
  const profile = resolveModelProfile({
    provider: entry.provider,
    protocol,
    modelId,
    ...(entry.capabilityOverrides === undefined
      ? {}
      : { capabilityOverrides: entry.capabilityOverrides }),
    ...(entry.contextWindowTokens === null
      ? {}
      : { contextWindowTokens: entry.contextWindowTokens }),
    ...(entry.maxTokens === null ? {} : { maxTokens: entry.maxTokens }),
  })
  const deepseek = isDeepSeekRoute(entry)
  let reasoningEfforts: readonly string[]
  let defaultReasoningEffort: string | undefined
  if (deepseek) {
    reasoningEfforts = DEEPSEEK_EFFORTS
    defaultReasoningEffort = deepseekEffort(entry.reasoningEffort)
  } else if (profile.reasoning && profile.reasoningEfforts.length > 0) {
    reasoningEfforts = [...new Set(profile.reasoningEfforts.map(piEffort))]
    const configured = entry.reasoningEffort
      ? piEffort(entry.reasoningEffort)
      : undefined
    defaultReasoningEffort =
      configured !== undefined && reasoningEfforts.includes(configured)
        ? configured
        : undefined
  } else {
    reasoningEfforts = []
    defaultReasoningEffort = undefined
  }
  const baseURL = (
    entry.apiBase ?? (deepseek ? DEFAULT_DEEPSEEK_BASE_URL : '')
  ).replace(/\/+$/, '')
  return Object.freeze({
    id,
    catalogProvider: entry.provider,
    displayName: entry.displayName || entry.label || modelId,
    protocol,
    adapter: deepseek ? 'deepseek' : 'pi-ai',
    modelId,
    baseURL,
    apiKey: entry.apiKey,
    contextWindow: profile.contextWindowTokens,
    maxTokens: profile.maxTokens,
    vision: profile.vision,
    reasoning: deepseek ? true : profile.reasoning,
    reasoningEfforts,
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    ...(entry.temperature === null ? {} : { temperature: entry.temperature }),
    ...(entry.extraHeaders ? { extraHeaders: { ...entry.extraHeaders } } : {}),
    ...(entry.extraBody ? { extraBody: { ...entry.extraBody } } : {}),
    retryPolicy: resolveRetryPolicy(undefined),
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  }) as RouteSpec
}
