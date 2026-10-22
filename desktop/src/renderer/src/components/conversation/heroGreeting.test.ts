import { describe, expect, it } from 'vitest'
import { heroHeadline } from './heroGreeting'

describe('heroHeadline (UI-S17)', () => {
  it('greets by the profile 称呼', () => {
    expect(heroHeadline('小周')).toBe('小周，今天想推进什么？')
    expect(heroHeadline('  Anran ')).toBe('Anran，今天想推进什么？')
  })

  it('keeps the plain question without a name', () => {
    expect(heroHeadline(null)).toBe('今天想推进什么？')
    expect(heroHeadline(undefined)).toBe('今天想推进什么？')
    expect(heroHeadline('   ')).toBe('今天想推进什么？')
  })

  it('cuts a long name to 12 characters', () => {
    expect(heroHeadline('周'.repeat(20))).toBe(
      `${'周'.repeat(12)}…，今天想推进什么？`,
    )
    expect(heroHeadline('😀'.repeat(13))).toBe(
      `${'😀'.repeat(12)}…，今天想推进什么？`,
    )
  })
})
