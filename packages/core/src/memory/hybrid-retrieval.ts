export type HybridMemorySource = 'global' | 'project' | 'session'

export interface HybridMemoryChunkInput {
  id: string
  text: string
  source: HybridMemorySource
  path: string
  createdAt: number
  projectId?: string | null
  sessionId?: string | null
  startLine?: number
  endLine?: number
  accessCount?: number
}

export interface HybridMemorySearchScope {
  mode: 'chat' | 'build'
  projectId?: string | null
  sessionId?: string | null
}

export interface MemoryEmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>
}

export interface HybridMemoryMmrConfig {
  enabled: boolean
  lambda: number
}

export interface HybridMemoryConfig {
  textWeight: number
  vectorWeight: number
  temporalHalfLifeDays: number
  sourceWeights: Record<HybridMemorySource, number>
  mmr: HybridMemoryMmrConfig
  candidateMultiplier: number
}

export interface HybridMemorySearchInput {
  query: string
  scope: HybridMemorySearchScope
  maxResults?: number
  signal?: AbortSignal
}

export interface HybridMemorySearchResult extends HybridMemoryChunkInput {
  score: number
  lexicalScore: number
  vectorScore: number
}

export interface HybridMemorySearchResponse {
  strategy: 'fts' | 'hybrid' | 'fts_fallback'
  fallbackReason: 'embedding_failed' | null
  embeddingProviderId: string | null
  generation: number
  results: HybridMemorySearchResult[]
}

interface IndexedChunk extends HybridMemoryChunkInput {
  tokens: string[]
  embedding: number[] | null
}

interface RankedChunk {
  rawScore: number
  result: HybridMemorySearchResult
  tokens: Set<string>
}

const DEFAULT_CONFIG: HybridMemoryConfig = {
  textWeight: 0.55,
  vectorWeight: 0.45,
  temporalHalfLifeDays: 30,
  sourceWeights: { global: 1, project: 1.05, session: 0.9 },
  mmr: { enabled: true, lambda: 0.72 },
  candidateMultiplier: 3,
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'for',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'where',
  'which',
  'with',
  '什么',
  '哪里',
  '如何',
  '是',
  '的',
])

/**
 * A bounded, derived retrieval projection. Markdown remains authoritative;
 * replace() may be called at any time and a search observes one immutable
 * generation even while an embedding request is in flight.
 */
export class HybridMemoryRetriever {
  readonly embeddingProvider: MemoryEmbeddingProvider | null
  readonly config: HybridMemoryConfig
  private readonly now: () => number
  private chunks: IndexedChunk[] = []
  private currentGeneration = 0
  private embeddingIndexFailed = false

  constructor(
    opts: {
      embeddingProvider?: MemoryEmbeddingProvider | null
      config?: Partial<HybridMemoryConfig> & {
        sourceWeights?: Partial<Record<HybridMemorySource, number>>
        mmr?: Partial<HybridMemoryMmrConfig>
      }
      now?: () => number
    } = {},
  ) {
    this.embeddingProvider = opts.embeddingProvider ?? null
    this.now = opts.now ?? Date.now
    this.config = normalizeConfig(opts.config)
  }

  generation(): number {
    return this.currentGeneration
  }

  async replace(
    inputs: readonly HybridMemoryChunkInput[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<number> {
    const normalized = inputs.map(normalizeChunk)
    let embeddings: number[][] | null = null
    this.embeddingIndexFailed = false
    if (this.embeddingProvider && normalized.length) {
      try {
        embeddings = await this.embeddingProvider.embed(
          normalized.map((chunk) => chunk.text),
          opts.signal,
        )
        validateEmbeddings(
          embeddings,
          normalized.length,
          this.embeddingProvider.dimensions,
        )
      } catch {
        if (opts.signal?.aborted) throw abortError(opts.signal)
        this.embeddingIndexFailed = true
        embeddings = null
      }
    }
    this.chunks = normalized.map((chunk, index) => ({
      ...chunk,
      tokens: tokenize(chunk.text),
      embedding: embeddings?.[index]?.slice() ?? null,
    }))
    this.currentGeneration += 1
    return this.currentGeneration
  }

  async search(
    input: HybridMemorySearchInput,
  ): Promise<HybridMemorySearchResponse> {
    throwIfAborted(input.signal)
    const query = String(input.query ?? '').trim()
    const generation = this.currentGeneration
    const snapshot = this.chunks
      .filter((chunk) => visibleInScope(chunk, input.scope))
      .map(cloneIndexedChunk)
    const queryTokens = tokenize(query)
    const lexical = bm25Scores(snapshot, queryTokens)
    let queryEmbedding: number[] | null = null
    let fallbackReason: HybridMemorySearchResponse['fallbackReason'] = null

    if (this.embeddingProvider && snapshot.length) {
      if (
        this.embeddingIndexFailed ||
        !snapshot.some((item) => item.embedding)
      ) {
        fallbackReason = 'embedding_failed'
      } else {
        try {
          const embedded = await this.embeddingProvider.embed(
            [query],
            input.signal,
          )
          validateEmbeddings(embedded, 1, this.embeddingProvider.dimensions)
          queryEmbedding = embedded[0]!.slice()
        } catch {
          if (input.signal?.aborted) throw abortError(input.signal)
          fallbackReason = 'embedding_failed'
        }
      }
    }
    throwIfAborted(input.signal)

    const vector = queryEmbedding
      ? vectorScores(snapshot, queryEmbedding)
      : new Map<string, number>()
    const maxResults = clampInteger(input.maxResults ?? 6, 1, 50)
    const ranked = rankChunks({
      chunks: snapshot,
      lexical,
      vector,
      config: this.config,
      now: this.now(),
    })
    const candidates = ranked.slice(
      0,
      Math.max(maxResults, maxResults * this.config.candidateMultiplier),
    )
    const diversified = mmrRerank(candidates, this.config.mmr)

    return {
      strategy: fallbackReason
        ? 'fts_fallback'
        : queryEmbedding
          ? 'hybrid'
          : 'fts',
      fallbackReason,
      embeddingProviderId: this.embeddingProvider?.id ?? null,
      generation,
      results: diversified.slice(0, maxResults).map((item) => item.result),
    }
  }
}

function normalizeConfig(
  input:
    | (Partial<HybridMemoryConfig> & {
        sourceWeights?: Partial<Record<HybridMemorySource, number>>
        mmr?: Partial<HybridMemoryMmrConfig>
      })
    | undefined,
): HybridMemoryConfig {
  return {
    textWeight: finiteWeight(input?.textWeight, DEFAULT_CONFIG.textWeight),
    vectorWeight: finiteWeight(
      input?.vectorWeight,
      DEFAULT_CONFIG.vectorWeight,
    ),
    temporalHalfLifeDays: positiveFinite(
      input?.temporalHalfLifeDays,
      DEFAULT_CONFIG.temporalHalfLifeDays,
    ),
    sourceWeights: {
      global: positiveFinite(
        input?.sourceWeights?.global,
        DEFAULT_CONFIG.sourceWeights.global,
      ),
      project: positiveFinite(
        input?.sourceWeights?.project,
        DEFAULT_CONFIG.sourceWeights.project,
      ),
      session: positiveFinite(
        input?.sourceWeights?.session,
        DEFAULT_CONFIG.sourceWeights.session,
      ),
    },
    mmr: {
      enabled: input?.mmr?.enabled ?? DEFAULT_CONFIG.mmr.enabled,
      lambda: finiteWeight(input?.mmr?.lambda, DEFAULT_CONFIG.mmr.lambda),
    },
    candidateMultiplier: clampInteger(
      input?.candidateMultiplier ?? DEFAULT_CONFIG.candidateMultiplier,
      1,
      10,
    ),
  }
}

function normalizeChunk(input: HybridMemoryChunkInput): HybridMemoryChunkInput {
  const id = String(input.id ?? '').trim()
  const text = String(input.text ?? '').trim()
  const path = String(input.path ?? '').trim()
  if (!id || !text || !path)
    throw new Error('memory chunk requires id, text and path')
  const source = input.source
  if (source !== 'global' && source !== 'project' && source !== 'session')
    throw new Error(`unsupported memory source: ${String(source)}`)
  return {
    id,
    text,
    source,
    path,
    createdAt: Math.max(0, Number(input.createdAt) || 0),
    projectId: nullableString(input.projectId),
    sessionId: nullableString(input.sessionId),
    startLine: Math.max(1, Math.trunc(Number(input.startLine) || 1)),
    endLine: Math.max(1, Math.trunc(Number(input.endLine) || 1)),
    accessCount: Math.max(0, Math.trunc(Number(input.accessCount) || 0)),
  }
}

function visibleInScope(
  chunk: IndexedChunk,
  scope: HybridMemorySearchScope,
): boolean {
  const projectId = nullableString(scope.projectId)
  const sessionId = nullableString(scope.sessionId)
  if (scope.mode === 'build') {
    if (!projectId) return false
    if (chunk.source === 'project') return chunk.projectId === projectId
    if (chunk.source === 'session') return chunk.projectId === projectId
    return false
  }
  if (chunk.source === 'global') return true
  if (chunk.source !== 'session' || chunk.projectId) return false
  return !chunk.sessionId || chunk.sessionId === sessionId
}

function bm25Scores(
  chunks: readonly IndexedChunk[],
  queryTokens: readonly string[],
): Map<string, number> {
  const scores = new Map<string, number>()
  if (!chunks.length || !queryTokens.length) return scores
  const terms = [...new Set(queryTokens)]
  const averageLength =
    chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) /
    Math.max(1, chunks.length)
  const documentFrequency = new Map<string, number>()
  for (const term of terms) {
    documentFrequency.set(
      term,
      chunks.filter((chunk) => chunk.tokens.includes(term)).length,
    )
  }
  for (const chunk of chunks) {
    const counts = frequency(chunk.tokens)
    let score = 0
    for (const term of terms) {
      const tf = counts.get(term) ?? 0
      if (!tf) continue
      const df = documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5))
      const denominator =
        tf + 1.2 * (0.25 + 0.75 * (chunk.tokens.length / averageLength))
      score += idf * ((tf * 2.2) / denominator)
    }
    if (score > 0) scores.set(chunk.id, score)
  }
  return normalizeScores(scores)
}

function vectorScores(
  chunks: readonly IndexedChunk[],
  queryEmbedding: readonly number[],
): Map<string, number> {
  const scores = new Map<string, number>()
  for (const chunk of chunks) {
    if (!chunk.embedding) continue
    const score = Math.max(0, cosineSimilarity(queryEmbedding, chunk.embedding))
    if (score > 0) scores.set(chunk.id, score)
  }
  return scores
}

function rankChunks(input: {
  chunks: readonly IndexedChunk[]
  lexical: Map<string, number>
  vector: Map<string, number>
  config: HybridMemoryConfig
  now: number
}): RankedChunk[] {
  const ranked: RankedChunk[] = []
  for (const chunk of input.chunks) {
    const lexicalScore = input.lexical.get(chunk.id) ?? 0
    const vectorScore = input.vector.get(chunk.id) ?? 0
    if (lexicalScore <= 0 && vectorScore <= 0) continue
    const hybrid =
      input.config.textWeight * lexicalScore +
      input.config.vectorWeight * vectorScore
    const baseScore = lexicalScore > 0 ? Math.max(lexicalScore, hybrid) : hybrid
    const decay = temporalDecay(chunk, input.now, input.config)
    const sourceWeight = input.config.sourceWeights[chunk.source]
    const accessBoost = 1 + Math.log1p(chunk.accessCount ?? 0) * 0.05
    const rawScore = baseScore * decay * sourceWeight * accessBoost
    ranked.push({
      rawScore,
      result: {
        ...publicChunk(chunk),
        score: clamp(rawScore, 0, 1),
        lexicalScore,
        vectorScore,
      },
      tokens: new Set(chunk.tokens),
    })
  }
  return ranked.sort(
    (left, right) =>
      right.rawScore - left.rawScore ||
      left.result.id.localeCompare(right.result.id),
  )
}

function temporalDecay(
  chunk: IndexedChunk,
  now: number,
  config: HybridMemoryConfig,
): number {
  if (chunk.source === 'global' || chunk.source === 'project') return 1
  const ageDays = Math.max(0, now - chunk.createdAt) / 86_400_000
  return Math.exp(
    -(Math.LN2 / Math.max(0.001, config.temporalHalfLifeDays)) * ageDays,
  )
}

function mmrRerank(
  ranked: readonly RankedChunk[],
  config: HybridMemoryMmrConfig,
): RankedChunk[] {
  if (!config.enabled || config.lambda >= 1 || ranked.length < 2)
    return [...ranked]
  const remaining = [...ranked]
  const selected: RankedChunk[] = []
  const max = Math.max(...ranked.map((item) => item.rawScore))
  const min = Math.min(...ranked.map((item) => item.rawScore))
  const range = Math.max(Number.EPSILON, max - min)
  while (remaining.length) {
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!
      const relevance = (candidate.rawScore - min) / range
      const redundancy = selected.reduce(
        (highest, item) =>
          Math.max(highest, jaccard(candidate.tokens, item.tokens)),
        0,
      )
      const mmr = config.lambda * relevance - (1 - config.lambda) * redundancy
      if (
        mmr > bestScore ||
        (mmr === bestScore &&
          candidate.result.id.localeCompare(remaining[bestIndex]!.result.id) <
            0)
      ) {
        bestIndex = index
        bestScore = mmr
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]!)
  }
  return selected
}

function tokenize(text: string): string[] {
  const words = String(text ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}_]+/gu)
  if (!words) return []
  const tokens: string[] = []
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue
    tokens.push(word)
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 1) {
      const chars = [...word]
      tokens.push(...chars)
      for (let index = 0; index + 1 < chars.length; index += 1)
        tokens.push(`${chars[index]}${chars[index + 1]}`)
    }
  }
  return tokens
}

function normalizeScores(scores: Map<string, number>): Map<string, number> {
  const max = Math.max(0, ...scores.values())
  if (max <= 0) return new Map()
  return new Map([...scores].map(([id, score]) => [id, score / max]))
}

function frequency(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || !left.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0
    const b = Number(right[index]) || 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / Math.max(1, left.size + right.size - intersection)
}

function validateEmbeddings(
  values: readonly number[][],
  count: number,
  dimensions: number,
): void {
  if (values.length !== count) throw new Error('embedding count mismatch')
  for (const value of values) {
    if (
      value.length !== dimensions ||
      value.some((item) => !Number.isFinite(item))
    )
      throw new Error('embedding dimensions mismatch')
  }
}

function cloneIndexedChunk(chunk: IndexedChunk): IndexedChunk {
  return {
    ...chunk,
    tokens: [...chunk.tokens],
    embedding: chunk.embedding?.slice() ?? null,
  }
}

function publicChunk(chunk: IndexedChunk): HybridMemoryChunkInput {
  const { tokens: _tokens, embedding: _embedding, ...result } = chunk
  return result
}

function nullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function finiteWeight(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? clamp(number, 0, 1) : fallback
}

function positiveFinite(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(Number(value) || 0)))
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}
