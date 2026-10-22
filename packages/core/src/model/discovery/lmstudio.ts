/**
 * LM Studio's native REST API: `GET {root}/api/v1/models` → `models[]`
 * with `key` (the id chat requests use), `type` (llm, embedding,
 * decision), `display_name`, `loaded_instances[].config.context_length`,
 * `max_context_length` and `capabilities.{vision, trained_for_tool_use,
 * reasoning.allowed_options}`.
 *
 * The context reported is the loaded instance's: LM Studio loads models
 * with a context smaller than `max_context_length` unless told otherwise.
 * A model that is not loaded has no known context. Older servers without
 * `/api/v1` fall back to `/api/v0/models`, then to the OpenAI-compatible
 * `/v1/models`.
 */
import {
  bool,
  kindFromType,
  posInt,
  record,
  str,
  strings,
  type Json,
} from './fields'
import { genericModel, openAiStyleParser } from './openai-compatible'
import { localRoot } from './ollama'
import {
  notCompatible,
  withExtraHeaders,
  type ModelListParser,
  type ParserContext,
  type ProbeOutcome,
} from './parser'
import {
  DiscoveryError,
  type DiscoveryConnection,
  type VendorModel,
} from './types'

function headers(connection: DiscoveryConnection): Record<string, string> {
  return withExtraHeaders(
    connection,
    connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {},
  )
}

export function lmStudioModel(item: Json): VendorModel | null {
  const id = str(item.key) ?? str(item.id)
  if (!id) return null
  const model: VendorModel = { id }
  const name = str(item.display_name)
  if (name) model.name = name
  const ownedBy = str(item.publisher)
  if (ownedBy) model.ownedBy = ownedBy
  const kind = kindFromType(item.type)
  if (kind) model.kind = kind
  const loaded = Array.isArray(item.loaded_instances)
    ? item.loaded_instances
    : []
  const context = posInt(record(record(loaded[0])?.config)?.context_length)
  if (context) model.contextWindowTokens = context
  const caps = record(item.capabilities)
  if (caps) {
    const vision = bool(caps.vision)
    const tools = bool(caps.trained_for_tool_use)
    const reasoning = record(caps.reasoning) ?? record(item.reasoning)
    model.capabilities = {}
    if (reasoning) model.capabilities.reasoning = true
    if (vision !== undefined) model.capabilities.vision = vision
    if (tools !== undefined) model.capabilities.toolCall = tools
    if (reasoning) {
      const options = (strings(reasoning.allowed_options) ?? []).map((o) =>
        o.toLowerCase(),
      )
      const efforts = options.filter((o) => o !== 'off' && o !== 'on')
      model.reasoning = {
        efforts,
        control: !options.includes('off')
          ? 'always'
          : efforts.length
            ? 'effort'
            : 'toggle',
      }
    }
  }
  return model
}

/** `/api/v0/models`: `data[]` with `type` llm | vlm | embeddings. */
export function lmStudioV0Model(item: Json): VendorModel | null {
  const model = genericModel(item)
  if (!model) return null
  delete model.contextWindowTokens
  const loaded = posInt(item.loaded_context_length)
  if (loaded) model.contextWindowTokens = loaded
  if (str(item.type) === 'vlm') model.capabilities = { vision: true }
  return model
}

async function native(context: ParserContext): Promise<VendorModel[]> {
  const url = `${localRoot(context.connection)}/api/v1/models`
  const body = await context.http.json(url, {
    headers: headers(context.connection),
  })
  const items = record(body)?.models
  if (!Array.isArray(items)) throw notCompatible(new URL(url).host)
  const models: VendorModel[] = []
  for (const item of items) {
    const object = record(item)
    const model = object ? lmStudioModel(object) : null
    if (model) models.push(model)
  }
  return models
}

function missing(error: unknown): boolean {
  return error instanceof DiscoveryError && error.code === 'WRONG_BASE'
}

export function lmStudioParser(): ModelListParser {
  const v0 = openAiStyleParser({
    id: 'lmstudio',
    listBase: (connection) => `${localRoot(connection)}/api/v0`,
    mapItem: lmStudioV0Model,
    headers,
  })
  const compatible = openAiStyleParser({
    id: 'lmstudio',
    listBase: (connection) => `${localRoot(connection)}/v1`,
    headers,
  })

  return {
    id: 'lmstudio',

    async list(context) {
      try {
        const models = await native(context)
        const truncated = models.length > context.stopAfter
        return { source: 'vendor_api', models, truncated }
      } catch (error) {
        if (!missing(error)) throw error
      }
      try {
        return await v0.list(context)
      } catch (error) {
        if (!missing(error)) throw error
      }
      return compatible.list(context)
    },

    async probe(context): Promise<ProbeOutcome> {
      try {
        return { method: 'list', modelCount: (await native(context)).length }
      } catch (error) {
        if (!missing(error)) throw error
      }
      return compatible.probe(context)
    },
  }
}
