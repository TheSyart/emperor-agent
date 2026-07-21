import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionManager } from './manager'
import type {
  PermissionSemanticClassifier,
  PermissionSemanticInput,
} from './semantic-classifier'
import { ModelPermissionSemanticClassifier } from './semantic-classifier'

function host(mode = 'smart_auto') {
  return {
    mode,
    createAsk: vi.fn(() => ({})),
  }
}

function stateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-semantic-permission-'))
}

describe('PermissionManager semantic review', () => {
  it('allows an indeterminate smart-auto command only after classifier approval and caches per turn', async () => {
    const classify = vi.fn(
      async (_input: PermissionSemanticInput) => 'allow' as const,
    )
    const classifier: PermissionSemanticClassifier = { classify }
    const manager = new PermissionManager(host(), {
      classifier,
      stateRoot: stateRoot(),
    })

    const first = await manager.assess(
      'run_command',
      { command: 'custom-linter --check .' },
      { sessionId: 's1', turnId: 't1', workspaceRoot: '/workspace' },
    )
    const second = await manager.assess(
      'run_command',
      { command: 'custom-linter --check .' },
      { sessionId: 's1', turnId: 't1', workspaceRoot: '/workspace' },
    )

    expect(first).toMatchObject({
      allowed: true,
      requiresApproval: false,
      rule: 'mode.smart_auto.semantic_classifier_allow',
    })
    expect(second.allowed).toBe(true)
    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ taskIntent: null }),
    )
  })

  it.each(['ask', null] as const)(
    'fails closed to approval when classifier returns %s',
    async (result) => {
      const classifier: PermissionSemanticClassifier = {
        classify: vi.fn(async () => result),
      }
      const manager = new PermissionManager(host(), {
        classifier,
        stateRoot: stateRoot(),
      })
      const decision = await manager.assess(
        'run_command',
        { command: 'unknown-tool token=top-secret' },
        { sessionId: 's1', turnId: 't1' },
      )

      expect(decision).toMatchObject({
        allowed: false,
        requiresApproval: true,
        rule: 'mode.smart_auto.semantic_review',
      })
    },
  )

  it('fails closed when an injected classifier throws', async () => {
    const manager = new PermissionManager(host(), {
      classifier: {
        classify: vi.fn(async () => {
          throw new Error('classifier unavailable')
        }),
      },
      stateRoot: stateRoot(),
    })

    await expect(
      manager.assess('run_command', { command: 'unknown-tool --mutate' }),
    ).resolves.toMatchObject({
      allowed: false,
      requiresApproval: true,
      rule: 'mode.smart_auto.semantic_review',
    })
  })

  it('never invokes the classifier in full-access mode', async () => {
    const classifier: PermissionSemanticClassifier = {
      classify: vi.fn(async () => 'ask' as const),
    }
    const manager = new PermissionManager(host('full_access'), {
      classifier,
      stateRoot: stateRoot(),
    })
    const decision = await manager.assess('run_command', {
      command: 'unknown-tool --mutate',
    })

    expect(decision.allowed).toBe(true)
    expect(classifier.classify).not.toHaveBeenCalled()
  })
})

describe('ModelPermissionSemanticClassifier', () => {
  const input: PermissionSemanticInput = {
    toolName: 'run_command',
    arguments: {
      command: 'custom-tool --token top-secret /Users/alice/project',
    },
    shell: null,
    cwd: '/Users/alice/project',
    workspaceRoot: '/Users/alice/project',
    taskIntent: 'run a local check',
  }

  it('returns null when model routing is unavailable', async () => {
    const classifier = new ModelPermissionSemanticClassifier({
      route: vi.fn(() => {
        throw new Error('no active model')
      }),
    } as never)

    await expect(classifier.classify(input)).resolves.toBeNull()
  })

  it('times out without retrying', async () => {
    const chat = vi.fn(() => new Promise(() => undefined))
    const classifier = new ModelPermissionSemanticClassifier(
      {
        route: vi.fn(() => ({
          snapshot: { provider: { chat }, model: 'classifier-test' },
        })),
      } as never,
      5,
    )

    await expect(classifier.classify(input)).resolves.toBeNull()
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('sends only a bounded redacted payload with tools disabled', async () => {
    const chat = vi.fn(async (_request: unknown) => ({ content: 'allow' }))
    const classifier = new ModelPermissionSemanticClassifier({
      route: vi.fn(() => ({
        snapshot: { provider: { chat }, model: 'classifier-test' },
      })),
    } as never)

    await expect(classifier.classify(input)).resolves.toBe('allow')
    const request = chat.mock.calls[0]![0] as Record<string, unknown>
    expect(request).toMatchObject({
      tools: null,
      temperature: 0,
      maxTokens: 128,
      reasoningEffort: null,
    })
    const serialized = JSON.stringify(request)
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('/Users/alice')
  })

  it('does not send custom headers, env secrets, quoted secrets, or URL credentials', async () => {
    const chat = vi.fn(async (_request: unknown) => ({ content: 'ask' }))
    const classifier = new ModelPermissionSemanticClassifier({
      route: vi.fn(() => ({
        snapshot: { provider: { chat }, model: 'classifier-test' },
      })),
    } as never)
    const secrets = [
      'sk-live-custom-header',
      'env-secret-value',
      'quoted-secret-value',
      'url-password-value',
    ]

    await classifier.classify({
      ...input,
      arguments: {
        command:
          "SECRET_TOKEN=env-secret-value curl -H 'X-Api-Key: sk-live-custom-header' " +
          "--data 'quoted-secret-value' https://user:url-password-value@example.test",
      },
    })

    const serialized = JSON.stringify(chat.mock.calls[0]![0])
    for (const secret of secrets) expect(serialized).not.toContain(secret)
  })
})
