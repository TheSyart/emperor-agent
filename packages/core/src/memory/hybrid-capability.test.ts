import { describe, expect, it } from 'vitest'
import type { ConfigCandidate } from '../config/resolver'
import {
  effectiveHybridMemoryCapability,
  resolveHybridMemoryMode,
  type HybridMemoryMode,
} from './hybrid-capability'

describe('hybrid memory capability gate', () => {
  it('is off by default and exposes ConfigResolver provenance', () => {
    const resolved = resolveHybridMemoryMode([])

    expect(resolved.value).toEqual({ mode: 'off' })
    expect(resolved.source.kind).toBe('builtin')
    expect(resolved.key.id).toBe('memory.hybrid')
  })

  it('lets an untrusted project tighten but never enable a user mode', () => {
    const tightened = resolveHybridMemoryMode([
      candidate('user', 'on'),
      candidate('project', 'off', 'untrusted'),
    ])
    const notEnabled = resolveHybridMemoryMode([
      candidate('user', 'off'),
      candidate('project', 'on', 'untrusted'),
    ])

    expect(tightened.value.mode).toBe('off')
    expect(tightened.source.kind).toBe('project')
    expect(notEnabled.value.mode).toBe('off')
    expect(notEnabled.source.kind).toBe('user')
    expect(notEnabled.trace.at(-1)).toMatchObject({
      status: 'rejected',
      reason: 'untrusted_project_not_tightening',
    })
  })

  it('will not mutate prompts without both a passed eval receipt and a real embedding provider', () => {
    const requested = resolveHybridMemoryMode([candidate('user', 'on')])

    expect(
      effectiveHybridMemoryCapability({
        requested,
        evaluationGate: {
          passed: true,
          datasetSha256: 'a'.repeat(64),
          embeddingProviderId: 'local-fixture',
        },
        embeddingProviderId: null,
      }),
    ).toMatchObject({
      requestedMode: 'on',
      effectiveMode: 'eval',
      promptMutationAllowed: false,
      reason: 'embedding_unavailable',
    })
    expect(
      effectiveHybridMemoryCapability({
        requested,
        evaluationGate: {
          passed: false,
          datasetSha256: 'b'.repeat(64),
          embeddingProviderId: 'local-fixture',
        },
        embeddingProviderId: 'local-fixture',
      }),
    ).toMatchObject({
      effectiveMode: 'eval',
      promptMutationAllowed: false,
      reason: 'evaluation_gate_failed',
    })
    expect(
      effectiveHybridMemoryCapability({
        requested,
        evaluationGate: {
          passed: true,
          datasetSha256: 'c'.repeat(64),
          embeddingProviderId: 'local-fixture',
        },
        embeddingProviderId: 'local-fixture',
      }),
    ).toMatchObject({
      effectiveMode: 'on',
      promptMutationAllowed: true,
      reason: 'enabled',
    })
  })
})

function candidate(
  kind: 'user' | 'project',
  mode: HybridMemoryMode,
  trust: 'trusted' | 'untrusted' = 'trusted',
): ConfigCandidate<{ mode: HybridMemoryMode }> {
  return {
    source: { kind, id: `${kind}-fixture`, trust },
    value: { mode },
  }
}
