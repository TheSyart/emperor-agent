export type OptionalCapabilityId = 'watchlist'

export interface OptionalCapabilityPortfolioEntry {
  readonly id: OptionalCapabilityId
  readonly owner: string
  readonly status: 'active' | 'evaluation_gated'
  readonly defaultMode: 'off' | 'available'
  readonly userEntry: string
  readonly dataAuthority: string
  readonly evaluation: {
    readonly command: string
    readonly receiptRequiredForMutation: boolean
  }
  readonly maintenance: {
    readonly budget: 'low' | 'medium' | 'high'
    readonly suite: string
  }
  readonly nextReviewOn: string
  readonly retireCriteria: readonly string[]
}

const NEXT_REVIEW_ON = '2026-11-09'

const PORTFOLIO: readonly OptionalCapabilityPortfolioEntry[] = Object.freeze([
  entry({
    id: 'watchlist',
    owner: 'WatchlistService',
    status: 'active',
    defaultMode: 'available',
    userEntry: 'Memory panel editor plus manual and Scheduler watchlist checks',
    dataAuthority:
      'User-authored memory/watchlist.md is canonical; watchlist_state.json stores only the latest derived decision',
    evaluation: {
      command:
        'npm test --workspace @emperor/core -- src/watchlist/watchlist.test.ts src/harness/host/scheduler.test.ts',
      receiptRequiredForMutation: false,
    },
    maintenance: {
      budget: 'low',
      suite: 'src/watchlist and Scheduler watchlist-check',
    },
    nextReviewOn: NEXT_REVIEW_ON,
    retireCriteria: [
      'The Memory panel and Scheduler entry are both removed',
      'No owner is assigned by the next scheduled portfolio review',
    ],
  }),
])

export function optionalCapabilityPortfolio(): OptionalCapabilityPortfolioEntry[] {
  return PORTFOLIO.map((item) => structuredClone(item))
}

function entry(
  value: OptionalCapabilityPortfolioEntry,
): OptionalCapabilityPortfolioEntry {
  return Object.freeze({
    ...value,
    evaluation: Object.freeze({ ...value.evaluation }),
    maintenance: Object.freeze({ ...value.maintenance }),
    retireCriteria: Object.freeze([...value.retireCriteria]),
  })
}
