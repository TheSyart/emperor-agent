import { describe, expect, it } from 'vitest'
import type { ConfigCandidate } from '../config/resolver'
import {
  effectiveCodeIntelligenceCapability,
  resolveCodeIntelligenceMode,
  type CodeIntelligenceMode,
} from './capability'

describe('code intelligence capability gate', () => {
  it('is off by default and exposes ConfigResolver provenance', () => {
    const resolved = resolveCodeIntelligenceMode([])

    expect(resolved.value).toEqual({ mode: 'off' })
    expect(resolved.source.kind).toBe('builtin')
    expect(resolved.key.id).toBe('code.intelligence')
  })

  it('lets an untrusted project tighten but never enable a user mode', () => {
    const tightened = resolveCodeIntelligenceMode([
      candidate('user', 'on'),
      candidate('project', 'eval', 'untrusted'),
    ])
    const notEnabled = resolveCodeIntelligenceMode([
      candidate('user', 'off'),
      candidate('project', 'on', 'untrusted'),
    ])

    expect(tightened.value.mode).toBe('eval')
    expect(tightened.source.kind).toBe('project')
    expect(notEnabled.value.mode).toBe('off')
    expect(notEnabled.source.kind).toBe('user')
    expect(notEnabled.trace.at(-1)).toMatchObject({
      status: 'rejected',
      reason: 'untrusted_project_not_tightening',
    })
  })

  it('allows tools only for a passed receipt bound to the running parser revision', () => {
    const requested = resolveCodeIntelligenceMode([candidate('user', 'on')])
    const receipt = {
      passed: true,
      datasetSha256: 'a'.repeat(64),
      parserRevision: 'typescript-5.9-code-graph-v1',
    }

    expect(
      effectiveCodeIntelligenceCapability({
        requested,
        evaluationGate: null,
        parserRevision: receipt.parserRevision,
      }),
    ).toMatchObject({
      requestedMode: 'on',
      effectiveMode: 'eval',
      toolAllowed: false,
      reason: 'gate_missing',
    })
    expect(
      effectiveCodeIntelligenceCapability({
        requested,
        evaluationGate: receipt,
        parserRevision: 'typescript-other',
      }),
    ).toMatchObject({
      effectiveMode: 'eval',
      toolAllowed: false,
      reason: 'parser_mismatch',
    })
    expect(
      effectiveCodeIntelligenceCapability({
        requested,
        evaluationGate: receipt,
        parserRevision: receipt.parserRevision,
      }),
    ).toEqual({
      requestedMode: 'on',
      effectiveMode: 'on',
      toolAllowed: true,
      reason: 'enabled',
      evaluationDatasetSha256: receipt.datasetSha256,
      parserRevision: receipt.parserRevision,
    })
  })

  it('keeps eval shadow-only even with a valid receipt', () => {
    const parserRevision = 'typescript-5.9-code-graph-v1'
    const capability = effectiveCodeIntelligenceCapability({
      requested: resolveCodeIntelligenceMode([candidate('user', 'eval')]),
      evaluationGate: {
        passed: true,
        datasetSha256: 'b'.repeat(64),
        parserRevision,
      },
      parserRevision,
    })

    expect(capability).toMatchObject({
      requestedMode: 'eval',
      effectiveMode: 'eval',
      toolAllowed: false,
      reason: 'evaluation_only',
    })
  })
})

function candidate(
  kind: 'user' | 'project',
  mode: CodeIntelligenceMode,
  trust: 'trusted' | 'untrusted' = 'trusted',
): ConfigCandidate<{ mode: CodeIntelligenceMode }> {
  return {
    source: { kind, id: `${kind}-fixture`, trust },
    value: { mode },
  }
}
