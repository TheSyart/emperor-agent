/**
 * Temporary history of the user's built-in browser (plan 5 C 线): the pages
 * committed in this browser session — address, title, time — in memory only,
 * never cookies or page data. BrowserViewHost empties it when the view
 * closes, when browsing data is cleared, and when the user turns temporary
 * history off; nothing survives the app quitting.
 */
import type { BrowserHistoryEntry } from '../shared/ipc-contract'
import { browserNavigationAllowed } from './browser-view-policy'

export type UserBrowserHistoryEntry = BrowserHistoryEntry

export const USER_BROWSER_HISTORY_LIMIT = 100

export class UserBrowserHistory {
  /** Oldest first. */
  private entries: UserBrowserHistoryEntry[] = []
  private nextId = 1
  private readonly limit: number
  private readonly now: () => number

  constructor(options: { limit?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? USER_BROWSER_HISTORY_LIMIT
    this.now = options.now ?? Date.now
  }

  /** A committed main-frame page; the same page again only refreshes it. */
  record(url: string, title: string): void {
    if (!browserNavigationAllowed(url)) return
    const last = this.entries.at(-1)
    if (last?.url === url) {
      this.entries[this.entries.length - 1] = {
        ...last,
        title: title || last.title,
        time: this.now(),
      }
      return
    }
    this.entries.push({
      id: `h${this.nextId++}`,
      url,
      title,
      time: this.now(),
    })
    if (this.entries.length > this.limit)
      this.entries.splice(0, this.entries.length - this.limit)
  }

  /** The title a page reported after it committed. */
  retitle(url: string, title: string): void {
    if (!title) return
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!
      if (entry.url !== url) continue
      this.entries[index] = { ...entry, title }
      return
    }
  }

  /** Newest first. */
  list(): UserBrowserHistoryEntry[] {
    return [...this.entries].reverse()
  }

  find(id: string): UserBrowserHistoryEntry | undefined {
    return this.entries.find((entry) => entry.id === id)
  }

  clear(): void {
    this.entries = []
  }
}
