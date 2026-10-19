/**
 * `ModelDiscovery`: list a connection's models and check its key.
 *
 * - The parser comes from `resolveParser` (protocol + host + provider).
 * - Listing is all pages or an error; at most `maxModels` (2000) are kept
 *   and the rest marked `truncated`; ids that look like secrets are
 *   dropped; each model is merged with the bundled catalog.
 * - Successful lists are cached in memory for 15 minutes, keyed by a hash
 *   of the connection (the key enters the hash only as its own SHA-256, and
 *   nothing is written to disk). `refresh` bypasses the cache.
 * - A 401/403 on one of the region-split vendors (Kimi .cn/.ai, Zhipu
 *   bigmodel.cn/z.ai, MiniMax minimaxi.com/minimax.io) is checked against
 *   the vendor's other region with the same key; if that one accepts it,
 *   the result is `REGION_KEY_MISMATCH` with the other base as the fix.
 * - Results never contain the key; messages are scrubbed of it.
 */
import { createHash } from 'node:crypto'
import {
  listCatalogModels,
  lookupModelFacts,
  type CatalogModel,
  type ModelFacts,
  type ModelFactsQuery,
} from '../metadata/lookup'
import { DiscoveryHttp, type DiscoveryFetch } from './http'
import { catalogModel, mergeModel } from './merge'
import { MAX_MODELS } from './paging'
import type { ModelListParser, ParserContext } from './parser'
import { resolveParser } from './registry'
import { looksLikeSecret } from './secrets'
import {
  DiscoveryError,
  type ConnectionFix,
  type DiscoveredModel,
  type DiscoveryConnection,
  type DiscoveryFailure,
  type DiscoveryResult,
  type DiscoverySuccess,
  type ParserId,
  type ProbeErrorCode,
  type ProbeResult,
} from './types'

export const DISCOVERY_CACHE_TTL_MS = 15 * 60_000
const MAX_CACHE_ENTRIES = 32

export interface ModelDiscoveryOptions {
  /** The transport (default: the process `fetch`, as model calls use). */
  fetch?: DiscoveryFetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  cacheTtlMs?: number
  maxModels?: number
  lookup?: (query: ModelFactsQuery) => ModelFacts
  listCatalog?: (query: {
    provider: string
    apiBase?: string
  }) => CatalogModel[]
}

/** Same vendor, other region: a key works on exactly one of the two. */
const REGION_SIBLINGS: Readonly<Record<string, string>> = {
  'api.moonshot.cn': 'api.moonshot.ai',
  'api.moonshot.ai': 'api.moonshot.cn',
  'open.bigmodel.cn': 'api.z.ai',
  'api.z.ai': 'open.bigmodel.cn',
  'api.minimaxi.com': 'api.minimax.io',
  'api.minimax.cn': 'api.minimax.io',
  'api.minimax.io': 'api.minimaxi.com',
}

/** Key prefixes that name their provider. */
const KEY_PREFIX_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ['sk-ant-', 'anthropic'],
  ['sk-or-', 'openrouter'],
  ['AIza', 'gemini'],
  ['hf_', 'huggingface'],
  ['xai-', 'xai'],
  ['gsk_', 'groq'],
]

interface CacheEntry {
  at: number
  result: DiscoverySuccess
}

export class ModelDiscovery {
  private readonly options: ModelDiscoveryOptions
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<DiscoveryResult>>()

  constructor(options: ModelDiscoveryOptions = {}) {
    this.options = options
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private context(connection: DiscoveryConnection): ParserContext {
    return {
      connection,
      http: new DiscoveryHttp({
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
        ...(this.options.timeoutMs !== undefined
          ? { timeoutMs: this.options.timeoutMs }
          : {}),
        secrets: secretsOf(connection),
      }),
      stopAfter: this.options.maxModels ?? MAX_MODELS,
    }
  }

  async discover(
    connection: DiscoveryConnection,
    options: { refresh?: boolean } = {},
  ): Promise<DiscoveryResult> {
    const parser = resolveParser(connection)
    const key = connectionHash(connection, parser.id)
    const ttl = this.options.cacheTtlMs ?? DISCOVERY_CACHE_TTL_MS
    const hit = this.cache.get(key)
    if (!options.refresh && hit && this.now() - hit.at < ttl)
      return { ...structuredClone(hit.result), cached: true }
    const running = this.inflight.get(key)
    if (running) return structuredClone(await running)
    const task = this.run(parser, connection, key)
    this.inflight.set(key, task)
    try {
      return await task
    } finally {
      this.inflight.delete(key)
    }
  }

  async probe(connection: DiscoveryConnection): Promise<ProbeResult> {
    const parser = resolveParser(connection)
    const started = this.now()
    try {
      const outcome = await parser.probe(this.context(connection))
      return {
        ok: true,
        latencyMs: Math.max(0, this.now() - started),
        method: outcome.method,
        ...(outcome.modelCount !== undefined
          ? { modelCount: outcome.modelCount }
          : {}),
      }
    } catch (error) {
      const failure = await this.explain(error, connection)
      return {
        ok: false,
        code: probeCode(failure.code),
        message: failure.message,
        ...(failure.fix ? { fix: failure.fix } : {}),
        ...(failure.status !== undefined ? { status: failure.status } : {}),
      }
    }
  }

  clearCache(): void {
    this.cache.clear()
  }

  private async run(
    parser: ModelListParser,
    connection: DiscoveryConnection,
    key: string,
  ): Promise<DiscoveryResult> {
    let listing
    try {
      listing = await parser.list(this.context(connection))
    } catch (error) {
      const failure = await this.explain(error, connection)
      return { ok: false, parser: parser.id, ...failure }
    }
    const fetchedAt = new Date(this.now()).toISOString()
    const limit = this.options.maxModels ?? MAX_MODELS
    let result: DiscoverySuccess
    if (listing.source === 'catalog') {
      const models = this.catalogModels(connection)
      result = {
        ok: true,
        parser: parser.id,
        source: 'catalog',
        models,
        truncated: false,
        totalCount: models.length,
        droppedSecretLikeIds: 0,
        cached: false,
        fetchedAt,
        ...(listing.message ? { message: listing.message } : {}),
      }
    } else {
      const secrets = secretsOf(connection)
      const seen = new Set<string>()
      let dropped = 0
      const kept = listing.models.filter((model) => {
        if (looksLikeSecret(model.id, secrets)) {
          dropped += 1
          return false
        }
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
      })
      const lookup = this.options.lookup ?? lookupModelFacts
      const catalogByKey = new Map(
        (this.options.listCatalog ?? listCatalogModels)({
          provider: connection.provider,
          apiBase: connection.apiBase,
        }).map((entry) => [entry.facts.key, entry] as const),
      )
      const runtimeContextOnly =
        parser.id === 'ollama' || parser.id === 'lmstudio'
      const merged = kept
        .map((model) =>
          mergeModel(model, {
            provider: connection.provider,
            apiBase: connection.apiBase,
            lookup,
            catalogByKey,
            runtimeContextOnly,
          }),
        )
        .sort(byId)
      const truncated = listing.truncated || merged.length > limit
      result = {
        ok: true,
        parser: parser.id,
        source: 'vendor_api',
        models: merged.slice(0, limit),
        truncated,
        totalCount: merged.length,
        droppedSecretLikeIds: dropped,
        cached: false,
        fetchedAt,
        ...(listing.fix ? { fix: listing.fix } : {}),
        ...(listing.message ? { message: listing.message } : {}),
      }
    }
    this.remember(key, result)
    // Accepting the suggested address should not list again.
    if (result.fix?.apiBase) {
      const fixed = { ...connection, apiBase: result.fix.apiBase }
      const { fix: _fix, message: _message, ...rest } = result
      this.remember(connectionHash(fixed, resolveParser(fixed).id), rest)
    }
    return result
  }

  private remember(key: string, result: DiscoverySuccess): void {
    this.cache.delete(key)
    this.cache.set(key, { at: this.now(), result: structuredClone(result) })
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private catalogModels(connection: DiscoveryConnection): DiscoveredModel[] {
    return (this.options.listCatalog ?? listCatalogModels)({
      provider: connection.provider,
      apiBase: connection.apiBase,
    })
      .filter((entry) => entry.facts.lifecycle?.status !== 'retired')
      .map(catalogModel)
      .sort(byId)
  }

  /** A thrown error as a failure, after the region and key-prefix checks. */
  private async explain(
    error: unknown,
    connection: DiscoveryConnection,
  ): Promise<Omit<DiscoveryFailure, 'ok' | 'parser'>> {
    if (!(error instanceof DiscoveryError)) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        code: 'UNKNOWN',
        message: `获取模型列表失败：${message.slice(0, 200)}`,
      }
    }
    const failure: Omit<DiscoveryFailure, 'ok' | 'parser'> = {
      code: error.code,
      message: error.message,
      ...(error.fix ? { fix: error.fix } : {}),
      ...(error.status !== undefined ? { status: error.status } : {}),
    }
    if (error.code !== 'AUTH') return failure
    const region = await this.regionMismatch(connection)
    if (region) return region
    const provider = providerForKey(connection)
    if (provider) {
      failure.fix = { ...failure.fix, provider }
      failure.message = `${failure.message}（这个 Key 看起来属于 ${provider}）`
    }
    return failure
  }

  private async regionMismatch(
    connection: DiscoveryConnection,
  ): Promise<Omit<DiscoveryFailure, 'ok' | 'parser'> | null> {
    let url: URL
    try {
      url = new URL(connection.apiBase)
    } catch {
      return null
    }
    const sibling = REGION_SIBLINGS[url.hostname.toLowerCase()]
    if (!sibling || !connection.apiKey) return null
    const host = url.hostname
    url.hostname = sibling
    const apiBase = url.toString().replace(/\/+$/, '')
    const other: DiscoveryConnection = { ...connection, apiBase }
    try {
      await resolveParser(other).probe(this.context(other))
    } catch {
      return null
    }
    const fix: ConnectionFix = { apiBase }
    return {
      code: 'REGION_KEY_MISMATCH',
      message: `这个 Key 属于 ${sibling}，不能用于 ${host}：两个站点的 Key 不通用，请改用 ${apiBase}`,
      fix,
      status: 401,
    }
  }
}

function byId(a: DiscoveredModel, b: DiscoveredModel): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function secretsOf(connection: DiscoveryConnection): string[] {
  return [
    connection.apiKey,
    ...Object.values(connection.extraHeaders ?? {}),
  ].filter((value) => typeof value === 'string' && value.length > 0)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Cache key: the connection with every secret reduced to its hash. */
export function connectionHash(
  connection: DiscoveryConnection,
  parser: ParserId,
): string {
  const headers = Object.entries(connection.extraHeaders ?? {})
    .map(([name, value]) => [name.toLowerCase(), sha256(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return sha256(
    JSON.stringify([
      parser,
      connection.provider,
      connection.protocol,
      connection.apiBase.replace(/\/+$/, '').toLowerCase(),
      connection.workspaceId ?? '',
      sha256(connection.apiKey),
      headers,
    ]),
  )
}

function providerForKey(connection: DiscoveryConnection): string | undefined {
  for (const [prefix, provider] of KEY_PREFIX_PROVIDERS)
    if (
      connection.apiKey.startsWith(prefix) &&
      connection.provider !== provider
    )
      return provider
  return undefined
}

function probeCode(code: DiscoveryFailure['code']): ProbeErrorCode {
  switch (code) {
    case 'PAGING_FAILED':
      return 'UNKNOWN'
    case 'CREDENTIAL_REQUIRED':
      return 'AUTH'
    case 'MISSING_API_BASE':
      return 'WRONG_BASE'
    default:
      return code
  }
}
