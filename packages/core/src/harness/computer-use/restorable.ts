/**
 * Tabs to offer back after a restart (spec 00 §7.1, M2.7): when the app
 * shuts down, pages open in *persistent* profiles are remembered per owning
 * conversation in `~/.emperor/browser/restorable.json` (0600). Nothing is
 * reopened automatically: `browser_tab_list` lists them so the Agent can
 * `browser_open` them again (through the normal permission checks), with
 * the profile's cookies still in place. Temporary profiles are never
 * remembered — their data is gone.
 */

import { join } from 'node:path'
import { z } from 'zod'
import { AtomicSnapshotSync, type SnapshotCodec } from '../../store/persistence'

export const RESTORABLE_FILE = 'restorable.json'
const MAX_TABS = 20
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

export interface RestorableTab {
  readonly ownerSessionId: string
  readonly profileId: string
  readonly url: string
  readonly title: string
  readonly closedAt: string
}

const tab = z
  .object({
    ownerSessionId: z.string().min(1).max(256),
    profileId: z.string().regex(/^p_[0-9a-f]{12}$/),
    url: z
      .string()
      .regex(/^https?:\/\//)
      .max(2048),
    title: z.string().max(200),
    closedAt: z.string().min(1).max(64),
  })
  .strict()

const schema = z
  .object({ schemaVersion: z.literal(1), tabs: z.array(tab).max(MAX_TABS) })
  .strict()

const CODEC: SnapshotCodec<RestorableTab[]> = {
  schemaVersion: 1,
  encode: (value) => ({ schemaVersion: 1, tabs: value }),
  decode(input) {
    return { value: schema.parse(input).tabs, schemaVersion: 1 }
  },
}

export class RestorableTabStore {
  private readonly snapshot: AtomicSnapshotSync<RestorableTab[]>

  constructor(
    root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.snapshot = new AtomicSnapshotSync({
      path: join(root, RESTORABLE_FILE),
      codec: CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
  }

  private read(): RestorableTab[] {
    const cutoff = this.now().getTime() - KEEP_MS
    return this.snapshot
      .read({ fallback: [] })
      .value.filter((item) => Date.parse(item.closedAt) >= cutoff)
  }

  forOwner(ownerSessionId: string): RestorableTab[] {
    return this.read().filter((item) => item.ownerSessionId === ownerSessionId)
  }

  /** Remember `tabs` (newest first wins), keeping older entries of others. */
  remember(tabs: readonly Omit<RestorableTab, 'closedAt'>[]): void {
    if (tabs.length === 0) return
    const closedAt = this.now().toISOString()
    const key = (item: {
      ownerSessionId: string
      profileId: string
      url: string
    }) => `${item.ownerSessionId}|${item.profileId}|${item.url}`
    const fresh = tabs.map((item) => ({
      ...item,
      url: item.url.slice(0, 2048),
      title: item.title.slice(0, 200),
      closedAt,
    }))
    const seen = new Set(fresh.map(key))
    const kept = this.read().filter((item) => !seen.has(key(item)))
    this.write([...fresh, ...kept].slice(0, MAX_TABS))
  }

  /** Forget entries (reopened, owner deleted, profile deleted). */
  forget(match: (tab: RestorableTab) => boolean): void {
    const current = this.read()
    const kept = current.filter((item) => !match(item))
    if (kept.length !== current.length) this.write(kept)
  }

  private write(next: RestorableTab[]): void {
    try {
      this.snapshot.write(next)
    } catch {
      // best effort: losing the hint never loses data
    }
  }
}
