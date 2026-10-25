/**
 * Project file changes for the 文件 pane (BUG-11).
 *
 * One recursive `fs.watch` per project root (FSEvents on macOS), shared by
 * every subscriber of that root and closed a while after the last one
 * leaves. Changes arrive in debounced batches of project-relative paths;
 * `.git/` and `node_modules/` are ignored, and a batch with more paths than
 * the limit (or a change the system could not name) is an overflow with no
 * paths: the reader re-reads what it shows. Read-only: nothing outside the
 * root is watched, and nothing is written. On macOS the watch also reports
 * the root folder itself by its own name (once at start, and when its
 * entries change); that is not a project path and is dropped.
 */
import { existsSync, watch as fsWatch } from 'node:fs'
import { basename, join } from 'node:path'

export interface FileChangeBatch {
  /** Project-relative paths with `/`, sorted; empty on overflow. */
  paths: string[]
  overflow: boolean
}

/** What the watcher needs of an `fs.watch` handle. */
interface WatchHandle {
  close(): void
  on(event: 'error', listener: (error: unknown) => void): unknown
}

type WatchFn = (
  root: string,
  options: { recursive: true; persistent: false },
  listener: (event: string, filename: string | Buffer | null) => void,
) => WatchHandle

export interface ProjectFileWatcherOptions {
  watch?: WatchFn
  debounceMs?: number
  /** Paths per batch before it becomes an overflow. */
  maxPaths?: number
  /** How long a root's watch outlives its last subscriber. */
  idleCloseMs?: number
}

interface Subscriber {
  onChange: (batch: FileChangeBatch) => void
  onError?: (error: unknown) => void
}

interface Root {
  watcher: WatchHandle
  subscribers: Set<Subscriber>
  pending: Set<string>
  overflow: boolean
  flushTimer?: ReturnType<typeof setTimeout>
  closeTimer?: ReturnType<typeof setTimeout>
}

const IGNORED = /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/u

export class ProjectFileWatcher {
  private readonly roots = new Map<string, Root>()
  private readonly watch: WatchFn
  private readonly debounceMs: number
  private readonly maxPaths: number
  private readonly idleCloseMs: number

  constructor(options: ProjectFileWatcherOptions = {}) {
    this.watch = options.watch ?? (fsWatch as unknown as WatchFn)
    this.debounceMs = options.debounceMs ?? 300
    this.maxPaths = options.maxPaths ?? 200
    this.idleCloseMs = options.idleCloseMs ?? 5000
  }

  /** Changes under `root` until the returned function is called. */
  subscribe(
    root: string,
    onChange: (batch: FileChangeBatch) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const subscriber: Subscriber = { onChange, ...(onError ? { onError } : {}) }
    let entry = this.roots.get(root)
    if (!entry) {
      try {
        entry = this.open(root)
      } catch (error) {
        onError?.(error)
        return () => undefined
      }
    }
    clearTimeout(entry.closeTimer)
    entry.subscribers.add(subscriber)
    const current = entry
    return () => {
      current.subscribers.delete(subscriber)
      if (current.subscribers.size || this.roots.get(root) !== current) return
      clearTimeout(current.closeTimer)
      current.closeTimer = setTimeout(
        () => this.drop(root, current),
        this.idleCloseMs,
      )
      current.closeTimer.unref?.()
    }
  }

  /** Stop every watch (Core shutdown). */
  close(): void {
    for (const [root, entry] of this.roots) this.drop(root, entry)
  }

  private open(root: string): Root {
    const entry = {
      subscribers: new Set<Subscriber>(),
      pending: new Set<string>(),
      overflow: false,
    } as unknown as Root
    const rootName = basename(root)
    entry.watcher = this.watch(
      root,
      { recursive: true, persistent: false },
      (_event, filename) => {
        // The root reported by its own name (FSEvents), unless the project
        // really holds an entry called that.
        if (filename !== null && String(filename) === rootName)
          if (!existsSync(join(root, rootName))) return
        this.record(entry, filename)
      },
    )
    entry.watcher.on('error', (error: unknown) => {
      const subscribers = [...entry.subscribers]
      this.drop(root, entry)
      for (const s of subscribers) s.onError?.(error)
    })
    this.roots.set(root, entry)
    return entry
  }

  private record(entry: Root, filename: string | Buffer | null): void {
    if (filename === null || filename === undefined) entry.overflow = true
    else {
      const path = String(filename).replaceAll('\\', '/').replace(/^\.\//u, '')
      if (!path || IGNORED.test(path)) return
      entry.pending.add(path)
      if (entry.pending.size > this.maxPaths) entry.overflow = true
    }
    clearTimeout(entry.flushTimer)
    entry.flushTimer = setTimeout(() => this.flush(entry), this.debounceMs)
    entry.flushTimer.unref?.()
  }

  private flush(entry: Root): void {
    const batch: FileChangeBatch = entry.overflow
      ? { paths: [], overflow: true }
      : { paths: [...entry.pending].sort(), overflow: false }
    entry.pending.clear()
    entry.overflow = false
    for (const s of [...entry.subscribers]) s.onChange(batch)
  }

  private drop(root: string, entry: Root): void {
    clearTimeout(entry.flushTimer)
    clearTimeout(entry.closeTimer)
    entry.subscribers.clear()
    entry.pending.clear()
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    if (this.roots.get(root) === entry) this.roots.delete(root)
  }
}
