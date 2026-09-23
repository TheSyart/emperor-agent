/**
 * State of the Pull Request page: gh status, the list per (tab, search),
 * and the detail / diff of PRs by reference. Stale-while-revalidate
 * everywhere: a cached entry keeps rendering while it reloads, and only the
 * newest request of an entry may write it. A failure coded as "gh
 * unavailable" re-checks `status()` so the page falls back to its
 * install / login empty state.
 */
import { computed, shallowRef, type Ref } from 'vue'
import {
  getPullRequestDiff,
  getPullRequestStatus,
  listPullRequests,
  PULL_REQUEST_LIST_LIMIT_MAX,
  pullRequestErrorInfo,
  viewPullRequest,
  type PullRequestBrowserStatus,
  type PullRequestDetail,
  type PullRequestDiffResult,
  type PullRequestErrorInfo,
  type PullRequestListFilter,
  type PullRequestListResult,
  type PullRequestRef,
} from '../../../api/pullRequests'
import { pullKey } from './pullRequestModel'

export interface AsyncEntry<T> {
  data: T | null
  loading: boolean
  error: PullRequestErrorInfo | null
}

const EMPTY: AsyncEntry<never> = { data: null, loading: false, error: null }

/** Bounded caches (a diff is up to 4 MiB). */
const DETAIL_CACHE_MAX = 30
const DIFF_CACHE_MAX = 4
const LIST_CACHE_MAX = 12

/** A keyed map of async entries that only lets the newest request write. */
function useEntryCache<T>(max: number) {
  const entries = shallowRef<Record<string, AsyncEntry<T>>>({})
  const seq = new Map<string, number>()

  function get(key: string): AsyncEntry<T> {
    return entries.value[key] ?? EMPTY
  }

  function write(key: string, entry: AsyncEntry<T>): void {
    const next = { ...entries.value }
    delete next[key]
    next[key] = entry
    const keys = Object.keys(next)
    for (const stale of keys.slice(0, Math.max(0, keys.length - max)))
      delete next[stale]
    entries.value = next
  }

  async function load(
    key: string,
    fetch: () => Promise<T>,
    onError?: (info: PullRequestErrorInfo) => void,
  ): Promise<void> {
    const id = (seq.get(key) ?? 0) + 1
    seq.set(key, id)
    const previous = get(key)
    write(key, { data: previous.data, loading: true, error: null })
    try {
      const data = await fetch()
      if (seq.get(key) === id) write(key, { data, loading: false, error: null })
    } catch (error) {
      if (seq.get(key) !== id) return
      const info = pullRequestErrorInfo(error)
      write(key, { data: previous.data, loading: false, error: info })
      onError?.(info)
    }
  }

  function clear(keep?: string): void {
    const kept = keep ? entries.value[keep] : undefined
    entries.value = kept && keep ? { [keep]: kept } : {}
  }

  return { entries, get, load, clear }
}

export function listKey(filter: PullRequestListFilter, query: string): string {
  return `${filter}\u0000${query.trim()}`
}

export function usePullRequestBrowser(options: {
  filter: Ref<PullRequestListFilter>
  /** Committed (debounced) search text. */
  query: Ref<string>
  selected: Ref<PullRequestRef | null>
}) {
  const status = shallowRef<PullRequestBrowserStatus | null>(null)
  const statusLoading = shallowRef(false)
  const lists = useEntryCache<PullRequestListResult>(LIST_CACHE_MAX)
  const details = useEntryCache<PullRequestDetail>(DETAIL_CACHE_MAX)
  const diffs = useEntryCache<PullRequestDiffResult>(DIFF_CACHE_MAX)

  const available = computed(() => status.value?.available === true)
  const currentListKey = computed(() =>
    listKey(options.filter.value, options.query.value),
  )
  const list = computed(() => lists.get(currentListKey.value))
  const detail = computed(() =>
    options.selected.value
      ? details.get(pullKey(options.selected.value))
      : EMPTY,
  )
  const diff = computed(() =>
    options.selected.value ? diffs.get(pullKey(options.selected.value)) : EMPTY,
  )

  let statusSeq = 0
  async function checkStatus(): Promise<PullRequestBrowserStatus> {
    const id = ++statusSeq
    statusLoading.value = true
    try {
      const next = await getPullRequestStatus()
      if (id === statusSeq) status.value = next
      return next
    } catch (error) {
      // IPC / bridge failure: surface it like a gh failure (retryable).
      const next: PullRequestBrowserStatus = {
        available: false,
        reason: 'gh_failed',
        message: pullRequestErrorInfo(error).message,
      }
      if (id === statusSeq) status.value = next
      return next
    } finally {
      if (id === statusSeq) statusLoading.value = false
    }
  }

  function onError(info: PullRequestErrorInfo): void {
    if (info.kind === 'unavailable') void checkStatus()
  }

  function loadList(): Promise<void> {
    const filter = options.filter.value
    const query = options.query.value
    return lists.load(
      listKey(filter, query),
      () =>
        listPullRequests({ filter, query, limit: PULL_REQUEST_LIST_LIMIT_MAX }),
      onError,
    )
  }

  /** Load the current list unless a fresh copy is cached or loading. */
  function ensureList(): Promise<void> {
    const entry = lists.get(currentListKey.value)
    if (entry.loading || entry.data) return Promise.resolve()
    return loadList()
  }

  function loadDetail(ref: PullRequestRef): Promise<void> {
    return details.load(pullKey(ref), () => viewPullRequest(ref), onError)
  }

  function ensureDetail(ref: PullRequestRef): Promise<void> {
    const entry = details.get(pullKey(ref))
    if (entry.loading || entry.data) return Promise.resolve()
    return loadDetail(ref)
  }

  function loadDiff(ref: PullRequestRef): Promise<void> {
    return diffs.load(pullKey(ref), () => getPullRequestDiff(ref), onError)
  }

  function ensureDiff(ref: PullRequestRef): Promise<void> {
    const entry = diffs.get(pullKey(ref))
    if (entry.loading || entry.data) return Promise.resolve()
    return loadDiff(ref)
  }

  /**
   * Re-check gh, then reload what is on screen: the current list and the
   * selected PR (plus its diff when it was loaded). Other cached entries are
   * dropped so switching tabs afterwards fetches fresh data. An entry that
   * is already loading (e.g. started by the page as gh became available) is
   * not requested twice.
   */
  async function refresh(): Promise<void> {
    const next = await checkStatus()
    if (!next.available) return
    const selected = options.selected.value
    const selectedKey = selected ? pullKey(selected) : undefined
    const hadDiff = selectedKey ? Boolean(diffs.get(selectedKey).data) : false
    lists.clear(currentListKey.value)
    details.clear(selectedKey)
    diffs.clear(selectedKey)
    const idle = <T>(entry: AsyncEntry<T>) => !entry.loading
    await Promise.all([
      idle(lists.get(currentListKey.value)) ? loadList() : undefined,
      selected && selectedKey && idle(details.get(selectedKey))
        ? loadDetail(selected)
        : undefined,
      selected && selectedKey && hadDiff && idle(diffs.get(selectedKey))
        ? loadDiff(selected)
        : undefined,
    ])
  }

  return {
    status,
    statusLoading,
    available,
    list,
    detail,
    diff,
    checkStatus,
    refresh,
    loadList,
    ensureList,
    loadDetail,
    ensureDetail,
    loadDiff,
    ensureDiff,
  }
}

export type PullRequestBrowserState = ReturnType<typeof usePullRequestBrowser>
