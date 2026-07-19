import { describe, expect, it } from 'vitest'
import {
  ConfigResolver,
  defineConfigKey,
  effectiveConfigSnapshot,
  type ConfigCandidate,
  type ConfigLayerKind,
} from './resolver'

function candidate<T>(
  kind: ConfigLayerKind,
  value: T,
  trust: 'trusted' | 'untrusted' | 'managed' =
    kind === 'managed' ? 'managed' : 'trusted',
): ConfigCandidate<T> {
  return {
    source: { kind, id: `${kind}-fixture`, trust },
    value,
  }
}

describe('ConfigResolver', () => {
  const scalarKey = defineConfigKey({
    id: 'example.scalar',
    builtin: 'builtin',
  })

  it.each(precedenceCases())(
    'resolves explicit layer precedence for $layers',
    ({ layers, expected }) => {
      const resolver = new ConfigResolver()
      const inputs = layers.map((layer) => candidate(layer, layer))
      const forward = resolver.resolve(scalarKey, { candidates: inputs })
      const reversed = resolver.resolve(scalarKey, {
        candidates: [...inputs].reverse(),
      })

      expect(forward.value).toBe(expected)
      expect(forward.source.kind).toBe(expected)
      expect(reversed.value).toBe(expected)
      expect(reversed.trace).toEqual(forward.trace)
    },
  )

  it('rejects an untrusted project replacement instead of relaxing user policy', () => {
    const resolved = new ConfigResolver().resolve(scalarKey, {
      candidates: [
        candidate('user', 'user'),
        candidate('project', 'project', 'untrusted'),
      ],
    })

    expect(resolved.value).toBe('user')
    expect(resolved.source.kind).toBe('user')
    expect(resolved.trace).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({ kind: 'project' }),
        status: 'rejected',
        reason: 'untrusted_project_cannot_replace',
      }),
    )
  })

  it('uses a stable source-id tie break within one layer', () => {
    const first = candidate('user', 'first')
    first.source.id = 'a-user-source'
    const second = candidate('user', 'second')
    second.source.id = 'z-user-source'
    const resolver = new ConfigResolver()

    expect(
      resolver.resolve(scalarKey, { candidates: [first, second] }).value,
    ).toBe('first')
    expect(
      resolver.resolve(scalarKey, { candidates: [second, first] }).value,
    ).toBe('first')
  })

  it('lets an untrusted project tighten a security lattice but never relax it', () => {
    type SandboxPolicy = {
      filesystem: 'read-only' | 'workspace-write'
      network: 'deny' | 'policy'
      process: 'deny' | 'policy'
    }
    const restrictSandbox = (
      current: Readonly<SandboxPolicy>,
      next: Readonly<ConfigCandidate<SandboxPolicy>>,
    ): SandboxPolicy => ({
      filesystem:
        current.filesystem === 'read-only' ||
        next.value.filesystem === 'read-only'
          ? 'read-only'
          : 'workspace-write',
      network:
        current.network === 'deny' || next.value.network === 'deny'
          ? 'deny'
          : 'policy',
      process:
        current.process === 'deny' || next.value.process === 'deny'
          ? 'deny'
          : 'policy',
    })
    const sandboxKey = defineConfigKey<SandboxPolicy>({
      id: 'sandbox.agent',
      builtin: {
        filesystem: 'workspace-write',
        network: 'policy',
        process: 'policy',
      },
      merge: restrictSandbox,
      restrictUntrustedProject: restrictSandbox,
    })
    const resolver = new ConfigResolver()

    const tightened = resolver.resolve(sandboxKey, {
      candidates: [
        candidate('user', {
          filesystem: 'workspace-write',
          network: 'policy',
          process: 'policy',
        }),
        candidate(
          'project',
          {
            filesystem: 'read-only',
            network: 'deny',
            process: 'deny',
          },
          'untrusted',
        ),
      ],
    })
    const notRelaxed = resolver.resolve(sandboxKey, {
      candidates: [
        candidate('user', {
          filesystem: 'read-only',
          network: 'deny',
          process: 'deny',
        }),
        candidate(
          'project',
          {
            filesystem: 'workspace-write',
            network: 'policy',
            process: 'policy',
          },
          'untrusted',
        ),
      ],
    })

    expect(tightened.value).toEqual({
      filesystem: 'read-only',
      network: 'deny',
      process: 'deny',
    })
    expect(notRelaxed.value).toEqual(tightened.value)
    expect(notRelaxed.source.kind).toBe('user')
    expect(notRelaxed.trace.at(-1)).toMatchObject({
      source: { kind: 'project', trust: 'untrusted' },
      status: 'rejected',
      reason: 'untrusted_project_not_tightening',
    })
  })

  it('re-applies managed requirements after project and session candidates', () => {
    const requiredKey = defineConfigKey({
      id: 'sandbox.command',
      builtin: { required: false, denied: false },
      merge: (current, next) => ({
        required: current.required || next.value.required,
        denied: current.denied || next.value.denied,
      }),
    })
    const resolved = new ConfigResolver().resolve(requiredKey, {
      candidates: [
        candidate('managed', { required: true, denied: true }),
        candidate('session', { required: false, denied: false }),
        candidate('project', { required: false, denied: false }),
      ],
    })

    expect(resolved.value).toEqual({ required: true, denied: true })
    expect(resolved.source.kind).toBe('managed')
    expect(resolved.trace.at(-1)).toMatchObject({
      source: { kind: 'managed' },
      status: 'applied',
    })
  })

  it('produces a deterministic effective snapshot with secret sources but no values', () => {
    const mcpKey = defineConfigKey({
      id: 'mcp.servers',
      builtin: { servers: {} as Record<string, unknown> },
      secretPaths: ['servers.*.env', 'servers.*.headers'],
      merge: (_current, next) => next.value,
    })
    const apiToken = 'top-secret-token-fixture'
    const resolved = new ConfigResolver().resolve(mcpKey, {
      candidates: [
        candidate('user', {
          servers: {
            docs: {
              command: 'mcp-docs',
              env: { API_TOKEN: apiToken },
              headers: { Authorization: `Bearer ${apiToken}` },
            },
          },
        }),
      ],
    })

    const first = effectiveConfigSnapshot([resolved])
    const second = effectiveConfigSnapshot([resolved])
    const serialized = JSON.stringify(first)

    expect(first).toEqual(second)
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(serialized).not.toContain(apiToken)
    expect(first.entries[0]).toMatchObject({
      key: 'mcp.servers',
      value: {
        servers: {
          docs: {
            command: 'mcp-docs',
            env: '[REDACTED]',
            headers: '[REDACTED]',
          },
        },
      },
      secretSources: [
        {
          path: 'servers.*.env',
          source: { kind: 'user', id: 'user-fixture', trust: 'trusted' },
        },
        {
          path: 'servers.*.headers',
          source: { kind: 'user', id: 'user-fixture', trust: 'trusted' },
        },
      ],
    })
    expect(serialized).not.toContain('Bearer')
  })

  it('attributes inherited secrets to their field layer, not the final non-secret layer', () => {
    const key = defineConfigKey({
      id: 'example.secret-owner',
      builtin: {} as Record<string, unknown>,
      secretPaths: ['credentials.token'],
      merge: (current, next) => ({ ...current, ...next.value }),
    })
    const resolution = new ConfigResolver().resolve(key, {
      candidates: [
        candidate('user', {
          credentials: { token: 'user-token' },
        }),
        candidate('managed', { policy: 'deny' }),
      ],
    })
    const snapshot = effectiveConfigSnapshot([resolution])

    expect(resolution.source.kind).toBe('managed')
    expect(snapshot.entries[0]?.secretSources).toEqual([
      {
        path: 'credentials.token',
        source: { kind: 'user', id: 'user-fixture', trust: 'trusted' },
      },
    ])
    expect(JSON.stringify(snapshot)).not.toContain('user-token')
  })
})

function precedenceCases(): Array<{
  layers: ConfigLayerKind[]
  expected: ConfigLayerKind
}> {
  const optional: ConfigLayerKind[] = [
    'user',
    'project',
    'session',
    'managed',
  ]
  return Array.from({ length: 2 ** optional.length }, (_, mask) => {
    const layers = optional.filter((_, index) => (mask & (1 << index)) !== 0)
    return {
      layers,
      expected: layers.at(-1) ?? 'builtin',
    }
  })
}
