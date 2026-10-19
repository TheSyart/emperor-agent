/**
 * DeepSeek `GET https://api.deepseek.com/models`: besides `id` it reports
 * `context_window` (input + output), `max_output_tokens`, input/output
 * modalities and `effort.supported_levels` / `default_level`. The same key
 * serves the Anthropic-compatible `/anthropic` base, so that connection is
 * listed here too.
 */
import { detectModelKind } from '../metadata/lookup'
import {
  modalities,
  orderedEfforts,
  posInt,
  record,
  str,
  strings,
  type Json,
} from './fields'
import { genericModel, openAiStyleParser } from './openai-compatible'
import { originOf, type ModelListParser } from './parser'
import type { DiscoveryConnection, VendorModel } from './types'

export function deepseekModel(item: Json): VendorModel | null {
  const model = genericModel(item)
  if (!model) return null
  const context = posInt(item.context_window)
  if (context) model.contextWindowTokens = context
  const input = modalities(item.input_modalities)
  if (input) {
    model.modalities = input
    model.capabilities = {
      ...model.capabilities,
      vision: input.includes('image'),
    }
  }
  const output = modalities(item.output_modalities)
  if (output)
    model.kind = detectModelKind(model.id, { outputModalities: output })
  const effort = record(item.effort)
  const levels = strings(effort?.supported_levels)
  if (levels && levels.length) {
    model.reasoning = { efforts: orderedEfforts(levels) }
    const fallback = str(effort?.default_level)
    if (fallback) model.reasoning.defaultEffort = fallback
    model.capabilities = { ...model.capabilities, reasoning: true }
  }
  return model
}

function listBase(connection: DiscoveryConnection): string {
  return connection.protocol === 'anthropic' ||
    /\/anthropic$/i.test(
      new URL(connection.apiBase).pathname.replace(/\/+$/, ''),
    )
    ? originOf(connection.apiBase)
    : connection.apiBase
}

export function deepseekParser(options: {
  catalogOnMissing: boolean
}): ModelListParser {
  return openAiStyleParser({
    id: 'deepseek',
    listBase,
    mapItem: deepseekModel,
    catalogOnMissing: options.catalogOnMissing,
  })
}
