/**
 * Anthropic `GET /v1/models?limit=1000`, `x-api-key` + `anthropic-version`,
 * paged by `after_id` while `has_more`. Each model reports
 * `max_input_tokens`, `max_tokens`, a `capabilities` tree (image and PDF
 * input, thinking types, effort levels) and, since 2026, lifecycle fields
 * (`lifecycle`, `deprecated_at`, `retires_at`).
 *
 * Third-party Anthropic-compatible endpoints may not implement the list;
 * for them a missing list falls back to the catalog and the key is checked
 * on `/v1/messages`.
 */
import { collectPages } from './paging'
import {
  bool,
  created,
  isoDate,
  modelArray,
  posInt,
  record,
  str,
  supported,
  type Json,
} from './fields'
import {
  anthropicHeaders,
  authCheck,
  catalogListing,
  notCompatible,
  pathOf,
  trimBase,
  type ModelListParser,
  type ParserContext,
} from './parser'
import {
  DiscoveryError,
  type DiscoveryConnection,
  type VendorModel,
} from './types'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function endsWithV1(base: string): boolean {
  return /\/v1$/i.test(pathOf(base))
}

function listUrl(connection: DiscoveryConnection): string {
  const base = trimBase(connection.apiBase)
  return endsWithV1(base) ? `${base}/models` : `${base}/v1/models`
}

export function anthropicModel(
  item: Json,
  now = Date.now(),
): VendorModel | null {
  const id = str(item.id)
  if (!id) return null
  const model: VendorModel = { id }
  const name = str(item.display_name)
  if (name) model.name = name
  const when = created(item.created_at)
  if (when !== undefined) model.created = when
  const input = posInt(item.max_input_tokens)
  if (input) {
    model.contextWindowTokens = input
    model.maxInputTokens = input
  }
  const output = posInt(item.max_tokens)
  if (output) model.maxOutputTokens = output

  const caps = record(item.capabilities)
  if (caps) {
    const vision = supported(caps.image_input)
    const pdf = supported(caps.pdf_input)
    const thinking = record(caps.thinking)
    const thinks = bool(thinking?.supported)
    model.capabilities = {}
    if (vision !== undefined) model.capabilities.vision = vision
    if (thinks !== undefined) model.capabilities.reasoning = thinks
    if (vision !== undefined || pdf !== undefined)
      model.modalities = [
        'text',
        ...(vision ? ['image'] : []),
        ...(pdf ? ['pdf'] : []),
      ]
    const effort = record(caps.effort)
    const efforts =
      effort && bool(effort.supported)
        ? EFFORT_LEVELS.filter((level) => supported(effort[level]) === true)
        : []
    if (thinks) {
      const types = record(thinking?.types)
      const canDisable = supported(types?.disabled)
      const budget = supported(types?.enabled) === true
      const control =
        efforts.length > 0
          ? canDisable === false
            ? 'always'
            : canDisable === true
              ? 'effort'
              : undefined
          : budget
            ? 'budget'
            : undefined
      model.reasoning = { efforts: [...efforts] }
      if (control) model.reasoning.control = control
    }
  }

  const retiresAt = isoDate(item.retires_at)
  const lifecycle = str(item.lifecycle)?.toLowerCase()
  const status =
    lifecycle === 'active' ||
    lifecycle === 'deprecated' ||
    lifecycle === 'retired'
      ? lifecycle
      : retiresAt && Date.parse(retiresAt) <= now
        ? 'retired'
        : retiresAt || str(item.deprecated_at)
          ? 'deprecated'
          : undefined
  if (status && (status !== 'active' || retiresAt))
    model.lifecycle = { status, ...(retiresAt ? { retiresAt } : {}) }
  return model
}

export function anthropicParser(options: {
  official: boolean
}): ModelListParser {
  async function collect(context: ParserContext, base: DiscoveryConnection) {
    const headers = anthropicHeaders(context.connection)
    const first = `${listUrl(base)}?limit=1000`
    return collectPages<unknown>(
      async (cursor) => {
        const url = cursor
          ? `${first}&after_id=${encodeURIComponent(cursor)}`
          : first
        const body = await context.http.json(url, { headers })
        const items = modelArray(body)
        if (!items) throw notCompatible(new URL(url).host)
        const page = record(body) ?? {}
        if (page.has_more !== true) return { items, next: null }
        const last = str(page.last_id)
        if (!last)
          throw new DiscoveryError(
            'NOT_COMPATIBLE',
            'has_more 为 true 但没有 last_id，无法翻页',
          )
        return { items, next: last }
      },
      { stopAfter: context.stopAfter },
    )
  }

  /** Messages are sent to `{base}/v1/messages`: a base ending in /v1 doubles it. */
  function v1Fix(connection: DiscoveryConnection): string | undefined {
    const base = trimBase(connection.apiBase)
    return endsWithV1(base) ? base.replace(/\/v1$/i, '') : undefined
  }

  return {
    id: 'anthropic',

    async list(context) {
      try {
        const { items, truncated } = await collect(context, context.connection)
        const models: VendorModel[] = []
        for (const item of items) {
          const object = record(item)
          const model = object ? anthropicModel(object) : null
          if (model) models.push(model)
        }
        const fixBase = v1Fix(context.connection)
        return {
          source: 'vendor_api',
          models,
          truncated,
          ...(fixBase
            ? {
                fix: { apiBase: fixBase },
                message: `Anthropic 地址不需要 /v1（请求会发往 /v1/messages）：保存前请改为 ${fixBase}`,
              }
            : {}),
        }
      } catch (error) {
        if (
          !options.official &&
          error instanceof DiscoveryError &&
          error.code === 'WRONG_BASE'
        )
          return catalogListing(
            '这个 Anthropic 兼容地址没有模型列表接口，下面是内置目录里该厂商的推荐模型，也可以手动输入模型 ID',
          )
        throw error
      }
    },

    async probe(context) {
      if (!options.official) return authCheck(context)
      const fixBase = v1Fix(context.connection)
      const target = fixBase
        ? { ...context.connection, apiBase: fixBase }
        : context.connection
      const body = await context.http.json(`${listUrl(target)}?limit=1000`, {
        headers: anthropicHeaders(context.connection),
      })
      const items = modelArray(body)
      if (!items) throw notCompatible(new URL(listUrl(target)).host)
      if (fixBase)
        throw new DiscoveryError(
          'WRONG_BASE',
          `Anthropic 地址不需要 /v1（请求会发往 /v1/messages），请改为 ${fixBase}`,
          { fix: { apiBase: fixBase } },
        )
      return record(body)?.has_more === true
        ? { method: 'list' }
        : { method: 'list', modelCount: items.length }
    },
  }
}
