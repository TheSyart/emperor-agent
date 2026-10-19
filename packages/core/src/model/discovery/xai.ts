/**
 * xAI `GET https://api.x.ai/v1/models`: `context_length` and
 * `capabilities.reasoning_effort[]` / `default_reasoning_effort`. Prices
 * are in US cents per 100 million tokens; they are not read (the bundled
 * catalog has xAI's dollar prices, and a unit slip would be worse than no
 * price).
 */
import { orderedEfforts, record, str, strings, type Json } from './fields'
import { genericModel, openAiStyleParser } from './openai-compatible'
import type { ModelListParser } from './parser'
import type { VendorModel } from './types'

export function xaiModel(item: Json): VendorModel | null {
  const model = genericModel(item)
  if (!model) return null
  const caps = record(item.capabilities)
  const efforts = strings(caps?.reasoning_effort)
  if (efforts && efforts.length) {
    model.reasoning = { efforts: orderedEfforts(efforts) }
    const fallback = str(caps?.default_reasoning_effort)
    if (fallback) model.reasoning.defaultEffort = fallback
    model.capabilities = { ...model.capabilities, reasoning: true }
  }
  if (/(?:^|-)imagine(?:-|$)|-image(?:-|$)/i.test(model.id))
    model.kind = 'image'
  return model
}

export function xaiParser(options: {
  catalogOnMissing: boolean
}): ModelListParser {
  return openAiStyleParser({
    id: 'xai',
    mapItem: xaiModel,
    catalogOnMissing: options.catalogOnMissing,
  })
}
