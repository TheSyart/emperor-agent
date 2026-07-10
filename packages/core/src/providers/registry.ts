/**
 * Provider Registry (MIG-PROV-002)。
 *
 * 对齐 Python `agent/providers/registry.py`：ProviderSpec 只描述「访问方式」，不内嵌 model 列表。
 * 字段、默认值与 PROVIDERS 表逐条保真（32 条）。`findByName` 容忍 - / _ 互换。
 */

export type ProviderBackend =
  | 'openai_compat'
  | 'anthropic'
  | 'azure_openai'
  | 'bedrock'
  | 'openai_codex'
  | 'github_copilot'

export type ProviderModelDiscovery =
  'openai_compat' | 'anthropic' | 'unsupported'

export type ProviderRegion =
  'foreign' | 'aggregator' | 'cloud' | 'cn' | 'local' | 'other'

export interface ProviderSpec {
  name: string
  displayName: string
  backend: ProviderBackend
  websiteUrl: string | null
  apiKeyUrl: string | null
  modelDiscovery: ProviderModelDiscovery
  selectable: boolean
  keywords: readonly string[]
  defaultApiBase: string | null
  envKey: string
  envExtras: ReadonlyArray<readonly [string, string]>
  region: ProviderRegion
  isGateway: boolean
  isLocal: boolean
  isOauth: boolean
  isDirect: boolean
  detectByKeyPrefix: string
  detectByBaseKeyword: string
  stripModelPrefix: boolean
  supportsMaxCompletionTokens: boolean
  supportsPromptCaching: boolean
  thinkingStyle: string
  reasoningAsContent: boolean
  modelOverrides: ReadonlyArray<readonly [string, Record<string, unknown>]>
}

export interface ProviderOption {
  name: string
  displayName: string
  backend: ProviderBackend
  websiteUrl: string
  apiKeyUrl: string
  modelDiscovery: ProviderModelDiscovery
  defaultApiBase: string
  region: ProviderRegion
  isGateway: boolean
  isLocal: boolean
  isOauth: boolean
  isDirect: boolean
  thinkingStyle: string | null
}

type SpecInput = Pick<ProviderSpec, 'name' | 'displayName' | 'backend'> &
  Partial<ProviderSpec>

function spec(input: SpecInput): ProviderSpec {
  const out: ProviderSpec = {
    websiteUrl: null,
    apiKeyUrl: null,
    modelDiscovery: 'unsupported',
    selectable: true,
    keywords: [],
    defaultApiBase: null,
    envKey: '',
    envExtras: [],
    region: 'other',
    isGateway: false,
    isLocal: false,
    isOauth: false,
    isDirect: false,
    detectByKeyPrefix: '',
    detectByBaseKeyword: '',
    stripModelPrefix: false,
    supportsMaxCompletionTokens: false,
    supportsPromptCaching: false,
    thinkingStyle: '',
    reasoningAsContent: false,
    modelOverrides: [],
    ...input,
  }
  out.modelDiscovery =
    input.modelDiscovery ?? defaultModelDiscovery(out.backend)
  return out
}

function defaultModelDiscovery(
  backend: ProviderBackend,
): ProviderModelDiscovery {
  if (backend === 'openai_compat') return 'openai_compat'
  if (backend === 'anthropic') return 'anthropic'
  return 'unsupported'
}

export const PROVIDERS: readonly ProviderSpec[] = [
  // ─── 海外大厂 ───
  spec({
    name: 'openai',
    displayName: 'OpenAI',
    backend: 'openai_compat',
    keywords: ['openai', 'gpt', 'o1', 'o3', 'o4'],
    defaultApiBase: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    region: 'foreign',
    supportsMaxCompletionTokens: true,
    websiteUrl: 'https://platform.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  }),
  spec({
    name: 'anthropic',
    displayName: 'Anthropic',
    backend: 'anthropic',
    keywords: ['anthropic', 'claude'],
    envKey: 'ANTHROPIC_API_KEY',
    region: 'foreign',
    supportsPromptCaching: true,
    websiteUrl: 'https://www.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  }),
  spec({
    name: 'gemini',
    displayName: 'Google Gemini',
    backend: 'openai_compat',
    keywords: ['gemini', 'gemma', 'google'],
    defaultApiBase: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    envKey: 'GEMINI_API_KEY',
    region: 'foreign',
    websiteUrl: 'https://ai.google.dev',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
  }),
  spec({
    name: 'xai',
    displayName: 'xAI Grok',
    backend: 'openai_compat',
    keywords: ['xai', 'grok'],
    defaultApiBase: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    region: 'foreign',
    websiteUrl: 'https://x.ai/api',
    apiKeyUrl: 'https://console.x.ai',
  }),
  spec({
    name: 'mistral',
    displayName: 'Mistral AI',
    backend: 'openai_compat',
    keywords: ['mistral', 'codestral'],
    defaultApiBase: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    region: 'foreign',
    websiteUrl: 'https://mistral.ai',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
  }),
  spec({
    name: 'groq',
    displayName: 'Groq',
    backend: 'openai_compat',
    keywords: ['groq'],
    defaultApiBase: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    region: 'foreign',
    websiteUrl: 'https://groq.com',
    apiKeyUrl: 'https://console.groq.com/keys',
  }),
  // ─── 聚合 / 网关 ───
  spec({
    name: 'openrouter',
    displayName: 'OpenRouter',
    backend: 'openai_compat',
    keywords: ['openrouter'],
    defaultApiBase: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    region: 'aggregator',
    isGateway: true,
    detectByKeyPrefix: 'sk-or-',
    detectByBaseKeyword: 'openrouter',
    supportsPromptCaching: true,
    websiteUrl: 'https://openrouter.ai',
    apiKeyUrl: 'https://openrouter.ai/keys',
  }),
  spec({
    name: 'huggingface',
    displayName: 'Hugging Face',
    backend: 'openai_compat',
    keywords: ['huggingface', 'hugging-face'],
    defaultApiBase: 'https://router.huggingface.co/v1',
    envKey: 'HF_TOKEN',
    region: 'aggregator',
    isGateway: true,
    detectByKeyPrefix: 'hf_',
    detectByBaseKeyword: 'huggingface',
    websiteUrl: 'https://huggingface.co',
    apiKeyUrl: 'https://huggingface.co/settings/tokens',
  }),
  spec({
    name: 'aihubmix',
    displayName: 'AiHubMix',
    backend: 'openai_compat',
    keywords: ['aihubmix'],
    defaultApiBase: 'https://aihubmix.com/v1',
    envKey: 'AIHUBMIX_API_KEY',
    region: 'aggregator',
    isGateway: true,
    detectByBaseKeyword: 'aihubmix',
    stripModelPrefix: true,
    websiteUrl: 'https://aihubmix.com',
    apiKeyUrl: 'https://aihubmix.com/token',
  }),
  spec({
    name: 'siliconflow',
    displayName: 'SiliconFlow (硅基流动)',
    backend: 'openai_compat',
    keywords: ['siliconflow'],
    defaultApiBase: 'https://api.siliconflow.cn/v1',
    envKey: 'SILICONFLOW_API_KEY',
    region: 'aggregator',
    isGateway: true,
    detectByBaseKeyword: 'siliconflow',
    websiteUrl: 'https://siliconflow.cn',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
  }),
  // ─── 云厂 ───
  spec({
    name: 'azure_openai',
    displayName: 'Azure OpenAI',
    backend: 'azure_openai',
    keywords: ['azure', 'azure-openai'],
    region: 'cloud',
    isDirect: true,
    websiteUrl: 'https://learn.microsoft.com/azure/ai-services/openai/',
    modelDiscovery: 'unsupported',
  }),
  spec({
    name: 'bedrock',
    displayName: 'AWS Bedrock',
    backend: 'bedrock',
    keywords: [
      'bedrock',
      'anthropic.claude',
      'amazon.nova',
      'meta.',
      'mistral.',
      'cohere.',
      'deepseek.',
      'moonshot.',
    ],
    envKey: 'AWS_BEARER_TOKEN_BEDROCK',
    region: 'cloud',
    isDirect: true,
    websiteUrl: 'https://aws.amazon.com/bedrock/',
    modelDiscovery: 'unsupported',
  }),
  // ─── 国内 ───
  spec({
    name: 'deepseek',
    displayName: 'DeepSeek',
    backend: 'openai_compat',
    keywords: ['deepseek'],
    defaultApiBase: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    region: 'cn',
    thinkingStyle: 'thinking_type',
    websiteUrl: 'https://platform.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  }),
  spec({
    name: 'dashscope',
    displayName: 'Alibaba DashScope (Qwen)',
    backend: 'openai_compat',
    keywords: ['dashscope', 'qwen'],
    defaultApiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    region: 'cn',
    thinkingStyle: 'enable_thinking',
    websiteUrl: 'https://bailian.console.aliyun.com',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key',
  }),
  spec({
    name: 'moonshot',
    displayName: 'Moonshot Kimi',
    backend: 'openai_compat',
    keywords: ['moonshot', 'kimi'],
    defaultApiBase: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    region: 'cn',
    modelOverrides: [
      ['kimi-k2', { temperature: 1.0 }],
      ['kimi-k2.5', { temperature: 1.0 }],
      ['kimi-k2.6', { temperature: 1.0 }],
    ],
    websiteUrl: 'https://platform.moonshot.cn',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  }),
  spec({
    name: 'zhipu',
    displayName: 'Zhipu GLM (智谱)',
    backend: 'openai_compat',
    keywords: ['zhipu', 'glm', 'zai'],
    defaultApiBase: 'https://open.bigmodel.cn/api/paas/v4/',
    envKey: 'ZAI_API_KEY',
    envExtras: [['ZHIPUAI_API_KEY', '{api_key}']],
    region: 'cn',
    websiteUrl: 'https://open.bigmodel.cn',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  }),
  spec({
    name: 'volcengine',
    displayName: 'VolcEngine 火山方舟 (含豆包)',
    backend: 'openai_compat',
    keywords: ['volcengine', 'volces', 'ark', 'doubao'],
    defaultApiBase: 'https://ark.cn-beijing.volces.com/api/v3',
    envKey: 'ARK_API_KEY',
    region: 'cn',
    isGateway: true,
    detectByBaseKeyword: 'volces',
    thinkingStyle: 'thinking_type',
    websiteUrl: 'https://www.volcengine.com/product/ark',
    apiKeyUrl: 'https://console.volcengine.com/ark',
  }),
  spec({
    name: 'volcengine_coding_plan',
    displayName: 'VolcEngine Coding Plan',
    backend: 'openai_compat',
    keywords: ['volcengine-plan'],
    defaultApiBase: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    envKey: 'ARK_API_KEY',
    region: 'cn',
    isGateway: true,
    stripModelPrefix: true,
    thinkingStyle: 'thinking_type',
    websiteUrl: 'https://www.volcengine.com/product/ark',
    apiKeyUrl: 'https://console.volcengine.com/ark',
  }),
  spec({
    name: 'byteplus',
    displayName: 'BytePlus (海外火山)',
    backend: 'openai_compat',
    keywords: ['byteplus'],
    defaultApiBase: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    envKey: 'BYTEPLUS_API_KEY',
    region: 'cn',
    isGateway: true,
    detectByBaseKeyword: 'bytepluses',
    stripModelPrefix: true,
    thinkingStyle: 'thinking_type',
    websiteUrl: 'https://www.byteplus.com/en/product/modelark',
    apiKeyUrl: 'https://console.byteplus.com/ark',
  }),
  spec({
    name: 'minimax',
    displayName: 'MiniMax',
    backend: 'openai_compat',
    keywords: ['minimax'],
    defaultApiBase: 'https://api.minimax.io/v1',
    envKey: 'MINIMAX_API_KEY',
    region: 'cn',
    thinkingStyle: 'reasoning_split',
    websiteUrl: 'https://www.minimaxi.com',
    apiKeyUrl:
      'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  }),
  spec({
    name: 'stepfun',
    displayName: 'Step Fun (阶跃星辰)',
    backend: 'openai_compat',
    keywords: ['stepfun', 'step'],
    defaultApiBase: 'https://api.stepfun.com/v1',
    envKey: 'STEPFUN_API_KEY',
    region: 'cn',
    reasoningAsContent: true,
    websiteUrl: 'https://platform.stepfun.com',
    apiKeyUrl: 'https://platform.stepfun.com/interface-key',
  }),
  spec({
    name: 'xiaomi_mimo',
    displayName: 'Xiaomi MIMO (小米)',
    backend: 'openai_compat',
    keywords: ['xiaomi', 'mimo'],
    defaultApiBase: 'https://api.xiaomimimo.com/v1',
    envKey: 'XIAOMIMIMO_API_KEY',
    region: 'cn',
    websiteUrl: 'https://platform.xiaomimimo.com',
    apiKeyUrl: 'https://platform.xiaomimimo.com/console/api-keys',
  }),
  spec({
    name: 'longcat',
    displayName: 'LongCat (美团)',
    backend: 'openai_compat',
    keywords: ['longcat'],
    defaultApiBase: 'https://api.longcat.chat/openai/v1',
    envKey: 'LONGCAT_API_KEY',
    region: 'cn',
    websiteUrl: 'https://longcat.chat/platform',
    apiKeyUrl: 'https://longcat.chat/platform/api_keys',
  }),
  spec({
    name: 'qianfan',
    displayName: 'Qianfan 千帆 (文心 ERNIE)',
    backend: 'openai_compat',
    keywords: ['qianfan', 'ernie', 'wenxin'],
    defaultApiBase: 'https://qianfan.baidubce.com/v2',
    envKey: 'QIANFAN_API_KEY',
    region: 'cn',
    websiteUrl: 'https://cloud.baidu.com/product/qianfan_modelbuilder',
    apiKeyUrl:
      'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
  }),
  // ─── 本地部署 ───
  spec({
    name: 'ollama',
    displayName: 'Ollama',
    backend: 'openai_compat',
    keywords: ['ollama', 'llama', 'nemotron'],
    defaultApiBase: 'http://localhost:11434/v1',
    envKey: 'OLLAMA_API_KEY',
    region: 'local',
    isLocal: true,
    detectByBaseKeyword: '11434',
    websiteUrl: 'https://ollama.com',
  }),
  spec({
    name: 'lm_studio',
    displayName: 'LM Studio',
    backend: 'openai_compat',
    keywords: ['lm-studio', 'lmstudio', 'lm_studio'],
    defaultApiBase: 'http://localhost:1234/v1',
    envKey: 'LM_STUDIO_API_KEY',
    region: 'local',
    isLocal: true,
    detectByBaseKeyword: '1234',
    websiteUrl: 'https://lmstudio.ai',
  }),
  spec({
    name: 'vllm',
    displayName: 'vLLM',
    backend: 'openai_compat',
    keywords: ['vllm'],
    envKey: 'HOSTED_VLLM_API_KEY',
    region: 'local',
    isLocal: true,
    websiteUrl: 'https://docs.vllm.ai',
  }),
  spec({
    name: 'ovms',
    displayName: 'OpenVINO Model Server',
    backend: 'openai_compat',
    keywords: ['openvino', 'ovms'],
    defaultApiBase: 'http://localhost:8000/v3',
    region: 'local',
    isLocal: true,
    isDirect: true,
    websiteUrl: 'https://docs.openvino.ai',
  }),
  // ─── OAuth-based ───
  spec({
    name: 'openai_codex',
    displayName: 'OpenAI Codex',
    backend: 'openai_codex',
    keywords: ['openai-codex', 'codex'],
    defaultApiBase: 'https://chatgpt.com/backend-api',
    region: 'other',
    isOauth: true,
    detectByBaseKeyword: 'codex',
    stripModelPrefix: true,
    selectable: false,
    modelDiscovery: 'unsupported',
    websiteUrl: 'https://openai.com/chatgpt/pricing',
  }),
  spec({
    name: 'github_copilot',
    displayName: 'GitHub Copilot',
    backend: 'github_copilot',
    keywords: ['github_copilot', 'copilot'],
    defaultApiBase: 'https://api.githubcopilot.com',
    region: 'other',
    isOauth: true,
    stripModelPrefix: true,
    supportsMaxCompletionTokens: true,
    selectable: false,
    modelDiscovery: 'unsupported',
    websiteUrl: 'https://github.com/features/copilot',
  }),
  // ─── 兜底 ───
  spec({
    name: 'custom',
    displayName: 'Custom',
    backend: 'openai_compat',
    keywords: [],
    region: 'other',
    isDirect: true,
  }),
]

/** 按 registry name 精确查找；容忍 - / _ 互换。对齐 `find_by_name`。 */
export function findByName(
  name: string | null | undefined,
): ProviderSpec | undefined {
  if (!name) return undefined
  const normalized = name.replace(/-/g, '_').toLowerCase()
  return PROVIDERS.find((s) => s.name === normalized)
}

/** WebUI ProviderOption 下拉元数据。对齐 `provider_options`。 */
export function providerOptions(): ProviderOption[] {
  return PROVIDERS.filter((s) => s.selectable !== false).map((s) => ({
    name: s.name,
    displayName: s.displayName,
    backend: s.backend,
    websiteUrl: s.websiteUrl ?? '',
    apiKeyUrl: s.apiKeyUrl ?? '',
    modelDiscovery: s.modelDiscovery,
    defaultApiBase: s.defaultApiBase ?? '',
    region: s.region,
    isGateway: s.isGateway,
    isLocal: s.isLocal,
    isOauth: s.isOauth,
    isDirect: s.isDirect,
    thinkingStyle: s.thinkingStyle || null,
  }))
}
