import type { HybridMemoryMode } from '../config/local-config'
import {
  ConfigResolver,
  defineConfigKey,
  type ConfigCandidate,
  type Resolved,
} from '../config/resolver'

export type { HybridMemoryMode } from '../config/local-config'

export interface HybridMemoryModeValue {
  mode: HybridMemoryMode
}

export interface HybridMemoryEvaluationGateReceipt {
  passed: boolean
  datasetSha256: string
  embeddingProviderId: string
}

export interface EffectiveHybridMemoryCapability {
  requestedMode: HybridMemoryMode
  effectiveMode: HybridMemoryMode
  promptMutationAllowed: boolean
  reason:
    | 'config_off'
    | 'evaluation_only'
    | 'evaluation_gate_failed'
    | 'embedding_unavailable'
    | 'enabled'
  evaluationDatasetSha256: string | null
  embeddingProviderId: string | null
}

export const HYBRID_MEMORY_CONFIG_KEY = defineConfigKey<HybridMemoryModeValue>({
  id: 'memory.hybrid',
  builtin: { mode: 'off' },
  merge: (_current, next) => ({ mode: normalizeMode(next.value.mode) }),
  restrictUntrustedProject: (current, next) => ({
    mode: tighterMode(current.mode, normalizeMode(next.value.mode)),
  }),
})

export function resolveHybridMemoryMode(
  candidates: readonly ConfigCandidate<HybridMemoryModeValue>[],
): Resolved<HybridMemoryModeValue> {
  return new ConfigResolver().resolve(HYBRID_MEMORY_CONFIG_KEY, { candidates })
}

export function effectiveHybridMemoryCapability(input: {
  requested: Resolved<HybridMemoryModeValue>
  evaluationGate: HybridMemoryEvaluationGateReceipt | null
  embeddingProviderId: string | null
}): EffectiveHybridMemoryCapability {
  const requestedMode = normalizeMode(input.requested.value.mode)
  const datasetSha256 = validSha256(input.evaluationGate?.datasetSha256)
  const providerId = nullableString(input.embeddingProviderId)
  if (requestedMode === 'off')
    return capability(
      'off',
      'off',
      false,
      'config_off',
      datasetSha256,
      providerId,
    )
  if (requestedMode === 'eval')
    return capability(
      'eval',
      'eval',
      false,
      'evaluation_only',
      datasetSha256,
      providerId,
    )
  if (!providerId)
    return capability(
      'on',
      'eval',
      false,
      'embedding_unavailable',
      datasetSha256,
      null,
    )
  if (
    !input.evaluationGate?.passed ||
    !datasetSha256 ||
    nullableString(input.evaluationGate.embeddingProviderId) !== providerId
  )
    return capability(
      'on',
      'eval',
      false,
      'evaluation_gate_failed',
      datasetSha256,
      providerId,
    )
  return capability('on', 'on', true, 'enabled', datasetSha256, providerId)
}

function capability(
  requestedMode: HybridMemoryMode,
  effectiveMode: HybridMemoryMode,
  promptMutationAllowed: boolean,
  reason: EffectiveHybridMemoryCapability['reason'],
  evaluationDatasetSha256: string | null,
  embeddingProviderId: string | null,
): EffectiveHybridMemoryCapability {
  return {
    requestedMode,
    effectiveMode,
    promptMutationAllowed,
    reason,
    evaluationDatasetSha256,
    embeddingProviderId,
  }
}

function tighterMode(
  current: HybridMemoryMode,
  candidate: HybridMemoryMode,
): HybridMemoryMode {
  const order: HybridMemoryMode[] = ['off', 'eval', 'on']
  return order[Math.min(order.indexOf(current), order.indexOf(candidate))]!
}

function normalizeMode(value: unknown): HybridMemoryMode {
  return value === 'eval' || value === 'on' ? value : 'off'
}

function validSha256(value: unknown): string | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function nullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim()
  return normalized || null
}
