/**
 * Bedrock provider (MIG-PROV-005)。
 * 对齐 Python `agent/providers/bedrock_provider.py`：system 透传、拒 tools 清晰报错、retries。
 * 当前为最小文本端口；主 agent 回合必带 tools → Bedrock 不承载主回合（fail-fast）。
 */
import { DEFAULT_MAX_RETRIES, LLMProvider, type LLMResponse, type ChatArgs, type OpenAiMessage } from './base'

export class BedrockProvider extends LLMProvider {
  readonly client: any

  constructor(cfg: ConstructorParameters<typeof LLMProvider>[0]) {
    super(cfg)
    try {
      const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime')

      const { StandardRetryStrategy } = require('@aws-sdk/middleware-retry') as any
      // Fall back to a simple client if retry strategy isn't available.
      try {
        this.client = new BedrockRuntimeClient({
          ...(this.apiBase ? { endpoint: this.apiBase } : {}),
          retryStrategy: new StandardRetryStrategy(async () => DEFAULT_MAX_RETRIES + 1, {}),
        })
      } catch {
        this.client = new BedrockRuntimeClient({ ...(this.apiBase ? { endpoint: this.apiBase } : {}) })
      }
    } catch {
      throw new Error('Bedrock provider requires @aws-sdk/client-bedrock-runtime')
    }
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    if (args.tools?.length) {
      throw new Error(
        'Bedrock backend does not support tool calling, which the main agent loop ' +
        'requires; use an Anthropic/OpenAI-compatible provider.',
      )
    }
    const model = args.model || this.defaultModel
    const request = BedrockProvider.converseRequest(model, args.messages, args.maxTokens ?? 4096, args.temperature ?? 0.7)
    const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime')
    const resp = await this.client.send(new ConverseCommand(request), BedrockProvider.sendOptions(args))
    const content: Array<{ text?: string }> = resp.output?.message?.content ?? []
    const text = content.map((b) => b.text ?? '').join('')
    return {
      content: text,
      toolCalls: [],
      finishReason: 'stop',
      usage: { input: resp.usage?.inputTokens ?? 0, output: resp.usage?.outputTokens ?? 0 },
      reasoningContent: null,
      thinkingBlocks: null,
    }
  }

  static sendOptions(args: ChatArgs): { abortSignal: AbortSignal } | undefined {
    return args.signal ? { abortSignal: args.signal } : undefined
  }

  static converseRequest(model: string, messages: OpenAiMessage[], maxTokens: number, temperature: number): Record<string, unknown> {
    const request: Record<string, unknown> = {
      modelId: model,
      messages: BedrockProvider.messages(messages),
      inferenceConfig: { maxTokens, temperature },
    }
    const system = BedrockProvider.systemText(messages)
    if (system) request.system = [{ text: system }]
    return request
  }

  static systemText(messages: OpenAiMessage[]): string {
    return messages
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content ?? ''))
      .filter((p) => p)
      .join('\n\n')
  }

  static messages(messages: OpenAiMessage[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const msg of messages) {
      let role = msg.role
      if (role === 'system') continue
      if (role === 'tool') role = 'user'
      out.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: [{ text: String(msg.content ?? '') }],
      })
    }
    return out.length ? out : [{ role: 'user', content: [{ text: '(empty)' }] }]
  }
}
