/**
 * Which parser lists a connection, by protocol and API host first (a
 * proxy or a renamed provider still answers like its host), then by
 * provider name, then by local port. Everything else is a generic
 * OpenAI-compatible list.
 *
 * Where a vendor's list may simply not exist, a missing list (404, 405 or
 * an HTML page) falls back to the bundled catalog instead of reporting a
 * wrong address: always for third-party Anthropic-compatible endpoints and
 * vendors without a list (Volcengine Ark), and for any other provider while
 * its API base is still the preset one. An address the user typed is more
 * likely wrong than list-less, so there a 404 stays `WRONG_BASE`.
 */
import { findByName } from '../../llm/catalog'
import { anthropicParser } from './anthropic'
import { bailianCatalogParser } from './bailian-catalog'
import { deepseekParser } from './deepseek'
import { geminiNativeParser } from './gemini-native'
import { groqParser } from './groq'
import { kimiParser } from './kimi'
import { lmStudioParser } from './lmstudio'
import { mistralParser } from './mistral'
import { ollamaParser } from './ollama'
import { openAiCompatibleParser, openAiStyleParser } from './openai-compatible'
import { openRouterParser } from './openrouter'
import {
  authCheck,
  catalogListing,
  originOf,
  trimBase,
  type ModelListParser,
} from './parser'
import { siliconflowParser } from './siliconflow'
import { togetherParser } from './together'
import { vllmParser } from './vllm'
import { xaiParser } from './xai'
import type { DiscoveryProtocol } from './types'

export interface ParserQuery {
  provider: string
  protocol: DiscoveryProtocol
  apiBase: string
  workspaceId?: string
}

const VOLCENGINE_PROVIDERS = new Set([
  'volcengine',
  'volcengine_coding_plan',
  'byteplus',
])

/**
 * Anthropic-compatible bases of vendors whose key also lists models on the
 * same host's OpenAI-style path (which reports more than the Anthropic
 * shape, when the Anthropic path has a list at all).
 */
const ANTHROPIC_SIBLING_LISTS: Readonly<Record<string, string>> = {
  'open.bigmodel.cn': '/api/paas/v4',
  'api.z.ai': '/api/paas/v4',
  'api.minimax.io': '/v1',
  'api.minimaxi.com': '/v1',
  'api.minimax.cn': '/v1',
  'dashscope.aliyuncs.com': '/compatible-mode/v1',
  'dashscope-intl.aliyuncs.com': '/compatible-mode/v1',
}

function hostOf(apiBase: string): string {
  try {
    return new URL(apiBase).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function portOf(apiBase: string): string {
  try {
    return new URL(apiBase).port
  } catch {
    return ''
  }
}

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  )
}

/** Whether the connection still uses the provider's preset API base. */
export function usesPresetBase(query: ParserQuery): boolean {
  const spec = findByName(query.provider)
  if (!spec || spec.name === 'custom') return false
  const preset = spec.apiBases[query.protocol]
  return (
    Boolean(preset) &&
    trimBase(preset!).toLowerCase() === trimBase(query.apiBase).toLowerCase()
  )
}

/** Vendors with no model list endpoint (Volcengine Ark and BytePlus). */
export function catalogOnlyParser(): ModelListParser {
  return {
    id: 'catalog-only',
    async list() {
      return catalogListing(
        '这家厂商没有公开的模型列表接口，下面是内置目录里的推荐模型；方舟的接入点 ID（ep-…）请手动输入',
      )
    },
    probe: authCheck,
  }
}

export function resolveParser(query: ParserQuery): ModelListParser {
  const provider =
    findByName(query.provider)?.name ?? query.provider.trim().toLowerCase()
  const host = hostOf(query.apiBase)
  const port = portOf(query.apiBase)
  const preset = usesPresetBase(query)

  if (
    VOLCENGINE_PROVIDERS.has(provider) ||
    host.endsWith('.volces.com') ||
    host.endsWith('.bytepluses.com')
  )
    return catalogOnlyParser()

  if (host === 'generativelanguage.googleapis.com') return geminiNativeParser()

  if (query.protocol === 'anthropic') {
    if (host === 'api.anthropic.com') return anthropicParser({ official: true })
    if (host === 'api.deepseek.com')
      return deepseekParser({ catalogOnMissing: true })
    if (
      /^api\.moonshot\.(?:cn|ai)$/.test(host) ||
      /^api\.kimi\.(?:com|ai)$/.test(host)
    )
      return kimiParser({ catalogOnMissing: true })
    if (/^api\.siliconflow\.(?:cn|com)$/.test(host))
      return siliconflowParser({ catalogOnMissing: true })
    const sibling = ANTHROPIC_SIBLING_LISTS[host]
    if (sibling)
      return openAiStyleParser({
        id: 'openai-compatible',
        listBase: (connection) => `${originOf(connection.apiBase)}${sibling}`,
        catalogOnMissing: true,
        probeByAuthCheck: true,
      })
    return anthropicParser({ official: false })
  }

  if (provider === 'dashscope' && query.workspaceId?.trim())
    return bailianCatalogParser()

  const onMissing = { catalogOnMissing: preset }
  if (host === 'api.deepseek.com' || provider === 'deepseek')
    return deepseekParser(onMissing)
  if (
    /^api\.moonshot\.(?:cn|ai)$/.test(host) ||
    /^api\.kimi\.(?:com|ai)$/.test(host) ||
    provider === 'moonshot'
  )
    return kimiParser(onMissing)
  if (host === 'api.x.ai' || provider === 'xai') return xaiParser(onMissing)
  if (host === 'api.mistral.ai' || provider === 'mistral')
    return mistralParser(onMissing)
  if (host === 'openrouter.ai' || provider === 'openrouter')
    return openRouterParser()
  if (host === 'api.groq.com' || provider === 'groq')
    return groqParser(onMissing)
  if (host === 'api.together.xyz' || host === 'api.together.ai')
    return togetherParser(onMissing)
  if (/^api\.siliconflow\.(?:cn|com)$/.test(host) || provider === 'siliconflow')
    return siliconflowParser(onMissing)
  if (provider === 'ollama' || (isLocalHost(host) && port === '11434'))
    return ollamaParser()
  if (provider === 'lm_studio' || (isLocalHost(host) && port === '1234'))
    return lmStudioParser()
  if (provider === 'vllm') return vllmParser(onMissing)
  return openAiCompatibleParser(onMissing)
}
