const PROVIDER_ICON_ASSETS: Readonly<Record<string, string>> = {
  openai: new URL('../assets/provider-logos/openai.svg', import.meta.url).href,
  anthropic: new URL('../assets/provider-logos/anthropic.svg', import.meta.url)
    .href,
  gemini: new URL('../assets/provider-logos/gemini.svg', import.meta.url).href,
  xai: new URL('../assets/provider-logos/xai.svg', import.meta.url).href,
  mistral: new URL('../assets/provider-logos/mistral.svg', import.meta.url)
    .href,
  openrouter: new URL(
    '../assets/provider-logos/openrouter.svg',
    import.meta.url,
  ).href,
  huggingface: new URL(
    '../assets/provider-logos/huggingface.svg',
    import.meta.url,
  ).href,
  aihubmix: new URL(
    '../assets/provider-logos/aihubmix-color.svg',
    import.meta.url,
  ).href,
  siliconflow: new URL(
    '../assets/provider-logos/siliconflow.svg',
    import.meta.url,
  ).href,
  deepseek: new URL('../assets/provider-logos/deepseek.svg', import.meta.url)
    .href,
  dashscope: new URL('../assets/provider-logos/qwen.svg', import.meta.url).href,
  moonshot: new URL('../assets/provider-logos/kimi.svg', import.meta.url).href,
  zhipu: new URL('../assets/provider-logos/zhipu.svg', import.meta.url).href,
  volcengine: new URL('../assets/provider-logos/doubao.svg', import.meta.url)
    .href,
  volcengine_coding_plan: new URL(
    '../assets/provider-logos/doubao.svg',
    import.meta.url,
  ).href,
  byteplus: new URL('../assets/provider-logos/bytedance.svg', import.meta.url)
    .href,
  minimax: new URL('../assets/provider-logos/minimax.svg', import.meta.url)
    .href,
  stepfun: new URL('../assets/provider-logos/stepfun.svg', import.meta.url)
    .href,
  xiaomi_mimo: new URL(
    '../assets/provider-logos/xiaomimimo.svg',
    import.meta.url,
  ).href,
  longcat: new URL(
    '../assets/provider-logos/longcat-color.svg',
    import.meta.url,
  ).href,
  qianfan: new URL('../assets/provider-logos/baidu.svg', import.meta.url).href,
  ollama: new URL('../assets/provider-logos/ollama.svg', import.meta.url).href,
}

const MONOCHROME_PROVIDER_ICONS = new Set([
  'anthropic',
  'longcat',
  'moonshot',
  'ollama',
  'openai',
  'openrouter',
  'xai',
  'xiaomi_mimo',
])

function normalizeProviderIconId(iconId: string | null | undefined): string {
  return String(iconId ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

export function providerIconAsset(
  iconId: string | null | undefined,
): string | null {
  const normalized = normalizeProviderIconId(iconId)
  return PROVIDER_ICON_ASSETS[normalized] ?? null
}

export function providerIconIsMonochrome(
  iconId: string | null | undefined,
): boolean {
  return MONOCHROME_PROVIDER_ICONS.has(normalizeProviderIconId(iconId))
}

export function providerIconMaskCssUrl(asset: string): string {
  return `url(${JSON.stringify(asset)})`
}

export function providerIconFallback(displayName: string): string {
  return Array.from(displayName.trim())[0]?.toUpperCase() ?? '?'
}
