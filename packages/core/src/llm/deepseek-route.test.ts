// KRN-07: which DeepSeek entries go to the Messages adapter. The official
// host defaults to Messages; custom gateways stay on chat-completions (8);
// an entry can force chat-completions (9).
import { describe, expect, it } from 'vitest'
import {
  compatibilityEntryForTest,
  parseModelConfig,
  upsertModelEntryConfig,
  type ModelConfigV2,
  type ModelEntry,
} from '../config/model-config'
import { routeEffort } from '../harness/subagent/skill-fork'
import {
  isOfficialDeepSeekHost,
  routeFromEntry,
  usesDeepSeekEfforts,
} from './route'
import { imagePricingForRoute } from './token-estimate'

function entry(overrides: Partial<ModelEntry>): ModelEntry {
  return {
    entryId: 'e1',
    provider: 'deepseek',
    protocol: 'openai',
    modelId: 'deepseek-flash',
    apiBase: 'https://api.deepseek.com',
    apiKey: 'sk',
    contextWindowTokens: 1_048_576,
    maxTokens: 393_216,
    reasoningEffort: 'high',
    name: 'deepseek-flash',
    id: 'e1',
    mainModelId: 'deepseek-flash',
    secondaryModelId: 'deepseek-flash',
    label: 'DeepSeek Flash',
    extraHeaders: null,
    extraBody: null,
    temperature: null,
    supportsVision: true,
    ...overrides,
  }
}

describe('isOfficialDeepSeekHost', () => {
  it('accepts api.deepseek.com under any path, and the default (no base)', () => {
    for (const base of [
      'https://api.deepseek.com',
      'https://api.deepseek.com/',
      'https://api.deepseek.com/v1',
      'https://api.deepseek.com/anthropic',
      'https://API.DeepSeek.com/beta',
      null,
    ])
      expect(isOfficialDeepSeekHost(base)).toBe(true)
  })

  it('refuses gateways, look-alikes and other schemes', () => {
    for (const base of [
      'https://llm-gateway.example.com/v1',
      'https://api.deepseek.com.evil.example/v1',
      'https://proxy.deepseek.com/v1',
      'http://api.deepseek.com',
      'not a url',
    ])
      expect(isOfficialDeepSeekHost(base)).toBe(false)
  })
})

describe('DeepSeek routing', () => {
  it.each([
    ['openai', 'https://api.deepseek.com'],
    ['openai', 'https://api.deepseek.com/v1'],
    ['anthropic', 'https://api.deepseek.com/anthropic'],
  ] as const)(
    'sends the official host (%s, %s) over Messages',
    (protocol, apiBase) => {
      const route = routeFromEntry(entry({ protocol, apiBase }))
      expect(route).toMatchObject({
        adapter: 'deepseek-messages',
        protocol: 'anthropic',
        baseURL: 'https://api.deepseek.com/anthropic',
        reasoning: true,
        reasoningEfforts: ['off', 'low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        contextWindow: 1_048_576,
        vision: true,
      })
      expect(usesDeepSeekEfforts(route)).toBe(true)
      expect(imagePricingForRoute(route)).toBe('deepseek')
      expect(routeEffort(route, 'medium')).toBe('high')
    },
  )

  it('keeps a custom gateway on chat-completions (8)', () => {
    const route = routeFromEntry(
      entry({ apiBase: 'https://llm-gateway.example.com/v1/' }),
    )
    expect(route.adapter).toBe('deepseek')
    expect(route.protocol).toBe('openai')
    expect(route.baseURL).toBe('https://llm-gateway.example.com/v1')
    // A gateway speaking Anthropic stays with the generic Anthropic client.
    expect(
      routeFromEntry(
        entry({
          protocol: 'anthropic',
          apiBase: 'https://llm-gateway.example.com/anthropic',
        }),
      ).adapter,
    ).toBe('pi-ai')
    // Only the deepseek provider is upgraded; a custom entry keeps its wire.
    expect(
      routeFromEntry(
        entry({ provider: 'custom', apiBase: 'https://api.deepseek.com' }),
      ).adapter,
    ).toBe('deepseek')
  })

  it("falls back to chat-completions when the entry says transport 'chat-completions' (9)", () => {
    const openai = routeFromEntry(
      entry({
        apiBase: 'https://api.deepseek.com/v1',
        transport: 'chat-completions',
      }),
    )
    expect(openai).toMatchObject({
      adapter: 'deepseek',
      protocol: 'openai',
      baseURL: 'https://api.deepseek.com/v1',
    })
    const anthropic = routeFromEntry(
      entry({
        protocol: 'anthropic',
        apiBase: 'https://api.deepseek.com/anthropic',
        transport: 'chat-completions',
      }),
    )
    expect(anthropic).toMatchObject({
      adapter: 'deepseek',
      protocol: 'openai',
      baseURL: 'https://api.deepseek.com',
    })
  })
})

describe("model_config.json: transport and the protocol 'chat-completions' alias (9)", () => {
  function config(model: Record<string, unknown>): ModelConfigV2 {
    return {
      schemaVersion: 2,
      activeModelId: 'e1',
      models: [
        {
          entryId: 'e1',
          provider: 'deepseek',
          protocol: 'openai',
          modelId: 'deepseek-flash',
          apiBase: 'https://api.deepseek.com',
          apiKey: null,
          contextWindowTokens: 1_048_576,
          maxTokens: 393_216,
          reasoningEffort: 'high',
          ...model,
        } as never,
      ],
    }
  }

  it("reads protocol 'chat-completions' as OpenAI protocol with the chat-completions transport", () => {
    const parsed = parseModelConfig(config({ protocol: 'chat-completions' }))
    const saved = parsed.raw.models[0]!
    expect(saved.protocol).toBe('openai')
    expect(saved.transport).toBe('chat-completions')
    expect(routeFromEntry(parsed.models[0]!).adapter).toBe('deepseek')
  })

  it('keeps transport across saves and clears it with null', () => {
    const forced = upsertModelEntryConfig(config({}), {
      entryId: 'e1',
      transport: 'chat-completions',
    })
    expect(forced.models[0]!.transport).toBe('chat-completions')
    const renamed = upsertModelEntryConfig(forced, {
      entryId: 'e1',
      displayName: 'Flash',
    })
    expect(renamed.models[0]!.transport).toBe('chat-completions')
    expect(
      routeFromEntry(compatibilityEntryForTest(renamed.models[0]!)).adapter,
    ).toBe('deepseek')
    const cleared = upsertModelEntryConfig(renamed, {
      entryId: 'e1',
      transport: null,
    })
    expect(cleared.models[0]).not.toHaveProperty('transport')
    expect(
      routeFromEntry(compatibilityEntryForTest(cleared.models[0]!)).adapter,
    ).toBe('deepseek-messages')
  })

  it('rejects a transport it does not know', () => {
    expect(() => parseModelConfig(config({ transport: 'responses' }))).toThrow(
      /transport/,
    )
  })
})
