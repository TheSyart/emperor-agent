import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadModelConfig,
  type ModelConfigV2,
  type ModelEntryV2,
} from '../../config/model-config'
import { ModelRouter } from '../../model/router'
import { CoreModelService } from './model-service'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function entry(overrides: Partial<ModelEntryV2> = {}): ModelEntryV2 {
  return {
    entryId: 'entry-openai',
    provider: 'openai',
    protocol: 'openai',
    modelId: 'gpt-5.2',
    displayName: 'Work model',
    apiBase: 'https://api.openai.com/v1',
    apiKey: 'sk-secret-1234',
    contextWindowTokens: 128_000,
    maxTokens: 16_000,
    reasoningEffort: 'high',
    ...overrides,
  }
}

function writeConfig(
  root: string,
  models: ModelEntryV2[],
  activeModelId = models[0]?.entryId ?? null,
): void {
  const config: ModelConfigV2 = { schemaVersion: 2, activeModelId, models }
  writeFileSync(
    join(root, 'model_config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  )
}

async function service(
  root: string,
  overrides: {
    refreshModelConfig?: () => void | Promise<void>
    afterConfigSaved?: () => any
  } = {},
): Promise<CoreModelService> {
  return new CoreModelService(root, {
    router: new ModelRouter(root, await loadModelConfig(root)),
    ...overrides,
  })
}

afterEach(() => vi.restoreAllMocks())

describe('CoreModelService schema v2', () => {
  it('returns only the v2 typed config with redacted models and resolved profiles', async () => {
    const root = tmp('emperor-model-service-v2-')
    writeConfig(root, [
      entry({
        capabilityOverrides: { vision: false },
        legacy: {
          temperature: 0.2,
          extraHeaders: { 'x-legacy': 'keep' },
        },
      }),
    ])

    const payload = await (await service(root)).getConfig()

    expect(payload).toMatchObject({
      schemaVersion: 2,
      activeModelId: 'entry-openai',
      models: [
        {
          entryId: 'entry-openai',
          apiKey: '***1234',
          resolvedProfile: {
            toolCall: true,
            vision: false,
            reasoning: true,
            sources: { vision: 'override' },
            reasoningEfforts: expect.arrayContaining(['high', 'xhigh']),
          },
        },
      ],
      current: {
        entryId: 'entry-openai',
        provider: 'openai',
        protocol: 'openai',
        modelId: 'gpt-5.2',
        displayName: 'Work model',
        reasoningEffort: 'high',
        capabilities: { toolCall: true, vision: false, reasoning: true },
        capabilitySources: { vision: 'override' },
        reasoningEfforts: expect.arrayContaining(['high', 'xhigh']),
      },
      availability: { usable: true },
    })
    expect(payload.providerOptions.some((item) => item.name === 'openai')).toBe(
      true,
    )
    expect(payload).not.toHaveProperty('config')
    expect(payload).not.toHaveProperty('secondary')
    expect(payload).not.toHaveProperty('routing')
    expect(JSON.stringify(payload)).not.toContain('mainModelId')
    expect(JSON.stringify(payload)).not.toContain('secondaryModelId')
    expect(JSON.stringify(payload)).not.toContain('modelRole')
    expect(JSON.stringify(payload)).not.toContain('sk-secret-1234')
  })

  it('supports typed CRUD, preserves secrets and legacy fields, refreshes after each mutation, and onboards only the first usable model', async () => {
    const root = tmp('emperor-model-service-crud-')
    writeConfig(root, [])
    const lifecycle: string[] = []
    const modelService = await service(root, {
      refreshModelConfig: () => {
        lifecycle.push('refresh')
      },
      afterConfigSaved: () => {
        lifecycle.push('onboarding')
        return { started: true, state: { status: 'in_progress' } }
      },
    })

    const first = await modelService.saveEntry(
      entry({
        entryId: undefined as unknown as string,
        legacy: { temperature: 0.3, extraBody: { keep: true } },
      }),
    )
    const firstId = first.activeModelId!
    expect(first.models).toHaveLength(1)
    expect(first.profileOnboarding).toMatchObject({ started: true })
    expect(lifecycle).toEqual(['refresh', 'onboarding'])

    await modelService.saveEntry({
      entryId: firstId,
      modelId: 'gpt-5.3-codex',
      apiKey: '',
    })
    let onDisk = JSON.parse(
      readFileSync(join(root, 'model_config.json'), 'utf8'),
    )
    expect(onDisk.models[0].apiKey).toBe('sk-secret-1234')
    expect(onDisk.models[0].legacy).toEqual({
      temperature: 0.3,
      extraBody: { keep: true },
    })

    await modelService.saveEntry({ entryId: firstId, apiKey: '***1234' })
    onDisk = JSON.parse(readFileSync(join(root, 'model_config.json'), 'utf8'))
    expect(onDisk.models[0].apiKey).toBe('sk-secret-1234')

    await modelService.saveEntry({ entryId: firstId, apiKey: null })
    onDisk = JSON.parse(readFileSync(join(root, 'model_config.json'), 'utf8'))
    expect(onDisk.models[0].apiKey).toBeNull()

    const second = await modelService.saveEntry(
      entry({
        entryId: undefined as unknown as string,
        provider: 'ollama',
        modelId: 'llama3',
        apiBase: 'http://localhost:11434/v1',
        apiKey: null,
        reasoningEffort: null,
      }),
    )
    const secondId = second.models.find(
      (item) => item.modelId === 'llama3',
    )!.entryId
    expect(second.activeModelId).toBe(firstId)
    expect(lifecycle).toEqual([
      'refresh',
      'onboarding',
      'refresh',
      'refresh',
      'refresh',
      'refresh',
    ])

    await modelService.activate(secondId)
    expect((await modelService.getConfig()).activeModelId).toBe(secondId)
    await modelService.deleteEntry(secondId)
    expect((await modelService.getConfig()).activeModelId).toBe(firstId)
    await modelService.deleteEntry(firstId)
    expect(await modelService.getConfig()).toMatchObject({
      activeModelId: null,
      models: [],
      current: null,
      availability: { usable: false },
    })
    expect(lifecycle.filter((item) => item === 'onboarding')).toHaveLength(1)
  })

  it('returns and saves explicit model execution policy without exposing credentials', async () => {
    const root = tmp('emperor-model-service-policy-')
    const priced = {
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 10,
      cacheReadUsdPerMillionTokens: 0.5,
      cacheWriteUsdPerMillionTokens: 3,
    }
    writeConfig(
      root,
      [
        entry({ entryId: 'primary', pricing: priced }),
        entry({ entryId: 'fallback', modelId: 'backup', pricing: priced }),
      ],
      'primary',
    )
    const refresh = vi.fn()
    const modelService = await service(root, { refreshModelConfig: refresh })

    const payload = await modelService.savePolicy({
      fallback: {
        enabled: true,
        entryId: 'fallback',
        triggerOn: ['rate_limit'],
      },
      cost: { maxUsdPerAgentTurn: 0.2 },
    })

    expect(payload.policy).toEqual({
      fallback: {
        enabled: true,
        entryId: 'fallback',
        triggerOn: ['rate_limit'],
      },
      cost: { maxUsdPerAgentTurn: 0.2 },
    })
    expect(payload.models[0]?.pricing).toEqual(priced)
    expect(refresh).toHaveBeenCalledOnce()
    expect(JSON.stringify(payload)).not.toContain('sk-secret-1234')
    expect((await loadModelConfig(root)).raw.policy).toEqual(payload.policy)
  })

  it('validates and persists only supported reasoning efforts', async () => {
    const root = tmp('emperor-model-service-reasoning-')
    writeConfig(root, [entry()])
    const modelService = await service(root)

    await modelService.setReasoningEffort('entry-openai', 'xhigh')
    expect((await loadModelConfig(root)).raw.models[0]?.reasoningEffort).toBe(
      'xhigh',
    )
    await expect(
      modelService.setReasoningEffort('entry-openai', 'max'),
    ).rejects.toThrow('不支持思考强度')
    await modelService.setReasoningEffort('entry-openai', null)
    expect(
      (await loadModelConfig(root)).raw.models[0]?.reasoningEffort,
    ).toBeNull()

    await expect(
      modelService.saveEntry({
        entryId: 'entry-openai',
        modelId: 'unknown-model',
        reasoningEffort: 'high',
      }),
    ).rejects.toThrow('不支持思考强度')
  })

  it('resolves a draft model profile before an entry is saved', async () => {
    const root = tmp('emperor-model-service-profile-preview-')
    writeConfig(root, [])
    const modelService = await service(root)

    expect(
      modelService.resolveProfile({
        provider: 'openai',
        protocol: 'openai',
        modelId: 'gpt-5.2',
        contextWindowTokens: 256_000,
        maxTokens: 32_000,
        capabilityOverrides: { vision: false },
      }),
    ).toMatchObject({
      reasoning: true,
      vision: false,
      sources: { vision: 'override' },
      contextWindowTokens: 256_000,
      maxTokens: 32_000,
      reasoningEfforts: expect.arrayContaining(['high', 'xhigh']),
    })
  })

  it('tests exactly the requested entry without accepting a model role', async () => {
    const root = tmp('emperor-model-service-test-')
    writeConfig(
      root,
      [
        entry({ entryId: 'active', modelId: 'active-model' }),
        entry({ entryId: 'target', modelId: 'target-model' }),
      ],
      'active',
    )
    const modelService = await service(root)
    const chat = vi
      .spyOn(
        (modelService as any).snapshotForModelTest(
          await loadModelConfig(root),
          'target',
        ).provider,
        'chat',
      )
      .mockResolvedValue({
        content: 'pong',
        toolCalls: [],
        finishReason: 'stop',
        usage: { input: 1, output: 1 },
        reasoningContent: null,
        thinkingBlocks: null,
      })
    vi.spyOn(modelService as any, 'snapshotForModelTest').mockReturnValue({
      ...(modelService as any).snapshotForModelTest(
        await loadModelConfig(root),
        'target',
      ),
      provider: { chat },
    })

    await expect(
      modelService.test({ entryId: 'target', kind: 'text' }),
    ).resolves.toMatchObject({
      ok: true,
      entryId: 'target',
      model: 'target-model',
      sample: 'pong',
    })
    expect(
      JSON.stringify(
        await modelService.test({ entryId: 'missing', kind: 'text' }),
      ),
    ).not.toContain('modelRole')
  })

  it('discovers models using the selected protocol and restores an existing masked key', async () => {
    const root = tmp('emperor-model-service-discover-')
    writeConfig(root, [
      entry({
        entryId: 'deepseek',
        provider: 'deepseek',
        protocol: 'anthropic',
        modelId: 'deepseek-chat',
        apiBase: 'https://api.deepseek.com/anthropic',
      }),
    ])
    const calls: Array<{ url: string; headers: Headers }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const result = await (
      await service(root)
    ).discoverModels({
      entryId: 'deepseek',
      provider: 'deepseek',
      protocol: 'anthropic',
      apiKey: '***1234',
    })

    expect(result).toMatchObject({
      ok: true,
      provider: 'deepseek',
      protocol: 'anthropic',
      source: 'anthropic',
      models: [{ id: 'deepseek-chat' }],
    })
    expect(calls[0]?.url).toBe('https://api.deepseek.com/anthropic/v1/models')
    expect(calls[0]?.headers.get('x-api-key')).toBe('sk-secret-1234')
  })

  it('never reuses an entry credential for a changed discovery endpoint or explicit null key', async () => {
    const root = tmp('emperor-model-service-discover-secret-boundary-')
    writeConfig(root, [
      entry({
        entryId: 'deepseek',
        provider: 'deepseek',
        protocol: 'openai',
        modelId: 'deepseek-chat',
        apiBase: 'https://api.deepseek.com/v1',
      }),
    ])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const modelService = await service(root)

    await expect(
      modelService.discoverModels({
        entryId: 'deepseek',
        provider: 'deepseek',
        protocol: 'openai',
        apiBase: 'https://attacker.example/v1',
        apiKey: '***1234',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'credential_required' })

    await expect(
      modelService.discoverModels({
        entryId: 'deepseek',
        provider: 'deepseek',
        protocol: 'openai',
        apiBase: 'https://api.deepseek.com/v1',
        apiKey: null,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'credential_required' })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('requests onboarding when activate or delete first transitions the active model to usable', async () => {
    const invalid = entry({ entryId: 'invalid', apiKey: null })
    const local = entry({
      entryId: 'local',
      provider: 'ollama',
      modelId: 'llama3',
      apiBase: 'http://localhost:11434/v1',
      apiKey: null,
      reasoningEffort: null,
    })

    const activateRoot = tmp('emperor-model-service-activate-onboarding-')
    writeConfig(activateRoot, [invalid, local], 'invalid')
    const activateHook = vi.fn(() => ({
      started: true,
      state: { status: 'in_progress' },
    }))
    const activated = await (
      await service(activateRoot, {
        afterConfigSaved: activateHook,
      })
    ).activate('local')
    expect(activated.profileOnboarding).toMatchObject({ started: true })
    expect(activateHook).toHaveBeenCalledOnce()

    const deleteRoot = tmp('emperor-model-service-delete-onboarding-')
    writeConfig(deleteRoot, [invalid, local], 'invalid')
    const deleteHook = vi.fn(() => ({
      started: true,
      state: { status: 'in_progress' },
    }))
    const deleted = await (
      await service(deleteRoot, {
        afterConfigSaved: deleteHook,
      })
    ).deleteEntry('invalid')
    expect(deleted.profileOnboarding).toMatchObject({ started: true })
    expect(deleteHook).toHaveBeenCalledOnce()
  })

  it('keeps vision tests read-only and rejects descriptive negative answers', async () => {
    const root = tmp('emperor-model-service-vision-readonly-')
    writeConfig(root, [entry({ capabilityOverrides: { vision: false } })])
    const modelService = await service(root)
    const original = readFileSync(join(root, 'model_config.json'), 'utf8')
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: 'The image has no red color.',
        toolCalls: [],
        finishReason: 'stop',
        usage: { input: 1, output: 1 },
        reasoningContent: null,
        thinkingBlocks: null,
      })
      .mockResolvedValueOnce({
        content: 'red',
        toolCalls: [],
        finishReason: 'stop',
        usage: { input: 1, output: 1 },
        reasoningContent: null,
        thinkingBlocks: null,
      })
    vi.spyOn(modelService as any, 'snapshotForModelTest').mockReturnValue({
      model: 'gpt-5.2',
      providerName: 'openai',
      provider: { chat },
    })

    await expect(
      modelService.test({
        entryId: 'entry-openai',
        kind: 'vision',
      }),
    ).resolves.toMatchObject({ ok: false })
    expect(readFileSync(join(root, 'model_config.json'), 'utf8')).toBe(original)

    await expect(
      modelService.test({
        entryId: 'entry-openai',
        kind: 'vision',
      }),
    ).resolves.toMatchObject({ ok: true, sample: 'red' })
    expect(readFileSync(join(root, 'model_config.json'), 'utf8')).toBe(original)
  })

  it('requires an explicit protocol for custom discovery and rejects removed providers', async () => {
    const root = tmp('emperor-model-service-discover-validation-')
    writeConfig(root, [])
    const modelService = await service(root)

    await expect(
      modelService.discoverModels({
        provider: 'custom',
        apiBase: 'https://example.test/v1',
        apiKey: 'key',
      }),
    ).rejects.toThrow('protocol')
    await expect(
      modelService.discoverModels({
        provider: 'azure_openai',
        protocol: 'openai',
        apiBase: 'https://example.test/v1',
        apiKey: 'key',
      }),
    ).rejects.toThrow('provider')
  })
})
