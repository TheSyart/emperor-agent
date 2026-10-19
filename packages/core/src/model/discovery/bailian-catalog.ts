/**
 * Bailian (阿里云百炼) official model catalog, optional: it needs the
 * workspace ID, and lives on its own host
 * `https://{workspace}.cn-beijing.maas.aliyuncs.com/api/v1/models`
 * (`page_no`, `page_size` ≤ 20, `total`). Each model has
 * `model_info.{context_window, max_input_tokens, max_output_tokens}`,
 * `capabilities[]` (TG, Reasoning, VU, ASR, TTS, IG, VG, ME, TR),
 * `features[]` (function-calling, structured-outputs, web-search, cache)
 * and `inference_metadata.{request_modality, response_modality}`. Prices
 * are in yuan and are not read (pricing here is US dollars only).
 * Without a workspace ID DashScope is listed through its OpenAI-compatible
 * `/models`.
 */
import { collectPages } from './paging'
import { modalities, posInt, record, str, strings, type Json } from './fields'
import {
  bearerHeaders,
  type ModelListParser,
  type ParserContext,
} from './parser'
import { DiscoveryError, type VendorModel } from './types'
import type { ModelKind } from '../metadata/lookup'

const PAGE_SIZE = 20

/** A workspace ID is a DNS label: no dots, slashes or empty labels. */
export function bailianWorkspace(value: string | undefined): string {
  const workspace = (value ?? '').trim()
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspace))
    throw new DiscoveryError('WRONG_BASE', '百炼 Workspace ID 格式无效')
  return workspace
}

function kindFromCapabilities(caps: string[]): ModelKind | undefined {
  if (caps.some((cap) => cap === 'TG' || cap === 'Reasoning' || cap === 'VU'))
    return 'chat'
  if (caps.some((cap) => cap === 'TR' || cap === 'ME')) return 'embedding'
  if (caps.includes('IG')) return 'image'
  if (caps.some((cap) => /ASR|TTS|Speech/i.test(cap))) return 'audio'
  if (caps.includes('VG')) return 'other'
  return undefined
}

export function bailianModel(item: Json): VendorModel | null {
  const id = str(item.model)
  if (!id) return null
  const model: VendorModel = { id }
  const name = str(item.name)
  if (name) model.name = name
  const ownedBy = str(item.provider)
  if (ownedBy) model.ownedBy = ownedBy
  const info = record(item.model_info)
  const context = posInt(info?.context_window)
  if (context) model.contextWindowTokens = context
  const input = posInt(info?.max_input_tokens)
  if (input) model.maxInputTokens = input
  const output = posInt(info?.max_output_tokens)
  if (output) model.maxOutputTokens = output
  const caps = strings(item.capabilities) ?? []
  const features = strings(item.features)
  const meta = record(item.inference_metadata)
  const request = modalities(meta?.request_modality)
  const kind = kindFromCapabilities(caps)
  if (kind) model.kind = kind
  if (request) model.modalities = request
  if (kind === 'chat') {
    model.capabilities = {
      vision: caps.includes('VU') || Boolean(request?.includes('image')),
      reasoning: caps.includes('Reasoning'),
    }
    if (features)
      model.capabilities.toolCall = features.includes('function-calling')
  }
  return model
}

export function bailianCatalogParser(): ModelListParser {
  async function collect(context: ParserContext) {
    const workspace = bailianWorkspace(context.connection.workspaceId)
    const headers = bearerHeaders(context.connection)
    let total: number | null = null
    let seen = 0
    return collectPages<unknown>(
      async (_cursor, pageNo) => {
        const url = `https://${workspace}.cn-beijing.maas.aliyuncs.com/api/v1/models?page_no=${pageNo}&page_size=${PAGE_SIZE}`
        const body = record(await context.http.json(url, { headers }))
        if (body?.success !== true) {
          const message = [str(body?.code), str(body?.message)]
            .filter(Boolean)
            .join(' · ')
          throw new DiscoveryError(
            /auth|key|permission/i.test(message) ? 'AUTH' : 'UNKNOWN',
            `百炼模型目录返回失败${message ? `：${message.slice(0, 200)}` : ''}`,
          )
        }
        const output = record(body.output)
        const items = output?.models
        const pageTotal = output?.total
        if (!Array.isArray(items) || typeof pageTotal !== 'number')
          throw new DiscoveryError(
            'NOT_COMPATIBLE',
            '百炼模型目录缺少 output.models 或 output.total',
          )
        if (total === null) total = pageTotal
        else if (total !== pageTotal)
          throw new DiscoveryError(
            'PAGING_FAILED',
            `百炼目录总数在翻页时变化：${total} → ${pageTotal}`,
          )
        seen += items.length
        if (seen < total && items.length === 0)
          throw new DiscoveryError(
            'PAGING_FAILED',
            `百炼目录第 ${pageNo} 页提前返回空页`,
          )
        return { items, next: seen < total ? String(pageNo + 1) : null }
      },
      { stopAfter: context.stopAfter },
    )
  }

  return {
    id: 'bailian-catalog',

    async list(context) {
      const { items, truncated } = await collect(context)
      const models: VendorModel[] = []
      for (const item of items) {
        const object = record(item)
        const model = object ? bailianModel(object) : null
        if (model) models.push(model)
      }
      return { source: 'vendor_api', models, truncated }
    },

    async probe(context) {
      const workspace = bailianWorkspace(context.connection.workspaceId)
      const url = `https://${workspace}.cn-beijing.maas.aliyuncs.com/api/v1/models?page_no=1&page_size=1`
      const body = record(
        await context.http.json(url, {
          headers: bearerHeaders(context.connection),
        }),
      )
      if (body?.success !== true)
        throw new DiscoveryError(
          'AUTH',
          '百炼模型目录拒绝了这个 Key 或 Workspace ID',
        )
      const total = record(body.output)?.total
      return typeof total === 'number'
        ? { method: 'list', modelCount: total }
        : { method: 'list' }
    },
  }
}
