import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  unlinkSync,
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
    quarantine: async () => undefined,
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

describe('download inbox list (设置 › 浏览器 › 下载历史记录)', () => {
  it('lists completed downloads newest first, with their conversation, site, time and size', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-inbox-list-'))
    const indexPath = join(root, '.index.json')
    const clock = { now: 1_000 }
    const box = new DownloadInbox({
      root,
      indexPath,
      hashFile: async () => 'd'.repeat(64),
      now: () => clock.now,
    })
    const receive = async (name: string, ownerSessionId?: string) => {
      const item = new FakeItem(name)
      const record = await box.receive(
        'tab_1',
        { ...request, ...(ownerSessionId ? { ownerSessionId } : {}) },
        async () => {
          box.offer('tab_1', event(), item)
          writeFileSync(item.savePath, 'abc')
          item.progress(3)
          item.finish()
        },
        new AbortController().signal,
      )
      return { record, path: item.savePath }
    }
    const first = await receive('a.csv', 's1')
    clock.now = 2_000
    const second = await receive('b.csv')
    // Refused and unfinished downloads never reach the inbox list.
    await box.receive(
      'tab_1',
      request,
      async () => {
        box.offer('tab_1', event(), new FakeItem('setup.dmg'))
      },
      new AbortController().signal,
    )
    expect(box.list()).toEqual([
      {
        downloadId: second.record.downloadId,
        name: 'b.csv',
        path: second.path,
        origin: 'https://files.test',
        time: 2_000,
        bytes: 3,
        exists: true,
      },
      {
        downloadId: first.record.downloadId,
        name: 'a.csv',
        path: first.path,
        ownerSessionId: 's1',
        origin: 'https://files.test',
        time: 1_000,
        bytes: 3,
        exists: true,
      },
    ])
    // Moved away by the user: still listed after a restart, as gone.
    unlinkSync(first.path)
    expect(new DownloadInbox({ root, indexPath }).list()[1]).toMatchObject({
      downloadId: first.record.downloadId,
      time: 1_000,
      bytes: 3,
      exists: false,
    })
  })

  it('reads the time and size of an entry saved before they were recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-inbox-legacy-'))
    const indexPath = join(root, '.index.json')
    const file = join(root, 'task-abcdef12', 'old.csv')
    mkdirSync(join(root, 'task-abcdef12'))
    writeFileSync(file, 'hello')
    utimesSync(file, 1_700_000_000, 1_700_000_000)
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: 1,
        entries: [
          ['dl_0123456789ab', { path: file, ownerSessionId: 's9' }],
          ['dl_0123456789ac', { path: join(root, 'gone.csv') }],
        ],
      }),
    )
    expect(new DownloadInbox({ root, indexPath }).list()).toEqual([
      {
        downloadId: 'dl_0123456789ab',
        name: 'old.csv',
        path: file,
        ownerSessionId: 's9',
        time: 1_700_000_000_000,
        bytes: 5,
        exists: true,
      },
      {
        downloadId: 'dl_0123456789ac',
        name: 'gone.csv',
        path: join(root, 'gone.csv'),
        time: 0,
        bytes: 0,
        exists: false,
      },
    ])
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

describe('download inbox source mark (SEC-10, MAIN-9)', () => {
  /** One completed download into a real temporary inbox. */
  async function completed(box: DownloadInbox, name = 'report.csv') {
    const item = new FakeItem(name)
    const record = await box.receive(
      'tab_1',
      request,
      async () => {
        expect(box.offer('tab_1', event(), item)).toBe('accepted')
        writeFileSync(item.savePath, 'a,b\n')
        item.progress(4)
        item.finish()
      },
      new AbortController().signal,
    )
    return { record, path: item.savePath }
  }

  it.skipIf(process.platform !== 'darwin')(
    'marks a finished inbox file with com.apple.quarantine',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-inbox-mark-'))
      const box = new DownloadInbox({
        root,
        indexPath: join(root, '.index.json'),
      })
      const { record, path } = await completed(box)
      expect(record.state).toBe('completed')
      const mark = execFileSync(
        '/usr/bin/xattr',
        ['-p', 'com.apple.quarantine', path],
        { encoding: 'utf8' },
      ).trim()
      expect(mark).toMatch(/^0083;[0-9a-f]+;Emperor Agent;$/)
      expect(box.list()[0]).not.toHaveProperty('unmarked')
    },
  )

  it('keeps a file whose mark could not be set, and says so after a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-inbox-unmarked-'))
    const indexPath = join(root, '.index.json')
    const marked: string[] = []
    const box = new DownloadInbox({
      root,
      indexPath,
      hashFile: async () => 'c'.repeat(64),
      quarantine: async (path) => {
        marked.push(path)
        throw new Error('xattr failed')
      },
    })
    const { record, path } = await completed(box)
    expect(record.state).toBe('completed')
    expect(marked).toEqual([path])
    expect(box.list()[0]).toMatchObject({
      downloadId: record.downloadId,
      unmarked: true,
    })
    expect(new DownloadInbox({ root, indexPath }).list()[0]?.unmarked).toBe(
      true,
    )
  })

  it('refuses a configuration profile (.mobileconfig)', async () => {
    const { box } = inbox()
    const offered = event()
    const record = await box.receive(
      'tab_1',
      request,
      async () => {
        expect(
          box.offer(
            'tab_1',
            offered,
            new FakeItem(
              'Wi-Fi.mobileconfig',
              10,
              'application/octet-stream',
              'https://files.test/Wi-Fi.mobileconfig',
            ),
          ),
        ).toBe('refused')
      },
      new AbortController().signal,
    )
    expect(offered.preventDefault).toHaveBeenCalled()
    expect(record).toMatchObject({ state: 'refused', bytes: 0 })
  })
})
