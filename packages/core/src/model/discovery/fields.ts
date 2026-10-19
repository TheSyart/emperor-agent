/** Small readers for untrusted vendor JSON: wrong types read as absent. */
import type { ModelKind } from '../metadata/lookup'

export type Json = Record<string, unknown>

export function record(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

export function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export function posInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter(
    (item): item is string => typeof item === 'string' && !!item.trim(),
  )
}

/** `{ supported: boolean }` leaves (Anthropic capabilities). */
export function supported(value: unknown): boolean | undefined {
  return bool(record(value)?.supported)
}

/** `YYYY-MM-DD` from an ISO date or datetime. */
export function isoDate(value: unknown): string | undefined {
  const text = str(value)
  if (!text) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text)
  return match?.[1]
}

export function created(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value
  return str(value)
}

/** Lower-cased modality names (`Image` → `image`), deduplicated. */
export function modalities(value: unknown): string[] | undefined {
  const list = strings(value)
  if (!list) return undefined
  return [...new Set(list.map((item) => item.toLowerCase()))]
}

/**
 * The model array of a list body: a bare array, `data`, or `models`.
 * Anything else is not a model list.
 */
export function modelArray(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) return body
  const object = record(body)
  if (!object) return undefined
  if (Array.isArray(object.data)) return object.data
  if (Array.isArray(object.models)) return object.models
  return undefined
}

/** The documented efforts in their usual order, then any others. */
const EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export function orderedEfforts(values: readonly string[]): string[] {
  const unique = [...new Set(values.map((value) => value.toLowerCase()))]
  return unique.sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a)
    const ib = EFFORT_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

/** A vendor's declared model type to our kind; `undefined` when unknown. */
export function kindFromType(value: unknown): ModelKind | undefined {
  switch (str(value)?.toLowerCase()) {
    case 'chat':
    case 'language':
    case 'code':
    case 'llm':
    case 'vlm':
      return 'chat'
    case 'embedding':
    case 'embeddings':
      return 'embedding'
    case 'rerank':
    case 'reranker':
      return 'rerank'
    case 'image':
      return 'image'
    case 'audio':
    case 'transcribe':
    case 'tts':
      return 'audio'
    case 'moderation':
    case 'video':
    case 'decision':
      return 'other'
    default:
      return undefined
  }
}

/** US dollars per token (a decimal string or number) → per million tokens. */
export function usdPerMTok(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined
  return Number((n * 1_000_000).toPrecision(12))
}
