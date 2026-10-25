/**
 * BUG-11: one recursive watch per project root, shared by its subscribers;
 * changes arrive in debounced batches of project-relative paths.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectFileWatcher, type FileChangeBatch } from './file-watch'

class FakeFsWatcher extends EventEmitter {
  closed = false
  close() {
    this.closed = true
  }
}

function fakeWatch() {
  const watchers: Array<{
    root: string
    watcher: FakeFsWatcher
    emit: (filename: string | null) => void
  }> = []
  const watch = vi.fn(
    (
      root: string,
      _options: unknown,
      listener: (event: string, filename: string | Buffer | null) => void,
    ) => {
      const watcher = new FakeFsWatcher()
      watchers.push({
        root,
        watcher,
        emit: (filename) => listener('change', filename),
      })
      return watcher
    },
  )
  return { watch, watchers }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ProjectFileWatcher (BUG-11)', () => {
  it('1 · batches a change after the debounce, as a project-relative path', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({ watch, debounceMs: 300 })
    const batches: FileChangeBatch[] = []
    files.subscribe('/p', (batch) => batches.push(batch))
    watchers[0]!.emit('src/app.ts')
    expect(batches).toEqual([])
    vi.advanceTimersByTime(300)
    expect(batches).toEqual([{ paths: ['src/app.ts'], overflow: false }])
  })

  it('2 · twenty quick writes make one batch with each path once', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({ watch, debounceMs: 300 })
    const batches: FileChangeBatch[] = []
    files.subscribe('/p', (batch) => batches.push(batch))
    for (let i = 0; i < 20; i++) {
      watchers[0]!.emit(i % 2 ? 'a.txt' : 'b.txt')
      vi.advanceTimersByTime(50)
    }
    vi.advanceTimersByTime(300)
    expect(batches).toEqual([{ paths: ['a.txt', 'b.txt'], overflow: false }])
  })

  it('3 · ignores .git and node_modules', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({ watch, debounceMs: 300 })
    const batches: FileChangeBatch[] = []
    files.subscribe('/p', (batch) => batches.push(batch))
    watchers[0]!.emit('.git/index')
    watchers[0]!.emit('node_modules/x/index.js')
    watchers[0]!.emit('packages/a/node_modules/y.js')
    vi.advanceTimersByTime(300)
    expect(batches).toEqual([])
  })

  it('4 · more than the path limit, or an unnamed change, is an overflow without paths', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({
      watch,
      debounceMs: 300,
      maxPaths: 3,
    })
    const batches: FileChangeBatch[] = []
    files.subscribe('/p', (batch) => batches.push(batch))
    for (const name of ['a', 'b', 'c', 'd']) watchers[0]!.emit(name)
    vi.advanceTimersByTime(300)
    watchers[0]!.emit(null)
    vi.advanceTimersByTime(300)
    expect(batches).toEqual([
      { paths: [], overflow: true },
      { paths: [], overflow: true },
    ])
  })

  it('5 · subscribers of one root share one watch; it closes a while after the last leaves', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({
      watch,
      debounceMs: 300,
      idleCloseMs: 5000,
    })
    const a: FileChangeBatch[] = []
    const b: FileChangeBatch[] = []
    const stopA = files.subscribe('/p', (batch) => a.push(batch))
    const stopB = files.subscribe('/p', (batch) => b.push(batch))
    expect(watch).toHaveBeenCalledTimes(1)
    watchers[0]!.emit('x.md')
    vi.advanceTimersByTime(300)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    stopA()
    stopB()
    vi.advanceTimersByTime(4999)
    expect(watchers[0]!.watcher.closed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(watchers[0]!.watcher.closed).toBe(true)
  })

  it('6 · a new subscriber within the idle time keeps the same watch', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({ watch, idleCloseMs: 5000 })
    files.subscribe('/p', () => undefined)()
    vi.advanceTimersByTime(1000)
    files.subscribe('/p', () => undefined)
    vi.advanceTimersByTime(10_000)
    expect(watch).toHaveBeenCalledTimes(1)
    expect(watchers[0]!.watcher.closed).toBe(false)
  })

  it('7 · a watch that fails tells its subscribers and is dropped, so the next one starts fresh', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({ watch })
    const failures: unknown[] = []
    files.subscribe(
      '/p',
      () => undefined,
      (error) => failures.push(error),
    )
    watchers[0]!.watcher.emit('error', new Error('EMFILE'))
    expect(failures).toHaveLength(1)
    expect(watchers[0]!.watcher.closed).toBe(true)
    files.subscribe('/p', () => undefined)
    expect(watch).toHaveBeenCalledTimes(2)
  })

  it('8 · a watch that cannot start reports it to the subscriber', () => {
    const files = new ProjectFileWatcher({
      watch: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      },
    })
    const failures: unknown[] = []
    files.subscribe(
      '/missing',
      () => undefined,
      (error) => failures.push(error),
    )
    expect(failures).toHaveLength(1)
  })

  it('9b · the root reported by its own name (FSEvents) is not a change', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({ watch })
    const batches: FileChangeBatch[] = []
    files.subscribe('/tmp/emperor-no-such-project', (batch) =>
      batches.push(batch),
    )
    watchers[0]!.emit('emperor-no-such-project')
    vi.advanceTimersByTime(1000)
    expect(batches).toEqual([])
  })

  it('9 · close() stops every watch and pending batch', () => {
    vi.useFakeTimers()
    const { watch, watchers } = fakeWatch()
    const files = new ProjectFileWatcher({ watch })
    const batches: FileChangeBatch[] = []
    files.subscribe('/p', (batch) => batches.push(batch))
    watchers[0]!.emit('a')
    files.close()
    vi.advanceTimersByTime(1000)
    expect(batches).toEqual([])
    expect(watchers[0]!.watcher.closed).toBe(true)
  })

  it.runIf(process.platform === 'darwin')(
    '10 · sees a real file written in a real folder (FSEvents)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-watch-'))
      const files = new ProjectFileWatcher({ debounceMs: 100 })
      try {
        const batch = new Promise<FileChangeBatch>((resolve) =>
          files.subscribe(root, (seen) => {
            if (seen.overflow || seen.paths.length) resolve(seen)
          }),
        )
        await new Promise((r) => setTimeout(r, 200))
        mkdirSync(join(root, 'docs'))
        writeFileSync(join(root, 'docs', 'new.md'), '# hi')
        const seen = await batch
        expect(seen.overflow || seen.paths.includes('docs/new.md')).toBe(true)
        expect(seen.paths).not.toContain(basename(root))
      } finally {
        files.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
    10_000,
  )
})
