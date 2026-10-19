/**
 * Gemini native `GET {origin}/v1beta/models?pageSize=1000`, key in the
 * `x-goog-api-key` header (never `?key=`, which ends up in logs), paged by
 * `pageToken` / `nextPageToken`. Models are `models/<id>` with
 * `inputTokenLimit`, `outputTokenLimit`, `thinking` and
 * `supportedGenerationMethods`.
 *
 * The OpenAI-compatible base (`/v1beta/openai`) lists bare ids only, so a
 * connection on Google's host is always listed natively with the same key;
 * chat requests keep using the compatible base, which accepts the ids
 * without the `models/` prefix.
 */
import { collectPages } from './paging'
import { bool, posInt, record, str, strings, type Json } from './fields'
import {
  notCompatible,
  originOf,
  withExtraHeaders,
  type ModelListParser,
  type ParserContext,
} from './parser'
import { detectModelKind, type ModelKind } from '../metadata/lookup'
import type { DiscoveryConnection, VendorModel } from './types'

function listUrl(connection: DiscoveryConnection): string {
  return `${originOf(connection.apiBase)}/v1beta/models?pageSize=1000`
}

function headers(connection: DiscoveryConnection): Record<string, string> {
  return withExtraHeaders(
    connection,
    connection.apiKey ? { 'x-goog-api-key': connection.apiKey } : {},
  )
}

function kindFromMethods(
  id: string,
  methods: string[] | undefined,
): ModelKind | undefined {
  if (!methods) return undefined
  if (methods.includes('generateContent')) return 'chat'
  if (
    methods.some((method) =>
      /^(?:embedContent|embedText|batchEmbed)/.test(method),
    )
  )
    return 'embedding'
  const byId = detectModelKind(id)
  if (byId !== 'chat') return byId
  if (methods.some((method) => method.startsWith('predict'))) return 'image'
  if (methods.some((method) => method.startsWith('bidiGenerate')))
    return 'audio'
  return 'other'
}

export function geminiModel(item: Json): VendorModel | null {
  const raw = str(item.name) ?? str(item.baseModelId)
  if (!raw) return null
  const id = raw.replace(/^models\//, '')
  if (!id) return null
  const model: VendorModel = { id }
  const name = str(item.displayName)
  if (name) model.name = name
  const input = posInt(item.inputTokenLimit)
  if (input) {
    // The input limit is the window: Gemini counts output inside it.
    model.contextWindowTokens = input
    model.maxInputTokens = input
  }
  const output = posInt(item.outputTokenLimit)
  if (output) model.maxOutputTokens = output
  const kind = kindFromMethods(id, strings(item.supportedGenerationMethods))
  if (kind) model.kind = kind
  const thinking = bool(item.thinking)
  if (thinking !== undefined) model.capabilities = { reasoning: thinking }
  return model
}

export function geminiNativeParser(): ModelListParser {
  async function collect(context: ParserContext) {
    const first = listUrl(context.connection)
    const hdrs = headers(context.connection)
    return collectPages<unknown>(
      async (cursor) => {
        const url = cursor
          ? `${first}&pageToken=${encodeURIComponent(cursor)}`
          : first
        const body = await context.http.json(url, { headers: hdrs })
        const items = Array.isArray(record(body)?.models)
          ? (record(body)!.models as unknown[])
          : undefined
        if (!items) throw notCompatible(new URL(url).host)
        return { items, next: str(record(body)?.nextPageToken) ?? null }
      },
      { stopAfter: context.stopAfter },
    )
  }

  return {
    id: 'gemini-native',

    async list(context) {
      const { items, truncated } = await collect(context)
      const models: VendorModel[] = []
      for (const item of items) {
        const object = record(item)
        const model = object ? geminiModel(object) : null
        if (model) models.push(model)
      }
      return { source: 'vendor_api', models, truncated }
    },

    async probe(context) {
      const url = listUrl(context.connection)
      const body = await context.http.json(url, {
        headers: headers(context.connection),
      })
      const page = record(body)
      if (!page || !Array.isArray(page.models))
        throw notCompatible(new URL(url).host)
      return str(page.nextPageToken)
        ? { method: 'list' }
        : { method: 'list', modelCount: page.models.length }
    },
  }
}
