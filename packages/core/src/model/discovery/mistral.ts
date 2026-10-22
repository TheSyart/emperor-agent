/**
 * Mistral `GET https://api.mistral.ai/v1/models`: `max_context_length`, a
 * `capabilities` object (`completion_chat`, `function_calling`, `vision`,
 * `reasoning`, `ocr`, `classification`, `moderation`, `audio`…),
 * `deprecation` with `deprecation_replacement_model`,
 * `default_model_temperature` and `archived`. Archived models are skipped:
 * they can no longer be called.
 */
import { detectModelKind, type ModelKind } from '../metadata/lookup'
import { bool, isoDate, posInt, record, str, type Json } from './fields'
import { genericModel, openAiStyleParser } from './openai-compatible'
import type { ModelListParser } from './parser'
import type { VendorModel } from './types'

function kindFromCapabilities(id: string, caps: Json): ModelKind {
  if (caps.completion_chat === true) return 'chat'
  if (caps.audio_transcription === true || caps.audio_speech === true)
    return 'audio'
  if (
    caps.ocr === true ||
    caps.moderation === true ||
    caps.classification === true
  )
    return 'other'
  const byId = detectModelKind(id)
  return byId === 'chat' ? 'other' : byId
}

export function mistralModel(item: Json): VendorModel | null {
  if (item.archived === true) return null
  const model = genericModel(item)
  if (!model) return null
  const context = posInt(item.max_context_length)
  if (context) model.contextWindowTokens = context
  const caps = record(item.capabilities)
  if (caps) {
    model.kind = kindFromCapabilities(model.id, caps)
    const capabilities: NonNullable<VendorModel['capabilities']> = {}
    const tools = bool(caps.function_calling)
    const vision = bool(caps.vision)
    const reasoning = bool(caps.reasoning)
    if (tools !== undefined) capabilities.toolCall = tools
    if (vision !== undefined) capabilities.vision = vision
    if (reasoning !== undefined) capabilities.reasoning = reasoning
    model.capabilities = capabilities
  }
  if (typeof item.default_model_temperature === 'number')
    model.acceptsTemperature = true
  const retiresAt = isoDate(item.deprecation)
  if (retiresAt) {
    const replacement = str(item.deprecation_replacement_model)
    model.lifecycle = {
      status: 'deprecated',
      retiresAt,
      ...(replacement ? { replacement } : {}),
    }
  }
  return model
}

export function mistralParser(options: {
  catalogOnMissing: boolean
}): ModelListParser {
  return openAiStyleParser({
    id: 'mistral',
    mapItem: mistralModel,
    catalogOnMissing: options.catalogOnMissing,
  })
}
