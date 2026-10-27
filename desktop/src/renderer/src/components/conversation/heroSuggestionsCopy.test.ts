import { describe, expect, it } from 'vitest'
import { BANNED_TERMS } from '../../copyAudit'
import { HERO_SUGGESTIONS } from './heroSuggestions'

// MOD-03: the Chat home's five starters are fixed copy, held to
// docs/design/writing.md like every other string on screen.

const CJK = /[㐀-鿿]/
/** A CJK character right next to a Latin letter or digit (writing.md › 格式). */
const UNSPACED = /[㐀-鿿][A-Za-z0-9]|[A-Za-z0-9][㐀-鿿]/

describe('HERO_SUGGESTIONS (MOD-03 9)', () => {
  it('has the five starters of the approved preview, in its order', () => {
    expect(HERO_SUGGESTIONS.map((item) => item.label)).toEqual([
      '调研一个话题',
      '润色一段文字',
      '翻译',
      '解释一个概念',
      '整理会议记录',
    ])
    expect(new Set(HERO_SUGGESTIONS.map((item) => item.id)).size).toBe(5)
  })

  it('fills a Chinese opening that ends where the user goes on typing', () => {
    for (const item of HERO_SUGGESTIONS) {
      expect(item.draft, item.id).toMatch(CJK)
      expect(item.draft.endsWith('：'), item.id).toBe(true)
      expect(item.draft.length, item.id).toBeLessThanOrEqual(40)
      expect(item.draft, item.id).not.toContain('\n')
    }
  })

  it('follows the writing rules: no retired terms, spacing, one-character ellipsis', () => {
    for (const item of HERO_SUGGESTIONS)
      for (const text of [item.label, item.draft]) {
        for (const term of Object.keys(BANNED_TERMS))
          expect(text, item.id).not.toContain(term)
        expect(text, item.id).not.toMatch(UNSPACED)
        expect(text, item.id).not.toContain('...')
        expect(text.trim(), item.id).toBe(text)
      }
  })
})
