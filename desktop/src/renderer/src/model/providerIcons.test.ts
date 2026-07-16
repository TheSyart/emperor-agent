import { describe, expect, it } from 'vitest'
import { providerIconAsset, providerIconFallback } from './providerIcons'

describe('providerIcons', () => {
  it.each([
    ['openai', 'openai.svg'],
    ['anthropic', 'anthropic.svg'],
    ['dashscope', 'qwen.svg'],
    ['moonshot', 'kimi.svg'],
    ['volcengine_coding_plan', 'doubao.svg'],
    ['qianfan', 'baidu.svg'],
  ])('maps %s to the pinned provider asset', (iconId, fileName) => {
    expect(providerIconAsset(iconId)).toMatch(
      new RegExp(`/provider-logos/${fileName}$`),
    )
  })

  it('returns null for providers without a copied upstream asset', () => {
    expect(providerIconAsset('lm_studio')).toBeNull()
    expect(providerIconAsset('custom')).toBeNull()
    expect(providerIconAsset(null)).toBeNull()
  })

  it('creates a stable initial fallback from the display name', () => {
    expect(providerIconFallback('LM Studio')).toBe('L')
    expect(providerIconFallback('  智谱 GLM  ')).toBe('智')
    expect(providerIconFallback('')).toBe('?')
  })
})
