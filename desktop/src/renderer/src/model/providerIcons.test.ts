import { describe, expect, it } from 'vitest'
import {
  providerIconAsset,
  providerIconFallback,
  providerIconIsMonochrome,
  providerIconMaskCssUrl,
} from './providerIcons'

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

  it('identifies monochrome assets that can follow the active theme', () => {
    expect(providerIconIsMonochrome('openai')).toBe(true)
    expect(providerIconIsMonochrome('anthropic')).toBe(true)
    expect(providerIconIsMonochrome('longcat')).toBe(true)
    expect(providerIconIsMonochrome('gemini')).toBe(false)
    expect(providerIconIsMonochrome('custom')).toBe(false)
  })

  it('quotes inline SVG data URIs before using them as CSS masks', () => {
    expect(
      providerIconMaskCssUrl(
        "data:image/svg+xml,%3csvg%20fill='currentColor'%3e",
      ),
    ).toBe(`url("data:image/svg+xml,%3csvg%20fill='currentColor'%3e")`)
  })
})
