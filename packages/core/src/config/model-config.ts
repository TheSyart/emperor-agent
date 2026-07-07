import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ValidationError } from '../errors'
import { logger } from '../util/log'
import { PROVIDERS, findByName } from '../providers/registry'

/**
 * 模型配置加载/解析/保存 (MIG-CFG-002 + CFG-003 IO)。
 *
 * 对齐 Python `agent/model_config.py`。schema 与磁盘字节格式（indent=2 + 末尾换行、unicode 原样）
 * 逐字保真，老 `model_config.json` 零迁移可读。`build_provider_snapshot`（需 provider 客户端）在 W02-PROV-006。
 */

export const MODEL_CONFIG_FILE = 'model_config.json'
export const MODEL_CONFIG_EXAMPLE_FILE = 'model_config.example.json'

export interface AgentDefaults {
  model: string
  provider: string
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  contextWindowTokens: number
}

export interface ProviderConfig {
  apiKey: string | null
  apiBase: string | null
  extraHeaders: Record<string, string> | null
  extraBody: Record<string, unknown> | null
}

export interface ModelEntry {
  name: string
  id: string
  mainModelId: string
  provider: string
  secondaryModelId: string
  apiKey: string | null
  apiBase: string | null
  extraHeaders: Record<string, string> | null
  extraBody: Record<string, unknown> | null
  maxTokens: number | null
  temperature: number | null
  contextWindowTokens: number | null
  reasoningEffort: string | null
  label: string
  supportsVision: boolean
}

export interface ModelConfig {
  defaults: AgentDefaults
  models: ModelEntry[]
  providers: Record<string, ProviderConfig>
  raw: RawConfig
}

export interface WizardModelSettings {
  provider: string
  name: string
  label: string
  apiKey: string
  apiBase: string
  mainModelId: string
  secondaryModelId: string
  maxTokens: number
  temperature: number
  contextWindowTokens: number
  reasoningEffort?: string | null
}

type RawConfig = Record<string, any>

function buildDefaultProviders(): RawConfig {
  const out: RawConfig = {}
  for (const s of PROVIDERS) {
    out[s.name] = { apiKey: '', apiBase: s.defaultApiBase ?? '', extraHeaders: null, extraBody: null }
  }
  return out
}

export function defaultModelConfig(): RawConfig {
  return {
    agents: {
      defaults: {
        model: '',
        provider: 'auto',
        maxTokens: 8192,
        temperature: 0.1,
        reasoningEffort: null,
        contextWindowTokens: 128000,
      },
    },
    models: [],
    providers: buildDefaultProviders(),
  }
}

// ── helpers（对齐 _nullable_str / _dict_or_none / _int / _float / _optional_* / _deep_merge）──

function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text !== '' ? text : null
}

function dictOrNone(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null
}

function toInt(value: unknown, def: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? n : def
}

function toFloat(value: unknown, def: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(n) ? n : def
}

function optionalInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? n : null
}

function optionalFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(n) ? n : null
}

function deepMerge(target: RawConfig, source: RawConfig): RawConfig {
  for (const [key, value] of Object.entries(source ?? {})) {
    const cur = target[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      deepMerge(cur, value as RawConfig)
    } else {
      target[key] = value
    }
  }
  return target
}

function isRawRecord(value: unknown): value is RawConfig {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function findRawEntry(models: unknown[], name: string): RawConfig | undefined {
  if (!name) return undefined
  return models.find((item): item is RawConfig => isRawRecord(item) && String(item.name ?? '') === name)
}

export function maskSecret(value: string | null | undefined): string {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= 4) return '***'
  return `***${text.slice(-4)}`
}

export function buildWizardModelConfig(
  existingRaw: Record<string, any> | null | undefined,
  settings: WizardModelSettings,
): Record<string, any> {
  const raw = structuredClone(existingRaw || defaultModelConfig()) as RawConfig
  ;(raw.agents ??= {}).defaults ??= {}
  raw.providers ??= {}
  let models = raw.models
  if (!Array.isArray(models)) {
    models = []
    raw.models = models
  }

  const currentName = String(raw.agents.defaults.model ?? '')
  const existingEntry = findRawEntry(models, currentName) ?? (isRawRecord(models[0]) ? models[0] : {})
  const previousKey = isRawRecord(existingEntry) ? String(existingEntry.apiKey ?? '') : ''
  const provider = findByName(settings.provider)
  const apiBase = settings.apiBase || provider?.defaultApiBase || ''
  const submittedKey = settings.apiKey.trim()
  // 掩码占位符（getConfig() 回传的 '***xxxx'）和空字符串一样代表"未修改"，必须回退到
  // 旧密钥，不能把占位符本身当成新密钥存盘（审计 P1-2）。
  const apiKey = submittedKey && !submittedKey.startsWith('***') ? submittedKey : previousKey
  const entry: RawConfig = {
    name: settings.name.trim(),
    label: settings.label.trim(),
    provider: settings.provider,
    apiKey,
    apiBase,
    mainModelId: settings.mainModelId.trim(),
    secondaryModelId: settings.secondaryModelId.trim(),
    maxTokens: Math.trunc(Number(settings.maxTokens)),
    temperature: Number(settings.temperature),
    contextWindowTokens: Math.trunc(Number(settings.contextWindowTokens)),
    reasoningEffort: settings.reasoningEffort || null,
  }
  entry.id = entry.mainModelId

  let replaced = false
  const oldName = isRawRecord(existingEntry) ? String(existingEntry.name ?? '') : ''
  for (const [index, item] of models.entries()) {
    if (isRawRecord(item) && new Set([oldName, entry.name]).has(String(item.name ?? ''))) {
      models[index] = entry
      replaced = true
      break
    }
  }
  if (!replaced) models.push(entry)

  raw.agents.defaults.model = entry.name
  raw.agents.defaults.provider = settings.provider
  raw.agents.defaults.maxTokens = Math.trunc(Number(settings.maxTokens))
  raw.agents.defaults.temperature = Number(settings.temperature)
  raw.agents.defaults.reasoningEffort = settings.reasoningEffort || null
  raw.agents.defaults.contextWindowTokens = Math.trunc(Number(settings.contextWindowTokens))

  const providerBlock = (raw.providers[settings.provider] ??= {})
  if (isRawRecord(providerBlock)) {
    providerBlock.apiKey ??= ''
    providerBlock.apiBase = apiBase
    providerBlock.extraHeaders ??= null
    providerBlock.extraBody ??= null
  }

  return raw
}

// ── 解析 / 归一化 ──

function normalizedRaw(raw: RawConfig): RawConfig {
  const normalized = structuredClone(defaultModelConfig())
  deepMerge(normalized, raw ?? {})
  const providers = (normalized.providers ??= {})
  for (const s of PROVIDERS) {
    providers[s.name] ??= { apiKey: '', apiBase: s.defaultApiBase ?? '', extraHeaders: null, extraBody: null }
  }
  ;(normalized.agents ??= {}).defaults ??= structuredClone(defaultModelConfig().agents.defaults)
  normalized.models ??= []
  for (const item of normalized.models as any[]) {
    if (!item || typeof item !== 'object') continue
    const mainModelId = String(item.mainModelId ?? item.id ?? '').trim()
    const secondaryModelId = String(item.secondaryModelId ?? '').trim()
    if (mainModelId) {
      item.mainModelId = mainModelId
      item.id = mainModelId
    } else {
      item.mainModelId ??= ''
      item.id ??= ''
    }
    item.secondaryModelId = secondaryModelId
  }
  return normalized
}

function parseEntry(item: RawConfig): ModelEntry {
  const mainModelId = String(item.mainModelId ?? item.id ?? '').trim()
  const secondaryModelId = String(item.secondaryModelId ?? '').trim()
  let name = String(item.name ?? mainModelId ?? '').trim()
  if (!name) name = '(unnamed)'
  const main = mainModelId || name
  return {
    name,
    id: main,
    mainModelId: main,
    secondaryModelId,
    provider: String(item.provider ?? 'custom'),
    apiKey: nullableStr(item.apiKey),
    apiBase: nullableStr(item.apiBase),
    extraHeaders: dictOrNone(item.extraHeaders) as Record<string, string> | null,
    extraBody: dictOrNone(item.extraBody),
    maxTokens: optionalInt(item.maxTokens),
    temperature: optionalFloat(item.temperature),
    contextWindowTokens: optionalInt(item.contextWindowTokens),
    reasoningEffort: nullableStr(item.reasoningEffort),
    label: String(item.label ?? ''),
    supportsVision: Boolean(item.supportsVision ?? false),
  }
}

function dedupeEntryNames(entries: ModelEntry[]): ModelEntry[] {
  const seen = new Map<string, number>()
  const out: ModelEntry[] = []
  for (const entry of entries) {
    const count = seen.get(entry.name)
    if (count === undefined) {
      seen.set(entry.name, 1)
      out.push(entry)
      continue
    }
    const next = count + 1
    seen.set(entry.name, next)
    const newName = `${entry.name}-${next}`
    logger.warn('Duplicate model entry name; renamed', { from: entry.name, to: newName })
    out.push({ ...entry, name: newName })
  }
  return out
}

export function parseModelConfig(raw: RawConfig): ModelConfig {
  const normalized = normalizedRaw(raw)
  const d = normalized.agents.defaults
  const defaults: AgentDefaults = {
    model: String(d.model ?? ''),
    provider: String(d.provider ?? 'auto'),
    maxTokens: toInt(d.maxTokens, 8192),
    temperature: toFloat(d.temperature, 0.1),
    reasoningEffort: nullableStr(d.reasoningEffort),
    contextWindowTokens: toInt(d.contextWindowTokens, 128000),
  }
  const providersRaw = normalized.providers ?? {}
  const providers: Record<string, ProviderConfig> = {}
  for (const s of PROVIDERS) {
    const item = providersRaw[s.name] ?? {}
    providers[s.name] = {
      apiKey: nullableStr(item.apiKey),
      apiBase: nullableStr(item.apiBase),
      extraHeaders: dictOrNone(item.extraHeaders) as Record<string, string> | null,
      extraBody: dictOrNone(item.extraBody),
    }
  }
  const modelsRaw = (normalized.models ?? []) as any[]
  const models = dedupeEntryNames(modelsRaw.filter((m) => m && typeof m === 'object').map(parseEntry))
  return { defaults, models, providers, raw: normalized }
}

export function findEntry(config: ModelConfig, name: string | null | undefined): ModelEntry | undefined {
  if (!name) return undefined
  return config.models.find((e) => e.name === name)
}

export function activeEntry(config: ModelConfig): ModelEntry | undefined {
  return findEntry(config, config.defaults.model) ?? config.models[0]
}

/** 旧 schema 合成时用：按 defaults.provider 找；'auto' 时按 model 名 keyword 匹配。 */
export function resolveProviderName(
  provider: string,
  model: string,
  providers: Record<string, ProviderConfig>,
): string {
  if (provider && !['auto', 'default'].includes(provider.toLowerCase())) {
    const spec = findByName(provider)
    if (!spec) {
      logger.warn("Unknown provider in defaults; falling back to 'custom'", { provider })
      return 'custom'
    }
    return spec.name
  }
  const normalizedModel = (model || '').toLowerCase().replace(/_/g, '-')
  for (const s of PROVIDERS) {
    if (s.keywords.some((kw) => kw && normalizedModel.includes(kw))) return s.name
  }
  for (const [name, p] of Object.entries(providers)) {
    if (p.apiKey) return name
  }
  return 'deepseek'
}

export function validateCompleteModelEntries(raw: RawConfig): void {
  const models = raw.models
  if (!Array.isArray(models) || models.length === 0) throw new ValidationError('请至少添加一个模型条目')
  const names = new Set<string>()
  models.forEach((item: any, idx0: number) => {
    const index = idx0 + 1
    if (!item || typeof item !== 'object') throw new ValidationError(`第 ${index} 个模型条目格式无效`)
    const name = String(item.name ?? '').trim()
    const mainModelId = String(item.mainModelId ?? item.id ?? '').trim()
    const secondaryModelId = String(item.secondaryModelId ?? '').trim()
    if (!name) throw new ValidationError(`第 ${index} 个模型条目的名称不能为空`)
    if (names.has(name)) throw new ValidationError(`模型条目名称重复: ${name}`)
    names.add(name)
    if (!mainModelId) throw new ValidationError(`模型条目 ${name} 必须填写 Main Model ID`)
    if (!secondaryModelId) throw new ValidationError(`模型条目 ${name} 必须填写 Secondary Model ID`)
  })
}

// ── 文件 IO（CFG-003）──

function serialize(data: RawConfig): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

export async function ensureModelConfig(root: string): Promise<string> {
  const path = join(root, MODEL_CONFIG_FILE)
  if (!existsSync(path)) await writeFile(path, serialize(defaultModelConfig()), 'utf8')
  return path
}

export async function ensureExampleConfig(root: string): Promise<string> {
  const path = join(root, MODEL_CONFIG_EXAMPLE_FILE)
  const desired = serialize(defaultModelConfig())
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== desired) {
    await writeFile(path, desired, 'utf8')
  }
  return path
}

export async function loadModelConfig(root: string, opts: { create?: boolean } = {}): Promise<ModelConfig> {
  const r = resolve(root)
  if (opts.create !== false) {
    await ensureModelConfig(r)
  }
  const path = join(r, MODEL_CONFIG_FILE)
  const raw = structuredClone(defaultModelConfig())
  if (existsSync(path)) {
    const loaded = JSON.parse((await readFile(path, 'utf8')) || '{}')
    deepMerge(raw, loaded)
  }
  return parseModelConfig(raw)
}

export async function saveModelConfig(
  root: string,
  data: RawConfig,
  opts: { validateComplete?: boolean } = {},
): Promise<ModelConfig> {
  const config = parseModelConfig(normalizedRaw(data))
  if (opts.validateComplete) validateCompleteModelEntries(config.raw)
  const r = resolve(root)
  await writeFile(join(r, MODEL_CONFIG_FILE), serialize(config.raw), 'utf8')
  return config
}

export async function markEntryVision(root: string, entryName: string, value = true): Promise<ModelConfig> {
  const config = await loadModelConfig(root)
  const raw = structuredClone(config.raw)
  const found = (raw.models as any[] | undefined)?.find((m) => m && typeof m === 'object' && m.name === entryName)
  if (!found) throw new ValidationError(`entry '${entryName}' not found in model_config.json`)
  found.supportsVision = Boolean(value)
  return saveModelConfig(root, raw)
}
