import { DiscoveryError } from './types'

/** Pages one list may take before discovery gives up. */
export const MAX_PAGES = 100
/** Models one list may return; more are cut and marked `truncated`. */
export const MAX_MODELS = 2000

export interface Page<T> {
  items: T[]
  /** Cursor (or next-page URL) for the following page; absent on the last. */
  next?: string | null
}

/**
 * Every page or nothing: a failing page fails the whole list (the message
 * names the page), a cursor seen before stops it, and more than `maxPages`
 * pages is an error rather than a silently short list. Collecting stops
 * early once more than `stopAfter` items are in, since the caller will cut
 * the list there anyway.
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | null, pageNo: number) => Promise<Page<T>>,
  options: { maxPages?: number; stopAfter?: number } = {},
): Promise<{ items: T[]; truncated: boolean }> {
  const maxPages = options.maxPages ?? MAX_PAGES
  const stopAfter = options.stopAfter ?? Number.POSITIVE_INFINITY
  const items: T[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    let page: Page<T>
    try {
      page = await fetchPage(cursor, pageNo)
    } catch (error) {
      if (pageNo > 1 && error instanceof DiscoveryError)
        throw error.withMessage(
          `第 ${pageNo} 页失败，未返回不完整的列表：${error.message}`,
        )
      throw error
    }
    items.push(...page.items)
    if (items.length > stopAfter) return { items, truncated: true }
    const next = page.next
    if (!next) return { items, truncated: false }
    if (seen.has(next))
      throw new DiscoveryError(
        'PAGING_FAILED',
        `分页游标重复（${next.slice(0, 60)}），已停止，未返回不完整的列表`,
      )
    seen.add(next)
    cursor = next
  }
  throw new DiscoveryError(
    'PAGING_FAILED',
    `模型列表超过 ${maxPages} 页，已停止，未返回不完整的列表`,
  )
}
