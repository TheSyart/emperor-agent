/**
 * Groq `GET https://api.groq.com/openai/v1/models`: `context_window`,
 * `active`, sometimes `max_completion_tokens`. Inactive models are
 * skipped: Groq keeps them listed after they stop serving.
 */
import { genericModel, openAiStyleParser } from './openai-compatible'
import type { Json } from './fields'
import type { ModelListParser } from './parser'
import type { VendorModel } from './types'

export function groqModel(item: Json): VendorModel | null {
  if (item.active === false) return null
  return genericModel(item)
}

export function groqParser(options: {
  catalogOnMissing: boolean
}): ModelListParser {
  return openAiStyleParser({
    id: 'groq',
    mapItem: groqModel,
    catalogOnMissing: options.catalogOnMissing,
  })
}
