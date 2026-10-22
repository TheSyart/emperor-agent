import { resolve } from 'node:path'
import {
  activateModelEntry,
  activeEntry,
  deleteModelEntry,
  discardRejectedModelEntry,
  effectiveDisplayName,
  effectiveMetadata,
  findEntry,
  loadModelConfig,
  maskSecret,
  newEntryId,
  sameConnection,
  parseModelConfig,
  saveModelConfig,
  saveModelEntries,
  saveModelEntry,
  saveModelPolicy,
  updateModelConnection,
  upsertModelEntryConfig,
  withModelConfigLock,
  type ModelConnectionSettings,
  type ModelEntry,
  type ModelEntryDraft,
  type ModelEntryMetadata,
  type ModelEntryUpdate,
  type ModelEntryV2,
  type ModelExecutionPolicy,
  type ModelMetadataField,
  type ModelProtocol,
} from '../../config/model-config'
import {
  lookupModelFacts,
  MODEL_CATALOG_INFO,
} from '../../model/metadata/lookup'
import type { ModelFacts, ModelFactsSource } from '../../model/metadata/types'
import type { PersistenceAdapter } from '../../store/persistence'
import {
  ModelTestLog,
  testFailureKind,
  type ModelTestRecord,
} from './model-test-log'
import {
  modelAvailability,
  type ModelAvailability,
} from '../../model/availability'
import {
  resolveModelProfile,
  type ResolvedModelProfile,
} from '../../model/profile'
import { createLlmClient } from '../../llm'
import type { LlmClient } from '../../llm/client'
import type { ImageResolver } from '../../llm/content'
import { createUserMessage } from '../../llm/message'
import { routeFromEntry } from '../../llm/route'
import type { ContentBlock } from '../../llm/types'
import {
  findByName,
  normalizeApiBase,
  providerOptions,
  type ProviderOption,
  type ProviderSpec,
} from '../../llm/catalog'
import type { SecretSealer } from '../../security/secret-sealer'
import {
  ModelDiscovery,
  type ConnectionFix,
  type DiscoveredModel,
  type DiscoveryConnection,
  type DiscoveryErrorCode,
  type ParserId,
  type ProbeResult,
} from '../../model/discovery'

type Dict = Record<string, any>

export interface CoreModelServiceDeps {
  /** Test hook: build the one-shot client used by `test()`. */
  createLlm?: (images: ImageResolver) => LlmClient
  refreshModelConfig?: () => void | Promise<void>
  /** Test hook: model lists and connection checks (transport, cache). */
  discovery?: ModelDiscovery
  /** Seals API keys in `model_config.json` (SEC-06); absent: left as written. */
  sealer?: SecretSealer | null
  /** Test hook: the file IO under model_config.json (counting writes). */
  persistenceAdapter?: PersistenceAdapter
}

/** A batch of one connection's models (MOD-03 `model.saveEntries`). */
export interface ModelEntriesSaveInput {
  connection: ModelConnectionSettings
  entries: ModelEntryDraft[]
  activateEntryId?: string | null
}

/** A rejected entry as Settings shows it: never its raw content. */
export interface RejectedModelEntryPayload {
  /** What `model.discardRejected` takes: the entryId, or `#<index>`. */
  key: string
  index: number
  entryId: string | null
  modelId: string | null
  provider: string | null
  reason: string
}

export interface ModelMetadataChange {
  field: ModelMetadataField
  from: unknown
  to: unknown
}

export interface ModelMetadataDiff {
  entryId: string
  modelId: string
  source: ModelFactsSource
  changes: ModelMetadataChange[]
}

export interface ModelMetadataRefreshInput {
  entryIds?: string[]
  connectionId?: string
  /** Apply the differences (locked fields are never touched). */
  apply?: boolean
}

export interface ModelDefaultsInput {
  provider: string
  protocol: ModelProtocol
  apiBase?: string
  modelId: string
}

export type ModelEntrySaveInput = Omit<
  ModelEntryUpdate,
  'legacy' | 'sampling' | 'metadata'
> & {
  /**
   * New entries only: copy the API key (and legacy extra headers) of this
   * saved entry instead of submitting one. The source must be the same
   * provider, protocol and API base, so a credential never reaches an
   * endpoint it was not saved for.
   */
  credentialsFrom?: string
  /** The editor's temperature (高级); null removes it (MOD-05). */
  sampling?: { temperature?: number | null }
  /** Fields the user set in the editor: metadata refreshes keep them. */
  lockFields?: ModelMetadataField[]
}

export interface ModelEntryReplaceInput {
  entryId: string
  /** The model to use instead, on the same connection. */
  modelId: string
}

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
  /** `***` + the last 4 characters of a saved key, or '' (never the key). */
  apiKey: string
  effectiveDisplayName: string
  resolvedProfile: ResolvedModelProfile
  /** The saved key cannot be opened (local key gone): Settings asks for it again. */
  credentialState?: 'needs_reentry'
  /** Where the entry's facts came from; old entries read as manual, locked. */
  metadata: ModelEntryMetadata
  /**
   * The model's lifecycle: as saved, else what the bundled catalog knows
   * (MOD-05: Settings offers the replacement of a retired model).
   */
  lifecycle?: ModelEntryLifecycle
  /** The last connection test of this entry (model_tests.json). */
  lastTest?: ModelTestRecord
}

export type ModelEntryLifecycle = NonNullable<ModelEntryMetadata['lifecycle']>

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
  /** Entries in the file that do not validate (Settings: 修复 / 删除). */
  rejectedEntries: RejectedModelEntryPayload[]
}

/**
 * What a model write returns: the new config. The first usable model no
 * longer starts the profile interview (UI-S17); the hero offers it.
 */
export type ModelConfigSavePayload = ModelConfigPayload

export type { DiscoveredModel, ProbeResult } from '../../model/discovery'

/**
 * A connection as the add-model form holds it. The draft `apiKey` always
 * wins; a stored key is used only when the draft key is empty or masked
 * (`***…`) and `entryId` / `connectionId` points at a saved entry on the
 * same provider, protocol and API base. `apiKey: null` means no key.
 */
export interface ModelConnectionInput {
  entryId?: string
  /** MOD-03 connection id; matched against entries that carry one. */
  connectionId?: string
  provider?: string
  protocol?: ModelProtocol
  apiBase?: string
  apiKey?: string | null
  extraHeaders?: Record<string, string>
  /** Bailian (百炼) workspace, for its official model catalog. */
  workspaceId?: string
}

export interface ModelDiscoveryInput extends ModelConnectionInput {
  /** Skip the 15-minute cache. */
  refresh?: boolean
}

export interface ModelDiscoveryPayload {
  ok: boolean
  provider: string
  protocol: ModelProtocol
  apiBase: string | null
  /** `catalog`: no list endpoint, the models are catalog recommendations. */
  source: 'vendor_api' | 'catalog' | 'none'
  parser: ParserId | null
  models: DiscoveredModel[]
  truncated: boolean
  totalCount: number
  droppedSecretLikeIds: number
  cached: boolean
  fetchedAt: string | null
  fix?: ConnectionFix
  code?: DiscoveryErrorCode
  message?: string
  status?: number
}

type ResolvedConnection =
  | { ok: true; connection: DiscoveryConnection; spec: ProviderSpec }
  | {
      ok: false
      spec: ProviderSpec
      protocol: ModelProtocol
      apiBase: string
      code: 'CREDENTIAL_REQUIRED' | 'MISSING_API_BASE' | 'NOT_COMPATIBLE'
      message: string
    }

export class CoreModelService {
  readonly root: string
  private readonly deps: CoreModelServiceDeps
  private readonly discovery: ModelDiscovery

  constructor(root: string, deps: CoreModelServiceDeps) {
    this.root = resolve(root)
    this.deps = deps
    this.discovery = deps.discovery ?? new ModelDiscovery()
  }

  private get tests(): ModelTestLog {
    return (this.testLog ??= new ModelTestLog(this.root))
  }

  private testLog: ModelTestLog | undefined

  private get store() {
    return {
      sealer: this.deps.sealer ?? null,
      ...(this.deps.persistenceAdapter
        ? { persistenceAdapter: this.deps.persistenceAdapter }
        : {}),
    }
  }

  async getConfig(): Promise<ModelConfigPayload> {
    const config = await loadModelConfig(this.root, this.store)
    const entry = activeEntry(config) ?? null
    const reentry = new Set(config.credentialsNeedingReentry)
    const tests = await this.tests.all()
    const models = config.raw.models.map((item) =>
      modelEntryPayload(item, reentry.has(item.entryId), tests[item.entryId]),
    )
    return {
      schemaVersion: 2,
      activeModelId: config.activeModelId,
      models,
      policy: structuredClone(config.policy),
      current: entry ? currentModelPayload(entry) : null,
      availability: modelAvailability(config),
      providerOptions: providerOptions(),
      rejectedEntries: config.rejectedEntries.map((item) => ({
        key: item.entryId ?? `#${item.index}`,
        index: item.index,
        entryId: item.entryId,
        modelId: item.modelId,
        provider:
          typeof item.raw.provider === 'string' ? item.raw.provider : null,
        reason: item.reason,
      })),
    }
  }

  /**
   * Save several models of one connection with one write and one config
   * refresh (MOD-03). Every entry is checked first; one bad entry fails
   * the batch and nothing is written.
   */
  async saveEntries(
    input: ModelEntriesSaveInput,
  ): Promise<ModelConfigSavePayload & { savedEntryIds: string[] }> {
    input.entries.forEach((draft, index) => {
      if (!draft.reasoningEffort) return
      const profile = resolveModelProfile({
        provider: input.connection.provider,
        protocol: input.connection.protocol,
        modelId: draft.modelId,
        capabilityOverrides: draft.capabilityOverrides,
        detected: draft.detected,
      })
      if (!profile.reasoningEfforts.includes(draft.reasoningEffort as never))
        throw new Error(
          `第 ${index + 1} 个模型（${draft.modelId}）不支持思考强度 ${draft.reasoningEffort}`,
        )
    })
    const { savedEntryIds } = await saveModelEntries(
      this.root,
      input,
      this.store,
    )
    return { ...(await this.afterModelMutation()), savedEntryIds }
  }

  /**
   * Change the key and/or address of every model on one connection
   * (MOD-03), named by connectionId or by one of its entries.
   */
  async updateConnection(input: {
    connectionId?: string | null
    entryId?: string | null
    apiKey?: string | null
    apiBase?: string | null
  }): Promise<ModelConfigSavePayload & { updated: number }> {
    const { updated } = await updateModelConnection(
      this.root,
      input,
      this.store,
    )
    return { ...(await this.afterModelMutation()), updated }
  }

  /** Drop a rejected entry from the file (Settings › 模型 › 删除). */
  async discardRejected(key: string): Promise<ModelConfigPayload> {
    await discardRejectedModelEntry(this.root, key, this.store)
    await this.deps.refreshModelConfig?.()
    return this.getConfig()
  }

  /**
   * Compare entries with the bundled catalog (MOD-03). Returns the
   * differences; with `apply`, writes them (one write), skipping every
   * field the user locked and recording where the facts came from.
   */
  async refreshMetadata(input: ModelMetadataRefreshInput): Promise<{
    diffs: ModelMetadataDiff[]
    applied: boolean
  }> {
    const run = async () => {
      const config = await loadModelConfig(this.root, this.store)
      const targets = config.raw.models.filter((entry) =>
        input.entryIds?.length
          ? input.entryIds.includes(entry.entryId)
          : input.connectionId
            ? entry.connectionId === input.connectionId
            : false,
      )
      if (!targets.length) throw new Error('没有要刷新的模型')
      const plans = targets.map((entry) => metadataPlan(entry))
      const diffs = plans.map((plan) => plan.diff)
      if (!input.apply) return { diffs, applied: false }
      const updated = new Map(
        plans.map((plan) => [plan.diff.entryId, plan.next]),
      )
      await saveModelConfig(
        this.root,
        {
          ...config.raw,
          models: config.raw.models.map(
            (entry) => updated.get(entry.entryId) ?? entry,
          ),
        },
        this.store,
      )
      return { diffs, applied: true }
    }
    const result = input.apply
      ? await withModelConfigLock(this.root, run)
      : await run()
    if (result.applied) await this.deps.refreshModelConfig?.()
    return result
  }

  /** Catalog defaults for a model typed in by hand (MOD-03). */
  lookupDefaults(input: ModelDefaultsInput): {
    facts: ModelFacts
    source: ModelFactsSource
  } {
    const modelId = trimString(input.modelId)
    if (!modelId) throw new Error('modelId required')
    const facts = lookupModelFacts({
      provider: trimString(input.provider),
      ...(input.apiBase ? { apiBase: input.apiBase } : {}),
      modelId,
    })
    return { facts, source: facts.source }
  }

  /** Tests: every entry's opened API key, in file order. */
  async connectionKeysForTest(): Promise<Array<string | null>> {
    const config = await loadModelConfig(this.root, this.store)
    return config.raw.models.map((entry) => entry.apiKey)
  }

  async saveEntry(input: ModelEntrySaveInput): Promise<ModelConfigSavePayload> {
    const before = await loadModelConfig(this.root, this.store)
    const { credentialsFrom, sampling, lockFields, ...fields } = input
    const update: ModelEntryUpdate = normalizeEntrySecret(fields)
    const existing = update.entryId
      ? before.raw.models.find((entry) => entry.entryId === update.entryId)
      : undefined
    if (sampling !== undefined) {
      const next = { ...existing?.sampling }
      if (sampling.temperature === null) delete next.temperature
      else if (sampling.temperature !== undefined)
        next.temperature = sampling.temperature
      update.sampling = next
    }
    if (lockFields?.length && existing) {
      const metadata = effectiveMetadata(existing)
      update.metadata = {
        ...metadata,
        userLocked: [
          ...new Set([...(metadata.userLocked ?? []), ...lockFields]),
        ],
      }
    }
    if (credentialsFrom)
      inheritCredentials(before.raw.models, update, credentialsFrom)
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
    await saveModelEntry(this.root, update, this.store)
    return this.afterModelMutation()
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
    await deleteModelEntry(this.root, requiredId(entryId), this.store)
    return this.afterModelMutation()
  }

  async activate(entryId: string): Promise<ModelConfigSavePayload> {
    await activateModelEntry(this.root, requiredId(entryId), this.store)
    return this.afterModelMutation()
  }

  async setReasoningEffort(
    entryId: string,
    reasoningEffort: string | null,
  ): Promise<ModelConfigPayload> {
    const config = await loadModelConfig(this.root, this.store)
    const entry = findEntry(config, requiredId(entryId))
    if (!entry) throw new Error(`model entry not found: ${entryId}`)
    const profile = resolvedProfile(entry)
    if (
      reasoningEffort !== null &&
      !profile.reasoningEfforts.includes(reasoningEffort as any)
    )
      throw new Error(`模型 ${entry.modelId} 不支持思考强度 ${reasoningEffort}`)
    await saveModelEntry(
      this.root,
      { entryId: entry.entryId, reasoningEffort },
      this.store,
    )
    await this.deps.refreshModelConfig?.()
    return this.getConfig()
  }

  async savePolicy(policy: ModelExecutionPolicy): Promise<ModelConfigPayload> {
    await saveModelPolicy(this.root, policy, this.store)
    await this.deps.refreshModelConfig?.()
    return this.getConfig()
  }

  /**
   * The connection's models from the vendor's own list (all pages, merged
   * with the bundled catalog), or catalog recommendations when the vendor
   * has no list. Uses the draft connection (see `ModelConnectionInput`).
   */
  async discoverModels(
    input: ModelDiscoveryInput,
  ): Promise<ModelDiscoveryPayload> {
    const resolved = await this.resolveConnection(input)
    if (!resolved.ok)
      return {
        ok: false,
        provider: resolved.spec.name,
        protocol: resolved.protocol,
        apiBase: resolved.apiBase || null,
        source: 'none',
        parser: null,
        models: [],
        truncated: false,
        totalCount: 0,
        droppedSecretLikeIds: 0,
        cached: false,
        fetchedAt: null,
        code: resolved.code,
        message: resolved.message,
      }
    const { connection } = resolved
    const result = await this.discovery.discover(connection, {
      refresh: input.refresh === true,
    })
    const base = {
      provider: connection.provider,
      protocol: connection.protocol,
      apiBase: connection.apiBase,
      parser: result.parser,
    }
    if (!result.ok)
      return {
        ...base,
        ok: false,
        source: 'none',
        models: [],
        truncated: false,
        totalCount: 0,
        droppedSecretLikeIds: 0,
        cached: false,
        fetchedAt: null,
        code: result.code,
        message: result.message,
        ...(result.fix ? { fix: result.fix } : {}),
        ...(result.status !== undefined ? { status: result.status } : {}),
      }
    const { ok: _ok, parser: _parser, ...listed } = result
    return { ...base, ok: true, ...listed }
  }

  /**
   * Check the draft connection with one cheap request (UI-29: the form's
   * values, not the saved entry). Never sends a stored key to an address
   * other than the one it was saved for, and never returns a key.
   */
  async probeConnection(input: ModelConnectionInput): Promise<ProbeResult> {
    const resolved = await this.resolveConnection(input)
    if (!resolved.ok)
      return {
        ok: false,
        code:
          resolved.code === 'CREDENTIAL_REQUIRED'
            ? 'AUTH'
            : resolved.code === 'MISSING_API_BASE'
              ? 'WRONG_BASE'
              : 'NOT_COMPATIBLE',
        message: resolved.message,
      }
    return this.discovery.probe(resolved.connection)
  }

  private async resolveConnection(
    input: ModelConnectionInput,
  ): Promise<ResolvedConnection> {
    const config = await loadModelConfig(this.root, this.store)
    const entry = credentialSource(config, input)
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

    const apiBase = normalizeApiBase(
      protocol,
      trimString(input.apiBase) ||
        entry?.apiBase ||
        spec.apiBases[protocol] ||
        '',
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
    const unavailable = (
      code: 'CREDENTIAL_REQUIRED' | 'MISSING_API_BASE' | 'NOT_COMPATIBLE',
      message: string,
    ): ResolvedConnection => ({
      ok: false,
      spec,
      protocol,
      apiBase,
      code,
      message,
    })

    if ((spec.modelDiscovery[protocol] ?? 'unsupported') === 'unsupported')
      return unavailable(
        'NOT_COMPATIBLE',
        `${spec.displayName} 当前不支持通过 ${protocol} 自动获取模型列表，请手动填写模型 ID。`,
      )
    if (!apiBase)
      return unavailable(
        'MISSING_API_BASE',
        `请先填写 ${spec.displayName} 的 API 地址。`,
      )
    if (!isHttpUrl(apiBase))
      return unavailable(
        'MISSING_API_BASE',
        `API 地址无效：需要 http:// 或 https:// 开头的完整地址。`,
      )
    // Local servers and custom gateways may need no key; everyone else does.
    if (!spec.isLocal && !spec.isOauth && spec.name !== 'custom' && !apiKey)
      return unavailable(
        'CREDENTIAL_REQUIRED',
        `请先填写 ${spec.displayName} 的 API Key。`,
      )

    const workspaceId = trimString(input.workspaceId)
    return {
      ok: true,
      spec,
      connection: {
        provider: spec.name,
        protocol,
        apiBase,
        apiKey,
        ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      },
    }
  }

  async test(body: { entryId?: string; kind?: string }): Promise<Dict> {
    const entryId = trimString(body.entryId)
    const kind = trimString(body.kind || 'text').toLowerCase()
    if (kind !== 'text' && kind !== 'vision')
      return { ok: false, kind, error: "kind must be 'text' or 'vision'" }
    if (!entryId) return { ok: false, kind, error: 'entryId required' }

    const config = await loadModelConfig(this.root, this.store)
    const entry = findEntry(config, entryId)
    if (!entry)
      return { ok: false, kind, error: `model entry not found: ${entryId}` }

    const probeEntry =
      kind === 'vision'
        ? (findEntry(
            parseModelConfig(
              upsertModelEntryConfig(config.raw, {
                entryId,
                capabilityOverrides: {
                  ...entry.capabilityOverrides,
                  vision: true,
                },
              }),
            ),
            entryId,
          ) ?? entry)
        : entry
    let llm: LlmClient
    let model: string
    let provider: string
    try {
      const route = routeFromEntry(probeEntry)
      llm = (this.deps.createLlm ?? ((images) => createLlmClient({ images })))(
        async () => ({
          data: Buffer.from(VISION_PROBE_PNG_BASE64, 'base64'),
          mediaType: 'image/png',
        }),
      )
      llm.setRoutes([route], route.id)
      model = route.modelId
      provider = route.catalogProvider
    } catch (error) {
      return {
        ok: false,
        kind,
        error: `route failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const started = Date.now()
    try {
      const base = llm.defaultCallConfig()
      const response = await llm.complete({
        provider: base.provider,
        model: base.model,
        messages: [
          createUserMessage({
            content:
              kind === 'vision'
                ? visionProbeContent()
                : [{ type: 'text', text: 'Reply with exactly one word: pong' }],
            source: { kind: 'user' },
          }),
        ],
        maxTokens: 64,
        temperature: 0,
        purpose: 'auxiliary',
      })
      const sample = response.text.trim().slice(0, 200)
      const ok = kind === 'vision' ? visionOk(sample) : /pong/i.test(sample)
      await this.rememberTest(config, entryId, kind, ok ? null : 'error')
      return {
        ok,
        kind,
        entryId,
        latencyMs: Date.now() - started,
        model,
        provider,
        sample,
        finishReason: response.finish.kind,
      }
    } catch (error) {
      await this.rememberTest(config, entryId, kind, testFailureKind(error))
      return {
        ok: false,
        kind,
        entryId,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
        model,
        provider,
      }
    }
  }

  /** Keep the outcome for 设置 › 模型's connection status; never fails a test. */
  private async rememberTest(
    config: Awaited<ReturnType<typeof loadModelConfig>>,
    entryId: string,
    kind: string,
    failure: 'auth' | 'error' | null,
  ): Promise<void> {
    try {
      await this.tests.record(
        entryId,
        {
          ok: failure === null,
          kind: kind === 'vision' ? 'vision' : 'text',
          testedAt: new Date().toISOString(),
          ...(failure ? { failure } : {}),
        },
        new Set(config.raw.models.map((entry) => entry.entryId)),
      )
    } catch {
      // The status line falls back to 「未测试」.
    }
  }

  /**
   * Use another model of the same connection instead of `entryId` (MOD-05:
   * a retired model's 「替换为 X」). The replacement takes the old entry's
   * place in the list, the active model and the backup model; what the user
   * set (locked fields, capability overrides, temperature, the key) stays,
   * the rest comes from the catalog for the new model. One write.
   */
  async replaceEntry(
    input: ModelEntryReplaceInput,
  ): Promise<ModelConfigSavePayload & { replacedEntryId: string }> {
    const replacedEntryId = await withModelConfigLock(this.root, async () => {
      const config = await loadModelConfig(this.root, this.store)
      const old = config.raw.models.find(
        (entry) => entry.entryId === requiredId(input.entryId),
      )
      if (!old) throw new Error(`model entry not found: ${input.entryId}`)
      const modelId = trimString(input.modelId)
      if (!modelId) throw new Error('modelId required')
      if (
        config.raw.models.some(
          (entry) =>
            entry !== old &&
            entry.modelId === modelId &&
            sameConnection(entry, old),
        )
      )
        throw new Error(`「${modelId}」已经添加在这个连接下`)
      const next = replacementEntry(old, modelId)
      const raw = config.raw
      const policy = structuredClone(raw.policy)
      if (policy?.fallback.entryId === old.entryId)
        policy.fallback.entryId = next.entryId
      await saveModelConfig(
        this.root,
        {
          ...raw,
          activeModelId:
            raw.activeModelId === old.entryId
              ? next.entryId
              : raw.activeModelId,
          models: raw.models.map((entry) => (entry === old ? next : entry)),
          ...(policy ? { policy } : {}),
        },
        this.store,
      )
      return next.entryId
    })
    return { ...(await this.afterModelMutation()), replacedEntryId }
  }

  private async afterModelMutation(): Promise<ModelConfigSavePayload> {
    await this.deps.refreshModelConfig?.()
    return this.getConfig()
  }
}

function requiredId(value: string): string {
  const id = value.trim()
  if (!id) throw new Error('entryId required')
  return id
}

function inheritCredentials(
  models: readonly ModelEntryV2[],
  update: ModelEntryUpdate,
  sourceId: string,
): void {
  if (update.entryId) throw new Error('credentialsFrom 只能用于新建模型')
  if (update.apiKey !== undefined) return
  const source = models.find((entry) => entry.entryId === sourceId)
  if (!source) throw new Error(`找不到要沿用凭证的模型: ${sourceId}`)
  const spec = findByName(update.provider || source.provider)
  const protocol = (update.protocol ||
    spec?.defaultProtocol ||
    'openai') as ModelProtocol
  const apiBase = normalizeApiBase(
    protocol,
    update.apiBase || spec?.apiBases[protocol] || '',
  )
  if (!spec || !discoveryIdentityMatches(source, spec, protocol, apiBase))
    throw new Error(
      '只能沿用同一供应商、协议和 API 地址的凭证，请重新填写 API Key',
    )
  update.apiKey = source.apiKey
  const extraHeaders = source.legacy?.extraHeaders
  if (extraHeaders) update.legacy = { extraHeaders: { ...extraHeaders } }
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
    detected: entry.detected,
    contextWindowTokens: entry.contextWindowTokens ?? undefined,
    maxTokens: entry.maxTokens ?? undefined,
  })
}

function modelEntryPayload(
  entry: ModelEntryV2,
  needsReentry: boolean,
  lastTest?: ModelTestRecord,
): ModelEntryPayload {
  const { legacy: _legacy, ...safe } = entry
  const lifecycle = entryLifecycle(entry)
  return {
    ...safe,
    apiKey: needsReentry ? '' : maskSecret(entry.apiKey),
    effectiveDisplayName: effectiveDisplayName(entry),
    resolvedProfile: resolvedProfile(entry),
    metadata: effectiveMetadata(entry),
    ...(lifecycle ? { lifecycle } : {}),
    ...(lastTest ? { lastTest } : {}),
    ...(needsReentry ? { credentialState: 'needs_reentry' as const } : {}),
  }
}

/** The saved lifecycle, else the bundled catalog's (retirements land there). */
function entryLifecycle(entry: ModelEntryV2): ModelEntryLifecycle | undefined {
  const saved = entry.metadata?.lifecycle
  if (saved?.status) return { ...saved }
  const facts = lookupModelFacts({
    provider: entry.provider,
    apiBase: entry.apiBase,
    modelId: entry.modelId,
  })
  return facts.lifecycle ? { ...facts.lifecycle } : undefined
}

/** The entry for `modelId` that replaces `old` (see replaceEntry). */
function replacementEntry(old: ModelEntryV2, modelId: string): ModelEntryV2 {
  const facts = lookupModelFacts({
    provider: old.provider,
    apiBase: old.apiBase,
    modelId,
  })
  const metadata = effectiveMetadata(old)
  const locked = new Set(metadata.userLocked ?? [])
  const next: ModelEntryV2 = {
    ...structuredClone(old),
    entryId: newEntryId(),
    modelId,
  }
  if (!locked.has('displayName')) delete next.displayName
  if (!locked.has('contextWindowTokens') && facts.contextWindowTokens)
    next.contextWindowTokens = facts.contextWindowTokens
  const maxTokens = defaultMaxTokens(facts)
  if (!locked.has('maxTokens') && maxTokens) next.maxTokens = maxTokens
  if (facts.maxInputTokens || facts.maxOutputTokens)
    next.limits = stripUndefinedFacts({
      maxInputTokens: facts.maxInputTokens,
      maxOutputTokens: facts.maxOutputTokens,
    })
  else delete next.limits
  if (!locked.has('capabilities'))
    next.detected = stripUndefinedFacts({
      toolCall: facts.capabilities.toolCall,
      vision: facts.capabilities.vision,
      reasoning: facts.capabilities.reasoning,
      reasoningEfforts: facts.reasoning?.efforts,
      defaultReasoningEffort: facts.reasoning?.defaultEffort,
      reasoningControl: facts.reasoning?.control,
      acceptsTemperature: facts.acceptsTemperature,
      modalities: facts.modalities,
      kind: facts.kind,
    })
  if (!locked.has('reasoningEffort')) next.reasoningEffort = null
  if (!locked.has('pricing')) {
    const price = facts.pricingUsdPerMTok
    if (price?.input !== undefined && price.output !== undefined)
      next.pricing = {
        inputUsdPerMillionTokens: price.input,
        outputUsdPerMillionTokens: price.output,
        cacheReadUsdPerMillionTokens: price.cacheRead ?? 0,
        cacheWriteUsdPerMillionTokens: price.cacheWrite ?? 0,
      }
    else delete next.pricing
  }
  if (facts.acceptsTemperature === false && next.sampling)
    delete next.sampling.temperature
  const { lifecycle: _lifecycle, ...rest } = metadata
  next.metadata = {
    ...rest,
    ...(facts.name ? { name: facts.name } : {}),
    source: facts.source,
    catalogKey: facts.key,
    catalogVersion: MODEL_CATALOG_INFO.sha256,
    checkedAt: new Date().toISOString(),
    ...(facts.lifecycle ? { lifecycle: { ...facts.lifecycle } } : {}),
  }
  return next
}

/**
 * What a request asks for by default (T4 §3): min(上限, 32K); a model that
 * always thinks, with ≥128K of output, min(上限, 64K); unknown 8,192.
 */
function defaultMaxTokens(facts: ModelFacts): number | undefined {
  const limit = facts.maxOutputTokens
  if (!limit) return undefined
  const alwaysThinks = facts.reasoning?.control === 'always'
  return Math.min(limit, alwaysThinks && limit >= 128_000 ? 64_000 : 32_000)
}

/** What refreshing one entry from the catalog would change (MOD-03). */
function metadataPlan(entry: ModelEntryV2): {
  diff: ModelMetadataDiff
  next: ModelEntryV2
} {
  const facts = lookupModelFacts({
    provider: entry.provider,
    apiBase: entry.apiBase,
    modelId: entry.modelId,
  })
  const metadata = effectiveMetadata(entry)
  const locked = new Set(metadata.userLocked ?? [])
  const next: ModelEntryV2 = structuredClone(entry)
  const changes: ModelMetadataChange[] = []
  const change = (
    field: ModelMetadataField,
    from: unknown,
    to: unknown,
    write: () => void,
  ) => {
    if (to === undefined || locked.has(field)) return
    if (JSON.stringify(from) === JSON.stringify(to)) return
    changes.push({ field, from, to })
    write()
  }
  change(
    'contextWindowTokens',
    entry.contextWindowTokens,
    facts.contextWindowTokens,
    () => (next.contextWindowTokens = facts.contextWindowTokens!),
  )
  change(
    'maxTokens',
    entry.maxTokens,
    facts.maxOutputTokens,
    () => (next.maxTokens = facts.maxOutputTokens!),
  )
  const price = facts.pricingUsdPerMTok
  if (price?.input !== undefined && price.output !== undefined) {
    const pricing = {
      inputUsdPerMillionTokens: price.input,
      outputUsdPerMillionTokens: price.output,
      cacheReadUsdPerMillionTokens: price.cacheRead ?? 0,
      cacheWriteUsdPerMillionTokens: price.cacheWrite ?? 0,
    }
    change('pricing', entry.pricing, pricing, () => (next.pricing = pricing))
  }
  const detected = {
    ...entry.detected,
    ...stripUndefinedFacts({
      toolCall: facts.capabilities.toolCall,
      vision: facts.capabilities.vision,
      reasoning: facts.capabilities.reasoning,
      acceptsTemperature: facts.acceptsTemperature,
      modalities: facts.modalities,
      kind: facts.kind,
    }),
  }
  change(
    'capabilities',
    entry.detected,
    detected,
    () => (next.detected = detected),
  )
  if (facts.reasoning) {
    const reasoning = {
      reasoningEfforts: facts.reasoning.efforts,
      defaultReasoningEffort: facts.reasoning.defaultEffort,
      reasoningControl: facts.reasoning.control,
    }
    change(
      'reasoningEffort',
      {
        reasoningEfforts: entry.detected?.reasoningEfforts,
        defaultReasoningEffort: entry.detected?.defaultReasoningEffort,
        reasoningControl: entry.detected?.reasoningControl,
      },
      reasoning,
      () =>
        (next.detected = {
          ...next.detected,
          ...stripUndefinedFacts(reasoning),
        }),
    )
  }
  change('displayName', metadata.name, facts.name, () => {
    metadata.name = facts.name
  })
  next.metadata = {
    ...metadata,
    source: facts.source,
    catalogKey: facts.key,
    catalogVersion: MODEL_CATALOG_INFO.sha256,
    checkedAt: new Date().toISOString(),
    ...(facts.lifecycle ? { lifecycle: { ...facts.lifecycle } } : {}),
  }
  return {
    diff: {
      entryId: entry.entryId,
      modelId: entry.modelId,
      source: facts.source,
      changes,
    },
    next,
  }
}

function stripUndefinedFacts<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>
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
  entry: Pick<ModelEntry, 'provider' | 'protocol' | 'apiBase'> | null,
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

// 1×1 opaque red RGBA PNG. Keep the expected answer aligned with visionOk().
const VISION_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

function visionProbeContent(): ContentBlock[] {
  return [
    {
      type: 'text',
      text: 'What is the color of this image? Reply with one word.',
    },
    {
      type: 'image',
      attachment: {
        attachmentId: 'model-test-probe',
        mediaType: 'image/png',
        bytes: Buffer.from(VISION_PROBE_PNG_BASE64, 'base64').length,
      },
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

/**
 * The saved entry whose key a masked draft may reuse: `entryId`, or the
 * first entry carrying `connectionId` (entries gain one in MOD-03; until
 * then a connection id finds nothing and no stored key is used).
 */
function credentialSource(
  config: Awaited<ReturnType<typeof loadModelConfig>>,
  input: ModelConnectionInput,
): ModelEntry | null {
  const entryId = trimString(input.entryId)
  if (entryId) return findEntry(config, entryId) ?? null
  const connectionId = trimString(input.connectionId)
  if (!connectionId) return null
  const raw = config.raw.models.find(
    (item) =>
      (item as unknown as Record<string, unknown>).connectionId ===
      connectionId,
  )
  return raw ? (findEntry(config, raw.entryId) ?? null) : null
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
