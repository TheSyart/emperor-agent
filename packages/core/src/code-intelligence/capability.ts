import type { CodeIntelligenceMode } from '../config/local-config'
import {
  ConfigResolver,
  defineConfigKey,
  type ConfigCandidate,
  type Resolved,
} from '../config/resolver'

export type { CodeIntelligenceMode } from '../config/local-config'

export interface CodeIntelligenceModeValue {
  mode: CodeIntelligenceMode
}

export interface CodeIntelligenceEvaluationGateReceipt {
  passed: boolean
  datasetSha256: string
  parserRevision: string
}

export interface EffectiveCodeIntelligenceCapability {
  requestedMode: CodeIntelligenceMode
  effectiveMode: CodeIntelligenceMode
  toolAllowed: boolean
  reason:
    | 'config_off'
    | 'evaluation_only'
    | 'gate_missing'
    | 'parser_mismatch'
    | 'enabled'
  evaluationDatasetSha256: string | null
  parserRevision: string
}

export const CODE_INTELLIGENCE_CONFIG_KEY =
  defineConfigKey<CodeIntelligenceModeValue>({
    id: 'code.intelligence',
    builtin: { mode: 'off' },
    merge: (_current, next) => ({ mode: normalizeMode(next.value.mode) }),
    restrictUntrustedProject: (current, next) => ({
      mode: tighterMode(current.mode, normalizeMode(next.value.mode)),
    }),
  })

export function resolveCodeIntelligenceMode(
  candidates: readonly ConfigCandidate<CodeIntelligenceModeValue>[],
): Resolved<CodeIntelligenceModeValue> {
  return new ConfigResolver().resolve(CODE_INTELLIGENCE_CONFIG_KEY, {
    candidates,
  })
}

export function effectiveCodeIntelligenceCapability(input: {
  requested: Resolved<CodeIntelligenceModeValue>
  evaluationGate: CodeIntelligenceEvaluationGateReceipt | null
  parserRevision: string
}): EffectiveCodeIntelligenceCapability {
  const requestedMode = normalizeMode(input.requested.value.mode)
  const parserRevision = String(input.parserRevision ?? '').trim()
  const datasetSha256 = validSha256(input.evaluationGate?.datasetSha256)
  if (requestedMode === 'off')
    return capability(
      'off',
      'off',
      false,
      'config_off',
      datasetSha256,
      parserRevision,
    )
  if (requestedMode === 'eval')
    return capability(
      'eval',
      'eval',
      false,
      'evaluation_only',
      datasetSha256,
      parserRevision,
    )
  if (!input.evaluationGate?.passed || !datasetSha256)
    return capability(
      'on',
      'eval',
      false,
      'gate_missing',
      datasetSha256,
      parserRevision,
    )
  if (
    !parserRevision ||
    String(input.evaluationGate.parserRevision ?? '').trim() !== parserRevision
  )
    return capability(
      'on',
      'eval',
      false,
      'parser_mismatch',
      datasetSha256,
      parserRevision,
    )
  return capability('on', 'on', true, 'enabled', datasetSha256, parserRevision)
}

function capability(
  requestedMode: CodeIntelligenceMode,
  effectiveMode: CodeIntelligenceMode,
  toolAllowed: boolean,
  reason: EffectiveCodeIntelligenceCapability['reason'],
  evaluationDatasetSha256: string | null,
  parserRevision: string,
): EffectiveCodeIntelligenceCapability {
  return {
    requestedMode,
    effectiveMode,
    toolAllowed,
    reason,
    evaluationDatasetSha256,
    parserRevision,
  }
}

function tighterMode(
  current: CodeIntelligenceMode,
  candidate: CodeIntelligenceMode,
): CodeIntelligenceMode {
  const order: CodeIntelligenceMode[] = ['off', 'eval', 'on']
  return order[Math.min(order.indexOf(current), order.indexOf(candidate))]!
}

function normalizeMode(value: unknown): CodeIntelligenceMode {
  return value === 'eval' || value === 'on' ? value : 'off'
}

function validSha256(value: unknown): string | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}
