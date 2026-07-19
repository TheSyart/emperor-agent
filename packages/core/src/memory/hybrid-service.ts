import { createHash } from 'node:crypto'
import {
  renderContextSections,
  type ContextProjection,
} from '../agent/context-builder'
import type { Resolved } from '../config/resolver'
import {
  effectiveHybridMemoryCapability,
  type EffectiveHybridMemoryCapability,
  type HybridMemoryEvaluationGateReceipt,
  type HybridMemoryModeValue,
} from './hybrid-capability'
import {
  HybridMemoryDerivedIndexStore,
  type HybridMemoryDocument,
} from './hybrid-index'
import {
  HybridMemoryRetriever,
  type HybridMemorySearchResponse,
  type HybridMemorySearchScope,
  type MemoryEmbeddingProvider,
} from './hybrid-retrieval'

export interface HybridMemoryRetrieveInput {
  query: string
  documents: readonly HybridMemoryDocument[]
  scope: HybridMemorySearchScope
  signal?: AbortSignal
  maxResults?: number
  promptBudgetBytes?: number
}

export interface HybridMemoryRetrieveResult {
  capability: EffectiveHybridMemoryCapability
  search: HybridMemorySearchResponse | null
  promptProjection: string | null
  sourceDigest: string | null
  derivedDiskBytes: number
}

export interface HybridMemoryServiceDiagnostics {
  capability: EffectiveHybridMemoryCapability
  indexPath: string
  searches: number
  promptMutations: number
  embeddingFallbacks: number
  lastStrategy: HybridMemorySearchResponse['strategy'] | null
  lastResultCount: number
  lastSourceDigest: string | null
  derivedDiskBytes: number
}

export class HybridMemoryService {
  readonly index: HybridMemoryDerivedIndexStore
  readonly retriever: HybridMemoryRetriever
  readonly capability: EffectiveHybridMemoryCapability
  private readonly now: () => number
  private indexedDigest: string | null = null
  private indexQueue: Promise<void> = Promise.resolve()
  private searches = 0
  private promptMutations = 0
  private embeddingFallbacks = 0
  private lastStrategy: HybridMemorySearchResponse['strategy'] | null = null
  private lastResultCount = 0
  private lastSourceDigest: string | null = null
  private derivedDiskBytes = 0

  constructor(opts: {
    stateRoot: string
    requested: Resolved<HybridMemoryModeValue>
    embeddingProvider?: MemoryEmbeddingProvider | null
    evaluationGate?: HybridMemoryEvaluationGateReceipt | null
    now?: () => number
  }) {
    this.index = new HybridMemoryDerivedIndexStore(opts.stateRoot)
    this.now = opts.now ?? Date.now
    this.retriever = new HybridMemoryRetriever({
      embeddingProvider: opts.embeddingProvider ?? null,
      now: this.now,
    })
    this.capability = effectiveHybridMemoryCapability({
      requested: opts.requested,
      evaluationGate: opts.evaluationGate ?? null,
      embeddingProviderId: opts.embeddingProvider?.id ?? null,
    })
  }

  async retrieve(
    input: HybridMemoryRetrieveInput,
  ): Promise<HybridMemoryRetrieveResult> {
    if (this.capability.effectiveMode === 'off')
      return {
        capability: { ...this.capability },
        search: null,
        promptProjection: null,
        sourceDigest: null,
        derivedDiskBytes: 0,
      }

    const sync = this.index.sync(input.documents)
    this.lastSourceDigest = sync.sourceDigest
    this.derivedDiskBytes = sync.derivedDiskBytes
    await this.ensureIndexed(sync.sourceDigest, sync.chunks, input.signal)
    const search = await this.retriever.search({
      query: input.query,
      scope: input.scope,
      maxResults: input.maxResults,
      signal: input.signal,
    })
    this.searches += 1
    this.lastStrategy = search.strategy
    this.lastResultCount = search.results.length
    if (search.strategy === 'fts_fallback') this.embeddingFallbacks += 1
    const promptProjection = this.capability.promptMutationAllowed
      ? renderPromptProjection(
          search,
          input.scope,
          this.now(),
          input.promptBudgetBytes,
        )
      : null
    if (promptProjection) this.promptMutations += 1
    return {
      capability: { ...this.capability },
      search,
      promptProjection,
      sourceDigest: sync.sourceDigest,
      derivedDiskBytes: sync.derivedDiskBytes,
    }
  }

  diagnostics(): HybridMemoryServiceDiagnostics {
    return {
      capability: { ...this.capability },
      indexPath: this.index.indexPath,
      searches: this.searches,
      promptMutations: this.promptMutations,
      embeddingFallbacks: this.embeddingFallbacks,
      lastStrategy: this.lastStrategy,
      lastResultCount: this.lastResultCount,
      lastSourceDigest: this.lastSourceDigest,
      derivedDiskBytes: this.derivedDiskBytes,
    }
  }

  private async ensureIndexed(
    sourceDigest: string,
    chunks: Parameters<HybridMemoryRetriever['replace']>[0],
    signal?: AbortSignal,
  ): Promise<void> {
    const run = async () => {
      if (this.indexedDigest === sourceDigest) return
      await this.retriever.replace(chunks, { signal })
      this.indexedDigest = sourceDigest
    }
    this.indexQueue = this.indexQueue.then(run, run)
    await this.indexQueue
  }
}

export function applyHybridMemoryPromptProjection(
  projection: ContextProjection,
  retrieval: HybridMemoryRetrieveResult,
): ContextProjection {
  const content = retrieval.promptProjection
  const sourceDigest = retrieval.sourceDigest
  if (!content || !sourceDigest) return projection
  const targetName =
    projection.contextPlan.mode === 'build'
      ? 'project_agents'
      : 'long_term_memory'
  const targetId = `section:${targetName}`
  if (!projection.sections.some((section) => section.name === targetName))
    return projection
  const source = `hybrid-memory:index:${sourceDigest}`
  const sections = projection.sections.map((section) =>
    section.name === targetName
      ? {
          ...section,
          content,
          source,
          budgetChars: content.length,
          stability: 'dynamic' as const,
        }
      : { ...section },
  )
  const contextPlan = {
    ...projection.contextPlan,
    activeMemoryBinding: structuredClone(
      projection.contextPlan.activeMemoryBinding,
    ),
    items: projection.contextPlan.items.map((item) =>
      item.id === targetId
        ? {
            ...item,
            source,
            hash: createHash('sha256').update(content, 'utf8').digest('hex'),
            charCount: content.length,
            tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
            reason: 'hybrid_memory_gate_passed',
          }
        : { ...item },
    ),
    omitted: projection.contextPlan.omitted.map((item) => ({ ...item })),
  }
  return {
    sections,
    contextPlan,
    prompt: renderContextSections(sections, contextPlan),
  }
}

function renderPromptProjection(
  search: HybridMemorySearchResponse,
  scope: HybridMemorySearchScope,
  now: number,
  requestedBudget?: number,
): string | null {
  if (!search.results.length) return null
  const heading =
    scope.mode === 'build'
      ? '# Retrieved Project Memory'
      : '# Retrieved Long-term Memory'
  const parts = [
    heading,
    '',
    'Derived retrieval projection; Markdown files remain authoritative.',
  ]
  for (const result of search.results) {
    const ageDays = Math.max(0, now - result.createdAt) / 86_400_000
    parts.push(
      '',
      `## Memory result ${result.id.slice(0, 12)}`,
      '',
      `[source=${result.source}; path=${result.path}; lines=${result.startLine ?? 1}-${result.endLine ?? 1}; age_days=${ageDays.toFixed(2)}; score=${result.score.toFixed(4)}]`,
      '',
      result.text,
    )
  }
  const budget = Math.min(
    64_000,
    Math.max(1_024, Math.trunc(Number(requestedBudget) || 12_000)),
  )
  return truncateUtf8(parts.join('\n'), budget)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const marker = '\n\n[Retrieved memory clipped by byte budget]'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const bytes =
      Buffer.byteLength(value.slice(0, middle), 'utf8') + markerBytes
    if (bytes <= maxBytes) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low).replace(/\s+$/, '')}${marker}`
}
