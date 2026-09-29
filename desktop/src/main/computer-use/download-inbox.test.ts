import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DownloadInbox, type DownloadItemLike } from './download-inbox'

type Listener = (event: unknown, state: any) => void

class FakeItem implements DownloadItemLike {
  savePath = ''
  received = 0
  cancelled = false
  private readonly updated: Listener[] = []
  private done: Listener | null = null
  constructor(
    readonly filename: string,
    readonly total = 10,
    readonly mime = 'text/csv',
    readonly url = 'https://files.test/r/report.csv',
  ) {}
  getFilename = () => this.filename
  getMimeType = () => this.mime
  getTotalBytes = () => this.total
  getReceivedBytes = () => this.received
  getURL = () => this.url
  setSavePath(path: string): void {
    this.savePath = path
  }
  cancel(): void {
    this.cancelled = true
    this.done?.({}, 'cancelled')
  }
  on(_event: 'updated', listener: Listener): this {
    this.updated.push(listener)
    return this
  }
  once(_event: 'done', listener: Listener): this {
    this.done = listener
    return this
  }
  progress(bytes: number): void {
    this.received = bytes
    for (const listener of this.updated) listener({}, 'progressing')
  }
  finish(state: 'completed' | 'interrupted' = 'completed'): void {
    this.done?.({}, state)
  }
}

function inbox(existing: string[] = []) {
  const made: string[] = []
  const box = new DownloadInbox({
    root: '/home/.emperor/browser/downloads',
    makeDirectory: async (path) => {
      made.push(path)
    },
    exists: (path) => existing.includes(path),
    hashFile: async () => 'a'.repeat(64),
  })
  return { box, made }
}

const request = {
  taskId: 'turn:s1:3',
  maxBytes: 100,
  timeoutMs: 5_000,
  startMs: 200,
}
const event = () => ({ preventDefault: vi.fn() })

describe('download inbox', () => {
  it('accepts the armed tab’s download into a per-task bucket and hashes it', async () => {
    const { box, made } = inbox(['/home/.emperor/browser/downloads/turn-s1-3-'])
    const item = new FakeItem('../../report.csv')
    const offered = event()
    const record = await box.receive(
      'tab_1',
      request,
      async () => {
        expect(box.offer('tab_1', offered, item)).toBe('accepted')
        item.progress(10)
        item.finish()
      },
      new AbortController().signal,
    )
    expect(made[0]).toMatch(/\/downloads\/turn-s1-3-[0-9a-f]{8}$/)
    expect(item.savePath).toBe(`${made[0]}/report.csv`)
    expect(offered.preventDefault).not.toHaveBeenCalled()
    expect(record).toMatchObject({
      state: 'completed',
      filename: 'report.csv',
      bytes: 10,
      sha256: 'a'.repeat(64),
      origin: 'https://files.test',
      mimeType: 'text/csv',
    })
    expect(box.pathOf(record.downloadId)).toBe(item.savePath)
    expect(box.pathOf('../etc')).toBeUndefined()
  })

  it('blocks downloads nobody armed, and a second download in the same arm', async () => {
    const { box } = inbox()
    const stray = event()
    expect(box.offer('tab_1', stray, new FakeItem('x.csv'))).toBe('blocked')
    expect(stray.preventDefault).toHaveBeenCalled()
    const second = event()
    await box.receive(
      'tab_1',
      request,
      async () => {
        const first = new FakeItem('a.csv')
        box.offer('tab_1', event(), first)
        expect(box.offer('tab_1', second, new FakeItem('b.csv'))).toBe(
          'blocked',
        )
        first.finish()
      },
      new AbortController().signal,
    )
    expect(second.preventDefault).toHaveBeenCalled()
  })

  it('refuses executables and files over the cap', async () => {
    const { box } = inbox()
    const refused = await box.receive(
      'tab_1',
      request,
      async () => {
        const offered = event()
        expect(box.offer('tab_1', offered, new FakeItem('setup.dmg'))).toBe(
          'refused',
        )
        expect(offered.preventDefault).toHaveBeenCalled()
      },
      new AbortController().signal,
    )
    expect(refused).toMatchObject({ state: 'refused', bytes: 0 })
    const byMime = await box.receive(
      'tab_1',
      request,
      async () => {
        box.offer(
          'tab_1',
          event(),
          new FakeItem('file', 5, 'application/x-msdownload'),
        )
      },
      new AbortController().signal,
    )
    expect(byMime.state).toBe('refused')
    const declared = await box.receive(
      'tab_1',
      request,
      async () => {
        box.offer('tab_1', event(), new FakeItem('big.zip', 500))
      },
      new AbortController().signal,
    )
    expect(declared).toMatchObject({ state: 'too-large', bytes: 500 })
    const streamed = new FakeItem('stream.zip', -1)
    const growing = await box.receive(
      'tab_1',
      request,
      async () => {
        box.offer('tab_1', event(), streamed)
        streamed.progress(101)
      },
      new AbortController().signal,
    )
    expect(growing.state).toBe('too-large')
    expect(streamed.cancelled).toBe(true)
  })

  it('keeps existing files and reports a download that never starts', async () => {
    const { box } = inbox()
    let bucket = ''
    const existing = new Set<string>()
    const named = new DownloadInbox({
      root: '/r',
      makeDirectory: async (path) => {
        bucket = path
        existing.add(`${path}/report.csv`)
      },
      exists: (path) => existing.has(path),
      hashFile: async () => 'b'.repeat(64),
    })
    const item = new FakeItem('report.csv')
    await named.receive(
      'tab_2',
      request,
      async () => {
        named.offer('tab_2', event(), item)
        item.finish()
      },
      new AbortController().signal,
    )
    expect(item.savePath).toBe(`${bucket}/report (1).csv`)
    const never = await box.receive(
      'tab_3',
      request,
      async () => undefined,
      new AbortController().signal,
    )
    expect(never).toMatchObject({ state: 'not-started' })
  })
})

describe('download inbox across restarts', () => {
  it('remembers completed downloads and moves one into the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-inbox-'))
    const indexPath = join(root, '.index.json')
    const box = new DownloadInbox({
      root,
      indexPath,
      hashFile: async () => 'b'.repeat(64),
    })
    const item = new FakeItem('report.csv')
    const record = await box.receive(
      'tab_1',
      { ...request, ownerSessionId: 's1' },
      async () => {
        expect(box.offer('tab_1', event(), item)).toBe('accepted')
        writeFileSync(item.savePath, 'a,b\n')
        item.progress(4)
        item.finish()
      },
      new AbortController().signal,
    )
    expect(record.state).toBe('completed')
    expect(statSync(indexPath).mode & 0o777).toBe(0o600)

    // A new process (restart) still finds the file and its conversation.
    const again = new DownloadInbox({ root, indexPath })
    expect(again.pathOf(record.downloadId)).toBe(item.savePath)
    expect(again.ownerOf(record.downloadId)).toBe('s1')

    const workspace = join(root, 'workspace')
    writeFileSync(join(root, 'taken.csv'), '')
    const moved = await again.moveTo(
      record.downloadId,
      join(workspace, 'downloads'),
    )
    expect(moved).toBe(join(workspace, 'downloads', 'report.csv'))
    expect(existsSync(item.savePath)).toBe(false)
    expect(existsSync(moved!)).toBe(true)
    expect(
      new DownloadInbox({ root, indexPath }).pathOf(record.downloadId),
    ).toBe(moved)
    // Unknown ids and relative destinations are refused.
    await expect(
      again.moveTo('dl_000000000000', workspace),
    ).resolves.toBeUndefined()
    await expect(
      again.moveTo(record.downloadId, 'relative/dir'),
    ).resolves.toBeUndefined()
  })
})

describe('download inbox retention and save as', () => {
  it('deletes only inbox files older than the retention period', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-inbox-sweep-'))
    const box = new DownloadInbox({
      root,
      indexPath: join(root, '.index.json'),
    })
    const bucket = join(root, 'task-1-abcdef12')
    mkdirSync(bucket)
    const old = join(bucket, 'old.csv')
    const fresh = join(bucket, 'fresh.csv')
    writeFileSync(old, 'a')
    writeFileSync(fresh, 'b')
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    utimesSync(old, (now - 40 * day) / 1000, (now - 40 * day) / 1000)
    const emptied = join(root, 'task-2-abcdef12')
    mkdirSync(emptied)
    writeFileSync(join(emptied, 'x.csv'), 'c')
    utimesSync(
      join(emptied, 'x.csv'),
      (now - 40 * day) / 1000,
      (now - 40 * day) / 1000,
    )

    expect(await box.sweep(0, now)).toBe(0)
    expect(await box.sweep(30, now)).toBe(2)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    // An emptied bucket goes too; the index file is never swept.
    expect(existsSync(emptied)).toBe(false)
  })

  it('moves a completed download to the path the user chose', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-inbox-save-'))
    const indexPath = join(root, '.index.json')
    const box = new DownloadInbox({
      root,
      indexPath,
      hashFile: async () => 'c'.repeat(64),
    })
    const item = new FakeItem('report.csv')
    const record = await box.receive(
      'tab_1',
      request,
      async () => {
        expect(box.offer('tab_1', event(), item)).toBe('accepted')
        writeFileSync(item.savePath, 'x')
        item.finish()
      },
      new AbortController().signal,
    )
    const target = join(root, 'elsewhere.csv')
    expect(await box.moveToFile(record.downloadId, target)).toBe(target)
    expect(existsSync(target)).toBe(true)
    expect(
      new DownloadInbox({ root, indexPath }).pathOf(record.downloadId),
    ).toBe(target)
    await expect(
      box.moveToFile(record.downloadId, 'relative.csv'),
    ).resolves.toBeUndefined()
  })
})
