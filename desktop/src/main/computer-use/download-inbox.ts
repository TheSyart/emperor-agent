/**
 * The Agent's download inbox (spec 00 §7.5). A tab accepts a download only
 * while `browser_download` has armed it: the file goes to
 * `~/.emperor/browser/downloads/<task>/` with a safe, unique name, is capped
 * in size, refused when it is an executable or installer, and hashed
 * (SHA-256) when complete. A completed file gets the macOS source mark
 * (`com.apple.quarantine`, SEC-10) so Gatekeeper checks it before it first
 * runs; when that fails the file is kept and listed as 未能标记来源. Every
 * other download is cancelled and noted.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { DownloadRecord } from '@emperor/core/runtime-contract'
import {
  downloadBucket,
  isExecutableDownload,
  safeDownloadName,
} from '@emperor/core/host-capabilities'
import { createQuarantine } from '../quarantine'

export interface DownloadItemLike {
  getFilename(): string
  getMimeType(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  getURL(): string
  setSavePath(path: string): void
  cancel(): void
  on(
    event: 'updated',
    listener: (event: unknown, state: 'progressing' | 'interrupted') => void,
  ): unknown
  once(
    event: 'done',
    listener: (
      event: unknown,
      state: 'completed' | 'cancelled' | 'interrupted',
    ) => void,
  ): unknown
}

export interface ArmRequest {
  readonly taskId: string
  /** The conversation the file belongs to (for 移到工作区). */
  readonly ownerSessionId?: string
  readonly maxBytes: number
  readonly timeoutMs: number
  /** How long to wait for the download to start after the click. */
  readonly startMs?: number
}

export interface DownloadInboxOptions {
  readonly root: string
  /**
   * Where completed downloads are remembered across restarts (0600), so
   * "show in Finder" and "move to workspace" keep working. Absent: memory.
   */
  readonly indexPath?: string
  hashFile?(path: string): Promise<string>
  /** The source mark; default `createQuarantine()` (macOS `xattr`). */
  quarantine?(path: string): Promise<void>
  makeDirectory?(path: string): Promise<void>
  exists?(path: string): boolean
  now?(): number
}

/** A completed download of the inbox (设置 › 浏览器 › 下载历史记录). */
export interface InboxDownload {
  readonly downloadId: string
  readonly name: string
  readonly path: string
  readonly ownerSessionId?: string
  /** Where it came from; absent for downloads saved before it was kept. */
  readonly origin?: string
  /** When it completed (ms), or 0 when unknown. */
  readonly time: number
  readonly bytes: number
  /** The file is still where the inbox last put it. */
  readonly exists: boolean
  /** The macOS source mark could not be set (未能标记来源). */
  readonly unmarked?: true
}

interface Armed {
  readonly request: ArmRequest
  readonly directory: string
  readonly settle: (record: DownloadRecord) => void
  started: boolean
}

const DOWNLOAD_ID = /^dl_[0-9a-f]{12}$/
const INDEX_LIMIT = 500

interface SavedDownload {
  readonly path: string
  readonly ownerSessionId?: string
  readonly origin?: string
  readonly savedAt?: number
  readonly bytes?: number
  /** `com.apple.quarantine` could not be set on the file. */
  readonly unmarked?: true
}

/**
 * `filename` inside `directory`, or `stem (1).ext`, `stem (2).ext`… while
 * `taken` says the name is in use (shared with the user's own downloads).
 */
export function uniqueDownloadPath(
  directory: string,
  filename: string,
  taken: (path: string) => boolean,
): string {
  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  let candidate = join(directory, filename)
  for (let index = 1; taken(candidate) && index < 1000; index += 1)
    candidate = join(directory, `${stem} (${index})${extension}`)
  return candidate
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export class DownloadInbox {
  private readonly armed = new Map<string, Armed>()
  private readonly saved = new Map<string, SavedDownload>()
  private indexLoaded = false
  private readonly quarantine: (path: string) => Promise<void>

  constructor(private readonly options: DownloadInboxOptions) {
    this.quarantine = options.quarantine ?? createQuarantine()
  }

  /**
   * Arm `targetId` for exactly one download, then run `trigger` (the click
   * or fetch). Resolves with the inbox record once the download finished,
   * was refused, or never started.
   */
  async receive(
    targetId: string,
    request: ArmRequest,
    trigger: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<DownloadRecord> {
    const directory = join(this.options.root, downloadBucket(request.taskId))
    await (
      this.options.makeDirectory ??
      ((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined))
    )(directory)
    if (this.armed.has(targetId))
      throw new Error('a download is already in progress in this tab')
    let settle!: (record: DownloadRecord) => void
    const done = new Promise<DownloadRecord>((resolve) => {
      settle = resolve
    })
    const entry: Armed = {
      request,
      directory,
      settle: (record) => settle(record),
      started: false,
    }
    this.armed.set(targetId, entry)
    const notStarted = (reason: string): DownloadRecord => ({
      downloadId: this.newId(),
      state: 'not-started',
      filename: '',
      bytes: 0,
      url: '',
      origin: null,
      reason,
    })
    const startTimer = setTimeout(() => {
      if (!entry.started)
        entry.settle(notStarted('no download started after the click'))
    }, request.startMs ?? 10_000)
    const onAbort = (): void => {
      if (!entry.started) entry.settle(notStarted('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await trigger()
      return await done
    } finally {
      clearTimeout(startTimer)
      signal.removeEventListener('abort', onAbort)
      if (this.armed.get(targetId) === entry) this.armed.delete(targetId)
    }
  }

  /**
   * Session `will-download` handler. Must decide synchronously: an armed
   * tab's download is saved into the inbox; anything else is cancelled.
   */
  offer(
    targetId: string | undefined,
    event: { preventDefault(): void },
    item: DownloadItemLike,
  ): 'accepted' | 'refused' | 'blocked' {
    const entry = targetId === undefined ? undefined : this.armed.get(targetId)
    if (entry === undefined || entry.started) {
      event.preventDefault()
      return 'blocked'
    }
    entry.started = true
    this.armed.delete(targetId!)
    const downloadId = this.newId()
    const url = item.getURL()
    const filename = safeDownloadName(item.getFilename())
    const mimeType = item.getMimeType() || undefined
    const base = {
      downloadId,
      filename,
      ...(mimeType === undefined ? {} : { mimeType }),
      url,
      origin: originOf(url),
    }
    if (isExecutableDownload(filename, mimeType)) {
      event.preventDefault()
      entry.settle({
        ...base,
        state: 'refused',
        bytes: 0,
        reason: 'executable files and installers are not downloaded',
      })
      return 'refused'
    }
    const total = item.getTotalBytes()
    if (total > entry.request.maxBytes) {
      event.preventDefault()
      entry.settle({
        ...base,
        state: 'too-large',
        bytes: total,
        reason: `larger than ${entry.request.maxBytes} bytes`,
      })
      return 'refused'
    }
    const path = this.uniquePath(entry.directory, filename)
    item.setSavePath(path)
    let tooLarge = false
    const timer = setTimeout(() => item.cancel(), entry.request.timeoutMs)
    item.on('updated', () => {
      if (item.getReceivedBytes() > entry.request.maxBytes) {
        tooLarge = true
        item.cancel()
      }
    })
    item.once('done', (_event, state) => {
      clearTimeout(timer)
      const bytes = item.getReceivedBytes()
      if (state !== 'completed') {
        entry.settle({
          ...base,
          state: tooLarge
            ? 'too-large'
            : state === 'cancelled'
              ? 'timed-out'
              : 'interrupted',
          bytes,
          reason: tooLarge
            ? `larger than ${entry.request.maxBytes} bytes`
            : state === 'cancelled'
              ? 'the download did not finish in time'
              : 'the download was interrupted',
        })
        return
      }
      void (this.options.hashFile ?? sha256File)(path).then(
        async (sha256) => {
          // Marked before the Agent hears of it; a file that cannot be
          // marked is kept, and the download list says so.
          const marked = await this.quarantine(path).then(
            () => true,
            (cause: unknown) => {
              console.warn(
                `Agent download ${downloadId} could not get the quarantine mark: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
              return false
            },
          )
          this.remember(downloadId, {
            path,
            ...(entry.request.ownerSessionId === undefined
              ? {}
              : { ownerSessionId: entry.request.ownerSessionId }),
            ...(base.origin === null ? {} : { origin: base.origin }),
            savedAt: (this.options.now ?? Date.now)(),
            bytes,
            ...(marked ? {} : { unmarked: true as const }),
          })
          entry.settle({
            ...base,
            filename: path.split(/[\\/]/).pop() ?? filename,
            state: 'completed',
            bytes,
            sha256,
          })
        },
        () =>
          entry.settle({
            ...base,
            state: 'interrupted',
            bytes,
            reason: 'the file could not be read back',
          }),
      )
    })
    return 'accepted'
  }

  /** Where a completed download is now (for "show in Finder"). */
  pathOf(downloadId: string): string | undefined {
    if (!DOWNLOAD_ID.test(downloadId)) return undefined
    this.loadIndex()
    return this.saved.get(downloadId)?.path
  }

  /** The conversation a completed download belongs to. */
  ownerOf(downloadId: string): string | undefined {
    if (!DOWNLOAD_ID.test(downloadId)) return undefined
    this.loadIndex()
    return this.saved.get(downloadId)?.ownerSessionId
  }

  /**
   * The completed downloads the inbox remembers, newest first, and whether
   * each file is still there. Entries saved before time and size were kept
   * read them from the file.
   */
  list(): InboxDownload[] {
    this.loadIndex()
    const exists = this.options.exists ?? existsSync
    return [...this.saved]
      .reverse()
      .map(([downloadId, entry]) => {
        const present = exists(entry.path)
        const file =
          present && (entry.savedAt === undefined || entry.bytes === undefined)
            ? fileFacts(entry.path)
            : null
        return {
          downloadId,
          name: basename(entry.path),
          path: entry.path,
          ...(entry.ownerSessionId === undefined
            ? {}
            : { ownerSessionId: entry.ownerSessionId }),
          ...(entry.origin === undefined ? {} : { origin: entry.origin }),
          time: entry.savedAt ?? file?.time ?? 0,
          bytes: entry.bytes ?? file?.bytes ?? 0,
          exists: present,
          ...(entry.unmarked ? { unmarked: true as const } : {}),
        }
      })
      .sort((a, b) => b.time - a.time)
  }

  /**
   * The user's "移到工作区": move a completed download into `directory`
   * under a unique name. Returns the new path, or undefined when the file
   * is gone.
   */
  async moveTo(
    downloadId: string,
    directory: string,
  ): Promise<string | undefined> {
    const from = this.pathOf(downloadId)
    if (from === undefined || !isAbsolute(directory)) return undefined
    if (!existsSync(from)) return undefined
    await mkdir(directory, { recursive: true })
    return await this.moveToFile(
      downloadId,
      this.uniquePath(directory, basename(from)),
    )
  }

  /**
   * The user's "另存为…": move a completed download to the exact path the
   * user chose in the system save dialog (it may replace that file).
   */
  async moveToFile(
    downloadId: string,
    target: string,
  ): Promise<string | undefined> {
    const from = this.pathOf(downloadId)
    if (from === undefined || !isAbsolute(target)) return undefined
    if (!existsSync(from)) return undefined
    if (from === target) return target
    try {
      await rename(from, target)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') throw cause
      await copyFile(from, target)
      await unlink(from)
    }
    this.remember(downloadId, { ...this.saved.get(downloadId)!, path: target })
    return target
  }

  /**
   * Retention (00 §10 保留策略): delete inbox files older than `days`
   * (0 keeps everything). Only files still inside the inbox are touched;
   * anything the user moved elsewhere is theirs. Returns how many went.
   */
  async sweep(days: number, now = Date.now()): Promise<number> {
    if (!(days > 0)) return 0
    const cutoff = now - days * 24 * 60 * 60 * 1000
    const root = this.options.root
    let removed = 0
    let buckets: string[]
    try {
      buckets = await readdir(root)
    } catch {
      return 0
    }
    for (const bucket of buckets) {
      if (bucket.startsWith('.')) continue
      const directory = join(root, bucket)
      let names: string[]
      try {
        if (!(await lstat(directory)).isDirectory()) continue
        names = await readdir(directory)
      } catch {
        continue
      }
      let kept = 0
      for (const name of names) {
        const file = join(directory, name)
        try {
          const info = await lstat(file)
          if (!info.isFile() || info.mtimeMs >= cutoff) {
            kept += 1
            continue
          }
          await unlink(file)
          removed += 1
        } catch {
          kept += 1
        }
      }
      if (kept === 0) await rmdir(directory).catch(() => undefined)
    }
    if (removed > 0) {
      this.loadIndex()
      for (const [id, entry] of [...this.saved])
        if (!existsSync(entry.path)) this.saved.delete(id)
      this.persistIndex()
    }
    return removed
  }

  private remember(downloadId: string, entry: SavedDownload): void {
    this.loadIndex()
    this.saved.delete(downloadId)
    this.saved.set(downloadId, entry)
    while (this.saved.size > INDEX_LIMIT) {
      const oldest = this.saved.keys().next().value
      if (oldest === undefined) break
      this.saved.delete(oldest)
    }
    this.persistIndex()
  }

  private persistIndex(): void {
    const indexPath = this.options.indexPath
    if (indexPath === undefined) return
    try {
      const temp = join(
        dirname(indexPath),
        `.index-${randomBytes(4).toString('hex')}.tmp`,
      )
      writeFileSync(
        temp,
        JSON.stringify({ version: 1, entries: [...this.saved] }),
        { mode: 0o600 },
      )
      renameSync(temp, indexPath)
    } catch {
      // best effort: the file itself is in the inbox either way
    }
  }

  private loadIndex(): void {
    if (this.indexLoaded) return
    this.indexLoaded = true
    const indexPath = this.options.indexPath
    if (indexPath === undefined) return
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as {
        version?: unknown
        entries?: unknown
      }
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return
      for (const item of parsed.entries.slice(-INDEX_LIMIT)) {
        if (!Array.isArray(item) || item.length !== 2) continue
        const [id, value] = item as [unknown, unknown]
        const entry = value as {
          path?: unknown
          ownerSessionId?: unknown
          origin?: unknown
          savedAt?: unknown
          bytes?: unknown
          unmarked?: unknown
        }
        if (
          typeof id !== 'string' ||
          !DOWNLOAD_ID.test(id) ||
          typeof entry?.path !== 'string' ||
          !isAbsolute(entry.path)
        )
          continue
        this.saved.set(id, {
          path: entry.path,
          ...(typeof entry.ownerSessionId === 'string'
            ? { ownerSessionId: entry.ownerSessionId.slice(0, 256) }
            : {}),
          ...(typeof entry.origin === 'string'
            ? { origin: entry.origin.slice(0, 512) }
            : {}),
          ...(count(entry.savedAt) ? { savedAt: entry.savedAt } : {}),
          ...(count(entry.bytes) ? { bytes: entry.bytes } : {}),
          ...(entry.unmarked === true ? { unmarked: true as const } : {}),
        })
      }
    } catch {
      // missing or unreadable: start empty
    }
  }

  private newId(): string {
    return `dl_${randomBytes(6).toString('hex')}`
  }

  private uniquePath(directory: string, filename: string): string {
    return uniqueDownloadPath(
      directory,
      filename,
      this.options.exists ?? existsSync,
    )
  }
}

/** A whole, non-negative number (time and size read from the index). */
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** When the file last changed and how big it is; null when unreadable. */
function fileFacts(path: string): { time: number; bytes: number } | null {
  try {
    const info = statSync(path)
    return { time: Math.round(info.mtimeMs), bytes: info.size }
  } catch {
    return null
  }
}
