/**
 * ModelRouter (MIG-CFG-004)。
 * 对齐 Python `agent/model_router.py`：main/secondary 角色路由 + fallback + rough token 估算。
 * `build_provider_snapshot` 的 credential-resolution 链在 Python 侧耦合了 create_provider，
 * TS 侧一样由 ModelRouter 封装：加载 config → 找 spec → resolve credentials → create_provider。
 */
import { resolve } from 'node:path'
import {
  activeEntry,
  findEntry,
  type ModelConfig,
  type ModelEntry,
  resolveProviderName,
} from '../config/model-config'
import { createProvider } from '../providers/factory'
import { findByName, type ProviderSpec } from '../providers/registry'
import { type GenerationSettings, type LLMProvider } from '../providers/base'
import { modelAvailability, type ModelAvailability } from './availability'

export type ModelRole = 'main' | 'secondary'

export interface ProviderSnapshot {
  provider: LLMProvider
  providerName: string
  providerLabel: string
  model: string
  apiBase: string | null
  generation: GenerationSettings
  contextWindowTokens: number
  config: Record<string, unknown>
  supportsVision: boolean
  entryName: string
  entryLabel: string
  modelRole: ModelRole
  routeReason: string
}

export interface ModelRoute {
  snapshot: ProviderSnapshot
  fallback: ProviderSnapshot | null
  useCase: string
  reason: string
  estimatedTokens: number | null
}

const MAIN: ModelRole = 'main'
const SECONDARY: ModelRole = 'secondary'

const LIGHTWEIGHT_AGENT_TYPES = new Set([
  'xiaohuangmen',
  'sili_suitang',
  'dongchang_tanshi',
  'shangbao_dianbu',
])
const WRITING_AGENT_TYPES = new Set(['neiguan_yingzao'])

export class ModelRouter {
  readonly root: string
  readonly modelOverride: string | null
  readonly availability: ModelAvailability
  readonly main: ProviderSnapshot
  readonly secondary: ProviderSnapshot

  constructor(
    root: string,
    config: ModelConfig,
    modelOverride?: string | null,
  ) {
    this.root = resolve(root)
    this.modelOverride = modelOverride ?? null
    this.availability = modelAvailability(config)
    this.main = buildProviderSnapshot(config, {
      modelOverride: this.modelOverride,
      role: MAIN,
    })
    this.secondary = buildProviderSnapshot(config, {
      modelOverride: this.modelOverride,
      role: SECONDARY,
    })
  }

  route(
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ): ModelRoute {
    const key = String(useCase || 'main_agent')
    if (key === 'main_agent') return this.mainRoute('main_agent')
    if (
      [
        'memory_compaction',
        'watchlist_check',
        'session_title',
        'hook_prompt',
        'hook_agent',
      ].includes(key)
    ) {
      return this.secondaryRoute(key, task)
    }
    if (['subagent', 'team'].includes(key)) {
      const normalizedAgent = String(agentType ?? '').trim()
      const estimated = task ? roughTokenEstimate(task) : null
      if (WRITING_AGENT_TYPES.has(normalizedAgent)) {
        return this.mainRoute(
          `${key}:${normalizedAgent}:write_capable`,
          estimated ?? undefined,
        )
      }
      if (LIGHTWEIGHT_AGENT_TYPES.has(normalizedAgent)) {
        return this.secondaryRoute(
          `${key}:${normalizedAgent}:lightweight`,
          task,
        )
      }
      return this.mainRoute(
        `${key}:${normalizedAgent || 'unknown'}:default_main`,
        estimated ?? undefined,
      )
    }
    return this.mainRoute(`${key}:default_main`)
  }

  routeForRole(
    useCase: string,
    role: ModelRole,
    task?: string | null,
  ): ModelRoute {
    const key = String(useCase || 'main_agent')
    const estimated = task ? roughTokenEstimate(task) : null
    if (role === MAIN)
      return this.mainRoute(`${key}:explicit_main`, estimated ?? undefined)
    return this.secondaryRoute(key, task)
  }

  private mainRoute(reason: string, estimatedTokens?: number): ModelRoute {
    return {
      snapshot: { ...this.main, routeReason: reason },
      fallback: null,
      useCase: reason.split(':', 1)[0]!,
      reason,
      estimatedTokens: estimatedTokens ?? null,
    }
  }

  private secondaryRoute(reason: string, task?: string | null): ModelRoute {
    const estimated = task ? roughTokenEstimate(task) : null
    if (this.secondary.modelRole !== SECONDARY) {
      return this.mainRoute(
        `${reason}:secondary_missing`,
        estimated ?? undefined,
      )
    }
    if (
      estimated !== null &&
      estimated > this.secondary.contextWindowTokens * 0.65
    ) {
      return this.mainRoute(
        `${reason}:secondary_context_too_small`,
        estimated ?? undefined,
      )
    }
    const snapshot = { ...this.secondary, routeReason: reason }
    const fallback = { ...this.main, routeReason: `${reason}:fallback_main` }
    return {
      snapshot,
      fallback,
      useCase: reason.split(':', 1)[0]!,
      reason,
      estimatedTokens: estimated,
    }
  }

  payload(): Record<string, unknown> {
    return {
      secondaryEnabled: this.secondary.modelRole === SECONDARY,
      fallbackToMain: true,
      mainEntry: this.main.entryName,
      mainModel: this.main.model,
      secondaryModel:
        this.secondary.model === this.main.model ? null : this.secondary.model,
    }
  }
}

export function roughTokenEstimate(text: string): number {
  return Math.max(1, Math.floor((text || '').length / 3))
}

// ── snapshot 装配（对齐 `build_provider_snapshot`）──

export interface SnapshotArgs {
  modelOverride?: string | null
  role?: ModelRole
}

export function buildProviderSnapshot(
  config: ModelConfig,
  args: SnapshotArgs = {},
): ProviderSnapshot {
  const modelOverride = args.modelOverride ?? null
  const role: ModelRole = args.role ?? MAIN
  const entry = resolveActiveEntry(config, modelOverride)
  const spec = findByName(entry.provider) ?? fallbackSpec(entry.provider)
  const [modelId, selectedRole, routeReason] = entryModelForRole(entry, role)
  const [apiKey, apiBase, extraHeaders, extraBody] = resolveCredentials(
    entry,
    config.providers,
    spec,
  )

  const defaults = config.defaults
  const generation: GenerationSettings = {
    maxTokens: entry.maxTokens ?? defaults.maxTokens,
    temperature: entry.temperature ?? defaults.temperature,
    reasoningEffort: entry.reasoningEffort ?? defaults.reasoningEffort,
  }

  const provider = createProvider({
    spec,
    apiKey,
    apiBase: apiBase || spec.defaultApiBase,
    defaultModel: modelId,
    extraHeaders,
    extraBody,
  })
  provider.generation = generation

  const contextWindowTokens =
    entry.contextWindowTokens ?? defaults.contextWindowTokens

  return {
    provider,
    providerName: spec.name,
    providerLabel: spec.displayName,
    model: modelId,
    apiBase: apiBase || spec.defaultApiBase,
    generation,
    contextWindowTokens,
    config: config.raw as unknown as Record<string, unknown>,
    supportsVision: selectedRole === 'main' ? entry.supportsVision : false,
    entryName: entry.name,
    entryLabel: entry.label || entry.name,
    modelRole: selectedRole,
    routeReason,
  }
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
      entryId: 'legacy-default',
      name: 'default',
      id: 'deepseek-chat',
      mainModelId: 'deepseek-chat',
      modelId: 'deepseek-chat',
      provider: 'deepseek',
      protocol: 'openai',
      secondaryModelId: '',
      apiKey: null,
      apiBase: 'https://api.deepseek.com',
      extraHeaders: null,
      extraBody: null,
      maxTokens: 8192,
      temperature: null,
      contextWindowTokens: 128000,
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
    entryId: `legacy-${modelId}`,
    name: modelId,
    id: modelId,
    mainModelId: modelId,
    modelId,
    provider: providerName,
    protocol: providerName === 'anthropic' ? 'anthropic' : 'openai',
    secondaryModelId: '',
    apiKey: p?.apiKey ?? null,
    apiBase:
      p?.apiBase ??
      (providerName === 'anthropic'
        ? 'https://api.anthropic.com'
        : 'https://api.openai.com/v1'),
    extraHeaders: p?.extraHeaders ?? null,
    extraBody: p?.extraBody ?? null,
    maxTokens: config.defaults.maxTokens,
    temperature: null,
    contextWindowTokens: config.defaults.contextWindowTokens,
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

function entryModelForRole(
  entry: ModelEntry,
  role: ModelRole,
): [string, ModelRole, string] {
  if (role === 'secondary') {
    if (entry.secondaryModelId)
      return [entry.secondaryModelId, 'secondary', 'secondary_model']
    return [entry.mainModelId, 'main', 'secondary_missing_fallback_main']
  }
  return [entry.mainModelId, 'main', 'main_model']
}
