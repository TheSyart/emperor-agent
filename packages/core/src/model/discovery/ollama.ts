/**
 * Ollama: `GET {root}/api/tags` lists the local models, then
 * `POST {root}/api/show {model}` per model gives `parameters` (a text
 * block where `num_ctx N` appears when the Modelfile sets it),
 * `model_info["<arch>.context_length"]` (the trained length) and
 * `capabilities` (completion, tools, vision, thinking, embedding, insert…).
 *
 * The context reported is `num_ctx`: what Ollama actually runs the model
 * with. Without it Ollama picks its own default (a few thousand tokens,
 * more with more VRAM), so the trained length would overstate it; the
 * context is then left unknown for the add-model dialog to default.
 * `/api/show` failures leave that model's facts unknown instead of failing
 * the list: they are per-model details, not pages.
 */
import { created, posInt, record, str, strings, type Json } from './fields'
import {
  notCompatible,
  originOf,
  pathOf,
  withExtraHeaders,
  type ModelListParser,
  type ParserContext,
} from './parser'
import {
  DiscoveryError,
  type DiscoveryConnection,
  type VendorModel,
} from './types'

const SHOW_CONCURRENCY = 4

/** The server root: the API base without `/v1` (or `/api`). */
export function localRoot(connection: DiscoveryConnection): string {
  const path = pathOf(connection.apiBase).replace(
    /\/(?:v\d+|api(?:\/v\d+)?)$/i,
    '',
  )
  return `${originOf(connection.apiBase)}${path}`
}

function headers(connection: DiscoveryConnection): Record<string, string> {
  return withExtraHeaders(
    connection,
    connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {},
  )
}

export function applyOllamaShow(model: VendorModel, show: Json): void {
  const parameters = str(show.parameters)
  const numCtx = parameters ? /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters) : null
  const context = numCtx ? posInt(Number(numCtx[1])) : undefined
  if (context) model.contextWindowTokens = context
  const capabilities = strings(show.capabilities)
  if (!capabilities) return
  // Ollama lists every capability a model has: absent means no.
  model.capabilities = {
    toolCall: capabilities.includes('tools'),
    vision: capabilities.includes('vision'),
    reasoning: capabilities.includes('thinking'),
  }
  if (capabilities.includes('completion')) model.kind = 'chat'
  else if (capabilities.includes('embedding')) model.kind = 'embedding'
  model.modalities = [
    'text',
    ...(capabilities.includes('vision') ? ['image'] : []),
  ]
}

async function tags(context: ParserContext): Promise<VendorModel[]> {
  const url = `${localRoot(context.connection)}/api/tags`
  const body = await context.http.json(url, {
    headers: headers(context.connection),
  })
  const items = record(body)?.models
  if (!Array.isArray(items)) throw notCompatible(new URL(url).host)
  const models: VendorModel[] = []
  for (const item of items) {
    const object = record(item)
    const id = str(object?.name) ?? str(object?.model)
    if (!object || !id) continue
    const model: VendorModel = { id }
    const when = created(object.modified_at)
    if (when !== undefined) model.created = when
    models.push(model)
  }
  return models
}

export function ollamaParser(): ModelListParser {
  return {
    id: 'ollama',

    async list(context) {
      const all = await tags(context)
      const truncated = all.length > context.stopAfter
      const models = truncated ? all.slice(0, context.stopAfter + 1) : all
      const url = `${localRoot(context.connection)}/api/show`
      const hdrs = headers(context.connection)
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < models.length) {
          const model = models[next++]!
          try {
            const show = record(
              await context.http.json(url, {
                method: 'POST',
                headers: hdrs,
                body: { model: model.id },
              }),
            )
            if (show) applyOllamaShow(model, show)
          } catch (error) {
            if (!(error instanceof DiscoveryError)) throw error
          }
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(SHOW_CONCURRENCY, models.length) },
          worker,
        ),
      )
      return { source: 'vendor_api', models, truncated }
    },

    async probe(context) {
      return { method: 'list', modelCount: (await tags(context)).length }
    },
  }
}
