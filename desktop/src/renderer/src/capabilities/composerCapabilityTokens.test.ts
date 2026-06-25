import { describe, expect, it } from 'vitest'

import {
  hasComposerCapabilityTokens,
  normalizeComposerCapabilityInput,
  parseComposerCapabilityTokens,
  renderComposerInlineTokens,
} from './composerCapabilityTokens'

describe('composer capability tokens', () => {
  it('parses skill and MCP inline placeholders', () => {
    const parsed = parseComposerCapabilityTokens('用 @skill(clawhub) 查资料，请用 @mcp(github) 看 issue')

    expect(parsed.skills).toEqual(['clawhub'])
    expect(parsed.mcps).toEqual(['github'])
  })

  it('deduplicates repeated skills and ignores normal mentions', () => {
    const parsed = parseComposerCapabilityTokens('@skill(clawhub) @skill(clawhub) @someone')

    expect(parsed.skills).toEqual(['clawhub'])
    expect(parsed.mcps).toEqual([])
    expect(parsed.tokens.map((token) => token.raw)).toEqual(['@skill(clawhub)', '@skill(clawhub)'])
  })

  it('normalizes model content while preserving display content', () => {
    const normalized = normalizeComposerCapabilityInput('用 @skill(components-build) 做按钮，并参考 @mcp(github)')

    expect(normalized.content).toBe('用 Skill: components-build 做按钮，并参考 MCP: github')
    expect(normalized.displayContent).toBe('用 @skill(components-build) 做按钮，并参考 @mcp(github)')
    expect(normalized.requestedSkills).toEqual([{ name: 'components-build', source: 'slash' }])
  })

  it('renders token-aware inline segments', () => {
    const segments = renderComposerInlineTokens('A @skill(code-audit) B')

    expect(segments).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'token', tokenKind: 'skill', name: 'code-audit', raw: '@skill(code-audit)' },
      { kind: 'text', text: ' B' },
    ])
  })

  it('renders token segments after a has-token check', () => {
    const text = '@skill(clawhub)'

    expect(hasComposerCapabilityTokens(text)).toBe(true)
    expect(renderComposerInlineTokens(text)).toEqual([
      { kind: 'token', tokenKind: 'skill', name: 'clawhub', raw: '@skill(clawhub)' },
    ])
  })
})
