/**
 * Model id handling shared by the lookup steps: normalisation (step 4),
 * prefix boundaries (step 5) and the id-keyword type check (step 1).
 */

export type ModelKind =
  'chat' | 'embedding' | 'rerank' | 'image' | 'audio' | 'other'

const ROUTE_SUFFIX = /:(?:free|thinking|beta|nitro|exacto)$/
const QUANT_SUFFIX = /-(?:fp8|fp4|int4|int8|awq|gptq|bf16)$/
const BEDROCK_REGION = /^(?:us|eu|apac|ap|jp|au|ca|us-gov|global)\./
const BEDROCK_VENDOR =
  /^(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|openai|writer|moonshot|minimax)\./
const BEDROCK_VERSION = /-v\d+:\d+$/
const VERTEX_DATE = /@\d{8}$/
const DATE_COMPACT = /-(20\d{2})(\d{2})(\d{2})$/
const DATE_DASHED = /-(20\d{2})-(\d{2})-(\d{2})$/
/** Volcengine Ark snapshots: `doubao-seed-2-1-pro-260628`. */
const DATE_YYMMDD = /-(\d{2})(\d{2})(\d{2})$/

function validMonthDay(month: string, day: string): boolean {
  const m = Number(month)
  const d = Number(day)
  return m >= 1 && m <= 12 && d >= 1 && d <= 31
}

function stripDate(id: string): string {
  const compact = DATE_COMPACT.exec(id)
  if (compact && validMonthDay(compact[2]!, compact[3]!))
    return id.slice(0, compact.index)
  const dashed = DATE_DASHED.exec(id)
  if (dashed && validMonthDay(dashed[2]!, dashed[3]!))
    return id.slice(0, dashed.index)
  const short = DATE_YYMMDD.exec(id)
  if (short) {
    const year = Number(short[1])
    if (year >= 23 && year <= 39 && validMonthDay(short[2]!, short[3]!))
      return id.slice(0, short.index)
  }
  return id
}

function stripRepeated(id: string, pattern: RegExp): string {
  let current = id
  for (;;) {
    const next = current.replace(pattern, '')
    if (next === current) return current
    current = next
  }
}

/** Lowercased id without any `org/` or `models/` path. */
export function bareModelId(modelId: string): string {
  const id = modelId.trim().toLowerCase().replace(/^~/, '')
  const slash = id.lastIndexOf('/')
  return slash === -1 ? id : id.slice(slash + 1)
}

/** The org (`Qwen` in `Qwen/Qwen3-…`); undefined without a path. */
export function modelOrg(modelId: string): string | undefined {
  const id = modelId
    .trim()
    .replace(/^~/, '')
    .replace(/^models\//i, '')
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash).toLowerCase() : undefined
}

/**
 * Step 4 normalisation: no `models/` or `org/` path, no routing suffix
 * (`:free` …), no quantisation suffix (`-fp8` …), no Bedrock region/vendor
 * prefix or `-v1:0`, no Vertex `@YYYYMMDD`, no trailing date (`-YYYYMMDD`,
 * `-YYYY-MM-DD`, Volcengine `-YYMMDD`). Parameter sizes (`-72b`) and
 * four-digit snapshot tags (`-0905`) stay: they name different models.
 */
export function normalizeModelId(modelId: string): string {
  let id = bareModelId(modelId)
  id = stripRepeated(id, ROUTE_SUFFIX)
  id = id.replace(BEDROCK_REGION, '').replace(BEDROCK_VENDOR, '')
  id = id.replace(BEDROCK_VERSION, '').replace(VERTEX_DATE, '')
  id = stripRepeated(id, QUANT_SUFFIX)
  id = stripDate(id)
  id = stripRepeated(id, ROUTE_SUFFIX)
  return id
}

const BOUNDARY = new Set(['-', '.', ':', '@', '/', '_'])

/**
 * Words that name a different model when they follow a known id
 * (`gpt-5.6-mini` is not `gpt-5.6`); a prefix match must not cross them.
 */
const VARIANT_WORDS = new Set([
  'mini',
  'nano',
  'micro',
  'pro',
  'max',
  'plus',
  'ultra',
  'lite',
  'light',
  'flash',
  'flashx',
  'air',
  'airx',
  'turbo',
  'small',
  'medium',
  'large',
  'vision',
  'vl',
  'coder',
  'code',
  'codex',
  'omni',
  'audio',
  'image',
  'realtime',
  'search',
  'highspeed',
  'fast',
  'chat',
  'thinking',
  'reasoning',
  'reasoner',
  'non',
  'nothink',
  'embedding',
  'tts',
])

/**
 * Whether `id` extends the known id `known` with a suffix that keeps it the
 * same model: a boundary character, then a word (`-preview`, `-latest`,
 * `:online`) that is not a tier or variant. A digit after the boundary is a
 * version (`glm-5` → `glm-5.9`) and never counts.
 */
export function isSameModelExtension(id: string, known: string): boolean {
  if (id.length <= known.length + 1 || !id.startsWith(known)) return false
  if (!BOUNDARY.has(id[known.length]!)) return false
  const word = /^[a-z]+/.exec(id.slice(known.length + 1))?.[0]
  return word !== undefined && !VARIANT_WORDS.has(word)
}

const KIND_KEYWORDS: ReadonlyArray<readonly [RegExp, ModelKind]> = [
  [/(?:^|[^a-z])(?:embed[a-z]*|bge|m3e)(?![a-z])/, 'embedding'],
  [/(?:^|[^a-z])rerank[a-z]*(?![a-z])/, 'rerank'],
  [/(?:^|[^a-z])(?:dall-e|gpt-image|imagen)(?![a-z])/, 'image'],
  [
    /(?:^|[^a-z])(?:tts|speech|whisper|transcribe|asr|audio|realtime)(?![a-z])/,
    'audio',
  ],
  [/(?:^|[^a-z])(?:sora|veo|wan|kling|moderation|guard|ocr)(?![a-z])/, 'other'],
]

export interface ModelKindHints {
  /** Output modalities from a vendor list or models.dev (`['text']`, `['image']`). */
  outputModalities?: readonly string[]
}

/**
 * Step 1 type check. A vendor-reported output without text decides the
 * kind; otherwise id keywords (`embed`, `rerank`, `tts`, `veo` …) mark
 * non-chat models and everything else is chat.
 */
export function detectModelKind(
  modelId: string,
  hints: ModelKindHints = {},
): ModelKind {
  const output = hints.outputModalities?.map((m) => m.toLowerCase())
  if (output && output.length > 0 && !output.includes('text')) {
    if (output.some((m) => m.startsWith('embedding'))) return 'embedding'
    if (output.includes('image')) return 'image'
    if (output.includes('audio')) return 'audio'
    return 'other'
  }
  const id = modelId.trim().toLowerCase()
  for (const [pattern, kind] of KIND_KEYWORDS) if (pattern.test(id)) return kind
  return 'chat'
}
