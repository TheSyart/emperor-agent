/**
 * Together `GET https://api.together.xyz/v1/models` answers with a bare
 * JSON array (no `data` envelope). Each model has `type` (chat, language,
 * code, image, embedding, moderation, rerank, audio, transcribe, video),
 * `display_name`, `organization` and `context_length`. `pricing` has no
 * documented unit or currency and is not read.
 */
import { genericModel, openAiStyleParser } from './openai-compatible'
import type { ModelListParser } from './parser'

export function togetherParser(options: {
  catalogOnMissing: boolean
}): ModelListParser {
  return openAiStyleParser({
    id: 'together',
    mapItem: genericModel,
    catalogOnMissing: options.catalogOnMissing,
  })
}
