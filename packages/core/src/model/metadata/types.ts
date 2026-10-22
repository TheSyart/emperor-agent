import type { ModelKind } from './model-id'

export type { ModelKind } from './model-id'

/**
 * How thinking is controlled:
 * - `effort`: a strength from `efforts`, and thinking can be switched off
 *   (a toggle, or a `none` effort);
 * - `always`: thinking cannot be switched off; `efforts` (possibly empty)
 *   are the strengths on offer;
 * - `toggle`: on or off only;
 * - `budget`: a thinking-token budget.
 */
export type ReasoningControl = 'effort' | 'toggle' | 'budget' | 'always'

export type ModelFactsSource =
  'vendor_api' | 'catalog' | 'family_rule' | 'fallback'

export type ModelLifecycleStatus = 'active' | 'deprecated' | 'retired'

/**
 * What is known about one model. Every optional field means "unknown";
 * capabilities are tri-state (`undefined` = unknown, never guessed).
 */
export interface ModelFacts {
  /** `models.dev:deepseek/deepseek-flash`, `emperor:…`, `family:<rule>` or `fallback`. */
  key: string
  name?: string
  kind: ModelKind
  contextWindowTokens?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  capabilities: { toolCall?: boolean; vision?: boolean; reasoning?: boolean }
  reasoning?: {
    efforts: string[]
    defaultEffort?: string
    control: ReasoningControl
  }
  acceptsTemperature?: boolean
  /** Input modalities (`text`, `image`, `pdf`, `audio`, `video`). */
  modalities?: string[]
  pricingUsdPerMTok?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
  lifecycle?: {
    status: ModelLifecycleStatus
    retiresAt?: string
    replacement?: string
  }
  source: ModelFactsSource
}

/** Fields an override or a family rule may set. */
export type ModelFactsPatch = Partial<
  Omit<ModelFacts, 'key' | 'source' | 'capabilities'>
> & {
  capabilities?: ModelFacts['capabilities']
}
