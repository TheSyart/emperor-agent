// KRN-07: DeepSeek Messages request serialization — effort mapping (4),
// thinking replay across models (7), and the Anthropic message shape.
import { describe, expect, it } from 'vitest'
import type { ModelEntry } from '../../../config/model-config'
import { LlmError } from '../../error'
import {
  createAssistantMessage,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  userText,
  type Message,
} from '../../message'
import { routeFromEntry } from '../../route'
import type { GenerateOptions } from '../../types'
import { messagesRequestDefaults, serializeMessagesRequest } from './serialize'
import { TINY_PNG } from './testing'

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    entryId: 'ds-flash',
    provider: 'deepseek',
    protocol: 'openai',
    modelId: 'deepseek-flash',
    apiBase: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    contextWindowTokens: 1_048_576,
    maxTokens: 32_000,
    reasoningEffort: null,
    name: 'deepseek-flash',
    id: 'ds-flash',
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

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'ds-flash',
    model: 'deepseek-flash',
    messages: [userText('hi')],
    ...overrides,
  }
}

async function bodyOf(
  generate: GenerateOptions,
  configured: string | null = null,
  extra: Parameters<typeof serializeMessagesRequest>[2] = {},
) {
  const route = routeFromEntry(entry({ reasoningEffort: configured }))
  return (
    await serializeMessagesRequest(
      generate,
      messagesRequestDefaults(route),
      extra,
    )
  ).body
}

describe('effort → thinking and output_config.effort (4)', () => {
  it.each([
    ['off', { thinking: { type: 'disabled' } }],
    [
      'low',
      { thinking: { type: 'enabled' }, output_config: { effort: 'low' } },
    ],
    [
      'medium',
      { thinking: { type: 'enabled' }, output_config: { effort: 'high' } },
    ],
    [
      'high',
      { thinking: { type: 'enabled' }, output_config: { effort: 'high' } },
    ],
    [
      'max',
      { thinking: { type: 'enabled' }, output_config: { effort: 'max' } },
    ],
  ] as const)(
    'a model configured %s sends %j',
    async (configured, expected) => {
      const body = await bodyOf(options(), configured)
      expect({
        thinking: body.thinking,
        output_config: body.output_config,
      }).toEqual({ output_config: undefined, ...expected })
    },
  )

  it.each([
    ['off', undefined],
    ['low', 'low'],
    ['medium', 'high'],
    ['high', 'high'],
    ['max', 'max'],
  ] as const)(
    'a request asking for %s overrides the configured effort',
    async (requested, effort) => {
      const body = await bodyOf(options({ reasoningEffort: requested }), 'low')
      expect(body.thinking).toEqual({
        type: effort === undefined ? 'disabled' : 'enabled',
      })
      expect(body.output_config).toEqual(
        effort === undefined ? undefined : { effort },
      )
    },
  )

  it('leaves both fields out when nothing is configured (server default: thinking on, high)', async () => {
    const body = await bodyOf(options())
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('output_config')
  })

  it('sends titles and compaction summaries without thinking', async () => {
    for (const purpose of ['session-title', 'compaction'] as const) {
      const body = await bodyOf(
        options({ purpose, reasoningEffort: 'max' }),
        'max',
      )
      expect(body.thinking).toEqual({ type: 'disabled' })
      expect(body).not.toHaveProperty('output_config')
    }
  })

  it('refuses an effort DeepSeek has no level for', async () => {
    await expect(
      bodyOf(options({ reasoningEffort: 'turbo' })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })
})

describe('thinking across models (7)', () => {
  const ask = userText('q')
  const signed = createAssistantMessage({
    content: [
      { type: 'reasoning', text: 'signed thought' },
      { type: 'text', text: 'answer' },
    ],
    source: {
      provider: 'ds-flash',
      model: 'deepseek-flash',
      replayState: {
        response: {
          kind: 'deepseek-messages',
          version: 1,
          model: 'deepseek-flash',
        },
        blocks: [{ type: 'reasoning', signature: 'sig-1' }, { type: 'text' }],
      },
    },
  })

  it('replays signed thinking to the same model', async () => {
    const body = await bodyOf(
      options({ messages: [ask, signed, userText('more')] }),
    )
    expect(body.messages[1]?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'signed thought',
      signature: 'sig-1',
    })
  })

  it('drops all thinking when another model continues', async () => {
    const body = await bodyOf(
      options({
        model: 'deepseek-v4-pro',
        messages: [ask, signed, userText('more')],
      }),
    )
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    })
  })

  it('reuses a signature recorded by the pi-ai Anthropic route for the same model', async () => {
    const piAi = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'from pi-ai' },
        { type: 'text', text: 'ok' },
      ],
      source: {
        provider: 'ds-flash',
        model: 'deepseek-flash',
        replayState: {
          response: {
            kind: 'pi-ai',
            version: 2,
            api: 'anthropic-messages',
            provider: 'deepseek',
            model: 'deepseek-flash',
            stopReason: 'stop',
          },
          blocks: [
            { type: 'reasoning', thinkingSignature: 'pi-sig' },
            { type: 'text' },
          ],
        },
      },
    })
    const body = await bodyOf(
      options({ messages: [ask, piAi, userText('go')] }),
    )
    expect(body.messages[1]?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'from pi-ai',
      signature: 'pi-sig',
    })
  })

  it('ignores replay state that no longer matches the content (unsigned)', async () => {
    const drifted = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'kept' }],
      source: {
        provider: 'ds-flash',
        model: 'deepseek-flash',
        replayState: {
          response: {
            kind: 'deepseek-messages',
            version: 1,
            model: 'deepseek-flash',
          },
          blocks: [{ type: 'text' }, { type: 'text' }],
        },
      },
    })
    const body = await bodyOf(
      options({ messages: [ask, drifted, userText('x')] }),
    )
    expect(body.messages[1]?.content).toEqual([
      { type: 'thinking', thinking: 'kept' },
    ])
  })

  it('leaves out an assistant turn with nothing left to send, merging the user turns around it', async () => {
    const onlyThinking = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'another model' }],
      source: { provider: 'other', model: 'gpt-5' },
    })
    const body = await bodyOf(
      options({ messages: [ask, onlyThinking, userText('next')] }),
    )
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q' },
          { type: 'text', text: 'next' },
        ],
      },
    ])
  })

  it('can leave unsigned thinking out (the one repair after a signature error)', async () => {
    const unsigned = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'old' },
        { type: 'text', text: 'reply' },
      ],
      source: { provider: 'ds-flash', model: 'deepseek-flash' },
    })
    const { body, hasUnsignedThinking } = await serializeMessagesRequest(
      options({
        messages: [ask, unsigned, userText('y'), signed, userText('z')],
      }),
      messagesRequestDefaults(routeFromEntry(entry())),
      { dropUnsignedThinking: true },
    )
    expect(hasUnsignedThinking).toBe(false)
    expect(body.messages[1]?.content).toEqual([{ type: 'text', text: 'reply' }])
    expect(body.messages[3]?.content[0]).toMatchObject({ signature: 'sig-1' })
  })
})

describe('Anthropic message shape', () => {
  it('folds in-history system text into a user turn and merges adjacent user turns', async () => {
    const system = createMessage({
      role: 'system' as const,
      content: [{ type: 'text' as const, text: 'Plan mode is on.' }],
      source: { kind: 'context' as const, producer: 'plan' },
    })
    const body = await bodyOf(options({ messages: [userText('a'), system] }))
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'Plan mode is on.' },
        ],
      },
    ])
  })

  it('puts tool results first when context follows them in the same user turn', async () => {
    const call = createAssistantMessage({
      content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
      source: { provider: 'ds-flash', model: 'deepseek-flash' },
    })
    const result = createToolResultMessage({
      callId: 'c1',
      content: [],
      isError: false,
    })
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'From this step on, X continues.' }],
      source: { kind: 'context', producer: 'model-switch', form: 'notice' },
    })
    const body = await bodyOf(
      options({ messages: [userText('go'), call, notice, result] }),
    )
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          content: [{ type: 'text', text: '(no output)' }],
        },
        { type: 'text', text: 'From this step on, X continues.' },
      ],
    })
  })

  it('keeps malformed tool-call arguments as an empty input', async () => {
    const call = createAssistantMessage({
      content: [
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":' },
      ],
      source: { provider: 'ds-flash', model: 'deepseek-flash' },
    })
    const body = await bodyOf(options({ messages: [userText('go'), call] }))
    expect(body.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'read', input: {} },
    ])
  })

  it('nests tool-result images inside the tool_result block', async () => {
    const result = createToolResultMessage({
      callId: 'c1',
      content: [
        { type: 'text', text: 'screenshot' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'shot',
            mediaType: 'image/png',
            bytes: TINY_PNG.byteLength,
          },
        },
      ],
      isError: false,
    })
    const call = createAssistantMessage({
      content: [{ type: 'tool-call', id: 'c1', name: 'shot', arguments: '{}' }],
      source: { provider: 'ds-flash', model: 'deepseek-flash' },
    })
    const body = await bodyOf(
      options({ messages: [userText('look'), call, result] }),
      null,
      {
        images: async () => ({ data: TINY_PNG, mediaType: 'image/png' }),
      },
    )
    expect(body.messages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'c1',
        content: [
          { type: 'text', text: 'screenshot' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from(TINY_PNG).toString('base64'),
            },
          },
        ],
      },
    ])
  })

  it('refuses an image in an assistant message', async () => {
    const odd: Message = createAssistantMessage({
      content: [
        {
          type: 'image',
          attachment: { attachmentId: 'x', mediaType: 'image/png', bytes: 1 },
        },
      ],
      source: { provider: 'ds-flash', model: 'deepseek-flash' },
    })
    const error = await bodyOf(
      options({ messages: [userText('a'), odd] }),
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
  })

  it('carries max_tokens, temperature, stop sequences and the legacy extra body', async () => {
    const route = routeFromEntry(
      entry({ extraBody: { metadata: { user_id: 'team-a' } } }),
    )
    const { body } = await serializeMessagesRequest(
      options({ temperature: 0.3, stop: ['</done>'], maxTokens: 1_024 }),
      messagesRequestDefaults(route),
      {},
    )
    expect(body).toMatchObject({
      metadata: { user_id: 'team-a' },
      max_tokens: 1_024,
      temperature: 0.3,
      stop_sequences: ['</done>'],
      stream: true,
    })
    const defaults = await serializeMessagesRequest(
      options(),
      messagesRequestDefaults(route),
      {},
    )
    expect(defaults.body.max_tokens).toBe(32_000)
  })
})
