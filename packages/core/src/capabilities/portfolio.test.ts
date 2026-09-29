import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { optionalCapabilityPortfolio } from './portfolio'

describe('optional capability portfolio lifecycle', () => {
  it('registers every maintained optional capability with a complete lifecycle', () => {
    const portfolio = optionalCapabilityPortfolio()

    expect(portfolio.map((item) => item.id)).toEqual([
      'watchlist',
      'computer_use',
    ])
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

  it('registers computer use exactly as spec 00 §14.4 describes it', () => {
    const item = optionalCapabilityPortfolio().find(
      (entry) => entry.id === 'computer_use',
    )!
    expect(item).toMatchObject({
      owner: 'ComputerUseService',
      status: 'evaluation_gated',
      defaultMode: 'off',
      evaluation: {
        command:
          'npm test --workspace @emperor/core -- src/harness/computer-use',
        receiptRequiredForMutation: true,
      },
      maintenance: { budget: 'high' },
      retireCriteria: [
        'All drivers are disabled for two review cycles with no active grants',
        'No owner is assigned by the next scheduled portfolio review',
      ],
    })
    expect(item.userEntry).toContain('Settings › 电脑操作')
    expect(item.userEntry).toContain('permission cards')
    for (const store of ['grants.json', 'vault.json', 'browser/profiles'])
      expect(item.dataAuthority).toContain(store)
    expect(item.maintenance.suite).toContain('platform helpers')
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
