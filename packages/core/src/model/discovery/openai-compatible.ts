/**
 * OpenAI-style `GET {base}/models` lists: `{ data: [...] }`, a bare array
 * (Together) or `{ models: [...] }`, Bearer auth. Vendor parsers built on
 * this only add their own field reading (`mapItem`) and URL quirks.
 */
import { collectPages } from './paging'
import {
  created,
  kindFromType,
  modelArray,
  posInt,
  record,
  str,
  type Json,
} from './fields'
import {
  authCheck,
  bearerHeaders,
  catalogListing,
  hasVersionSuffix,
  notCompatible,
  trimBase,
  type ModelListParser,
  type ParserContext,
  type ParserListing,
  type ProbeOutcome,
} from './parser'
import {
  DiscoveryError,
  type DiscoveryConnection,
  type ParserId,
  type VendorModel,
} from './types'

export interface OpenAiStyleOptions {
  id: ParserId
  /** Base the list lives under; default the connection's API base. */
  listBase?: (connection: DiscoveryConnection) => string
  /** Path and query after the list base; default `/models`. */
  listPath?: string
  /** One list item → a model, or `null` to skip it (no id, archived …). */
  mapItem?: (item: Json) => VendorModel | null
  /**
   * On a 404 at a base with no version segment, try `{base}/v1/models`; a
   * hit lists the models and returns the corrected base as `fix.apiBase`.
   * Only valid when the list base is the API base.
   */
  retryV1?: boolean
  /** A missing list (404/405/HTML) means "no list endpoint": use the catalog. */
  catalogOnMissing?: boolean
  /** Follow `links.next` page URLs on the same origin (OpenRouter). */
  followLinksNext?: boolean
  /** Check the key with this authenticated GET instead of the list. */
  probeUrl?: (connection: DiscoveryConnection) => string
  /** Check the key with an auth check on the chat endpoint, not the list. */
  probeByAuthCheck?: boolean
  headers?: (connection: DiscoveryConnection) => Record<string, string>
}

const NO_LIST_MESSAGE =
  '这个地址没有可用的模型列表接口，下面是内置目录里该厂商的推荐模型，也可以手动输入模型 ID'

/** The fields most OpenAI-style gateways add to `{ id, owned_by, created }`. */
export function genericModel(item: Json): VendorModel | null {
  const id = str(item.id) ?? str(item.model) ?? str(item.name)
  if (!id) return null
  const model: VendorModel = { id }
  const name =
    str(item.display_name) ??
    (str(item.name) !== id ? str(item.name) : undefined)
  if (name) model.name = name
  const ownedBy =
    str(item.owned_by) ?? str(item.ownedBy) ?? str(item.organization)
  if (ownedBy) model.ownedBy = ownedBy
  const when = created(item.created ?? item.created_at)
  if (when !== undefined) model.created = when
  const context =
    posInt(item.context_length) ??
    posInt(item.context_window) ??
    posInt(item.max_context_length) ??
    posInt(item.max_model_len)
  if (context) model.contextWindowTokens = context
  const output =
    posInt(item.max_output_tokens) ?? posInt(item.max_completion_tokens)
  if (output) model.maxOutputTokens = output
  const kind = kindFromType(item.type)
  if (kind) model.kind = kind
  const root = str(item.root)
  if (root && root !== id) model.lookupId = root
  return model
}

export function openAiStyleParser(
  options: OpenAiStyleOptions,
): ModelListParser {
  const listPath = options.listPath ?? '/models'
  const mapItem = options.mapItem ?? genericModel
  const headersFor = options.headers ?? bearerHeaders
  const listBaseFor = (connection: DiscoveryConnection): string =>
    trimBase(options.listBase?.(connection) ?? connection.apiBase)

  async function collect(
    context: ParserContext,
    firstUrl: string,
  ): Promise<{ models: VendorModel[]; truncated: boolean }> {
    const headers = headersFor(context.connection)
    const { items, truncated } = await collectPages<unknown>(
      async (cursor) => {
        const url = cursor ?? firstUrl
        const body = await context.http.json(url, { headers })
        const items = modelArray(body)
        if (!items) throw notCompatible(new URL(url).host)
        return {
          items,
          next: options.followLinksNext ? nextLink(body, url) : null,
        }
      },
      { stopAfter: context.stopAfter },
    )
    const models: VendorModel[] = []
    for (const item of items) {
      const object = record(item)
      const model = object ? mapItem(object) : null
      if (model) models.push(model)
    }
    return { models, truncated }
  }

  function canRetryV1(error: unknown, base: string): boolean {
    return (
      options.retryV1 === true &&
      error instanceof DiscoveryError &&
      error.code === 'WRONG_BASE' &&
      error.status === 404 &&
      !hasVersionSuffix(base)
    )
  }

  function isMissing(error: unknown): error is DiscoveryError {
    return error instanceof DiscoveryError && error.code === 'WRONG_BASE'
  }

  return {
    id: options.id,

    async list(context): Promise<ParserListing> {
      const base = listBaseFor(context.connection)
      try {
        const { models, truncated } = await collect(
          context,
          `${base}${listPath}`,
        )
        return { source: 'vendor_api', models, truncated }
      } catch (error) {
        if (canRetryV1(error, base)) {
          try {
            const fixed = `${base}/v1`
            const { models, truncated } = await collect(
              context,
              `${fixed}${listPath}`,
            )
            return {
              source: 'vendor_api',
              models,
              truncated,
              fix: { apiBase: fixed },
              message: `API 地址缺少 /v1：已按 ${fixed} 获取模型，保存前请改用这个地址`,
            }
          } catch (retryError) {
            if (!isMissing(retryError)) throw retryError
          }
        }
        if (options.catalogOnMissing && isMissing(error))
          return catalogListing(NO_LIST_MESSAGE)
        throw error
      }
    },

    async probe(context): Promise<ProbeOutcome> {
      const { connection } = context
      if (options.probeByAuthCheck) return authCheck(context)
      if (options.probeUrl) {
        await context.http.json(options.probeUrl(connection), {
          headers: headersFor(connection),
        })
        return { method: 'auth_check' }
      }
      const base = listBaseFor(connection)
      const headers = headersFor(connection)
      const firstPage = async (url: string): Promise<ProbeOutcome> => {
        const body = await context.http.json(url, { headers })
        const items = modelArray(body)
        if (!items) throw notCompatible(new URL(url).host)
        const more = options.followLinksNext && nextLink(body, url)
        return more
          ? { method: 'list' }
          : { method: 'list', modelCount: items.length }
      }
      try {
        return await firstPage(`${base}${listPath}`)
      } catch (error) {
        if (canRetryV1(error, base)) {
          const fixed = `${base}/v1`
          try {
            await firstPage(`${fixed}${listPath}`)
          } catch (retryError) {
            if (!isMissing(retryError)) throw retryError
            throw error
          }
          throw new DiscoveryError(
            'WRONG_BASE',
            `API 地址缺少 /v1：${base} 下没有接口，${fixed} 可以连通`,
            { status: 404, fix: { apiBase: fixed } },
          )
        }
        if (options.catalogOnMissing && isMissing(error))
          return authCheck(context)
        throw error
      }
    },
  }
}

function nextLink(body: unknown, current: string): string | null {
  const next = str(record(record(body)?.links)?.next)
  if (!next) return null
  const url = new URL(next, current)
  if (url.origin !== new URL(current).origin)
    throw new DiscoveryError(
      'PAGING_FAILED',
      `下一页地址指向其他主机（${url.host}），已停止`,
    )
  return url.toString()
}

/** Any OpenAI-compatible server Emperor has no dedicated parser for. */
export function openAiCompatibleParser(
  options: { catalogOnMissing?: boolean } = {},
): ModelListParser {
  return openAiStyleParser({
    id: 'openai-compatible',
    retryV1: true,
    catalogOnMissing: options.catalogOnMissing ?? false,
  })
}
