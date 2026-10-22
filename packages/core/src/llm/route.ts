/**
 * Model routes: the resolved connection facts of one `model_config.json`
 * entry. The model entry id is the route key every `GenerateOptions.provider`
 * names; the user-facing configuration stays `model_config.json` V2.
 */

import type { ModelEntry } from '../config/model-config'
import { resolveModelProfile } from '../model/profile'
import {
  ANTHROPIC_BASE_PATH,
  DEEPSEEK_OFFICIAL_HOST,
  DEEPSEEK_ORIGIN,
} from './adapters/deepseek-messages/constants'
import { resolveRetryPolicy, type ResolvedRetryPolicy } from './retry-policy'

/**
 * Which transport implementation serves a route: `deepseek-messages` (the
 * official DeepSeek host over the Anthropic Messages API, KRN-07),
 * `deepseek` (DeepSeek-style chat-completions: gateways, and entries that
 * keep it), `pi-ai` (everything else).
 */
export type RouteAdapterKind = 'deepseek' | 'deepseek-messages' | 'pi-ai'

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
  /** Inline image budget per request in base64 bytes (default 20 MiB). */
  maxRequestImageBytes?: number
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEEPSEEK_EFFORTS = ['off', 'low', 'high', 'max'] as const

/**
 * Whether an API base is DeepSeek's official host (`https://api.deepseek.com`
 * under any path). No base means the provider default, which is that host.
 */
export function isOfficialDeepSeekHost(
  apiBase: string | null | undefined,
): boolean {
  if (apiBase === null || apiBase === undefined || apiBase.trim() === '')
    return true
  try {
    const url = new URL(apiBase.trim())
    return url.protocol === 'https:' && url.hostname === DEEPSEEK_OFFICIAL_HOST
  } catch {
    return false
  }
}

/** Whether a route speaks DeepSeek's effort vocabulary (off/low/high/max). */
export function usesDeepSeekEfforts(
  route: Pick<RouteSpec, 'adapter'>,
): boolean {
  return route.adapter === 'deepseek' || route.adapter === 'deepseek-messages'
}

/**
 * Which adapter serves an entry. DeepSeek on its official host goes over
 * Messages unless the entry keeps chat-completions; DeepSeek elsewhere (and
 * OpenAI-protocol entries pointing at a deepseek.com host) use the direct
 * chat-completions adapter; the rest go to pi-ai.
 */
function adapterFor(entry: ModelEntry): RouteAdapterKind {
  if (entry.provider === 'deepseek' && isOfficialDeepSeekHost(entry.apiBase))
    return entry.transport === 'chat-completions'
      ? 'deepseek'
      : 'deepseek-messages'
  if (entry.protocol === 'anthropic') return 'pi-ai'
  if (entry.provider === 'deepseek') return 'deepseek'
  try {
    return entry.apiBase !== null &&
      new URL(entry.apiBase).hostname.endsWith('deepseek.com')
      ? 'deepseek'
      : 'pi-ai'
  } catch {
    return 'pi-ai'
  }
}

/** The base URL an adapter is given (no trailing slash). */
function baseUrlFor(entry: ModelEntry, adapter: RouteAdapterKind): string {
  const configured = (entry.apiBase ?? '').trim().replace(/\/+$/, '')
  if (adapter === 'deepseek-messages')
    return `${DEEPSEEK_ORIGIN}${ANTHROPIC_BASE_PATH}`
  if (adapter === 'deepseek') {
    // An official Anthropic-protocol entry that keeps chat-completions talks
    // to the OpenAI-compatible origin instead of /anthropic.
    if (
      configured === '' ||
      (entry.provider === 'deepseek' &&
        isOfficialDeepSeekHost(configured) &&
        new URL(configured).pathname.replace(/\/+$/, '') ===
          ANTHROPIC_BASE_PATH)
    )
      return DEEPSEEK_ORIGIN
  }
  return configured
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
    ...(entry.detected === undefined ? {} : { detected: entry.detected }),
    ...(entry.contextWindowTokens === null
      ? {}
      : { contextWindowTokens: entry.contextWindowTokens }),
    ...(entry.maxTokens === null ? {} : { maxTokens: entry.maxTokens }),
  })
  const adapter = adapterFor(entry)
  const deepseek = adapter !== 'pi-ai'
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
  const baseURL = baseUrlFor(entry, adapter)
  return Object.freeze({
    id,
    catalogProvider: entry.provider,
    displayName: entry.displayName || entry.label || modelId,
    // The wire each adapter speaks, whatever the entry was saved with.
    protocol:
      adapter === 'deepseek-messages'
        ? 'anthropic'
        : adapter === 'deepseek'
          ? 'openai'
          : protocol,
    adapter,
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
