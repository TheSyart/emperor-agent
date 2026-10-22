/**
 * OpenRouter `GET https://openrouter.ai/api/v1/models`: public (a key is
 * sent but not required), paged by `links.next` when `offset`/`limit` are
 * used (omitting both returns the full list). Rich fields:
 * `top_provider.context_length` / `max_completion_tokens`,
 * `architecture.input_modalities` / `output_modalities`,
 * `supported_parameters` (tools, reasoning, temperature),
 * `reasoning.{mandatory, supported_efforts, default_effort}`,
 * `pricing` in US dollars per token (strings; `-1` = variable) and
 * `expiration_date`. Because the list is public, the key is checked with
 * `GET /key`.
 */
import { detectModelKind } from '../metadata/lookup'
import {
  bool,
  isoDate,
  modalities,
  orderedEfforts,
  posInt,
  record,
  str,
  strings,
  usdPerMTok,
  type Json,
} from './fields'
import { genericModel, openAiStyleParser } from './openai-compatible'
import { trimBase, type ModelListParser } from './parser'
import type { VendorModel } from './types'

export function openRouterModel(item: Json): VendorModel | null {
  const model = genericModel(item)
  if (!model) return null
  const top = record(item.top_provider)
  const context = posInt(top?.context_length) ?? posInt(item.context_length)
  if (context) model.contextWindowTokens = context
  else delete model.contextWindowTokens
  const output = posInt(top?.max_completion_tokens)
  if (output) model.maxOutputTokens = output

  const arch = record(item.architecture)
  const input = modalities(arch?.input_modalities)
  const outputModalities = modalities(arch?.output_modalities)
  if (input) model.modalities = input
  if (outputModalities)
    model.kind = detectModelKind(model.id, { outputModalities })

  const capabilities: NonNullable<VendorModel['capabilities']> = {}
  if (input) capabilities.vision = input.includes('image')
  const params = strings(item.supported_parameters)
  // An empty list (openrouter/auto) says nothing either way.
  if (params && params.length) {
    capabilities.toolCall = params.includes('tools')
    capabilities.reasoning = params.includes('reasoning')
    model.acceptsTemperature = params.includes('temperature')
  }
  const reasoning = record(item.reasoning)
  if (reasoning) {
    capabilities.reasoning = true
    const efforts = orderedEfforts(strings(reasoning.supported_efforts) ?? [])
    const mandatory = bool(reasoning.mandatory)
    model.reasoning = {
      efforts,
      control: mandatory ? 'always' : efforts.length ? 'effort' : 'toggle',
    }
    const fallback = str(reasoning.default_effort)
    if (fallback) model.reasoning.defaultEffort = fallback
  }
  if (Object.keys(capabilities).length) model.capabilities = capabilities

  const pricing = record(item.pricing)
  if (pricing) {
    const prices: NonNullable<VendorModel['pricingUsdPerMTok']> = {}
    const inputPrice = usdPerMTok(pricing.prompt)
    const outputPrice = usdPerMTok(pricing.completion)
    const cacheRead = usdPerMTok(pricing.input_cache_read)
    const cacheWrite = usdPerMTok(pricing.input_cache_write)
    if (inputPrice !== undefined) prices.input = inputPrice
    if (outputPrice !== undefined) prices.output = outputPrice
    if (cacheRead !== undefined) prices.cacheRead = cacheRead
    if (cacheWrite !== undefined) prices.cacheWrite = cacheWrite
    if (Object.keys(prices).length) model.pricingUsdPerMTok = prices
  }
  const expires = isoDate(item.expiration_date)
  if (expires) model.lifecycle = { status: 'deprecated', retiresAt: expires }
  return model
}

export function openRouterParser(): ModelListParser {
  return openAiStyleParser({
    id: 'openrouter',
    mapItem: openRouterModel,
    followLinksNext: true,
    probeUrl: (connection) => `${trimBase(connection.apiBase)}/key`,
  })
}
