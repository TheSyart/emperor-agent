/**
 * The add-model dialog's pure logic (MOD-04): which provider a pasted URL
 * or key belongs to, how the vendor's model list is grouped, filtered,
 * sorted and preselected, the parameter defaults for a picked model (the
 * T4 §3 fallback table), and what the user must confirm before saving.
 * No Vue, no IO.
 */
import type {
  DiscoveredModel,
  ModelFacts,
  ModelMetadataField,
} from '@emperor/core/api'
import type { ModelEntriesSaveRequest } from '../../../api/model'
import type { ModelEntry, ProviderOption } from '../../../types'

/* ── Step 1: connection ───────────────────────────────────────────────── */

export type ProviderGroupKey = 'cn' | 'foreign' | 'local' | 'other' | 'more'

/** The picker's groups and the providers each shows first (T4 MOD-04). */
export const PROVIDER_GROUPS: ReadonlyArray<{
  key: ProviderGroupKey
  label: string
  names: readonly string[]
}> = [
  {
    key: 'cn',
    label: '国内',
    names: [
      'deepseek',
      'moonshot',
      'zhipu',
      'dashscope',
      'volcengine',
      'minimax',
      'siliconflow',
    ],
  },
  {
    key: 'foreign',
    label: '海外',
    names: ['openai', 'anthropic', 'gemini', 'openrouter', 'xai', 'mistral'],
  },
  { key: 'local', label: '本地', names: ['ollama', 'lm_studio'] },
  { key: 'other', label: '其他', names: ['custom'] },
]

export interface ProviderPickerGroup {
  key: ProviderGroupKey
  label: string
  options: ProviderOption[]
}

function matches(option: ProviderOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    option.name.toLowerCase().includes(q) ||
    (option.displayName ?? '').toLowerCase().includes(q)
  )
}

/**
 * The providers in picker order, filtered by `query`. Providers outside
 * the four named groups appear under 更多 (found by search too).
 */
export function providerGroups(
  options: readonly ProviderOption[],
  query: string,
): ProviderPickerGroup[] {
  const byName = new Map(options.map((option) => [option.name, option]))
  const placed = new Set<string>()
  const groups: ProviderPickerGroup[] = []
  for (const group of PROVIDER_GROUPS) {
    const picked = group.names
      .map((name) => byName.get(name))
      .filter((option): option is ProviderOption => Boolean(option))
    for (const option of picked) placed.add(option.name)
    const visible = picked.filter((option) => matches(option, query))
    if (visible.length)
      groups.push({ key: group.key, label: group.label, options: visible })
  }
  const rest = options.filter(
    (option) => !placed.has(option.name) && matches(option, query),
  )
  if (rest.length) groups.push({ key: 'more', label: '更多', options: rest })
  return groups
}

/** Hosts that belong to a provider besides its preset API base. */
const HOST_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)moonshot\.(cn|ai)$/, 'moonshot'],
  [/(^|\.)kimi\.(com|ai)$/, 'moonshot'],
  [/(^|\.)bigmodel\.cn$|(^|\.)z\.ai$/, 'zhipu'],
  [/(^|\.)dashscope(-intl)?\.aliyuncs\.com$/, 'dashscope'],
  [/(^|\.)volces\.com$/, 'volcengine'],
  [/(^|\.)minimaxi?\.(com|cn|io)$/, 'minimax'],
  [/(^|\.)siliconflow\.(cn|com)$/, 'siliconflow'],
  [/(^|\.)openai\.com$/, 'openai'],
  [/(^|\.)anthropic\.com$/, 'anthropic'],
  [/(^|\.)googleapis\.com$/, 'gemini'],
  [/(^|\.)openrouter\.ai$/, 'openrouter'],
  [/(^|\.)x\.ai$/, 'xai'],
  [/(^|\.)mistral\.ai$/, 'mistral'],
  [/(^|\.)groq\.com$/, 'groq'],
  [/(^|\.)deepseek\.com$/, 'deepseek'],
]

const LOCAL_PORTS: Readonly<Record<string, string>> = {
  '11434': 'ollama',
  '1234': 'lm_studio',
}

function parseUrl(text: string): URL | null {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$)|^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(
          trimmed,
        )
      ? `https://${trimmed}`
      : null
  if (!withScheme) return null
  try {
    const url = new URL(withScheme)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** A pasted API address without the request path (`/chat/completions`). */
function apiBaseOf(url: URL): string {
  const path = url.pathname
    .replace(
      /\/(chat\/completions|completions|messages|models|responses)\/?$/,
      '',
    )
    .replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

/**
 * The provider a pasted URL belongs to, by host (preset API bases first,
 * then known aliases and local ports). An address no provider claims is a
 * custom OpenAI/Anthropic-compatible one. Null when `text` is not a URL
 * (the search box then filters by name).
 */
export function detectProviderFromUrl(
  text: string,
  options: readonly ProviderOption[],
): { provider: string; apiBase: string } | null {
  const url = parseUrl(text)
  if (!url) return null
  const host = url.hostname.toLowerCase()
  const apiBase = apiBaseOf(url)
  if (host === 'localhost' || host === '127.0.0.1') {
    const local = LOCAL_PORTS[url.port]
    if (local && options.some((option) => option.name === local))
      return { provider: local, apiBase }
  }
  for (const option of options) {
    for (const base of Object.values(option.apiBases ?? {})) {
      const preset = base ? parseUrl(base) : null
      if (preset && preset.hostname.toLowerCase() === host && !option.isLocal)
        return { provider: option.name, apiBase }
    }
  }
  for (const [pattern, name] of HOST_ALIASES)
    if (pattern.test(host) && options.some((option) => option.name === name))
      return { provider: name, apiBase }
  return { provider: 'custom', apiBase }
}

/** The provider a pasted key looks like it belongs to, by its prefix. */
export function detectProviderFromKey(key: string): string | null {
  const text = key.trim()
  if (text.startsWith('sk-or-')) return 'openrouter'
  if (text.startsWith('sk-ant-')) return 'anthropic'
  if (text.startsWith('AIza')) return 'gemini'
  if (text.startsWith('hf_')) return 'huggingface'
  if (text.startsWith('xai-')) return 'xai'
  if (text.startsWith('gsk_')) return 'groq'
  return null
}

/* ── Step 2: picking models ───────────────────────────────────────────── */

export type ModelFilter =
  'all' | 'vision' | 'tools' | 'reasoning' | 'new' | 'non-chat'

export const MODEL_FILTERS: ReadonlyArray<{ key: ModelFilter; label: string }> =
  [
    { key: 'all', label: '全部' },
    { key: 'vision', label: '识图' },
    { key: 'tools', label: '工具' },
    { key: 'reasoning', label: '思考' },
    { key: 'new', label: '新' },
    { key: 'non-chat', label: '非对话' },
  ]

export type ModelSort = 'recommended' | 'newest' | 'name'

const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000

function releasedAt(model: DiscoveredModel): number {
  if (model.releaseDate) {
    const parsed = Date.parse(model.releaseDate)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof model.created === 'number')
    return model.created < 1e12 ? model.created * 1000 : model.created
  if (typeof model.created === 'string') {
    const parsed = Date.parse(model.created)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** Chat models only, unless the filter asks for the others. */
export function filterModels(
  models: readonly DiscoveredModel[],
  filter: ModelFilter,
  query: string,
  now: Date = new Date(),
): DiscoveredModel[] {
  const q = query.trim().toLowerCase()
  return models.filter((model) => {
    if (
      q &&
      !model.id.toLowerCase().includes(q) &&
      !(model.name ?? '').toLowerCase().includes(q)
    )
      return false
    if (filter === 'non-chat') return model.kind !== 'chat'
    if (model.kind !== 'chat') return false
    if (filter === 'vision') return model.capabilities.vision === true
    if (filter === 'tools') return model.capabilities.toolCall === true
    if (filter === 'reasoning') return model.capabilities.reasoning === true
    if (filter === 'new') {
      const at = releasedAt(model)
      return at > 0 && now.getTime() - at <= SIX_MONTHS_MS
    }
    return true
  })
}

/** models.dev family, else the name before its version (`glm-5-air` → glm). */
export function familyOf(model: DiscoveredModel): string {
  if (model.family) return model.family
  const bare = model.id.toLowerCase().split('/').pop() ?? model.id
  return bare.match(/^[a-z]+/)?.[0] ?? bare
}

export function groupByFamily(
  models: readonly DiscoveredModel[],
): Array<{ family: string; models: DiscoveredModel[] }> {
  const groups = new Map<string, DiscoveredModel[]>()
  for (const model of models) {
    const family = familyOf(model)
    groups.set(family, [...(groups.get(family) ?? []), model])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, items]) => ({ family, models: items }))
}

function retiring(model: DiscoveredModel): boolean {
  return model.lifecycle?.status === 'deprecated'
}

function retired(model: DiscoveredModel): boolean {
  return model.lifecycle?.status === 'retired'
}

export function sortModels(
  models: readonly DiscoveredModel[],
  sort: ModelSort,
): DiscoveredModel[] {
  const list = [...models]
  if (sort === 'name') return list.sort((a, b) => a.id.localeCompare(b.id))
  if (sort === 'newest')
    return list.sort(
      (a, b) => releasedAt(b) - releasedAt(a) || a.id.localeCompare(b.id),
    )
  // Recommended: live models first, newest first, then the rest.
  return list.sort(
    (a, b) =>
      Number(retired(a) || retiring(a)) - Number(retired(b) || retiring(b)) ||
      releasedAt(b) - releasedAt(a) ||
      a.id.localeCompare(b.id),
  )
}

/**
 * What starts checked: every chat model of a list of three or fewer;
 * otherwise the newest live (not deprecated or retired) model per family.
 */
export function preselect(models: readonly DiscoveredModel[]): string[] {
  const chat = models.filter(
    (model) => model.kind === 'chat' && !retired(model),
  )
  if (chat.length <= 3) return chat.map((model) => model.id)
  return groupByFamily(chat.filter((model) => !retiring(model))).map(
    (group) => sortModels(group.models, 'newest')[0]!.id,
  )
}

export type StatusMark = '已添加' | '将下线' | '已退役'

export function statusMarks(
  model: DiscoveredModel,
  existing: ReadonlyArray<Pick<ModelEntry, 'modelId'>>,
): StatusMark[] {
  const marks: StatusMark[] = []
  if (existing.some((entry) => entry.modelId === model.id)) marks.push('已添加')
  if (retired(model)) marks.push('已退役')
  else if (retiring(model)) marks.push('将下线')
  return marks
}

export function sourceLabel(
  source: DiscoveredModel['source'] | undefined,
): string {
  if (source === 'vendor_api') return '官方接口'
  if (source === 'catalog') return '内置目录'
  if (source === 'family_rule') return '推断'
  return '未知'
}

/* ── Step 3: parameters ───────────────────────────────────────────────── */

export type DraftField = 'contextWindowTokens' | 'maxTokens'

export interface EntryDraft {
  model: DiscoveredModel
  modelId: string
  displayName: string
  contextWindowTokens: number
  maxTokens: number
  /** The model's own output limit, when known ("上限 N"). */
  maxOutputLimit: number | null
  /** Fields filled from the fallback; the user must confirm them. */
  unknown: DraftField[]
  confirmed: boolean
  /** Fields the user changed: saved as locked against metadata refreshes. */
  edited: ModelMetadataField[]
  reasoningEffort: string | null
  capabilityOverrides: {
    toolCall?: boolean
    vision?: boolean
    reasoning?: boolean
  }
  temperature: number | null
  pricing: {
    inputUsdPerMillionTokens: number
    outputUsdPerMillionTokens: number
    cacheReadUsdPerMillionTokens: number
    cacheWriteUsdPerMillionTokens: number
  } | null
}

const UNKNOWN_CLOUD = { context: 128_000, output: 8_192 }
const UNKNOWN_LOCAL = { context: 32_768, output: 4_096 }

function known(
  model: DiscoveredModel,
  value: number | undefined,
  field: string,
): boolean {
  if (value === undefined) return false
  const source = (model.fieldSources as Record<string, string | undefined>)[
    field
  ]
  return source !== 'fallback'
}

/**
 * Defaults for one picked model (T4 §3): context from the vendor or the
 * catalog; output min(limit, 32K), or min(limit, 64K) for a model that
 * always thinks and allows ≥128K; unknown values fall back to 128K / 8,192
 * in the cloud, 32,768 / 4,096 for a local server, and must be confirmed.
 */
export function buildEntryDraft(
  model: DiscoveredModel,
  opts: { local: boolean },
): EntryDraft {
  const fallback = opts.local ? UNKNOWN_LOCAL : UNKNOWN_CLOUD
  const unknown: DraftField[] = []
  const hasContext = known(
    model,
    model.contextWindowTokens,
    'contextWindowTokens',
  )
  if (!hasContext) unknown.push('contextWindowTokens')
  const limit = known(model, model.maxOutputTokens, 'maxOutputTokens')
    ? model.maxOutputTokens!
    : null
  let maxTokens: number
  if (limit === null) {
    unknown.push('maxTokens')
    maxTokens = fallback.output
  } else {
    const alwaysThinks = model.reasoning?.control === 'always'
    maxTokens = Math.min(
      limit,
      alwaysThinks && limit >= 128_000 ? 64_000 : 32_000,
    )
  }
  const price = model.pricingUsdPerMTok
  return {
    model,
    modelId: model.id,
    displayName: model.name && model.name !== model.id ? model.name : '',
    contextWindowTokens: hasContext
      ? model.contextWindowTokens!
      : fallback.context,
    maxTokens,
    maxOutputLimit: limit,
    unknown,
    confirmed: false,
    edited: [],
    reasoningEffort: null,
    capabilityOverrides: {},
    temperature: null,
    pricing:
      price?.input !== undefined && price.output !== undefined
        ? {
            inputUsdPerMillionTokens: price.input,
            outputUsdPerMillionTokens: price.output,
            cacheReadUsdPerMillionTokens: price.cacheRead ?? 0,
            cacheWriteUsdPerMillionTokens: price.cacheWrite ?? 0,
          }
        : null,
  }
}

/** True while some picked model still has an unconfirmed fallback value. */
export function needsConfirmation(drafts: readonly EntryDraft[]): boolean {
  return drafts.some((draft) => draft.unknown.length > 0 && !draft.confirmed)
}

/**
 * The thinking choices: 跟随默认（X） first, then the model's efforts. A
 * model that always thinks gets no 关闭 (`none`); one without reasoning
 * facts gets none at all.
 */
export function reasoningOptions(
  model: DiscoveredModel,
): Array<{ value: string | null; label: string }> {
  const reasoning = model.reasoning
  if (!reasoning?.efforts.length) return []
  const efforts =
    reasoning.control === 'always'
      ? reasoning.efforts.filter((effort) => effort !== 'none')
      : reasoning.efforts
  const fallback = reasoning.defaultEffort ?? efforts[efforts.length - 1]!
  return [
    { value: null, label: `跟随默认（${fallback}）` },
    ...efforts.map((effort) => ({
      value: effort,
      label: effort === 'none' ? '关闭' : effort,
    })),
  ]
}

export function temperatureState(model: DiscoveredModel): {
  enabled: boolean
  note?: string
} {
  if (model.acceptsTemperature === false)
    return { enabled: false, note: '这个模型不接受温度参数，请求里不会发送' }
  return { enabled: true }
}

/* ── Manage models (step 2 for an existing provider) ──────────────────── */

export function canUncheck(
  entryId: string,
  config: {
    activeModelId: string | null
    policy?: { fallback?: { enabled?: boolean; entryId?: string | null } }
  },
): { ok: true } | { ok: false; reason: string } {
  if (entryId === config.activeModelId)
    return { ok: false, reason: '正在使用的模型不能移除，请先切换到其他模型' }
  const fallback = config.policy?.fallback
  if (fallback?.enabled && fallback.entryId === entryId)
    return { ok: false, reason: '备用模型引用了它，请先在执行策略里换掉' }
  return { ok: true }
}

/** A model typed in by hand, as the list would have shown it. */
export function manualModel(
  modelId: string,
  facts: ModelFacts,
): DiscoveredModel {
  const { key, ...rest } = facts
  return { ...rest, id: modelId, catalogKey: key, fieldSources: {} }
}

/** Mark a field as changed by the user (locked on save). */
export function markEdited(draft: EntryDraft, field: ModelMetadataField): void {
  if (!draft.edited.includes(field)) draft.edited.push(field)
}

function compactRecord<T extends Record<string, unknown>>(
  value: T,
): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  return entries.length
    ? (Object.fromEntries(entries) as Partial<T>)
    : undefined
}

/**
 * The `model.saveEntries` request for the picked models: what discovery
 * found goes into `detected` / `limits`, where it came from into
 * `metadata` (with the user's edits locked), and a temperature only when
 * the user set one for a model that accepts it.
 */
export function toSaveRequest(input: {
  connection: ModelEntriesSaveRequest['connection']
  drafts: readonly EntryDraft[]
  activateModelId: string | null
  entryIds: Readonly<Record<string, string>>
  now?: Date
}): ModelEntriesSaveRequest {
  const checkedAt = (input.now ?? new Date()).toISOString()
  return {
    connection: input.connection,
    entries: input.drafts.map((draft) => {
      const model = draft.model
      const overrides = compactRecord(draft.capabilityOverrides)
      const limits = compactRecord({
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
      })
      const detected = compactRecord({
        toolCall: model.capabilities.toolCall,
        vision: model.capabilities.vision,
        reasoning: model.capabilities.reasoning,
        reasoningEfforts: model.reasoning?.efforts.length
          ? [...model.reasoning.efforts]
          : undefined,
        defaultReasoningEffort: model.reasoning?.defaultEffort,
        reasoningControl: model.reasoning?.control,
        acceptsTemperature: model.acceptsTemperature,
        modalities: model.modalities?.length
          ? [...model.modalities]
          : undefined,
        kind: model.kind,
      })
      const accepts = model.acceptsTemperature !== false
      return {
        entryId: input.entryIds[draft.modelId],
        modelId: draft.modelId,
        ...(draft.displayName ? { displayName: draft.displayName } : {}),
        contextWindowTokens: draft.contextWindowTokens,
        maxTokens: draft.maxTokens,
        reasoningEffort: draft.reasoningEffort,
        ...(overrides ? { capabilityOverrides: overrides } : {}),
        ...(draft.pricing ? { pricing: { ...draft.pricing } } : {}),
        ...(limits ? { limits } : {}),
        ...(detected ? { detected } : {}),
        metadata: {
          source: model.source,
          ...(model.name ? { name: model.name } : {}),
          ...(model.catalogKey ? { catalogKey: model.catalogKey } : {}),
          checkedAt,
          ...(draft.edited.length ? { userLocked: [...draft.edited] } : {}),
          ...(model.lifecycle ? { lifecycle: { ...model.lifecycle } } : {}),
        },
        ...(accepts && draft.temperature !== null
          ? { sampling: { temperature: draft.temperature } }
          : {}),
      }
    }),
    ...(input.activateModelId
      ? { activateEntryId: input.entryIds[input.activateModelId] }
      : {}),
  }
}
