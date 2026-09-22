/**
 * `web_search` (ported from dsh-tool-web search). This module owns the
 * model-facing schema, argument validation, the result-count bound, merging,
 * and result formatting; network access belongs to a {@link WebSearchBackend}.
 *
 * Emperor's host seam is the {@link WebSearchAdapter} (the host-injected
 * `webSearchAdapter`); {@link webSearchBackendFromAdapter} bridges it.
 */

import { z } from 'zod'
import type { JsonValue } from '../../../session-log/json'
import type { SystemPromptAssembler } from '../../prompt/assembler'
import { defineTool, ToolError, type ToolDefinition } from '../definition'

/** One result row from a host {@link WebSearchAdapter}. */
export interface WebSearchAdapterResult {
  title: string
  url: string
  snippet: string
  source?: string
  timestamp?: string
}

/** Emperor's host web-search seam (a trusted adapter injected by the host). */
export interface WebSearchAdapter {
  name: string
  search(
    query: string,
    opts: { maxResults: number; fresh?: boolean; signal?: AbortSignal | null },
  ): Promise<WebSearchAdapterResult[]>
}

/** Default upper bound on returned sources. */
export const WEB_SEARCH_MAX_RESULTS = 8
/** Default upper bound on queries in one call. */
export const WEB_SEARCH_MAX_QUERIES = 4
/** Standard-preset tool timeout. */
export const WEB_SEARCH_TIMEOUT_MS = 60_000

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

/**
 * Search backend. Returns hits for one query, or hits plus an optional
 * provider-generated summary answer.
 */
export interface WebSearchBackend {
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<WebSearchHit[] | { summary?: string; results: WebSearchHit[] }>
}

export interface WebSearchSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** Normalized outcome (dsh `WebSearchResult`). */
export interface WebSearchOutcome {
  content?: string
  sources: WebSearchSource[]
  truncated: boolean
}

export interface WebSearchToolOptions {
  maxResults?: number
  maxQueries?: number
  timeoutMs?: number
}

/** Validate query values: non-empty, non-blank, within the bound; exact duplicates collapse. */
export function parseSearchArgs(
  queries: readonly string[],
  maxQueries: number,
): string[] {
  if (queries.length === 0)
    throw new ToolError(
      'queries must contain at least one query',
      'INVALID_QUERIES',
    )
  if (queries.length > maxQueries) {
    const noun = maxQueries === 1 ? 'query' : 'queries'
    throw new ToolError(
      `queries must contain at most ${maxQueries} ${noun}`,
      'INVALID_QUERIES',
    )
  }
  if (queries.some((query) => query.trim().length === 0))
    throw new ToolError(
      'each query must be a non-empty string',
      'INVALID_QUERIES',
    )
  return [...new Set(queries)]
}

function sourceLabel(url: string, title: string | undefined): string {
  if (title !== undefined && title.length > 0) return title
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Format a search outcome as one model-facing text block (dsh `formatSearchOutput`). */
export function formatSearchOutput(result: WebSearchOutcome): string {
  const parts: string[] = []
  if (result.content !== undefined && result.content.length > 0)
    parts.push(result.content)
  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title)
      const meta: string[] = []
      if (source.snippet !== undefined && source.snippet.length > 0)
        meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0)
        meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if (result.content === undefined || result.content.length === 0) {
    parts.push('No results found.')
  }
  if (result.truncated)
    parts.push(
      `(Showing the first ${result.sources.length} sources. Refine the query for more.)`,
    )
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

function toSource(hit: WebSearchHit): WebSearchSource {
  return {
    url: hit.url,
    ...(hit.title.length > 0 ? { title: hit.title } : {}),
    ...(hit.snippet.length > 0 ? { snippet: hit.snippet } : {}),
    ...(hit.publishedAt !== undefined && hit.publishedAt.length > 0
      ? { publishedAt: hit.publishedAt }
      : {}),
  }
}

async function searchOne(
  backend: WebSearchBackend,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<WebSearchOutcome> {
  const raw = await backend.search(query, signal)
  const hits = Array.isArray(raw) ? raw : raw.results
  const summary = Array.isArray(raw) ? undefined : raw.summary
  const valid = hits.filter(
    (hit) => typeof hit.url === 'string' && hit.url.length > 0,
  )
  return {
    ...(summary !== undefined && summary.length > 0
      ? { content: summary }
      : {}),
    sources: valid.slice(0, maxResults).map(toSource),
    truncated: valid.length > maxResults,
  }
}

/** Merge per-query results into one deduplicated, round-robin, capped result. */
function mergeSearchResults(
  queries: readonly string[],
  results: readonly WebSearchOutcome[],
  maxResults: number,
): WebSearchOutcome {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  const ranks = Math.max(0, ...results.map((result) => result.sources.length))
  let dropped = false
  merge: for (let rank = 0; rank < ranks; rank++) {
    for (const result of results) {
      const source = result.sources[rank]
      if (source !== undefined && !seen.has(source.url)) {
        seen.add(source.url)
        if (sources.length === maxResults) {
          dropped = true
          break merge
        }
        sources.push(source)
      }
    }
  }
  const contents = results.flatMap((result, index) =>
    result.content === undefined || result.content.length === 0
      ? []
      : [`### ${queries[index]}\n\n${result.content}`],
  )
  return {
    ...(contents.length > 0 ? { content: contents.join('\n\n') } : {}),
    sources,
    truncated: results.some((result) => result.truncated) || dropped,
  }
}

/** One query keeps its exact result; several run concurrently, a failure aborts siblings. */
export async function runSearchQueries(
  backend: WebSearchBackend,
  queries: readonly string[],
  maxResults: number,
  signal: AbortSignal,
): Promise<WebSearchOutcome> {
  if (queries.length === 1)
    return searchOne(backend, queries[0]!, maxResults, signal)
  const controller = new AbortController()
  const batchSignal = AbortSignal.any([signal, controller.signal])
  let firstFailure: { error: unknown } | undefined
  const results: WebSearchOutcome[] = []
  await Promise.allSettled(
    queries.map(async (query, index) => {
      try {
        results[index] = await searchOne(
          backend,
          query,
          maxResults,
          batchSignal,
        )
      } catch (error: unknown) {
        if (firstFailure === undefined) firstFailure = { error }
        controller.abort(error)
        throw error
      }
    }),
  )
  if (firstFailure !== undefined) throw firstFailure.error
  return mergeSearchResults(queries, results, maxResults)
}

/** Register the `tool:web_search` guidance section (order 110; fetch disabled). */
export function installWebSearchPromptSection(
  prompt: SystemPromptAssembler,
  options: { maxQueries?: number; fetchEnabled?: boolean } = {},
): () => void {
  const maxQueries = options.maxQueries ?? WEB_SEARCH_MAX_QUERIES
  return prompt.section({
    name: 'tool:web_search',
    order: 110,
    text:
      options.fetchEnabled === true
        ? `Use the web_search tool to discover current information on the web. The required queries array accepts 1–${maxQueries} non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Follow up with web_fetch when you need the full content of a specific result, and cite the relevant URLs as markdown links.`
        : `Use the web_search tool to discover current information on the web. The required queries array accepts 1–${maxQueries} non-empty search queries; use a one-item array for a single search. It returns an optional answer plus a list of source URLs. Use the returned source snippets when available, and cite the relevant URLs as markdown links.`,
  })
}

export function createWebSearchTool(
  backend: WebSearchBackend,
  options: WebSearchToolOptions = {},
): ToolDefinition<{ queries: string[] }> {
  const maxResults = options.maxResults ?? WEB_SEARCH_MAX_RESULTS
  const maxQueries = options.maxQueries ?? WEB_SEARCH_MAX_QUERIES
  return defineTool({
    name: 'web_search',
    description: `Search the web for current information. Provide 1–${maxQueries} queries in the required queries array. Returns an optional summary answer and a list of source URLs.`,
    input: z.object({
      queries: z
        .array(z.string())
        .describe(
          `Required search queries; accepts 1–${maxQueries} items and merges their results.`,
        ),
    }),
    timeoutMs: options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS,
    // Provider reads do not mutate agent state.
    isConcurrencySafe: () => true,
    async execute(args, context) {
      const queries = parseSearchArgs(args.queries, maxQueries)
      const result = await runSearchQueries(
        backend,
        queries,
        maxResults,
        context.signal,
      )
      const meta: JsonValue = {
        sources: result.sources.map((source) => ({ ...source })),
        truncated: result.truncated,
        ...(result.content === undefined ? {} : { answer: result.content }),
      }
      return { content: formatSearchOutput(result), meta }
    },
  })
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

/** Bridge Emperor's host {@link WebSearchAdapter} to a {@link WebSearchBackend}. */
export function webSearchBackendFromAdapter(
  adapter: WebSearchAdapter,
  options: { maxResults?: number; fresh?: boolean } = {},
): WebSearchBackend {
  const maxResults = options.maxResults ?? WEB_SEARCH_MAX_RESULTS
  return {
    async search(query, signal) {
      const results = await adapter.search(query, {
        maxResults,
        ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
        signal,
      })
      return results.flatMap((result) => {
        const url = safeHttpUrl(String(result.url ?? ''))
        if (url.length === 0) return []
        return [
          {
            title: String(result.title ?? ''),
            url,
            snippet: String(result.snippet ?? ''),
            ...(result.timestamp ? { publishedAt: result.timestamp } : {}),
          },
        ]
      })
    },
  }
}
