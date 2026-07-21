/** 单模型路由：所有 use case 共享当前激活条目，路由只记录用途，不再选型或 fallback。 */
import { resolve } from 'node:path'
import {
  activeEntry,
  findEntry,
  type ModelConfig,
  type ModelEntry,
  type ModelFallbackTrigger,
  type ModelPricing,
  resolveProviderName,
} from '../config/model-config'
import { createProvider } from '../providers/factory'
import {
  findByName,
  type ProviderProtocol,
  type ProviderSpec,
} from '../providers/registry'
import { type GenerationSettings, type LLMProvider } from '../providers/base'
import { modelAvailability, type ModelAvailability } from './availability'
import { resolveModelProfile, type ResolvedModelProfile } from './profile'

export type ModelRole = 'main' | 'secondary'

export interface ProviderSnapshot {
  provider: LLMProvider
  providerName: string
  providerLabel: string
  model: string
  apiBase: string | null
  generation: GenerationSettings
  /** Compatibility-optional for synthetic test snapshots; real snapshots always set it. */
  profile?: ResolvedModelProfile
  protocol?: ProviderProtocol
  contextWindowTokens: number
  config: Record<string, unknown>
  supportsVision: boolean
  pricing?: ModelPricing
  /** Compatibility-optional for synthetic test snapshots; real snapshots always set it. */
  modelEntryId?: string
  /** @deprecated CoreApi 迁移期间的只读别名。 */
  entryName: string
  entryLabel: string
  /** @deprecated Historical synthetic fixtures only; real snapshots omit it. */
  modelRole?: ModelRole
  routeReason: string
}

export interface ModelRoute {
  snapshot: ProviderSnapshot
  /** @deprecated Historical synthetic fixtures only; real routes omit it. */
  fallback?: ProviderSnapshot | null
  executionPolicy?: {
    fallback: ProviderSnapshot | null
    triggerOn: ModelFallbackTrigger[]
    maxUsdPerAgentTurn: number | null
  }
  useCase: string
  reason: string
  estimatedTokens: number | null
}

export class ModelRouter {
  readonly root: string
  readonly modelOverride: string | null
  readonly availability: ModelAvailability
  readonly active: ProviderSnapshot
  readonly executionPolicy: ModelRoute['executionPolicy']
  private readonly routeCounts = new Map<string, number>()

  constructor(
    root: string,
    config: ModelConfig,
    modelOverride?: string | null,
  ) {
    this.root = resolve(root)
    // modelOverride 只保留构造签名兼容；全局 activeModelId 是唯一运行时选择。
    this.modelOverride = modelOverride ?? null
    this.availability = modelAvailability(config)
    this.active = buildProviderSnapshot(config)
    this.executionPolicy = buildExecutionPolicy(config)
  }

  route(
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ): ModelRoute {
    void agentType
    const key = String(useCase || 'main_agent')
    this.routeCounts.set(key, (this.routeCounts.get(key) ?? 0) + 1)
    return this.activeRoute(key, task)
  }

  routeForRole(
    useCase: string,
    _role: ModelRole,
    task?: string | null,
  ): ModelRoute {
    return this.route(useCase, null, task)
  }

  private activeRoute(useCase: string, task?: string | null): ModelRoute {
    return {
      snapshot: { ...this.active, routeReason: useCase },
      ...(this.executionPolicy
        ? {
            executionPolicy: {
              ...this.executionPolicy,
              fallback: this.executionPolicy.fallback
                ? {
                    ...this.executionPolicy.fallback,
                    routeReason: `${useCase}:explicit_fallback`,
                  }
                : null,
              triggerOn: [...this.executionPolicy.triggerOn],
            },
          }
        : {}),
      useCase,
      reason: useCase,
      estimatedTokens: task ? roughTokenEstimate(task) : null,
    }
  }

  payload(): Record<string, unknown> {
    return {
      activeModelId: this.active.modelEntryId ?? this.active.entryName,
      activeModel: this.active.model,
      routeCounts: Object.fromEntries(this.routeCounts),
    }
  }
}

export function roughTokenEstimate(text: string): number {
  return Math.max(1, Math.floor((text || '').length / 3))
}

// ── snapshot 装配（对齐 `build_provider_snapshot`）──

export interface SnapshotArgs {
  modelOverride?: string | null
  /** @deprecated 单模型运行时忽略 role。 */
  role?: ModelRole
}

export function buildProviderSnapshot(
  config: ModelConfig,
  args: SnapshotArgs = {},
): ProviderSnapshot {
  const modelOverride = args.modelOverride ?? null
  const entry = resolveActiveEntry(config, modelOverride)
  const spec = findByName(entry.provider) ?? fallbackSpec(entry.provider)
  const modelId = entry.modelId || entry.mainModelId
  const [apiKey, apiBase, extraHeaders, extraBody] = resolveCredentials(
    entry,
    config.providers,
    spec,
  )

  const defaults = config.defaults
  const protocol = snapshotProtocol(entry, spec)
  const resolvedApiBase = snapshotApiBase(apiBase, spec, protocol)
  const profile = resolveModelProfile({
    provider: entry.provider,
    protocol,
    modelId,
    capabilityOverrides: entry.capabilityOverrides,
    contextWindowTokens:
      entry.contextWindowTokens ?? defaults.contextWindowTokens,
    maxTokens: entry.maxTokens ?? defaults.maxTokens,
  })
  const generation: GenerationSettings = {
    maxTokens: profile.maxTokens,
    temperature: entry.temperature ?? defaults.temperature,
    reasoningEffort: entry.reasoningEffort ?? defaults.reasoningEffort,
  }

  const provider = createProvider({
    protocol,
    profile,
    spec,
    apiKey,
    apiBase: resolvedApiBase,
    defaultModel: modelId,
    extraHeaders,
    extraBody,
  })
  provider.generation = generation

  const contextWindowTokens = profile.contextWindowTokens

  return {
    provider,
    providerName: spec.name,
    providerLabel: spec.displayName,
    model: modelId,
    apiBase: resolvedApiBase,
    generation,
    profile,
    protocol,
    contextWindowTokens,
    config: config.raw,
    supportsVision: profile.vision,
    ...(entry.pricing ? { pricing: structuredClone(entry.pricing) } : {}),
    modelEntryId: entry.entryId || entry.name,
    entryName: entry.entryId || entry.name,
    entryLabel:
      entry.displayName ||
      entry.label ||
      entry.modelId ||
      entry.mainModelId ||
      entry.id ||
      entry.name,
    routeReason: 'active_model',
  }
}

function buildExecutionPolicy(
  config: ModelConfig,
): ModelRoute['executionPolicy'] {
  const policy = config.policy
  const hasFallback =
    policy.fallback.enabled && Boolean(policy.fallback.entryId)
  const hasCostCap = policy.cost.maxUsdPerAgentTurn !== null
  if (!hasFallback && !hasCostCap) return undefined
  return {
    fallback:
      hasFallback && policy.fallback.entryId
        ? buildProviderSnapshot(config, {
            modelOverride: policy.fallback.entryId,
          })
        : null,
    triggerOn: [...policy.fallback.triggerOn],
    maxUsdPerAgentTurn: policy.cost.maxUsdPerAgentTurn,
  }
}

function snapshotProtocol(
  entry: ModelEntry,
  spec: ProviderSpec,
): ProviderProtocol {
  const protocol = entry.protocol ?? spec.defaultProtocol
  if (!protocol)
    throw new Error(`Provider ${spec.name} requires an explicit protocol`)
  if (!spec.protocols.includes(protocol))
    throw new Error(
      `Provider ${spec.name} does not support ${protocol} protocol`,
    )
  return protocol
}

function snapshotApiBase(
  explicit: string | null,
  spec: ProviderSpec,
  protocol: ProviderProtocol,
): string {
  const apiBase = explicit || spec.apiBases[protocol]
  if (!apiBase)
    throw new Error(
      `Provider ${spec.name} requires an API base for ${protocol} protocol`,
    )
  return apiBase
}

function resolveActiveEntry(
  config: ModelConfig,
  modelOverride: string | null,
): ModelEntry {
  if (modelOverride) {
    const match = findEntry?.(config, modelOverride) ?? activeEntry(config)
    return match || synthEntryFromLegacy(config, modelOverride)
  }
  if (config.models.length) {
    const a = activeEntry(config)
    if (a) return a
  }
  return synthEntryFromLegacy(config, config.defaults.model ?? '')
}

function synthEntryFromLegacy(
  config: ModelConfig,
  modelId: string,
): ModelEntry {
  if (!modelId) {
    return {
      name: 'default',
      id: 'deepseek-chat',
      mainModelId: 'deepseek-chat',
      provider: 'deepseek',
      secondaryModelId: '',
      apiKey: null,
      apiBase: null,
      extraHeaders: null,
      extraBody: null,
      maxTokens: null,
      temperature: null,
      contextWindowTokens: null,
      reasoningEffort: null,
      label: '',
      supportsVision: false,
    }
  }
  const providerName = resolveProviderName(
    config.defaults.provider,
    modelId,
    config.providers,
  )
  const p = config.providers[providerName] ?? null
  return {
    name: modelId,
    id: modelId,
    mainModelId: modelId,
    provider: providerName,
    secondaryModelId: '',
    apiKey: p?.apiKey ?? null,
    apiBase: p?.apiBase ?? null,
    extraHeaders: p?.extraHeaders ?? null,
    extraBody: p?.extraBody ?? null,
    maxTokens: null,
    temperature: null,
    contextWindowTokens: null,
    reasoningEffort: null,
    label: '',
    supportsVision: false,
  }
}

function fallbackSpec(_providerName: string): ProviderSpec {
  const custom = findByName('custom')
  if (!custom) throw new Error('custom provider missing from registry')
  return custom
}

function resolveCredentials(
  entry: ModelEntry,
  providers: Record<string, any>,
  spec: ProviderSpec,
): [
  string | null,
  string | null,
  Record<string, string> | null,
  Record<string, unknown> | null,
] {
  const p = providers[spec.name] ?? null
  return [
    entry.apiKey || (p?.apiKey ?? null),
    entry.apiBase || (p?.apiBase ?? null),
    entry.extraHeaders || (p?.extraHeaders ?? null),
    entry.extraBody || (p?.extraBody ?? null),
  ]
}
