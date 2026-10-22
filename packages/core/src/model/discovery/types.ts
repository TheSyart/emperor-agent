import type {
  ModelFacts,
  ModelFactsSource,
  ModelKind,
  ReasoningControl,
} from '../metadata/lookup'

export type DiscoveryProtocol = 'openai' | 'anthropic'

/** Which list parser serves a connection (see `registry.ts`). */
export type ParserId =
  | 'openai-compatible'
  | 'anthropic'
  | 'gemini-native'
  | 'deepseek'
  | 'kimi'
  | 'xai'
  | 'mistral'
  | 'openrouter'
  | 'groq'
  | 'together'
  | 'siliconflow'
  | 'ollama'
  | 'lmstudio'
  | 'vllm'
  | 'bailian-catalog'
  | 'catalog-only'

/** A connection as the add-model form has it: draft values, key included. */
export interface DiscoveryConnection {
  /** Provider catalog name (`llm/catalog.ts`), `custom` included. */
  provider: string
  protocol: DiscoveryProtocol
  /** Normalised API base (no trailing slash, no `/chat/completions`). */
  apiBase: string
  /** `''` when the connection has no key (local servers). */
  apiKey: string
  extraHeaders?: Readonly<Record<string, string>>
  /** Bailian (百炼) workspace, for the official workspace model catalog. */
  workspaceId?: string
}

/** A corrected connection the UI can offer with one click. */
export interface ConnectionFix {
  apiBase?: string
  provider?: string
}

export type ProbeErrorCode =
  | 'AUTH'
  | 'WRONG_BASE'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'REGION_KEY_MISMATCH'
  | 'NOT_COMPATIBLE'
  | 'UNKNOWN'

/**
 * `model.probeConnection`: one cheap request with the draft connection.
 * `method` says how the key was checked: `list` read the model list,
 * `auth_check` sent a request no model can run (no list endpoint, or a
 * public list) and read only whether the key was accepted.
 */
export type ProbeResult =
  | {
      ok: true
      latencyMs: number
      modelCount?: number
      method: 'list' | 'auth_check'
    }
  | {
      ok: false
      code: ProbeErrorCode
      message: string
      fix?: ConnectionFix
      status?: number
    }

export type DiscoveryErrorCode =
  | ProbeErrorCode
  /** Too many pages, a repeated cursor or an inconsistent total. */
  | 'PAGING_FAILED'
  | 'CREDENTIAL_REQUIRED'
  | 'MISSING_API_BASE'

/** What a vendor's list says about one model; absent = not reported. */
export interface VendorModel {
  id: string
  /** Id to look up in the bundled catalog when it is not `id` (vLLM `root`). */
  lookupId?: string
  name?: string
  ownedBy?: string
  created?: number | string
  kind?: ModelKind
  contextWindowTokens?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  capabilities?: { toolCall?: boolean; vision?: boolean; reasoning?: boolean }
  reasoning?: {
    efforts: string[]
    defaultEffort?: string
    control?: ReasoningControl
  }
  acceptsTemperature?: boolean
  modalities?: string[]
  /** Only from vendors that price in US dollars per token (OpenRouter). */
  pricingUsdPerMTok?: ModelFacts['pricingUsdPerMTok']
  lifecycle?: ModelFacts['lifecycle']
}

export type DiscoveredFactField =
  | 'name'
  | 'kind'
  | 'contextWindowTokens'
  | 'maxInputTokens'
  | 'maxOutputTokens'
  | 'toolCall'
  | 'vision'
  | 'reasoning'
  | 'reasoningEfforts'
  | 'acceptsTemperature'
  | 'modalities'
  | 'pricing'
  | 'lifecycle'

/**
 * One listed model: the vendor's facts merged over the bundled catalog's.
 * `source` is `vendor_api` when the vendor reported any limit, capability
 * or thinking option, otherwise the catalog's own source; `fieldSources`
 * says field by field where each value came from.
 */
export interface DiscoveredModel extends Omit<ModelFacts, 'key'> {
  id: string
  ownedBy?: string
  created?: number | string
  family?: string
  releaseDate?: string
  /** The catalog entry the model matched (`models.dev:…`, `family:…`). */
  catalogKey?: string
  fieldSources: Partial<Record<DiscoveredFactField, ModelFactsSource>>
}

export interface DiscoverySuccess {
  ok: true
  parser: ParserId
  /** `catalog`: the vendor has no list endpoint; models are recommendations. */
  source: 'vendor_api' | 'catalog'
  models: DiscoveredModel[]
  truncated: boolean
  /** Models before truncation. */
  totalCount: number
  droppedSecretLikeIds: number
  cached: boolean
  fetchedAt: string
  /** The list was read at a corrected address the UI should offer. */
  fix?: ConnectionFix
  /** Why the list came from the catalog, or what the fix is for. */
  message?: string
}

export interface DiscoveryFailure {
  ok: false
  parser: ParserId
  code: DiscoveryErrorCode
  message: string
  fix?: ConnectionFix
  status?: number
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryFailure

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode
  readonly status?: number
  readonly fix?: ConnectionFix
  readonly retryAfterMs?: number

  constructor(
    code: DiscoveryErrorCode,
    message: string,
    detail: {
      status?: number
      fix?: ConnectionFix
      retryAfterMs?: number
    } = {},
  ) {
    super(message)
    this.name = 'DiscoveryError'
    this.code = code
    if (detail.status !== undefined) this.status = detail.status
    if (detail.fix) this.fix = detail.fix
    if (detail.retryAfterMs !== undefined)
      this.retryAfterMs = detail.retryAfterMs
  }

  withMessage(message: string): DiscoveryError {
    return new DiscoveryError(this.code, message, {
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.fix ? { fix: this.fix } : {}),
      ...(this.retryAfterMs !== undefined
        ? { retryAfterMs: this.retryAfterMs }
        : {}),
    })
  }
}
