/**
 * Kimi / Moonshot `GET {base}/models` (api.moonshot.cn, api.moonshot.ai,
 * the Coding plan's api.kimi.com/coding/v1). Documented: `context_length`,
 * `supports_image_in`, `supports_video_in`, `supports_reasoning`. Returned
 * but undocumented (model-center, real response 2026-09-19):
 * `supports_dynamic_tools` (tool calls), `supports_thinking_type`
 * (`only` = thinking cannot be turned off) and `think_efforts`
 * `{ support, valid_efforts, default_effort }`. No output limit, no price,
 * no paging. A `.cn` key and an `.ai` key are not interchangeable.
 */
import {
  bool,
  orderedEfforts,
  posInt,
  record,
  str,
  strings,
  type Json,
} from './fields'
import { genericModel, openAiStyleParser } from './openai-compatible'
import { originOf, pathOf, type ModelListParser } from './parser'
import type { DiscoveryConnection, VendorModel } from './types'

export function kimiModel(item: Json): VendorModel | null {
  const model = genericModel(item)
  if (!model) return null
  const context = posInt(item.context_length)
  if (context) model.contextWindowTokens = context
  const vision = bool(item.supports_image_in)
  const video = bool(item.supports_video_in)
  const reasoning = bool(item.supports_reasoning)
  const tools = bool(item.supports_dynamic_tools)
  const capabilities: NonNullable<VendorModel['capabilities']> = {}
  if (tools !== undefined) capabilities.toolCall = tools
  if (vision !== undefined) capabilities.vision = vision
  if (reasoning !== undefined) capabilities.reasoning = reasoning
  if (Object.keys(capabilities).length) model.capabilities = capabilities
  if (vision !== undefined || video !== undefined)
    model.modalities = [
      'text',
      ...(vision ? ['image'] : []),
      ...(video ? ['video'] : []),
    ]
  const efforts = record(item.think_efforts)
  const valid = strings(efforts?.valid_efforts)
  const thinkingOnly =
    str(item.supports_thinking_type)?.toLowerCase() === 'only'
  // Half a set is worse than none: only a supported, non-empty list counts.
  if (efforts?.support === true && valid && valid.length) {
    model.reasoning = {
      efforts: orderedEfforts(valid),
      ...(thinkingOnly ? { control: 'always' as const } : {}),
    }
    const fallback = str(efforts.default_effort)
    if (fallback && valid.includes(fallback))
      model.reasoning.defaultEffort = fallback
  } else if (thinkingOnly) {
    model.reasoning = { efforts: [], control: 'always' }
  }
  return model
}

/** The Anthropic-compatible base lists on the same host's OpenAI path. */
function listBase(connection: DiscoveryConnection): string {
  const path = pathOf(connection.apiBase)
  if (/\/anthropic$/i.test(path)) return `${originOf(connection.apiBase)}/v1`
  if (/\/coding$/i.test(path))
    return `${originOf(connection.apiBase)}${path}/v1`
  return connection.apiBase
}

export function kimiParser(options: {
  catalogOnMissing: boolean
}): ModelListParser {
  return openAiStyleParser({
    id: 'kimi',
    listBase,
    mapItem: kimiModel,
    catalogOnMissing: options.catalogOnMissing,
  })
}
