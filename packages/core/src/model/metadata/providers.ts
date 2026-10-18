/**
 * Which models.dev provider answers for an Emperor connection.
 *
 * `llm/catalog.ts` names providers by access route (`dashscope`, `moonshot`);
 * models.dev splits some of them by region or plan (`alibaba-cn` vs
 * `alibaba`, `moonshotai-cn` vs `moonshotai`, Kimi's coding plan). The
 * catalog name picks a default; a recognised API host overrides it, because
 * the host says which account and price list the requests really hit.
 */
import { findByName } from '../../llm/catalog'

/** Catalog provider name → default models.dev provider id. */
export const CATALOG_PROVIDER_MAP: Readonly<Record<string, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  xai: 'xai',
  mistral: 'mistral',
  groq: 'groq',
  openrouter: 'openrouter',
  huggingface: 'huggingface',
  aihubmix: 'aihubmix',
  siliconflow: 'siliconflow-cn',
  deepseek: 'deepseek',
  dashscope: 'alibaba-cn',
  moonshot: 'moonshotai-cn',
  zhipu: 'zhipuai',
  volcengine: 'volcengine',
  volcengine_coding_plan: 'volcengine-coding-plan',
  minimax: 'minimax',
  stepfun: 'stepfun',
  xiaomi_mimo: 'xiaomi',
  longcat: 'longcat',
  lm_studio: 'lmstudio',
}

/** Catalog providers models.dev has no list for; lookups go cross-provider. */
export const UNMAPPED_CATALOG_PROVIDERS: readonly string[] = [
  'byteplus',
  'qianfan',
  'ollama',
  'vllm',
  'ovms',
  'custom',
]

interface HostRule {
  /** Exact hostname or a parent domain (`aliyuncs.com` matches `x.aliyuncs.com`). */
  host: string
  /** Optional path prefix the API base must start with. */
  path?: string
  provider: string
}

/** First match wins; more specific rules come first. */
const HOST_RULES: readonly HostRule[] = [
  { host: 'dashscope-intl.aliyuncs.com', provider: 'alibaba' },
  { host: 'dashscope.aliyuncs.com', provider: 'alibaba-cn' },
  { host: 'api.moonshot.ai', provider: 'moonshotai' },
  { host: 'api.moonshot.cn', provider: 'moonshotai-cn' },
  { host: 'api.kimi.com', path: '/coding', provider: 'kimi-code-plan-cn' },
  { host: 'api.kimi.ai', path: '/coding', provider: 'kimi-code-plan-global' },
  { host: 'open.bigmodel.cn', provider: 'zhipuai' },
  { host: 'api.z.ai', provider: 'zai' },
  { host: 'api.siliconflow.cn', provider: 'siliconflow-cn' },
  { host: 'api.siliconflow.com', provider: 'siliconflow' },
  { host: 'api.minimaxi.com', provider: 'minimax-cn' },
  { host: 'api.minimax.cn', provider: 'minimax-cn' },
  { host: 'api.minimax.io', provider: 'minimax' },
  {
    host: 'ark.cn-beijing.volces.com',
    path: '/api/coding',
    provider: 'volcengine-coding-plan',
  },
  { host: 'ark.cn-beijing.volces.com', provider: 'volcengine' },
  { host: 'api.stepfun.ai', provider: 'stepfun-ai' },
  { host: 'api.stepfun.com', provider: 'stepfun' },
  { host: 'generativelanguage.googleapis.com', provider: 'google' },
  { host: 'api.openai.com', provider: 'openai' },
  { host: 'api.anthropic.com', provider: 'anthropic' },
  { host: 'api.deepseek.com', provider: 'deepseek' },
  { host: 'api.x.ai', provider: 'xai' },
  { host: 'api.mistral.ai', provider: 'mistral' },
  { host: 'api.groq.com', provider: 'groq' },
  { host: 'openrouter.ai', provider: 'openrouter' },
  { host: 'router.huggingface.co', provider: 'huggingface' },
  { host: 'aihubmix.com', provider: 'aihubmix' },
  { host: 'api.xiaomimimo.com', provider: 'xiaomi' },
  { host: 'api.longcat.chat', provider: 'longcat' },
]

/**
 * models.dev providers kept in the snapshot: everything the catalog names or
 * an API host refines to. Sorted, like the snapshot's provider keys.
 */
export const SNAPSHOT_PROVIDERS: readonly string[] = [
  ...new Set([
    ...Object.values(CATALOG_PROVIDER_MAP),
    ...HOST_RULES.map((rule) => rule.provider),
  ]),
].sort()

/**
 * Providers whose bundled prices are dropped at sync time: they bill in CNY
 * (models.dev converts to USD at some rate) or sell subscription plans, so a
 * per-token USD price would be wrong — and a wrong price is worse than none.
 */
export const UNPRICED_PROVIDERS: ReadonlySet<string> = new Set([
  'alibaba-cn',
  'moonshotai-cn',
  'zhipuai',
  'siliconflow-cn',
  'minimax-cn',
  'stepfun',
  'volcengine',
  'volcengine-coding-plan',
  'kimi-code-plan-cn',
  'kimi-code-plan-global',
  'xiaomi',
  'longcat',
  'lmstudio',
])

/**
 * Model labs (canonical id prefixes and common Hugging Face org names) →
 * the providers that are the lab's own API, most international first.
 */
export const OFFICIAL_PROVIDERS_BY_LAB: Readonly<
  Record<string, readonly string[]>
> = {
  openai: ['openai'],
  anthropic: ['anthropic'],
  google: ['google'],
  xai: ['xai'],
  mistral: ['mistral'],
  deepseek: ['deepseek'],
  alibaba: ['alibaba', 'alibaba-cn'],
  moonshotai: ['moonshotai', 'moonshotai-cn'],
  zhipuai: ['zhipuai', 'zai'],
  minimax: ['minimax', 'minimax-cn'],
  stepfun: ['stepfun-ai', 'stepfun'],
  xiaomi: ['xiaomi'],
  meituan: ['longcat'],
  'bytedance-seed': ['volcengine'],
}

const LAB_ALIASES: Readonly<Record<string, string>> = {
  qwen: 'alibaba',
  'deepseek-ai': 'deepseek',
  'zai-org': 'zhipuai',
  'z-ai': 'zhipuai',
  zai: 'zhipuai',
  thudm: 'zhipuai',
  minimaxai: 'minimax',
  mistralai: 'mistral',
  'x-ai': 'xai',
  'stepfun-ai': 'stepfun',
  xiaomimimo: 'xiaomi',
  'meituan-longcat': 'meituan',
  bytedance: 'bytedance-seed',
}

/** Lab for an org prefix (`Qwen` → `alibaba`); undefined when unknown. */
export function labForOrg(org: string): string | undefined {
  const key = org.trim().toLowerCase()
  const lab = LAB_ALIASES[key] ?? key
  return OFFICIAL_PROVIDERS_BY_LAB[lab] ? lab : undefined
}

const LAB_BY_ID_PREFIX: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:gpt|chatgpt|o\d|text-embedding|dall-e|whisper|tts-|codex)/, 'openai'],
  [/^claude/, 'anthropic'],
  [/^(?:gemini|gemma|imagen|veo)/, 'google'],
  [/^grok/, 'xai'],
  [
    /^(?:mistral|magistral|devstral|codestral|ministral|pixtral|voxtral)/,
    'mistral',
  ],
  [/^deepseek/, 'deepseek'],
  [/^(?:qwen|qwq|qvq)/, 'alibaba'],
  [/^(?:kimi|moonshot)/, 'moonshotai'],
  [/^(?:glm|chatglm|cogview)/, 'zhipuai'],
  [/^minimax/, 'minimax'],
  [/^step/, 'stepfun'],
  [/^mimo/, 'xiaomi'],
  [/^longcat/, 'meituan'],
  [/^(?:doubao|seed-)/, 'bytedance-seed'],
]

/** Lab a bare model id belongs to by its family name (`glm-5.2` → `zhipuai`). */
export function labForModelId(bareId: string): string | undefined {
  for (const [pattern, lab] of LAB_BY_ID_PREFIX)
    if (pattern.test(bareId)) return lab
  return undefined
}

/** Lab of a canonical id (`zhipuai/glm-5.2` → `zhipuai`). */
export function labForCanonical(canonicalId: string): string | undefined {
  const slash = canonicalId.indexOf('/')
  return slash > 0 ? labForOrg(canonicalId.slice(0, slash)) : undefined
}

/** All official providers in a fixed order (labs in declaration order). */
export const OFFICIAL_PROVIDERS: readonly string[] = [
  ...new Set(Object.values(OFFICIAL_PROVIDERS_BY_LAB).flat()),
]

function providerForHost(apiBase: string | undefined): string | undefined {
  if (!apiBase) return undefined
  let url: URL
  try {
    url = new URL(apiBase.trim())
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  for (const rule of HOST_RULES) {
    const hostMatches = host === rule.host || host.endsWith('.' + rule.host)
    if (hostMatches && (!rule.path || path.startsWith(rule.path)))
      return rule.provider
  }
  return undefined
}

/**
 * models.dev provider for a connection: a recognised API host first, then
 * the catalog name (`-`/`_` tolerated), then a models.dev id passed as is.
 */
export function resolveCatalogProvider(q: {
  provider: string
  apiBase?: string
}): string | undefined {
  const byHost = providerForHost(q.apiBase)
  if (byHost) return byHost
  const spec = findByName(q.provider)
  if (spec) return CATALOG_PROVIDER_MAP[spec.name]
  const raw = q.provider.trim().toLowerCase()
  return SNAPSHOT_PROVIDERS.includes(raw) ? raw : undefined
}
