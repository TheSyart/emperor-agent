/**
 * Hand-written corrections to the models.dev snapshot.
 *
 * Each entry names the models.dev providers and model id it corrects, the
 * fields it replaces (`capabilities` merges key by key), why, the page that
 * says so and the day it was checked. An entry whose model is missing from
 * the snapshot adds the model (retired ids the catalog dropped); such an
 * entry answers only for its own providers, never for a cross-provider
 * lookup. Overrides apply after matching and win over the snapshot.
 *
 * Remove an entry once models.dev agrees with it: `lookup.test.ts` fails on
 * an override that no longer changes anything.
 */
import type { ModelFactsPatch } from './types'

export interface ModelOverride {
  /** models.dev provider ids. */
  providers: readonly string[]
  modelId: string
  patch: ModelFactsPatch
  note: string
  source: string
  /** YYYY-MM-DD */
  checkedAt: string
}

const DEEPSEEK_MODELS = 'https://api-docs.deepseek.com/api/list-models'
const DEEPSEEK_PRICING = 'https://api-docs.deepseek.com/quick_start/pricing'
const DEEPSEEK_UPDATES = 'https://api-docs.deepseek.com/updates'
const KIMI_MODELS = 'https://platform.kimi.ai/docs/models'
const KIMI_CODING_LIST =
  'https://github.com/TheSyart/model-center/blob/7f3f4a7/docs/vendor-apis/kimi.md'
const MINIMAX_RETIREMENT =
  'https://platform.minimax.io/docs/guides/models-intro'
const MINIMAX_RETIRED = 'https://platform.minimax.io/docs/faq/models'
const MINIMAX_MODELS = 'https://platform.minimax.io/docs/guides/text-generation'
const GEMINI_MODELS = 'https://ai.google.dev/gemini-api/docs/models'

const DEEPSEEK_FLASH_PEAK = { input: 0.3, output: 1.2, cacheRead: 0.006 }
const DEEPSEEK_EFFORT = {
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
  control: 'effort' as const,
}

function retired(
  providers: readonly string[],
  modelIds: readonly string[],
  lifecycle: NonNullable<ModelFactsPatch['lifecycle']>,
  source: string,
  checkedAt: string,
  note: string,
): ModelOverride[] {
  return modelIds.map((modelId) => ({
    providers,
    modelId,
    patch: { kind: 'chat', lifecycle },
    note,
    source,
    checkedAt,
  }))
}

export const MODEL_OVERRIDES: readonly ModelOverride[] = [
  // ─── DeepSeek ───
  {
    providers: ['deepseek'],
    modelId: 'deepseek-flash',
    patch: { contextWindowTokens: 1_048_576, reasoning: DEEPSEEK_EFFORT },
    note: 'GET /models reports context_window 1048576 and default effort high; models.dev rounds to 1,000,000.',
    source: DEEPSEEK_MODELS,
    checkedAt: '2026-10-19',
  },
  {
    providers: ['deepseek'],
    modelId: 'deepseek-flash',
    patch: { pricingUsdPerMTok: DEEPSEEK_FLASH_PEAK },
    note: 'models.dev lists the off-peak rate; peak is twice that. The peak rate keeps cost caps on the safe side.',
    source: DEEPSEEK_PRICING,
    checkedAt: '2026-10-19',
  },
  {
    providers: ['deepseek'],
    modelId: 'deepseek-v4-pro',
    patch: {
      contextWindowTokens: 1_048_576,
      reasoning: DEEPSEEK_EFFORT,
      pricingUsdPerMTok: { input: 1.32, output: 3.96, cacheRead: 0.044 },
    },
    note: 'context_window 1048576 per GET /models; peak rate as for deepseek-flash.',
    source: DEEPSEEK_PRICING,
    checkedAt: '2026-10-19',
  },
  ...['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].map(
    (modelId): ModelOverride => ({
      providers: ['deepseek'],
      modelId,
      patch: {
        contextWindowTokens: 1_048_576,
        reasoning: DEEPSEEK_EFFORT,
        pricingUsdPerMTok: DEEPSEEK_FLASH_PEAK,
        lifecycle: { status: 'deprecated', replacement: 'deepseek-flash' },
      },
      note: 'Legacy name: still accepted, served by DeepSeek-V4.1-Flash-1017 and billed at the Flash price.',
      source: DEEPSEEK_PRICING,
      checkedAt: '2026-10-19',
    }),
  ),
  ...retired(
    ['deepseek'],
    ['deepseek-chat', 'deepseek-reasoner'],
    {
      status: 'retired',
      retiresAt: '2026-07-24',
      replacement: 'deepseek-flash',
    },
    DEEPSEEK_UPDATES,
    '2026-10-19',
    'Legacy names discontinued on 2026-07-24; models.dev no longer lists them.',
  ),

  // ─── Google ───
  {
    providers: ['google'],
    modelId: 'gemini-4-argon',
    patch: {
      maxOutputTokens: 65_536,
      acceptsTemperature: false,
      reasoning: {
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        control: 'always',
      },
    },
    note: 'Default synchronous output is 65,536 (models.dev: 32,768); temperature is deprecated and ignored; thinking defaults to medium.',
    source: GEMINI_MODELS,
    checkedAt: '2026-10-18',
  },

  // ─── Kimi ───
  ...['kimi-code-plan-cn', 'kimi-code-plan-global'].flatMap(
    (provider): ModelOverride[] => [
      {
        providers: [provider],
        modelId: 'kimi-for-coding-highspeed',
        patch: { capabilities: { toolCall: false } },
        note: 'The coding-plan list reports supports_dynamic_tools: false for the highspeed variant.',
        source: KIMI_CODING_LIST,
        checkedAt: '2026-10-18',
      },
      {
        providers: [provider],
        modelId: 'kimi-for-coding',
        patch: {
          reasoning: {
            efforts: ['low', 'high', 'max'],
            defaultEffort: 'max',
            control: 'always',
          },
        },
        note: 'supports_thinking_type "only" (thinking cannot be disabled), think_efforts low/high/max, default max.',
        source: KIMI_CODING_LIST,
        checkedAt: '2026-10-18',
      },
    ],
  ),
  {
    providers: ['moonshotai', 'moonshotai-cn'],
    modelId: 'kimi-k2.7-code-highspeed',
    patch: { capabilities: { toolCall: false } },
    note: 'Same model as the coding plan’s kimi-for-coding-highspeed (models.dev canonical id), which reports no tool calling.',
    source: KIMI_CODING_LIST,
    checkedAt: '2026-10-18',
  },
  ...retired(
    ['moonshotai', 'moonshotai-cn'],
    [
      'kimi-k2-0905-preview',
      'kimi-k2-0711-preview',
      'kimi-k2-turbo-preview',
      'kimi-k2-thinking',
      'kimi-k2-thinking-turbo',
    ],
    { status: 'retired', retiresAt: '2026-05-25', replacement: 'kimi-k3' },
    KIMI_MODELS,
    '2026-10-19',
    'The kimi-k2 series was discontinued on 2026-05-25; Kimi points to kimi-k3.',
  ),
  ...retired(
    ['moonshotai', 'moonshotai-cn'],
    [
      'kimi-k2.5',
      'moonshot-v1-8k',
      'moonshot-v1-32k',
      'moonshot-v1-128k',
      'moonshot-v1-auto',
      'moonshot-v1-8k-vision-preview',
      'moonshot-v1-32k-vision-preview',
      'moonshot-v1-128k-vision-preview',
    ],
    { status: 'retired', retiresAt: '2026-08-31', replacement: 'kimi-k3' },
    KIMI_MODELS,
    '2026-10-19',
    'kimi-k2.5 and the moonshot-v1 series were discontinued on 2026-08-31.',
  ),
  ...retired(
    ['moonshotai', 'moonshotai-cn'],
    ['kimi-latest'],
    { status: 'retired', retiresAt: '2026-01-28', replacement: 'kimi-k3' },
    KIMI_MODELS,
    '2026-10-19',
    'kimi-latest was discontinued on 2026-01-28.',
  ),

  // ─── MiniMax ───
  {
    providers: ['minimax', 'minimax-cn'],
    modelId: 'MiniMax-M3',
    patch: { maxOutputTokens: 128_000 },
    note: 'MiniMax lists M3 with a 1,000,000 context but no output limit; models.dev’s 512,000 is unverified. 128K stays until a real request confirms more.',
    source: MINIMAX_MODELS,
    checkedAt: '2026-10-19',
  },
  ...[
    'MiniMax-M2.5',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
  ].map((modelId): ModelOverride => ({
    providers: ['minimax', 'minimax-cn'],
    modelId,
    patch: { lifecycle: { status: 'deprecated', retiresAt: '2026-11-18' } },
    note: 'M2.5 and M2.7 families: closed to new users 2026-10-19, retired 2026-11-18.',
    source: MINIMAX_RETIREMENT,
    checkedAt: '2026-10-19',
  })),
  ...['MiniMax-M2', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed'].map(
    (modelId): ModelOverride => ({
      providers: ['minimax', 'minimax-cn'],
      modelId,
      patch: { kind: 'chat', lifecycle: { status: 'retired' } },
      note: 'Listed under Retired Models; models.dev still lists some of them as current.',
      source: MINIMAX_RETIRED,
      checkedAt: '2026-10-19',
    }),
  ),
]
