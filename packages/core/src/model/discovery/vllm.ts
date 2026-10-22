/**
 * vLLM's OpenAI-compatible server: `GET {base}/models` with `max_model_len`
 * (the context it actually serves) and `root` (the weights, usually a
 * Hugging Face id). The served name is often an alias, so the catalog is
 * looked up by `root`.
 */
import { genericModel, openAiStyleParser } from './openai-compatible'
import type { ModelListParser } from './parser'

export function vllmParser(options: {
  catalogOnMissing: boolean
}): ModelListParser {
  return openAiStyleParser({
    id: 'vllm',
    mapItem: genericModel,
    retryV1: true,
    catalogOnMissing: options.catalogOnMissing,
  })
}
