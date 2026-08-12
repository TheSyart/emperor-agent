import chokidar, { type FSWatcher } from 'chokidar'
import { resolve } from 'node:path'

export interface SkillCatalogChange {
  catalogVersion: number
}

export class SkillChangeDetector {
  private watcher: FSWatcher | null = null
  private roots = new Set<string>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private catalogVersion = 0

  constructor(
    roots: readonly string[],
    private readonly onChange: (
      change: SkillCatalogChange,
    ) => void | Promise<void>,
    private readonly debounceMs = 300,
  ) {
    this.roots = normalizedRoots(roots)
  }

  get version(): number {
    return this.catalogVersion
  }

  async start(): Promise<void> {
    if (this.watcher) return
    const watcher = chokidar.watch([...this.roots], {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: Math.max(50, this.debounceMs),
        pollInterval: 25,
      },
    })
    this.watcher = watcher
    watcher.on('all', () => this.schedule())
    await new Promise<void>((resolveReady, reject) => {
      watcher.once('ready', resolveReady)
      watcher.once('error', reject)
    })
  }

  async setRoots(roots: readonly string[]): Promise<void> {
    const next = normalizedRoots(roots)
    const watcher = this.watcher
    if (watcher) {
      const removed = [...this.roots].filter((root) => !next.has(root))
      const added = [...next].filter((root) => !this.roots.has(root))
      if (removed.length) await watcher.unwatch(removed)
      if (added.length) watcher.add(added)
    }
    this.roots = next
  }

  async close(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    const watcher = this.watcher
    this.watcher = null
    if (watcher) await watcher.close()
  }

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.catalogVersion += 1
      void Promise.resolve(
        this.onChange({ catalogVersion: this.catalogVersion }),
      ).catch(() => {})
    }, this.debounceMs)
  }
}

function normalizedRoots(roots: readonly string[]): Set<string> {
  return new Set(
    roots
      .map((root) => String(root).trim())
      .filter(Boolean)
      .map((root) => resolve(root)),
  )
}
