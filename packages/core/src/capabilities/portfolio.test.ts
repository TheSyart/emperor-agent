import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { optionalCapabilityPortfolio } from './portfolio'

describe('optional capability portfolio lifecycle', () => {
  it('registers every maintained optional capability with a complete lifecycle', () => {
    const portfolio = optionalCapabilityPortfolio()

    expect(portfolio.map((item) => item.id)).toEqual(['watchlist'])
    for (const item of portfolio) {
      expect(item.owner).not.toBe('')
      expect(item.userEntry).not.toBe('')
      expect(item.dataAuthority).not.toBe('')
      expect(item.evaluation.command).not.toBe('')
      expect(item.maintenance.suite).not.toBe('')
      expect(item.nextReviewOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(item.retireCriteria.length).toBeGreaterThanOrEqual(2)
    }
    expect(
      portfolio
        .filter((item) => item.status === 'evaluation_gated')
        .every((item) => item.defaultMode === 'off'),
    ).toBe(true)
  })

  it('returns detached diagnostics data instead of mutable registry authority', () => {
    const first = optionalCapabilityPortfolio()
    ;(first[0]!.retireCriteria as string[])[0] = 'mutated test copy'

    expect(optionalCapabilityPortfolio()[0]!.retireCriteria[0]).not.toBe(
      'mutated test copy',
    )
  })

  it('keeps every registered capability discoverable from the Active lifecycle document', () => {
    const document = readFileSync(
      resolve(
        __dirname,
        '../../../../docs/architecture/optional-capabilities.md',
      ),
      'utf8',
    )

    for (const item of optionalCapabilityPortfolio())
      expect(document).toContain(`\`${item.id}\``)
  })
})
