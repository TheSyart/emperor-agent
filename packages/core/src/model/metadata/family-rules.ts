/**
 * Family rules: step 7 of the lookup, for chat models the catalog does not
 * list yet (a new version, a dated build under another name). Each rule is
 * a regex over the normalised id (lowercase, no `org/` path, no date) and
 * the facts the family shares, from the vendor pages checked on the date
 * given. First match wins, so specific rules precede general ones.
 *
 * A rule never states a price or a lifecycle, and leaves a field out when
 * the family's members disagree; the generic rules at the end only state
 * capabilities that every member of the family has. Numbers err low where
 * sources differ: a smaller limit costs an earlier compaction, a larger one
 * a failed request.
 */
import type { ModelFactsPatch } from './types'

export type FamilyFacts = Omit<
  ModelFactsPatch,
  'kind' | 'name' | 'lifecycle' | 'pricingUsdPerMTok'
>

export interface FamilyRule {
  id: string
  match: RegExp
  facts: FamilyFacts
  source: string
  /** YYYY-MM-DD */
  checkedAt: string
}

const OAI = 'https://developers.openai.com/api/docs/models'
const ANT = 'https://platform.claude.com/docs/en/about-claude/models/overview'
const GOO = 'https://ai.google.dev/gemini-api/docs/models'
const DS = 'https://api-docs.deepseek.com/api/list-models'
const ALI = 'https://www.alibabacloud.com/help/en/model-studio/models'
const KIMI = 'https://platform.kimi.ai/docs/models'
const ZAI = 'https://docs.z.ai/guides/overview/overview'
const MM = 'https://platform.minimax.io/docs/guides/text-generation'
const XAI = 'https://docs.x.ai/docs/models'
const MIS = 'https://docs.mistral.ai/getting-started/models/'
const VOLC = 'https://www.volcengine.com/docs/82379/1330310'
const OR = 'https://openrouter.ai/api/v1/models'
const CHECKED = '2026-10-18'

const ALL_TOOLS = { toolCall: true, vision: true, reasoning: true }
const TEXT_TOOLS = { toolCall: true, vision: false, reasoning: true }
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export const FAMILY_RULES: readonly FamilyRule[] = [
  // ─── DeepSeek ───
  {
    id: 'deepseek-flash',
    match: /^deepseek-(?:flash|v4-flash)/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 393_216,
      capabilities: ALL_TOOLS,
      reasoning: {
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
        control: 'effort',
      },
      acceptsTemperature: true,
    },
    source: DS,
    checkedAt: '2026-10-19',
  },
  {
    id: 'deepseek-v4-pro',
    match: /^deepseek-v4-pro/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 393_216,
      capabilities: TEXT_TOOLS,
      reasoning: {
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
        control: 'effort',
      },
      acceptsTemperature: true,
    },
    source: DS,
    checkedAt: '2026-10-19',
  },

  // ─── OpenAI ───
  {
    id: 'gpt-6',
    match: /^gpt-6/,
    facts: {
      contextWindowTokens: 1_050_000,
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      capabilities: ALL_TOOLS,
      // astra and 6.1-sol cannot switch thinking off; assume the stricter.
      reasoning: {
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
        control: 'always',
      },
      acceptsTemperature: false,
    },
    source: OAI,
    checkedAt: CHECKED,
  },
  {
    id: 'gpt-5.4-5.6',
    match: /^gpt-5\.[4-6](?!\d)(?!-mini|-nano)/,
    facts: {
      contextWindowTokens: 1_050_000,
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      capabilities: ALL_TOOLS,
      reasoning: {
        efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        control: 'effort',
      },
      acceptsTemperature: false,
    },
    source: OAI,
    checkedAt: CHECKED,
  },
  {
    id: 'gpt-5',
    match: /^gpt-5(?:$|[.-])/,
    facts: {
      contextWindowTokens: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: ['low', 'medium', 'high'], control: 'always' },
      acceptsTemperature: false,
    },
    source: OAI,
    checkedAt: CHECKED,
  },
  {
    id: 'o-series',
    match: /^o[13](?:-|$)/,
    facts: {
      contextWindowTokens: 200_000,
      maxOutputTokens: 100_000,
      capabilities: { toolCall: true, reasoning: true },
      reasoning: { efforts: ['low', 'medium', 'high'], control: 'always' },
      acceptsTemperature: false,
    },
    source: OAI,
    checkedAt: CHECKED,
  },
  {
    id: 'gpt-oss',
    match: /gpt-oss/,
    facts: {
      contextWindowTokens: 131_072,
      maxOutputTokens: 131_072,
      capabilities: TEXT_TOOLS,
      reasoning: { efforts: ['low', 'medium', 'high'], control: 'always' },
      acceptsTemperature: true,
    },
    source: OAI,
    checkedAt: CHECKED,
  },

  // ─── Anthropic ───
  {
    id: 'claude-5',
    match: /^claude-(?:fable|mythos|opus|sonnet|haiku)-5/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: CLAUDE_EFFORTS, control: 'always' },
      acceptsTemperature: false,
    },
    source: ANT,
    checkedAt: CHECKED,
  },
  {
    id: 'claude-4.6-4.8',
    match: /^claude-(?:opus|sonnet)-4-[678]/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: ALL_TOOLS,
      reasoning: {
        efforts: ['low', 'medium', 'high', 'max'],
        control: 'always',
      },
      acceptsTemperature: false,
    },
    source: ANT,
    checkedAt: CHECKED,
  },
  {
    id: 'claude-4.5',
    match: /^claude-[a-z]+-4-5(?:$|-)/,
    facts: {
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: [], control: 'budget' },
      acceptsTemperature: true,
    },
    source: ANT,
    checkedAt: CHECKED,
  },

  // ─── Google ───
  {
    id: 'gemini-4',
    match: /^gemini-4/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: ALL_TOOLS,
      reasoning: {
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        control: 'always',
      },
      acceptsTemperature: false,
    },
    source: GOO,
    checkedAt: CHECKED,
  },
  {
    id: 'gemini-3-flash',
    match: /^gemini-3(?:\.\d+)?-flash/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: ['low', 'medium', 'high'], control: 'always' },
      acceptsTemperature: true,
    },
    source: GOO,
    checkedAt: CHECKED,
  },
  {
    id: 'gemini-3-pro',
    match: /^gemini-3(?:\.\d+)?-pro/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: ALL_TOOLS,
      reasoning: {
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        control: 'always',
      },
      acceptsTemperature: true,
    },
    source: GOO,
    checkedAt: CHECKED,
  },
  {
    id: 'gemini-2.5',
    match: /^gemini-2\.5/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: [], control: 'budget' },
      acceptsTemperature: true,
    },
    source: GOO,
    checkedAt: CHECKED,
  },

  // ─── Qwen ───
  {
    id: 'qwen3.x-max',
    match: /^qwen3\.\d+-max/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
      capabilities: { toolCall: true, reasoning: true },
      reasoning: { efforts: [], control: 'toggle' },
      acceptsTemperature: true,
    },
    source: ALI,
    checkedAt: CHECKED,
  },
  {
    id: 'qwen3.x-plus-flash',
    match: /^qwen3\.\d+-(?:plus|flash)/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: [], control: 'toggle' },
      acceptsTemperature: true,
    },
    source: ALI,
    checkedAt: CHECKED,
  },
  {
    id: 'qwen-turbo',
    match: /^qwen-turbo/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 16_384,
      capabilities: TEXT_TOOLS,
      reasoning: { efforts: [], control: 'toggle' },
      acceptsTemperature: true,
    },
    source: ALI,
    checkedAt: CHECKED,
  },
  {
    id: 'qwen-plus-flash',
    match: /^qwen-(?:plus|flash)/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 32_768,
      capabilities: TEXT_TOOLS,
      reasoning: { efforts: [], control: 'toggle' },
      acceptsTemperature: true,
    },
    source: ALI,
    checkedAt: CHECKED,
  },
  {
    id: 'qwen3-coder',
    match: /^qwen3-coder-(?:plus|flash)/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 65_536,
      capabilities: { toolCall: true, vision: false, reasoning: false },
      acceptsTemperature: true,
    },
    source: ALI,
    checkedAt: CHECKED,
  },

  // ─── Kimi ───
  {
    id: 'kimi-k3',
    match: /^(?:kimi-)?k3(?:$|[-.])/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 1_048_576,
      capabilities: ALL_TOOLS,
      reasoning: {
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
        control: 'always',
      },
      acceptsTemperature: false,
    },
    source: KIMI,
    checkedAt: CHECKED,
  },
  {
    id: 'kimi-highspeed',
    match: /^kimi-(?:k2\.7-code|for-coding)-highspeed/,
    facts: {
      contextWindowTokens: 262_144,
      capabilities: { toolCall: false, vision: true, reasoning: true },
      reasoning: { efforts: [], control: 'always' },
      acceptsTemperature: false,
    },
    source: KIMI,
    checkedAt: CHECKED,
  },
  {
    id: 'kimi-k2.7',
    match: /^kimi-k2\.7/,
    facts: {
      contextWindowTokens: 262_144,
      maxOutputTokens: 262_144,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: [], control: 'always' },
      acceptsTemperature: false,
    },
    source: KIMI,
    checkedAt: CHECKED,
  },
  {
    id: 'kimi-k2.6',
    match: /^kimi-k2\.6/,
    facts: {
      contextWindowTokens: 262_144,
      maxOutputTokens: 262_144,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: [], control: 'toggle' },
      acceptsTemperature: true,
    },
    source: KIMI,
    checkedAt: CHECKED,
  },

  // ─── GLM ───
  {
    id: 'glm-vision',
    match: /^glm-[\d.]+v/,
    facts: {
      contextWindowTokens: 64_000,
      maxOutputTokens: 16_384,
      capabilities: ALL_TOOLS,
      acceptsTemperature: true,
    },
    source: ZAI,
    checkedAt: CHECKED,
  },
  {
    id: 'glm-5.2+',
    match: /^glm-5\.[2-9]/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 131_072,
      capabilities: { toolCall: true, reasoning: true },
      acceptsTemperature: true,
    },
    source: ZAI,
    checkedAt: CHECKED,
  },
  {
    id: 'glm-4.6-5.1',
    match: /^glm-(?:5|5\.1|4\.[67])$/,
    facts: {
      contextWindowTokens: 200_000,
      maxOutputTokens: 131_072,
      capabilities: TEXT_TOOLS,
      reasoning: { efforts: [], control: 'toggle' },
      acceptsTemperature: true,
    },
    source: ZAI,
    checkedAt: CHECKED,
  },

  // ─── MiniMax ───
  {
    id: 'minimax-m3',
    match: /^minimax-m3/,
    facts: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: [], control: 'toggle' },
      acceptsTemperature: true,
    },
    source: MM,
    checkedAt: CHECKED,
  },
  {
    id: 'minimax-m2',
    match: /^minimax-m2/,
    facts: {
      contextWindowTokens: 204_800,
      maxOutputTokens: 128_000,
      capabilities: TEXT_TOOLS,
      reasoning: { efforts: [], control: 'always' },
      acceptsTemperature: true,
    },
    source: MM,
    checkedAt: CHECKED,
  },

  // ─── Doubao (Volcengine Ark) ───
  {
    id: 'doubao-seed-2.1',
    match: /^doubao-seed-2-1/,
    facts: {
      contextWindowTokens: 256_000,
      maxOutputTokens: 256_000,
      capabilities: ALL_TOOLS,
      reasoning: {
        efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        control: 'effort',
      },
      acceptsTemperature: true,
    },
    source: VOLC,
    checkedAt: CHECKED,
  },
  {
    id: 'doubao-seed-2.0-1.x',
    match: /^doubao-seed-(?:2-0|1-[68])/,
    facts: {
      contextWindowTokens: 256_000,
      maxOutputTokens: 32_000,
      capabilities: { toolCall: true, reasoning: true },
      acceptsTemperature: true,
    },
    source: VOLC,
    checkedAt: CHECKED,
  },

  // ─── xAI ───
  {
    id: 'grok-4.5+',
    match: /^grok-4\.[5-9]/,
    facts: {
      contextWindowTokens: 500_000,
      capabilities: ALL_TOOLS,
      reasoning: { efforts: ['low', 'medium', 'high'], control: 'always' },
      acceptsTemperature: true,
    },
    source: XAI,
    checkedAt: CHECKED,
  },

  // ─── Mistral ───
  {
    id: 'mistral-large-4',
    match: /^mistral-large-4/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 262_144,
      capabilities: { toolCall: true, vision: true },
      acceptsTemperature: true,
    },
    source: MIS,
    checkedAt: CHECKED,
  },
  {
    id: 'mistral',
    match: /^mistral-(?:large|medium|small)/,
    facts: {
      contextWindowTokens: 262_144,
      maxOutputTokens: 256_000,
      capabilities: { toolCall: true, vision: true },
      acceptsTemperature: true,
    },
    source: MIS,
    checkedAt: CHECKED,
  },

  // ─── Llama ───
  {
    id: 'llama-4',
    match: /llama-4/,
    facts: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 16_384,
      capabilities: { toolCall: true, vision: true, reasoning: false },
      acceptsTemperature: true,
    },
    source: OR,
    checkedAt: CHECKED,
  },

  // ─── Newer generations: capabilities every member of the family has ───
  {
    id: 'glm',
    match: /^glm-\d/,
    facts: { capabilities: { toolCall: true, reasoning: true } },
    source: ZAI,
    checkedAt: CHECKED,
  },
  {
    id: 'claude',
    match: /^claude-(?:fable|mythos|opus|sonnet|haiku)-\d/,
    facts: { capabilities: ALL_TOOLS, acceptsTemperature: false },
    source: ANT,
    checkedAt: CHECKED,
  },
  {
    id: 'gemini',
    match: /^gemini-(?:[2-9]|\d{2})/,
    facts: { capabilities: { toolCall: true, vision: true } },
    source: GOO,
    checkedAt: CHECKED,
  },
  {
    id: 'kimi',
    match: /^kimi-k\d/,
    facts: { capabilities: { toolCall: true } },
    source: KIMI,
    checkedAt: CHECKED,
  },
]
