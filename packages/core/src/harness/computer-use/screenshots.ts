/**
 * Screenshot quota (spec 00 §8.5): every screenshot saved as an attachment
 * (the audit PNG and the model's JPEG copy) is noted in
 * `~/.emperor/computer-use/screenshots.json` (0600). Past the per-session or
 * global limit the oldest are deleted first; the user can clear them all.
 * A cleared image replays to the model as text, never as an error.
 */

import { join } from 'node:path'
import { z } from 'zod'
import { AtomicSnapshotSync, type SnapshotCodec } from '../../store/persistence'

export const SCREENSHOT_LEDGER_FILE = 'screenshots.json'

export interface ScreenshotQuota {
  readonly perSession: { readonly count: number; readonly bytes: number }
  readonly total: { readonly count: number; readonly bytes: number }
}

const MB = 1024 * 1024

/** 200 images or 200 MB per session; the whole app keeps at most 10×. */
export const DEFAULT_SCREENSHOT_QUOTA: ScreenshotQuota = {
  perSession: { count: 200, bytes: 200 * MB },
  total: { count: 2_000, bytes: 2_000 * MB },
}

export interface ScreenshotEntry {
  readonly attachmentId: string
  readonly sessionId: string
  readonly bytes: number
  readonly savedAt: string
}

export interface ScreenshotUsage {
  readonly count: number
  readonly bytes: number
}

const entry = z
  .object({
    attachmentId: z.string().regex(/^att_[A-Za-z0-9_-]{1,64}$/),
    sessionId: z.string().min(1).max(256),
    bytes: z.number().int().nonnegative(),
    savedAt: z.string().min(1).max(64),
  })
  .strict()

const schema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(entry).max(20_000),
  })
  .strict()

const CODEC: SnapshotCodec<ScreenshotEntry[]> = {
  schemaVersion: 1,
  encode: (value) => ({ schemaVersion: 1, entries: value }),
  decode(input) {
    return { value: schema.parse(input).entries, schemaVersion: 1 }
  },
}

export class ScreenshotLedger {
  private readonly snapshot: AtomicSnapshotSync<ScreenshotEntry[]>
  private entries: ScreenshotEntry[] | null = null

  constructor(
    root: string,
    private readonly quota: ScreenshotQuota = DEFAULT_SCREENSHOT_QUOTA,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.snapshot = new AtomicSnapshotSync({
      path: join(root, SCREENSHOT_LEDGER_FILE),
      codec: CODEC,
      fileMode: 0o600,
      directoryMode: 0o700,
      corruptionPolicy: 'quarantine_and_fallback',
    })
  }

  private load(): ScreenshotEntry[] {
    this.entries ??= this.snapshot.read({ fallback: [] }).value
    return this.entries
  }

  /**
   * Note freshly saved screenshots of `sessionId`; returns the attachment
   * ids to delete (oldest first) so both limits hold again. The new ones
   * are never evicted by their own save.
   */
  record(
    sessionId: string,
    saved: ReadonlyArray<{ attachmentId: string; bytes: number }>,
  ): string[] {
    const savedAt = this.now().toISOString()
    const fresh = new Set(saved.map((item) => item.attachmentId))
    let list = [
      ...this.load().filter((item) => !fresh.has(item.attachmentId)),
      ...saved.map((item) => ({ ...item, sessionId, savedAt })),
    ]
    const evicted: string[] = []
    const trim = (
      scope: (item: ScreenshotEntry) => boolean,
      limit: { count: number; bytes: number },
    ): void => {
      let count = 0
      let bytes = 0
      for (const item of list)
        if (scope(item)) {
          count += 1
          bytes += item.bytes
        }
      const keep: ScreenshotEntry[] = []
      for (const item of list) {
        if (
          scope(item) &&
          !fresh.has(item.attachmentId) &&
          (count > limit.count || bytes > limit.bytes)
        ) {
          count -= 1
          bytes -= item.bytes
          evicted.push(item.attachmentId)
          continue
        }
        keep.push(item)
      }
      list = keep
    }
    trim((item) => item.sessionId === sessionId, this.quota.perSession)
    trim(() => true, this.quota.total)
    this.write(list)
    return evicted
  }

  /** Remove the entries of one session (or all); returns what they were. */
  clear(sessionId?: string): ScreenshotEntry[] {
    const list = this.load()
    const removed = list.filter(
      (item) => sessionId === undefined || item.sessionId === sessionId,
    )
    if (removed.length > 0)
      this.write(
        list.filter(
          (item) => sessionId !== undefined && item.sessionId !== sessionId,
        ),
      )
    return removed
  }

  usage(sessionId?: string): ScreenshotUsage {
    let count = 0
    let bytes = 0
    for (const item of this.load())
      if (sessionId === undefined || item.sessionId === sessionId) {
        count += 1
        bytes += item.bytes
      }
    return { count, bytes }
  }

  private write(next: ScreenshotEntry[]): void {
    this.entries = next
    try {
      this.snapshot.write(next)
    } catch {
      // best effort: the in-memory list still bounds this run
    }
  }
}
