/**
 * SiliconFlow `GET {origin}/v1/models?type=text&sub_type=chat`: the query
 * filters to chat models (the list otherwise mixes image, audio, video,
 * embedding and rerank models); the response is `id`, `object`, `created`,
 * `owned_by` only. The Anthropic-compatible base (`api.siliconflow.cn`, no
 * path) lists on the same host.
 */
import { genericModel, openAiStyleParser } from './openai-compatible'
import { hasVersionSuffix, originOf, type ModelListParser } from './parser'
import type { Json } from './fields'
import type { DiscoveryConnection, VendorModel } from './types'

export function siliconflowModel(item: Json): VendorModel | null {
  const model = genericModel(item)
  if (!model) return null
  // The sub_type=chat filter is the vendor saying so.
  model.kind = 'chat'
  return model
}

function listBase(connection: DiscoveryConnection): string {
  return hasVersionSuffix(connection.apiBase)
    ? connection.apiBase
    : `${originOf(connection.apiBase)}/v1`
}

export function siliconflowParser(options: {
  catalogOnMissing: boolean
}): ModelListParser {
  return openAiStyleParser({
    id: 'siliconflow',
    listBase,
    listPath: '/models?type=text&sub_type=chat',
    mapItem: siliconflowModel,
    catalogOnMissing: options.catalogOnMissing,
  })
}
