export type OptionalCapabilityId =
  'code_intelligence' | 'hybrid_memory' | 'soft_git_rewind' | 'watchlist'

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
    id: 'code_intelligence',
    owner: 'CodeIntelligenceService',
    status: 'evaluation_gated',
    defaultMode: 'off',
    userEntry:
      'Build-only code_intelligence tool after a host-provided parser-bound evaluation receipt',
    dataAuthority:
      'Derived graph/LSP cache; workspace source files remain authoritative',
    evaluation: {
      command: 'npm run eval:code-intelligence --workspace @emperor/core',
      receiptRequiredForMutation: true,
    },
    maintenance: {
      budget: 'high',
      suite: 'src/code-intelligence',
    },
    nextReviewOn: NEXT_REVIEW_ON,
    retireCriteria: [
      'No production receipt or user entry exists at two consecutive reviews',
      'Parser/LSP maintenance exceeds the approved high capability budget',
    ],
  }),
  entry({
    id: 'hybrid_memory',
    owner: 'HybridMemoryService',
    status: 'evaluation_gated',
    defaultMode: 'off',
    userEntry:
      'Local config off/eval/on; prompt mutation only after an embedding-bound evaluation receipt',
    dataAuthority:
      'Derived retrieval index; canonical memory Markdown and session records remain authoritative',
    evaluation: {
      command: 'npm run eval:hybrid-memory --workspace @emperor/core',
      receiptRequiredForMutation: true,
    },
    maintenance: {
      budget: 'medium',
      suite: 'src/memory/hybrid-*',
    },
    nextReviewOn: NEXT_REVIEW_ON,
    retireCriteria: [
      'Retrieval evaluation cannot outperform the FTS fallback at two consecutive reviews',
      'No supported embedding provider or production receipt remains',
    ],
  }),
  entry({
    id: 'soft_git_rewind',
    owner: 'FileCheckpointService',
    status: 'evaluation_gated',
    defaultMode: 'off',
    userEntry:
      'File checkpoint review UI after an explicit on request and platform/Git-bound safety receipt',
    dataAuthority:
      'Recovery transactions and rescue refs; Git HEAD/index and managed file checkpoints remain authoritative',
    evaluation: {
      command: 'npm run eval:soft-git-rewind --workspace @emperor/core',
      receiptRequiredForMutation: true,
    },
    maintenance: {
      budget: 'high',
      suite: 'src/checkpoints/soft-git-rewind*',
    },
    nextReviewOn: NEXT_REVIEW_ON,
    retireCriteria: [
      'No current platform/Git safety receipt exists at two consecutive reviews',
      'Rollback or rescue-ref invariants cannot remain green across supported platforms',
    ],
  }),
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
        'npm test --workspace @emperor/core -- src/watchlist/watchlist.test.ts src/scheduler/executor.test.ts',
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
