import { resolve } from 'node:path'
import {
  activeEntry,
  buildWizardModelConfig,
  findEntry,
  loadModelConfig,
  markEntryVision,
  saveModelConfig,
  type ModelConfig,
  type ModelEntry,
  type ProviderConfig,
  type WizardModelSettings,
} from '../../config/model-config'
import {
  buildProviderSnapshot,
  type ModelRole,
  type ModelRoute,
  type ProviderSnapshot,
} from '../../model/router'
import {
  modelAvailability,
  type ModelAvailability,
} from '../../model/availability'
import type { OpenAiMessage } from '../../providers/base'
import {
  findByName,
  providerOptions,
  type ProviderOption,
  type ProviderSpec,
} from '../../providers/registry'

type Dict = Record<string, any>

const MODEL_DISCOVERY_TIMEOUT_MS = 15_000
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_VERSION = '2023-06-01'

export interface CoreModelRouterLike {
  route(
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ): ModelRoute
  payload?(): Record<string, unknown>
}

export interface CoreModelServiceDeps {
  router: CoreModelRouterLike | (() => CoreModelRouterLike)
  refreshModelConfig?: () => void | Promise<void>
}

export interface CurrentModelPayload {
  provider: string
  providerLabel: string
  model: string
  apiBase: string | null
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  contextWindowTokens: number
  entryName: string
  entryLabel: string
  supportsVision: boolean
  mainModelId: string
  secondaryModelId: string
  modelRole: ModelRole
}

export interface ModelConfigPayload {
  current: CurrentModelPayload
  secondary: CurrentModelPayload | null
  availability: ModelAvailability
  routing: Record<string, unknown>
  config: Dict
  providerOptions: ProviderOption[]
}

export interface DiscoveredModel {
  id: string
  ownedBy?: string
  created?: number | string
}

export interface ModelDiscoveryPayload {
  ok: boolean
  provider: string
  apiBase: string | null
  source: string
  models: DiscoveredModel[]
  code?: string
  message?: string
}

export class CoreModelService {
  readonly root: string
  private readonly deps: CoreModelServiceDeps

  constructor(root: string, deps: CoreModelServiceDeps) {
    this.root = resolve(root)
    this.deps = deps
  }

  async getConfig(): Promise<ModelConfigPayload> {
    const config = await loadModelConfig(this.root)
    const entry = activeEntry(config) ?? null
    const current = this.router().route('main_agent').snapshot
    const secondary = entry?.secondaryModelId
      ? this.snapshotPayload(
          this.router().route('memory_compaction').snapshot,
          entry,
        )
      : null
    return {
      current: this.snapshotPayload(current, entry),
      secondary,
      availability: modelAvailability(config),
      routing: this.router().payload?.() ?? {
        secondaryEnabled: Boolean(entry?.secondaryModelId),
        fallbackToMain: true,
      },
      config: redactApiKeys(config.raw),
      providerOptions: providerOptions(),
    }
  }

  async saveConfig(input: unknown): Promise<ModelConfigPayload> {
    const body =
      isRecord(input) && isRecord(input.config) ? input.config : input
    if (!isRecord(body)) throw new Error('model config must be an object')
    const existing = (await loadModelConfig(this.root)).raw
    const next = structuredClone(body)
    restoreMaskedKeys(next, existing)
    await saveModelConfig(this.root, next, { validateComplete: true })
    await this.deps.refreshModelConfig?.()
    return this.getConfig()
  }

  async saveOnboardingConfig(input: unknown): Promise<ModelConfigPayload> {
    const settings = wizardSettings(input)
    const existing = (await loadModelConfig(this.root)).raw
    const next = buildWizardModelConfig(existing, settings)
    await saveModelConfig(this.root, next, { validateComplete: true })
    await this.deps.refreshModelConfig?.()
    return this.getConfig()
  }

  async discoverModels(input: Dict): Promise<ModelDiscoveryPayload> {
    const config = await loadModelConfig(this.root)
    const providerName = String(input.provider ?? '').trim()
    const spec = findByName(providerName) ?? findByName('custom')
    if (!spec) throw new Error('custom provider missing from registry')

    const entryName = String(input.entryName ?? '').trim()
    const entry = entryName
      ? (findEntry(config, entryName) ?? null)
      : (activeEntry(config) ?? null)
    const providerConfig = config.providers[spec.name] ?? null
    const apiBase = discoveryApiBase(input.apiBase, entry, providerConfig, spec)
    const apiKey = discoveryApiKey(input.apiKey, entry, providerConfig)
    const extraHeaders = discoveryExtraHeaders(
      input.extraHeaders,
      entry,
      providerConfig,
    )

    if (spec.modelDiscovery === 'unsupported') {
      return discoveryUnavailable(
        spec,
        apiBase,
        'unsupported_backend',
        `${spec.displayName} 当前不支持自动获取模型列表，请手动填写模型 ID。`,
      )
    }
    if (!spec.isLocal && !spec.isOauth && !apiKey) {
      return discoveryUnavailable(
        spec,
        apiBase,
        'credential_required',
        `请先填写 ${spec.displayName} 的 API Key 后再获取模型列表。`,
      )
    }
    if (!apiBase && spec.modelDiscovery === 'openai_compat') {
      return discoveryUnavailable(
        spec,
        apiBase,
        'missing_api_base',
        `请先填写 ${spec.displayName} 的 API Base 后再获取模型列表。`,
      )
    }

    if (spec.modelDiscovery === 'anthropic') {
      return discoverAnthropicModels(spec, apiBase, apiKey, extraHeaders)
    }
    return discoverOpenAiCompatibleModels(spec, apiBase, apiKey, extraHeaders)
  }

  async test(body: Dict): Promise<Dict> {
    const entryName = String(body.entryName ?? '').trim()
    const kind = String(body.kind ?? 'text').toLowerCase()
    let role = String(body.role ?? 'main').toLowerCase() as ModelRole
    if (!['text', 'vision'].includes(kind))
      return { ok: false, kind, error: "kind must be 'text' or 'vision'" }
    if (!entryName) return { ok: false, kind, error: 'entryName required' }
    if (!['main', 'secondary'].includes(role))
      return { ok: false, kind, error: "role must be 'main' or 'secondary'" }
    if (kind === 'vision') role = 'main'

    const config = await loadModelConfig(this.root)
    const entry = findEntry(config, entryName)
    if (role === 'secondary' && entry && !entry.secondaryModelId) {
      return {
        ok: false,
        kind,
        error:
          'secondaryModelId is required before testing the secondary model',
      }
    }

    let snapshot: ProviderSnapshot
    try {
      snapshot = this.snapshotForModelTest(config, entryName, role)
    } catch (error) {
      return {
        ok: false,
        kind,
        error: `snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const started = Date.now()
    try {
      const response = await snapshot.provider.chat({
        messages:
          kind === 'vision'
            ? visionProbeMessages()
            : [{ role: 'user', content: 'Reply with exactly one word: pong' }],
        tools: null,
        model: snapshot.model,
        maxTokens: 64,
        temperature: 0,
        reasoningEffort: null,
      })
      const sample = String(response.content || '')
        .trim()
        .slice(0, 200)
      const ok =
        kind === 'vision'
          ? visionOk(sample)
          : Boolean(sample && sample.toLowerCase().includes('pong'))
      const payload: Dict = {
        ok,
        kind,
        latencyMs: Date.now() - started,
        model: snapshot.model,
        provider: snapshot.providerName,
        modelRole: snapshot.modelRole,
        sample,
        finishReason: response.finishReason || 'stop',
      }
      if (kind === 'vision' && ok) {
        try {
          await markEntryVision(this.root, entryName, true)
          await this.deps.refreshModelConfig?.()
          payload.visionMarked = true
        } catch {
          payload.visionMarked = false
        }
      }
      return payload
    } catch (error) {
      return {
        ok: false,
        kind,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
        model: snapshot.model,
        provider: snapshot.providerName,
        modelRole: snapshot.modelRole,
      }
    }
  }

  private router(): CoreModelRouterLike {
    return typeof this.deps.router === 'function'
      ? this.deps.router()
      : this.deps.router
  }

  private snapshotForModelTest(
    config: ModelConfig,
    entryName: string,
    role: ModelRole,
  ): ProviderSnapshot {
    const routed =
      role === 'secondary'
        ? this.router().route('memory_compaction').snapshot
        : this.router().route('main_agent').snapshot
    if (routed.entryName === entryName) return routed
    return buildProviderSnapshot(config, { modelOverride: entryName, role })
  }

  private snapshotPayload(
    snapshot: ProviderSnapshot,
    entry: ModelEntry | null,
  ): CurrentModelPayload {
    return {
      provider: snapshot.providerName,
      providerLabel: snapshot.providerLabel,
      model: snapshot.model,
      apiBase: snapshot.apiBase,
      maxTokens: snapshot.generation.maxTokens,
      temperature: snapshot.generation.temperature,
      reasoningEffort: snapshot.generation.reasoningEffort,
      contextWindowTokens: snapshot.contextWindowTokens,
      entryName: entry?.name ?? snapshot.entryName,
      entryLabel: entry?.label || entry?.name || snapshot.entryLabel,
      supportsVision: Boolean(snapshot.supportsVision),
      mainModelId:
        entry?.mainModelId ??
        (snapshot.modelRole === 'main' ? snapshot.model : ''),
      secondaryModelId: entry?.secondaryModelId ?? '',
      modelRole: snapshot.modelRole,
    }
  }
}

export function redactApiKeys(raw: Dict): Dict {
  const out = structuredClone(raw)
  for (const prov of Object.values(out.providers ?? {})) {
    if (isRecord(prov) && typeof prov.apiKey === 'string' && prov.apiKey)
      prov.apiKey = maskKey(prov.apiKey)
  }
  for (const entry of out.models ?? []) {
    if (isRecord(entry) && typeof entry.apiKey === 'string' && entry.apiKey)
      entry.apiKey = maskKey(entry.apiKey)
  }
  return out
}

function discoveryApiBase(
  input: unknown,
  entry: ModelEntry | null,
  provider: ProviderConfig | null,
  spec: ProviderSpec,
): string | null {
  const direct = trimString(input)
  if (direct) return direct
  return (
    trimString(entry?.apiBase) ||
    trimString(provider?.apiBase) ||
    spec.defaultApiBase ||
    null
  )
}

function discoveryApiKey(
  input: unknown,
  entry: ModelEntry | null,
  provider: ProviderConfig | null,
): string {
  const direct = trimString(input)
  if (direct && !direct.startsWith('***')) return direct
  const candidates = [
    trimString(entry?.apiKey),
    trimString(provider?.apiKey),
  ].filter(Boolean)
  if (!direct) return candidates[0] ?? ''
  const suffix = direct.replace(/^\*+/, '')
  return (
    candidates.find((candidate) => suffix && candidate.endsWith(suffix)) ??
    candidates[0] ??
    ''
  )
}

function discoveryExtraHeaders(
  input: unknown,
  entry: ModelEntry | null,
  provider: ProviderConfig | null,
): Record<string, string> {
  const resolved =
    recordValue(input) ||
    recordValue(entry?.extraHeaders) ||
    recordValue(provider?.extraHeaders) ||
    {}
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(resolved)) {
    if (value === null || value === undefined) continue
    headers[key] = String(value)
  }
  return headers
}

async function discoverOpenAiCompatibleModels(
  spec: ProviderSpec,
  apiBase: string | null,
  apiKey: string,
  extraHeaders: Record<string, string>,
): Promise<ModelDiscoveryPayload> {
  let last: ModelDiscoveryPayload | null = null
  for (const url of openAiModelEndpointCandidates(apiBase || '')) {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: discoveryHeaders(
          extraHeaders,
          apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        ),
      })
      if (!response.ok) {
        last = discoveryUnavailable(
          spec,
          apiBase,
          codeForHttpStatus(response.status),
          response.statusText || `HTTP ${response.status}`,
        )
        continue
      }
      const body = await response.json()
      return {
        ok: true,
        provider: spec.name,
        apiBase,
        source: 'openai_compat',
        models: parseDiscoveredModels(body),
      }
    } catch (error) {
      last = discoveryUnavailable(
        spec,
        apiBase,
        codeForFetchError(error),
        fetchErrorMessage(error),
      )
    }
  }
  return (
    last ??
    discoveryUnavailable(
      spec,
      apiBase,
      'no_endpoint',
      '未找到可用的模型列表 endpoint。',
    )
  )
}

async function discoverAnthropicModels(
  spec: ProviderSpec,
  apiBase: string | null,
  apiKey: string,
  extraHeaders: Record<string, string>,
): Promise<ModelDiscoveryPayload> {
  const url = anthropicModelsUrl(apiBase)
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: discoveryHeaders(extraHeaders, {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      }),
    })
    if (!response.ok) {
      return discoveryUnavailable(
        spec,
        apiBase,
        codeForHttpStatus(response.status),
        response.statusText || `HTTP ${response.status}`,
      )
    }
    const body = await response.json()
    return {
      ok: true,
      provider: spec.name,
      apiBase,
      source: 'anthropic',
      models: parseDiscoveredModels(body),
    }
  } catch (error) {
    return discoveryUnavailable(
      spec,
      apiBase,
      codeForFetchError(error),
      fetchErrorMessage(error),
    )
  }
}

function discoveryUnavailable(
  spec: ProviderSpec,
  apiBase: string | null,
  code: string,
  message: string,
): ModelDiscoveryPayload {
  return {
    ok: false,
    provider: spec.name,
    apiBase,
    source: spec.modelDiscovery,
    models: [],
    code,
    message,
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function discoveryHeaders(
  extraHeaders: Record<string, string>,
  defaults: Record<string, string>,
): Headers {
  const headers = new Headers({ accept: 'application/json', ...defaults })
  for (const [key, value] of Object.entries(extraHeaders))
    headers.set(key, value)
  return headers
}

function openAiModelEndpointCandidates(apiBase: string): string[] {
  const base = trimApiBase(apiBase)
  const candidates = new Set<string>()
  addModelEndpoint(candidates, base)
  for (const normalized of normalizedOpenAiCompatBases(base))
    addModelEndpoint(candidates, normalized)
  return [...candidates]
}

function addModelEndpoint(out: Set<string>, base: string): void {
  if (!base) return
  out.add(`${base}/models`)
}

function normalizedOpenAiCompatBases(base: string): string[] {
  if (!base) return []
  const suffixes = [
    /\/api\/anthropic$/i,
    /\/anthropic$/i,
    /\/apps\/anthropic$/i,
    /\/step_plan(?:\/v\d+)?$/i,
    /\/api\/coding(?:\/v\d+)?$/i,
    /\/coding(?:\/v\d+)?$/i,
  ]
  const out: string[] = []
  for (const suffix of suffixes) {
    const next = trimApiBase(base.replace(suffix, ''))
    if (next && next !== base) out.push(next)
  }
  return out
}

function anthropicModelsUrl(apiBase: string | null): string {
  const base = trimApiBase(apiBase || '')
  if (!base) return ANTHROPIC_MODELS_URL
  if (base.endsWith('/v1')) return `${base}/models`
  return `${base}/v1/models`
}

function parseDiscoveredModels(body: unknown): DiscoveredModel[] {
  const data = modelArray(body)
  const seen = new Set<string>()
  const out: DiscoveredModel[] = []
  for (const raw of data) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const id =
      trimString(item.id) || trimString(item.name) || trimString(item.model)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: DiscoveredModel = { id }
    const ownedBy =
      trimString(item.owned_by) ||
      trimString(item.ownedBy) ||
      trimString(item.owner)
    const created = item.created ?? item.created_at ?? item.createdAt
    if (ownedBy) model.ownedBy = ownedBy
    if (typeof created === 'number' || typeof created === 'string')
      model.created = created
    out.push(model)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function modelArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const record = body as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.models)) return record.models
  return []
}

function codeForHttpStatus(status: number): string {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status >= 500 || status === 408) return 'transient'
  return 'request_failed'
}

function codeForFetchError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'timeout'
  return 'network_error'
}

function fetchErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError')
    return '获取模型列表超时。'
  return error instanceof Error ? error.message : String(error)
}

export function restoreMaskedKeys(config: Dict, existing: Dict): void {
  const incomingProviders = isRecord(config.providers) ? config.providers : {}
  const existingProviders = isRecord(existing.providers)
    ? existing.providers
    : {}
  for (const [name, prov] of Object.entries(incomingProviders)) {
    if (
      isRecord(prov) &&
      typeof prov.apiKey === 'string' &&
      prov.apiKey.startsWith('***')
    ) {
      const old = existingProviders[name]
      prov.apiKey = isRecord(old) ? String(old.apiKey ?? '') : ''
    }
  }

  const existingModels = new Map<string, Dict>()
  for (const item of Array.isArray(existing.models) ? existing.models : []) {
    if (isRecord(item) && item.name) existingModels.set(String(item.name), item)
  }
  for (const entry of Array.isArray(config.models) ? config.models : []) {
    if (
      !isRecord(entry) ||
      typeof entry.apiKey !== 'string' ||
      !entry.apiKey.startsWith('***')
    )
      continue
    const old = existingModels.get(String(entry.name ?? ''))
    entry.apiKey = old ? String(old.apiKey ?? '') : ''
  }
}

function maskKey(key: string): string {
  return key.length > 4 ? `***${key.slice(-4)}` : '***'
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function trimApiBase(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Dict {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function wizardSettings(input: unknown): WizardModelSettings {
  if (!isRecord(input)) throw new Error('wizard settings must be an object')
  return {
    provider: String(input.provider ?? '').trim(),
    name: String(input.name ?? '').trim(),
    label: String(input.label ?? '').trim(),
    apiKey: String(input.apiKey ?? ''),
    apiBase: String(input.apiBase ?? ''),
    mainModelId: String(input.mainModelId ?? '').trim(),
    secondaryModelId: String(input.secondaryModelId ?? '').trim(),
    maxTokens: Number(input.maxTokens ?? 8192),
    temperature: Number(input.temperature ?? 0.1),
    contextWindowTokens: Number(input.contextWindowTokens ?? 128000),
    reasoningEffort: input.reasoningEffort
      ? String(input.reasoningEffort)
      : null,
  }
}

const PROBE_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='

function visionProbeMessages(): OpenAiMessage[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Reply with ONE English word only: name a visible color in this image.',
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${PROBE_JPEG_BASE64}` },
        },
      ],
    },
  ]
}

function visionOk(sample: string): boolean {
  const lower = sample.toLowerCase()
  return (
    Boolean(sample) &&
    !['invalid', 'error', 'cannot', 'unable', 'sorry'].some((token) =>
      lower.includes(token),
    )
  )
}
