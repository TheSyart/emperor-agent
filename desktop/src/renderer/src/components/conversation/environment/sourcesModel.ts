// 来源 on the environment card and in the workbench's 来源 view (UI-S13).
// Pure. The card lists the first CARD_SOURCE_LIMIT sources in display
// order — what you provided, then what was read, then search hits, then the
// rest — and the view groups all of them the same way. Each source shows
// where it is (a path with home as `~`, an address without its scheme, else
// what it is) and, only when the loaded transcript says so, what produced it
// (the search that found it) and how many places used it.
import type { ChatNode } from '../../../conversation/types'
import {
  PROVENANCE_LABEL,
  type DisplayResource,
  type ResourceProvenance,
} from '../resources/resourceModel'
import { argsOf } from '../tools/toolModel'

/** Sources listed on the card; more open the 来源 view. */
export const CARD_SOURCE_LIMIT = 3

/** What the workbench's 来源 view shows (workspace/SourcesView.vue). */
export interface SourcesViewState {
  /** The chat window the sources come from. */
  sessionId: string
  /** In display order. */
  sources: readonly DisplayResource[]
  /** That window's nodes: what produced a source (the search query). */
  nodes: ReadonlyMap<string, ChatNode>
  /** Older history is not loaded: the list covers the loaded window. */
  hasMore: boolean
}

/** Group order; the first three are the ones a reader asks about. */
const GROUP_ORDER: readonly ResourceProvenance[] = [
  'provided',
  'read',
  'discovered',
  'cited',
  'used',
  'observed',
  'created',
]

const GROUP_LABEL: Partial<Record<ResourceProvenance, string>> = {
  provided: '你提供的',
}

function rank(resource: DisplayResource): number {
  const at = GROUP_ORDER.indexOf(resource.provenance)
  return at < 0 ? GROUP_ORDER.length : at
}

/** Display order, stable within each provenance. */
export function orderSources(
  sources: readonly DisplayResource[],
): DisplayResource[] {
  return sources
    .map((resource, index) => ({ resource, index, rank: rank(resource) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.resource)
}

export interface SourceEntry {
  readonly resource: DisplayResource
  readonly location: SourceLocation
  /** What produced it and how often it was used; '' when unknown. */
  readonly note: string
}

export interface SourceGroup {
  readonly key: ResourceProvenance
  readonly label: string
  readonly entries: readonly SourceEntry[]
}

/** The 来源 view's groups, empty ones left out. */
export function sourceGroups(
  sources: readonly DisplayResource[],
  nodes: ReadonlyMap<string, ChatNode>,
): SourceGroup[] {
  const groups = new Map<ResourceProvenance, SourceEntry[]>()
  for (const resource of orderSources(sources)) {
    const entries = groups.get(resource.provenance) ?? []
    entries.push({
      resource,
      location: sourceLocation(resource),
      note: sourceNote(resource, nodes),
    })
    groups.set(resource.provenance, entries)
  }
  return [...groups].map(([key, entries]) => ({
    key,
    label: GROUP_LABEL[key] ?? PROVENANCE_LABEL[key],
    entries,
  }))
}

/** `/Users/<name>` reads as `~` (macOS). */
export function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/u, '~')
}

export interface SourceLocation {
  readonly text: string
  /** A path or an address (monospace, wrapping). */
  readonly mono: boolean
}

/** Where a source is: its path or address, else what it is. */
export function sourceLocation(resource: DisplayResource): SourceLocation {
  if (resource.kind === 'web' || resource.kind === 'github')
    return { text: resource.href.replace(/^https?:\/\//iu, ''), mono: true }
  const path =
    (resource.kind === 'file' ||
      resource.kind === 'folder' ||
      resource.kind === 'image') &&
    !resource.attachmentId
  return path
    ? { text: shortenHome(resource.subtitle || resource.href), mono: true }
    : { text: resource.subtitle, mono: false }
}

/** The queries of the loaded web searches that found `resource`. */
function searchQueries(
  resource: DisplayResource,
  nodes: ReadonlyMap<string, ChatNode>,
): string[] {
  const queries: string[] = []
  for (const use of resource.uses ?? []) {
    if (use.provenance !== 'discovered') continue
    const node = nodes.get(use.nodeKey)
    if (node?.kind !== 'tool' || node.data.name !== 'web_search') continue
    const value = argsOf(node.data).queries
    if (!Array.isArray(value)) continue
    for (const query of value)
      if (typeof query === 'string' && query.trim() && !queries.includes(query))
        queries.push(query)
  }
  return queries
}

/**
 * What the transcript says about a source beyond its place: the search that
 * found it, how many places used it. Never who read it — a subagent's reads
 * are not in this transcript.
 */
export function sourceNote(
  resource: DisplayResource,
  nodes: ReadonlyMap<string, ChatNode>,
): string {
  const parts: string[] = []
  const queries = searchQueries(resource, nodes)
  if (queries.length) parts.push(`搜索「${queries.join('、')}」`)
  const uses = resource.uses?.length ?? 0
  if (uses > 1) parts.push(`${uses} 处记录`)
  // No space beside full-width punctuation (writing.md).
  return parts.join(' · ').replace('」 ·', '」·')
}
