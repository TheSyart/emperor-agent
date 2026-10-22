/**
 * Downloads from the user's own browsing (设置 › 浏览器 › 下载). The built-in
 * browser's memory-only session hands every `will-download` here, and the
 * choice is made inside that callback (Electron takes a save path only
 * there), from main's synchronous copy of the browser preferences:
 * - 下载前询问保存位置 on: Electron's own save dialog, opened at the download
 *   folder with a safe file name;
 * - off: straight into the download folder, under a name of its own
 *   (`report (1).csv`).
 * The folder is 设置 › 浏览器 › 下载 › 位置, or the system Downloads folder
 * while that is unset or no longer a folder.
 *
 * The Agent inbox's checks apply (download-inbox.ts, the same Core rules):
 * programs and installers are refused before the download, and again when
 * the save dialog gave one such a name (a file already written is deleted);
 * files over USER_DOWNLOAD_MAX_BYTES are refused or stopped; a finished file
 * gets the macOS quarantine mark, so Gatekeeper checks it before it first
 * runs.
 *
 * What happened is kept in `~/.emperor/browser/user-downloads.json` (0600,
 * replaced atomically): id, name, site (the page's origin, else the file's),
 * path, time, state and size of the latest USER_DOWNLOAD_HISTORY_LIMIT
 * downloads, never the address. 清除浏览数据 empties the list; the files
 * stay where they are.
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  isExecutableDownload,
  safeDownloadName,
} from '@emperor/core/host-capabilities'
import type {
  UserDownloadBlock,
  UserDownloadState,
  UserDownloadView,
} from '../shared/ipc-contract'
import {
  uniqueDownloadPath,
  type DownloadItemLike,
} from './computer-use/download-inbox'
import { createQuarantine } from './quarantine'

export { createQuarantine } from './quarantine'

/** The largest file your own browsing downloads (2 GiB). */
export const USER_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** How many downloads the history keeps; the oldest go first. */
export const USER_DOWNLOAD_HISTORY_LIMIT = 200

/** A running download reports its progress at most this often. */
const PROGRESS_INTERVAL_MS = 250

const RECORD_VERSION = 1
const DOWNLOAD_ID = /^ud_[0-9a-f]{12}$/
const STATES: ReadonlySet<string> = new Set<UserDownloadState>([
  'progressing',
  'completed',
  'cancelled',
  'interrupted',
  'blocked',
])
const BLOCKS: ReadonlySet<string> = new Set<UserDownloadBlock>([
  'executable',
  'too-large',
])
const FILE_GONE = '找不到这个下载文件，可能已被移走或删除'

export interface UserDownloadItem extends DownloadItemLike {
  getSavePath(): string
  setSaveDialogOptions(options: { defaultPath?: string }): void
}

export interface UserDownloadsOptions {
  /** `~/.emperor/browser/user-downloads.json`; absent: memory only. */
  readonly recordPath?: string
  /** 设置 › 浏览器 › 下载, read synchronously. */
  preferences(): {
    readonly downloadDirectory: string | null
    readonly askWhereToSave: boolean
  }
  /** The system Downloads folder (`app.getPath('downloads')`). */
  systemDownloads(): string
  /** A download started, moved on or ended (the 浏览器 pane shows it). */
  notify?(view: UserDownloadView): void
  /** Default: `createQuarantine()` (macOS `xattr`, nothing elsewhere). */
  quarantine?(path: string): Promise<void>
  /** `shell.openPath`: '' once opened, else why not. */
  openPath?(path: string): Promise<string>
  /** `shell.showItemInFolder`. */
  showItemInFolder?(path: string): void
  now?(): number
  readonly maxBytes?: number
}

interface UserDownloadRecord {
  readonly id: string
  name: string
  readonly site: string
  /** Where it goes; '' while the save dialog has not answered. */
  path: string
  readonly time: number
  state: UserDownloadState
  bytes: number
  reason?: UserDownloadBlock
}

export class UserDownloads {
  /** Oldest first. */
  private records: UserDownloadRecord[] = []
  private loaded = false
  /** Items still running, for their announced size. */
  private readonly running = new Map<string, UserDownloadItem>()
  /** Save paths running downloads were given, so two never share one. */
  private readonly reserved = new Set<string>()
  private readonly quarantine: (path: string) => Promise<void>

  private newerFile = false

  constructor(private readonly options: UserDownloadsOptions) {
    this.quarantine = options.quarantine ?? createQuarantine()
  }

  /** Where a download goes now: the chosen folder, else the system one. */
  folder(): string {
    const chosen = this.options.preferences().downloadDirectory
    return chosen !== null && isDirectory(chosen)
      ? chosen
      : this.options.systemDownloads()
  }

  /**
   * The session's `will-download` handler; decides synchronously. Refused
   * downloads are recorded as blocked and never start.
   */
  offer(
    event: { preventDefault(): void },
    item: UserDownloadItem,
    contents?: { getURL(): string } | null,
  ): 'accepted' | 'blocked' {
    this.load()
    const name = safeDownloadName(item.getFilename())
    const mimeType = item.getMimeType()
    const maxBytes = this.options.maxBytes ?? USER_DOWNLOAD_MAX_BYTES
    const total = item.getTotalBytes()
    const record: UserDownloadRecord = {
      id: `ud_${randomBytes(6).toString('hex')}`,
      name,
      site: siteOf(contents, item.getURL()),
      path: '',
      time: this.now(),
      state: 'progressing',
      bytes: 0,
    }
    const refused: UserDownloadBlock | null = isExecutableDownload(
      name,
      mimeType,
    )
      ? 'executable'
      : total > maxBytes
        ? 'too-large'
        : null
    if (refused !== null) {
      event.preventDefault()
      record.state = 'blocked'
      record.reason = refused
      if (refused === 'too-large') record.bytes = total
      this.add(record)
      return 'blocked'
    }
    const folder = this.folder()
    let reserved = ''
    if (this.options.preferences().askWhereToSave)
      item.setSaveDialogOptions({ defaultPath: join(folder, name) })
    else {
      reserved = uniqueDownloadPath(
        folder,
        name,
        (path) => this.reserved.has(path) || existsSync(path),
      )
      record.path = reserved
      record.name = basename(reserved)
      this.reserved.add(reserved)
      item.setSavePath(reserved)
    }
    this.running.set(record.id, item)
    this.add(record)
    this.follow(record, item, { mimeType, maxBytes, reserved })
    return 'accepted'
  }

  /** Your downloads, newest first. */
  list(): UserDownloadView[] {
    this.load()
    return [...this.records].reverse().map((record) => this.view(record))
  }

  /** The file of a completed download that is still there. */
  completedFile(id: string): string | undefined {
    if (!DOWNLOAD_ID.test(id)) return undefined
    this.load()
    const record = this.records.find((entry) => entry.id === id)
    return record?.state === 'completed' && fileExists(record.path)
      ? record.path
      : undefined
  }

  /** Open a completed download; '' once it opened, else why not. */
  async open(id: string): Promise<string> {
    const file = this.completedFile(id)
    if (file === undefined) return FILE_GONE
    return (await this.options.openPath?.(file)) ?? '无法打开这个文件'
  }

  /** Show a completed download in Finder; false when its file is gone. */
  reveal(id: string): boolean {
    const file = this.completedFile(id)
    if (file === undefined || !this.options.showItemInFolder) return false
    this.options.showItemInFolder(file)
    return true
  }

  /** Take a finished download off the list; the file stays. */
  remove(id: string): boolean {
    if (!DOWNLOAD_ID.test(id)) return false
    this.load()
    const index = this.records.findIndex((entry) => entry.id === id)
    if (index < 0 || this.records[index]!.state === 'progressing') return false
    this.records.splice(index, 1)
    this.persist()
    return true
  }

  /**
   * 清除浏览数据: forget every finished download. The files stay, and a
   * download still running carries on (and stays listed).
   */
  clear(): void {
    this.load()
    this.records = this.records.filter((entry) => entry.state === 'progressing')
    this.persist()
  }

  private follow(
    record: UserDownloadRecord,
    item: UserDownloadItem,
    rules: { mimeType: string; maxBytes: number; reserved: string },
  ): void {
    let stopped: UserDownloadBlock | null = null
    let named = false
    let reported = this.now()
    item.on('updated', () => {
      if (stopped !== null) return
      const received = item.getReceivedBytes()
      if (received > rules.maxBytes) {
        stopped = 'too-large'
        item.cancel()
        return
      }
      const path = item.getSavePath()
      if (path && !named) {
        // The save dialog answered: it may have given another name.
        named = true
        record.path = path
        record.name = basename(path)
        if (isExecutableDownload(record.name, rules.mimeType)) {
          stopped = 'executable'
          item.cancel()
          return
        }
      }
      record.bytes = received
      const now = this.now()
      if (now - reported < PROGRESS_INTERVAL_MS) return
      reported = now
      this.notify(record)
    })
    item.once('done', (_event, state) => {
      this.running.delete(record.id)
      if (rules.reserved) this.reserved.delete(rules.reserved)
      const path = item.getSavePath() || record.path
      if (path) {
        record.path = path
        record.name = basename(path)
      }
      record.bytes = item.getReceivedBytes()
      // Cancelled on purpose: nothing was written over what was there.
      if (stopped !== null) return this.settle(record, 'blocked', stopped)
      if (state !== 'completed') return this.settle(record, state)
      if (isExecutableDownload(record.name, rules.mimeType)) {
        try {
          unlinkSync(path)
        } catch {
          // Already gone.
        }
        return this.settle(record, 'blocked', 'executable')
      }
      void this.quarantine(path)
        .catch(() => undefined)
        .then(() => this.settle(record, 'completed'))
    })
  }

  private settle(
    record: UserDownloadRecord,
    state: UserDownloadState,
    reason?: UserDownloadBlock,
  ): void {
    record.state = state
    if (reason !== undefined) record.reason = reason
    // Dropped meanwhile (the list only keeps the latest): nothing to save.
    if (this.records.includes(record)) this.persist()
    this.notify(record)
  }

  private add(record: UserDownloadRecord): void {
    this.records.push(record)
    const extra = this.records.length - USER_DOWNLOAD_HISTORY_LIMIT
    if (extra > 0) this.records.splice(0, extra)
    this.persist()
    this.notify(record)
  }

  private notify(record: UserDownloadRecord): void {
    this.options.notify?.(this.view(record))
  }

  private view(record: UserDownloadRecord): UserDownloadView {
    const item = this.running.get(record.id)
    return {
      id: record.id,
      name: record.name,
      site: record.site,
      time: record.time,
      state: record.state,
      bytes: record.bytes,
      ...(record.state === 'progressing'
        ? { totalBytes: Math.max(0, item?.getTotalBytes() ?? 0) }
        : {}),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.state === 'completed'
        ? { exists: fileExists(record.path) }
        : {}),
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private persist(): void {
    const recordPath = this.options.recordPath
    // A newer Emperor's history file stays as it is (REL-03).
    if (recordPath === undefined || this.newerFile) return
    const directory = dirname(recordPath)
    const temp = join(
      directory,
      `.user-downloads-${randomBytes(4).toString('hex')}.tmp`,
    )
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(
        temp,
        JSON.stringify({ version: RECORD_VERSION, downloads: this.records }),
        { mode: 0o600 },
      )
      renameSync(temp, recordPath)
    } catch {
      // Best effort: the downloads themselves are not affected.
      try {
        unlinkSync(temp)
      } catch {
        // never written
      }
    }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const recordPath = this.options.recordPath
    if (recordPath === undefined) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(recordPath, 'utf8'))
    } catch {
      return // missing or damaged: start empty
    }
    if (isRecord(parsed) && Number(parsed.version) > RECORD_VERSION)
      this.newerFile = true
    if (
      !isRecord(parsed) ||
      parsed.version !== RECORD_VERSION ||
      !Array.isArray(parsed.downloads)
    )
      return
    this.records = parsed.downloads
      .flatMap((value) => {
        const record = storedRecord(value)
        return record === null ? [] : [record]
      })
      .slice(-USER_DOWNLOAD_HISTORY_LIMIT)
  }
}

/** A record read back; one still running when Emperor quit was cut off. */
function storedRecord(value: unknown): UserDownloadRecord | null {
  if (!isRecord(value)) return null
  const { id, name, site, path, time, state, bytes, reason } = value
  if (
    typeof id !== 'string' ||
    !DOWNLOAD_ID.test(id) ||
    typeof name !== 'string' ||
    name.length > 255 ||
    typeof site !== 'string' ||
    site.length > 512 ||
    typeof path !== 'string' ||
    (path !== '' && !isAbsolute(path)) ||
    !count(time) ||
    typeof state !== 'string' ||
    !STATES.has(state) ||
    !count(bytes) ||
    (reason !== undefined &&
      (typeof reason !== 'string' || !BLOCKS.has(reason)))
  )
    return null
  return {
    id,
    name,
    site,
    path,
    time,
    state:
      state === 'progressing' ? 'interrupted' : (state as UserDownloadState),
    bytes,
    ...(reason === undefined ? {} : { reason: reason as UserDownloadBlock }),
  }
}

/** The page's web origin, else the file's; '' when neither is one. */
function siteOf(
  contents: { getURL(): string } | null | undefined,
  url: string,
): string {
  let page = ''
  try {
    page = contents?.getURL() ?? ''
  } catch {
    // The tab closed meanwhile.
  }
  return webOrigin(page) || webOrigin(url)
}

function webOrigin(url: string): string {
  try {
    const origin = new URL(url).origin
    return origin.startsWith('http://') || origin.startsWith('https://')
      ? origin
      : ''
  } catch {
    return ''
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fileExists(path: string): boolean {
  return path !== '' && existsSync(path)
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
