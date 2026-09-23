import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  providerIconAsset,
  providerIconFallback,
  providerIconGlyph,
  providerIconIsMonochrome,
  providerIconMaskCssUrl,
} from './providerIcons'

describe('providerIcons', () => {
  it.each([
    ['openai', 'openai.svg'],
    ['anthropic', 'anthropic.svg'],
    ['dashscope', 'qwen.svg'],
    ['moonshot', 'kimi.svg'],
    ['volcengine', 'volcengine-color.svg'],
    ['volcengine_coding_plan', 'volcengine-color.svg'],
    ['qianfan', 'baidu.svg'],
    ['groq', 'groq.svg'],
    ['lm-studio', 'lmstudio.svg'],
    ['vllm', 'vllm-color.svg'],
  ])('maps %s to the pinned provider asset', (iconId, fileName) => {
    expect(providerIconAsset(iconId)).toMatch(
      new RegExp(`/provider-logos/${fileName}$`),
    )
  })

  it('returns null for providers without a copied upstream asset', () => {
    expect(providerIconAsset('ovms')).toBeNull()
    expect(providerIconAsset('custom')).toBeNull()
    expect(providerIconAsset(null)).toBeNull()
  })

  it('gives every catalog provider a logo or a generic glyph', () => {
    const catalog = readFileSync(
      resolve(__dirname, '../../../../../packages/core/src/llm/catalog.ts'),
      'utf8',
    )
    const block = catalog.slice(catalog.indexOf('export const PROVIDERS'))
    const names = [...block.matchAll(/^\s{4}name: '([a-z0-9_]+)',$/gm)].map(
      (match) => match[1]!,
    )
    expect(names.length).toBeGreaterThan(20)
    for (const name of names)
      expect(
        providerIconAsset(name) ?? providerIconGlyph(name),
        name,
      ).toBeTruthy()
    expect(providerIconGlyph('ovms')).toBe('server')
    expect(providerIconGlyph('custom')).toBe('custom')
    expect(providerIconGlyph('openai')).toBeNull()
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
