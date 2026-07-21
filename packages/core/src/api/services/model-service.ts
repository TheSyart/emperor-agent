import { resolve } from 'node:path'
import {
  activateModelEntry,
  activeEntry,
  deleteModelEntry,
  findEntry,
  loadModelConfig,
  maskSecret,
  parseModelConfig,
  saveModelEntry,
  saveModelPolicy,
  upsertModelEntryConfig,
  type ModelConfig,
  type ModelEntry,
  type ModelEntryUpdate,
  type ModelEntryV2,
  type ModelExecutionPolicy,
  type ModelProtocol,
} from '../../config/model-config'
import {
  modelAvailability,
  type ModelAvailability,
} from '../../model/availability'
import {
  resolveModelProfile,
  type ResolvedModelProfile,
} from '../../model/profile'
import {
  buildProviderSnapshot,
  type ModelRoute,
  type ProviderSnapshot,
} from '../../model/router'
import type { OpenAiMessage } from '../../providers/base'
import {
  findByName,
  normalizeApiBase,
  providerOptions,
  type ProviderOption,
  type ProviderSpec,
} from '../../providers/registry'
import type { ProfileOnboardingActionResult } from '../../sessions/onboarding'

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
  afterConfigSaved?: () =>
    ProfileOnboardingActionResult | Promise<ProfileOnboardingActionResult>
}

export type ModelEntrySaveInput = Omit<ModelEntryUpdate, 'legacy'>

export interface ModelProfilePreviewInput {
  provider: string
  protocol: ModelProtocol
  modelId: string
  capabilityOverrides?: ModelEntryV2['capabilityOverrides']
  contextWindowTokens?: number
  maxTokens?: number
}

export interface ModelEntryPayload extends Omit<
  ModelEntryV2,
  'apiKey' | 'legacy'
> {
  apiKey: string
  effectiveDisplayName: string
  resolvedProfile: ResolvedModelProfile
}

export interface CurrentModelPayload {
  entryId: string
  provider: string
  providerLabel: string
  protocol: ModelProtocol
  modelId: string
  displayName: string | null
  effectiveDisplayName: string
  apiBase: string
  reasoningEffort: string | null
  contextWindowTokens: number
  maxTokens: number
  capabilities: Pick<ResolvedModelProfile, 'toolCall' | 'vision' | 'reasoning'>
  capabilitySources: ResolvedModelProfile['sources']
  reasoningEfforts: ResolvedModelProfile['reasoningEfforts']
  reasoningAdapter: ResolvedModelProfile['reasoningAdapter']
}

export interface ModelConfigPayload {
  schemaVersion: 2
  activeModelId: string | null
  models: ModelEntryPayload[]
  policy: ModelExecutionPolicy
  current: CurrentModelPayload | null
  availability: ModelAvailability
  providerOptions: ProviderOption[]
}

export interface ModelConfigSavePayload extends ModelConfigPayload {
  profileOnboarding?: ProfileOnboardingActionResult
}

export interface DiscoveredModel {
  id: string
  ownedBy?: string
  created?: number | string
}

export interface ModelDiscoveryPayload {
  ok: boolean
  provider: string
  protocol: ModelProtocol
  apiBase: string | null
  source: string
  models: DiscoveredModel[]
  code?: string
  message?: string
}

export class CoreModelService {
  readonly root: string
  private readonly deps: CoreModelServiceDeps
  private profileOnboardingRequested = false

  constructor(root: string, deps: CoreModelServiceDeps) {
    this.root = resolve(root)
    this.deps = deps
  }

  async getConfig(): Promise<ModelConfigPayload> {
    const config = await loadModelConfig(this.root)
    const entry = activeEntry(config) ?? null
    const models = config.raw.models.map((item) => modelEntryPayload(item))
    return {
      schemaVersion: 2,
      activeModelId: config.activeModelId,
      models,
      policy: structuredClone(config.policy),
      current: entry ? currentModelPayload(entry) : null,
      availability: modelAvailability(config),
      providerOptions: providerOptions(),
    }
  }

  async saveEntry(input: ModelEntrySaveInput): Promise<ModelConfigSavePayload> {
    const before = await loadModelConfig(this.root)
    const wasUsable = modelAvailability(before).usable
    const update = normalizeEntrySecret(input)
    const prospective = upsertModelEntryConfig(before.raw, update)
    const prospectiveEntry = update.entryId
      ? prospective.models.find((entry) => entry.entryId === update.entryId)
      : prospective.models[prospective.models.length - 1]
    if (!prospectiveEntry) throw new Error('保存模型前无法解析模型条目')
    const prospectiveProfile = resolvedProfile(prospectiveEntry)
    if (
      prospectiveEntry.reasoningEffort &&
      !prospectiveProfile.reasoningEfforts.includes(
        prospectiveEntry.reasoningEffort as any,
      )
    )
      throw new Error(
        `模型 ${prospectiveEntry.modelId} 不支持思考强度 ${prospectiveEntry.reasoningEffort}`,
      )
    await saveModelEntry(this.root, update)
    return this.afterModelMutation(wasUsable)
  }

  resolveProfile(input: ModelProfilePreviewInput): ResolvedModelProfile {
    const provider = trimString(input.provider)
    const spec = findByName(provider)
    if (!spec) throw new Error(`provider 无效: ${provider}`)
    if (!spec.protocols.includes(input.protocol))
      throw new Error(
        `provider ${spec.name} 不支持 protocol: ${input.protocol}`,
      )
    const modelId = trimString(input.modelId)
    if (!modelId) throw new Error('modelId required')
    return resolveModelProfile({
      provider: spec.name,
      protocol: input.protocol,
      modelId,
      capabilityOverrides: input.capabilityOverrides,
      contextWindowTokens: input.contextWindowTokens,
      maxTokens: input.maxTokens,
    })
  }

  async deleteEntry(entryId: string): Promise<ModelConfigSavePayload> {
    const before = await loadModelConfig(this.root)
    await deleteModelEntry(this.root, requiredId(entryId))
    return this.afterModelMutation(modelAvailability(before).usable)
  }

  async activate(entryId: string): Promise<ModelConfigSavePayload> {
    const before = await loadModelConfig(this.root)
    await activateModelEntry(this.root, requiredId(entryId))
    return this.afterModelMutation(modelAvailability(before).usable)
  }

  async setReasoningEffort(
    entryId: string,
    reasoningEffort: string | null,
  ): Promise<ModelConfigPayload> {
    const config = await loadModelConfig(this.root)
    const entry = findEntry(config, requiredId(entryId))
    if (!entry) throw new Error(`model entry not found: ${entryId}`)
    const profile = resolvedProfile(entry)
    if (
      reasoningEffort !== null &&
      !profile.reasoningEfforts.includes(reasoningEffort as any)
    )
      throw new Error(`模型 ${entry.modelId} 不支持思考强度 ${reasoningEffort}`)
    await saveModelEntry(this.root, {
      entryId: entry.entryId,
      reasoningEffort,
    })
    await this.deps.refreshModelConfig?.()
    return this.getConfig()
  }

  async savePolicy(policy: ModelExecutionPolicy): Promise<ModelConfigPayload> {
    await saveModelPolicy(this.root, policy)
    await this.deps.refreshModelConfig?.()
    return this.getConfig()
  }

  async discoverModels(input: Dict): Promise<ModelDiscoveryPayload> {
    const config = await loadModelConfig(this.root)
    const entryId = trimString(input.entryId)
    const entry = entryId ? (findEntry(config, entryId) ?? null) : null
    const providerName = trimString(input.provider) || entry?.provider || ''
    const spec = findByName(providerName)
    if (!spec) throw new Error(`provider 无效: ${providerName}`)
    const submittedProtocol = trimString(input.protocol)
    if (spec.name === 'custom' && !submittedProtocol)
      throw new Error('custom provider 必须明确选择 protocol')
    const protocol = (submittedProtocol ||
      entry?.protocol ||
      spec.defaultProtocol) as ModelProtocol | null
    if (!protocol || !spec.protocols.includes(protocol))
      throw new Error(
        `provider ${spec.name} 不支持 protocol: ${protocol ?? ''}`,
      )

    const submittedBase = trimString(input.apiBase)
    const apiBase = normalizeApiBase(
      protocol,
      submittedBase || entry?.apiBase || spec.apiBases[protocol] || '',
    )
    const canReuseEntryCredentials = discoveryIdentityMatches(
      entry,
      spec,
      protocol,
      apiBase,
    )
    const apiKey = discoveryApiKey(
      input.apiKey,
      entry,
      canReuseEntryCredentials,
    )
    const extraHeaders = discoveryExtraHeaders(
      input.extraHeaders,
      entry,
      canReuseEntryCredentials,
    )
    const discovery = spec.modelDiscovery[protocol] ?? 'unsupported'

    if (discovery === 'unsupported')
      return discoveryUnavailable(
        spec,
        protocol,
        apiBase,
        'unsupported_protocol',
        `${spec.displayName} 当前不支持通过 ${protocol} 自动获取模型列表，请手动填写模型 ID。`,
      )
    if (!spec.isLocal && !spec.isOauth && !apiKey)
      return discoveryUnavailable(
        spec,
        protocol,
        apiBase,
        'credential_required',
        `请先填写 ${spec.displayName} 的 API Key 后再获取模型列表。`,
      )
    if (!apiBase)
      return discoveryUnavailable(
        spec,
        protocol,
        apiBase,
        'missing_api_base',
        `请先填写 ${spec.displayName} 的 API Base 后再获取模型列表。`,
      )

    return discovery === 'anthropic'
      ? discoverAnthropicModels(spec, protocol, apiBase, apiKey, extraHeaders)
      : discoverOpenAiCompatibleModels(
          spec,
          protocol,
          apiBase,
          apiKey,
          extraHeaders,
        )
  }

  async test(body: { entryId?: string; kind?: string }): Promise<Dict> {
    const entryId = trimString(body.entryId)
    const kind = trimString(body.kind || 'text').toLowerCase()
    if (kind !== 'text' && kind !== 'vision')
      return { ok: false, kind, error: "kind must be 'text' or 'vision'" }
    if (!entryId) return { ok: false, kind, error: 'entryId required' }

    const config = await loadModelConfig(this.root)
    const entry = findEntry(config, entryId)
    if (!entry)
      return { ok: false, kind, error: `model entry not found: ${entryId}` }

    let snapshot: ProviderSnapshot
    try {
      snapshot = this.snapshotForModelTest(config, entryId, kind === 'vision')
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
      const ok = kind === 'vision' ? visionOk(sample) : /pong/i.test(sample)
      const payload: Dict = {
        ok,
        kind,
        entryId,
        latencyMs: Date.now() - started,
        model: snapshot.model,
        provider: snapshot.providerName,
        sample,
        finishReason: response.finishReason || 'stop',
      }
      return payload
    } catch (error) {
      return {
        ok: false,
        kind,
        entryId,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
        model: snapshot.model,
        provider: snapshot.providerName,
      }
    }
  }

  private snapshotForModelTest(
    config: ModelConfig,
    entryId: string,
    forceVision = false,
  ): ProviderSnapshot {
    if (!forceVision)
      return buildProviderSnapshot(config, { modelOverride: entryId })
    const entry = findEntry(config, entryId)
    if (!entry) throw new Error(`model entry not found: ${entryId}`)
    const raw = upsertModelEntryConfig(config.raw, {
      entryId,
      capabilityOverrides: { ...entry.capabilityOverrides, vision: true },
    })
    return buildProviderSnapshot(parseModelConfig(raw), {
      modelOverride: entryId,
    })
  }

  private async afterModelMutation(
    wasUsable: boolean,
  ): Promise<ModelConfigSavePayload> {
    await this.deps.refreshModelConfig?.()
    const payload = await this.getConfig()
    if (
      !wasUsable &&
      payload.availability.usable &&
      !this.profileOnboardingRequested
    ) {
      const profileOnboarding = await this.deps.afterConfigSaved?.()
      if (profileOnboarding) {
        this.profileOnboardingRequested = true
        return { ...payload, profileOnboarding }
      }
    }
    return payload
  }
}

function requiredId(value: string): string {
  const id = value.trim()
  if (!id) throw new Error('entryId required')
  return id
}

function normalizeEntrySecret(input: ModelEntrySaveInput): ModelEntryUpdate {
  const update = structuredClone(input) as ModelEntryUpdate
  if (
    typeof update.apiKey === 'string' &&
    (!update.apiKey.trim() || update.apiKey.trim().startsWith('***'))
  )
    delete update.apiKey
  return update
}

function resolvedProfile(
  entry: ModelEntry | ModelEntryV2,
): ResolvedModelProfile {
  const modelId =
    entry.modelId || ('mainModelId' in entry ? entry.mainModelId : '')
  return resolveModelProfile({
    provider: entry.provider,
    protocol: entry.protocol ?? 'openai',
    modelId,
    capabilityOverrides: entry.capabilityOverrides,
    contextWindowTokens: entry.contextWindowTokens ?? undefined,
    maxTokens: entry.maxTokens ?? undefined,
  })
}

function modelEntryPayload(entry: ModelEntryV2): ModelEntryPayload {
  const { legacy: _legacy, ...safe } = entry
  return {
    ...safe,
    apiKey: maskSecret(entry.apiKey),
    effectiveDisplayName: entry.displayName || entry.modelId,
    resolvedProfile: resolvedProfile(entry),
  }
}

function currentModelPayload(entry: ModelEntry): CurrentModelPayload {
  const profile = resolvedProfile(entry)
  const spec = findByName(entry.provider)
  return {
    entryId: entry.entryId || entry.name,
    provider: entry.provider,
    providerLabel: spec?.displayName ?? entry.provider,
    protocol: entry.protocol ?? spec?.defaultProtocol ?? 'openai',
    modelId: entry.modelId || entry.mainModelId,
    displayName: entry.displayName || entry.label || null,
    effectiveDisplayName:
      entry.displayName || entry.label || entry.modelId || entry.mainModelId,
    apiBase: entry.apiBase || '',
    reasoningEffort: entry.reasoningEffort,
    contextWindowTokens: profile.contextWindowTokens,
    maxTokens: profile.maxTokens,
    capabilities: {
      toolCall: profile.toolCall,
      vision: profile.vision,
      reasoning: profile.reasoning,
    },
    capabilitySources: profile.sources,
    reasoningEfforts: profile.reasoningEfforts,
    reasoningAdapter: profile.reasoningAdapter,
  }
}

function discoveryIdentityMatches(
  entry: ModelEntry | null,
  spec: ProviderSpec,
  protocol: ModelProtocol,
  apiBase: string,
): boolean {
  if (!entry || entry.provider !== spec.name) return false
  const entryProtocol = entry.protocol ?? spec.defaultProtocol
  if (entryProtocol !== protocol) return false
  const entryApiBase = normalizeApiBase(
    protocol,
    entry.apiBase || spec.apiBases[protocol] || '',
  )
  return entryApiBase === apiBase
}

function discoveryApiKey(
  input: unknown,
  entry: ModelEntry | null,
  canReuseEntryCredentials: boolean,
): string {
  if (input === null) return ''
  const direct = trimString(input)
  const existing = trimString(entry?.apiKey)
  if (!direct || direct.startsWith('***'))
    return canReuseEntryCredentials ? existing : ''
  return direct
}

function discoveryExtraHeaders(
  input: unknown,
  entry: ModelEntry | null,
  canReuseEntryCredentials: boolean,
): Record<string, string> {
  const resolved =
    recordValue(input) ||
    (input !== null && canReuseEntryCredentials
      ? recordValue(entry?.legacy?.extraHeaders)
      : null) ||
    {}
  return Object.fromEntries(
    Object.entries(resolved)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  )
}

async function discoverOpenAiCompatibleModels(
  spec: ProviderSpec,
  protocol: ModelProtocol,
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
          protocol,
          apiBase,
          codeForHttpStatus(response.status),
          response.statusText || `HTTP ${response.status}`,
        )
        continue
      }
      return {
        ok: true,
        provider: spec.name,
        protocol,
        apiBase,
        source: 'openai_compat',
        models: parseDiscoveredModels(await response.json()),
      }
    } catch (error) {
      last = discoveryUnavailable(
        spec,
        protocol,
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
      protocol,
      apiBase,
      'no_endpoint',
      '未找到可用的模型列表 endpoint。',
    )
  )
}

async function discoverAnthropicModels(
  spec: ProviderSpec,
  protocol: ModelProtocol,
  apiBase: string | null,
  apiKey: string,
  extraHeaders: Record<string, string>,
): Promise<ModelDiscoveryPayload> {
  try {
    const response = await fetchWithTimeout(anthropicModelsUrl(apiBase), {
      method: 'GET',
      headers: discoveryHeaders(extraHeaders, {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      }),
    })
    if (!response.ok)
      return discoveryUnavailable(
        spec,
        protocol,
        apiBase,
        codeForHttpStatus(response.status),
        response.statusText || `HTTP ${response.status}`,
      )
    return {
      ok: true,
      provider: spec.name,
      protocol,
      apiBase,
      source: 'anthropic',
      models: parseDiscoveredModels(await response.json()),
    }
  } catch (error) {
    return discoveryUnavailable(
      spec,
      protocol,
      apiBase,
      codeForFetchError(error),
      fetchErrorMessage(error),
    )
  }
}

function discoveryUnavailable(
  spec: ProviderSpec,
  protocol: ModelProtocol,
  apiBase: string | null,
  code: string,
  message: string,
): ModelDiscoveryPayload {
  return {
    ok: false,
    provider: spec.name,
    protocol,
    apiBase,
    source: spec.modelDiscovery[protocol] ?? 'unsupported',
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
  return base ? [`${base}/models`] : []
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
  return error instanceof Error && error.name === 'AbortError'
    ? 'timeout'
    : 'network_error'
}

function fetchErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError')
    return '获取模型列表超时。'
  return error instanceof Error ? error.message : String(error)
}

function visionProbeMessages(): OpenAiMessage[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is the color of this image? Reply with one word.',
        },
        {
          type: 'image_url',
          image_url: {
            // 1×1 opaque red RGBA PNG. Keep the expected answer aligned with visionOk().
            url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
          },
        },
      ],
    },
  ]
}

function visionOk(sample: string): boolean {
  const normalized = sample
    .trim()
    .toLowerCase()
    .replace(/[.!。！]+$/g, '')
  return normalized === 'red' || normalized === '红' || normalized === '红色'
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function trimApiBase(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
