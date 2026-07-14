/**
 * Provider 工厂 (MIG-PROV-006)。
 * 仅按调用方已经解析完成的公开协议创建 provider。
 * snapshot 装配（`build_provider_snapshot`）依赖 model_config + credentials 解析 —— 在 CFG-004 ModelRouter。
 */
import type { LLMProviderConfig } from './base'
import type { ProviderProtocol, ProviderSpec } from './registry'
import { AnthropicProvider } from './anthropic'
import { OpenAICompatProvider } from './openai-compat'

export interface CreateProviderArgs extends LLMProviderConfig {
  protocol: ProviderProtocol
  spec?: ProviderSpec
}

export function createProvider(
  args: CreateProviderArgs,
): AnthropicProvider | OpenAICompatProvider {
  const { protocol, spec, ...common } = args
  const resolved = {
    ...common,
    apiBase: common.apiBase || spec?.apiBases[protocol] || null,
  }
  switch (protocol) {
    case 'anthropic':
      return new AnthropicProvider(resolved)
    case 'openai':
      return new OpenAICompatProvider({ ...resolved, spec })
    default:
      throw new Error(`Unsupported provider protocol: ${String(protocol)}`)
  }
}
