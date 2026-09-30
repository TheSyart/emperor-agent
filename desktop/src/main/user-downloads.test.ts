import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { UserDownloadView } from '../shared/ipc-contract'
import {
  USER_DOWNLOAD_HISTORY_LIMIT,
  USER_DOWNLOAD_MAX_BYTES,
  UserDownloads,
  createQuarantine,
  type UserDownloadItem,
  type UserDownloadsOptions,
} from './user-downloads'

type Listener = (event: unknown, state: any) => void

class FakeItem implements UserDownloadItem {
  savePath = ''
  dialog: { defaultPath?: string } | null = null
  received = 0
  cancelled = false
  private readonly updated: Listener[] = []
  private done: Listener | null = null
  constructor(
    readonly filename: string,
    readonly total = 24,
    readonly mime = 'text/csv',
    readonly url = 'https://files.example/r/report.csv',
  ) {}
  getFilename = () => this.filename
  getMimeType = () => this.mime
  getTotalBytes = () => this.total
  getReceivedBytes = () => this.received
  getURL = () => this.url
  getSavePath = () => this.savePath
  setSavePath(path: string): void {
    this.savePath = path
  }
  setSaveDialogOptions(options: { defaultPath?: string }): void {
    this.dialog = options
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
  /** Chromium wrote the file where it was told to, then reports done. */
  complete(body = 'month,total\n'): void {
    writeFileSync(this.savePath, body)
    this.received = Buffer.byteLength(body)
    this.done?.({}, 'completed')
  }
  finish(state: 'completed' | 'cancelled' | 'interrupted'): void {
    this.done?.({}, state)
  }
}

const event = () => ({ preventDefault: vi.fn() })
const page = (url: string) => ({ getURL: () => url })

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function setup(
  choice: { folder?: string | null; ask?: boolean } = {},
  options: Partial<UserDownloadsOptions> = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'emperor-user-downloads-'))
  const system = join(home, 'Downloads')
  mkdirSync(system)
  const recordPath = join(home, '.emperor', 'browser', 'user-downloads.json')
  const preferences = {
    downloadDirectory: choice.folder ?? null,
    askWhereToSave: choice.ask ?? false,
  }
  const quarantined: string[] = []
  const views: UserDownloadView[] = []
  const clock = { now: 1_000 }
  const make = (extra: Partial<UserDownloadsOptions> = {}) =>
    new UserDownloads({
      recordPath,
      preferences: () => preferences,
      systemDownloads: () => system,
      notify: (view) => views.push(view),
      quarantine: async (path) => {
        quarantined.push(path)
      },
      now: () => clock.now,
      ...options,
      ...extra,
    })
  return {
    home,
    system,
    recordPath,
    preferences,
    quarantined,
    views,
    clock,
    make,
    downloads: make(),
  }
}

describe('your downloads: where they go', () => {
  it('saves straight into the chosen folder under a name of its own', async () => {
    const t = setup()
    const folder = join(t.home, 'web')
    mkdirSync(folder)
    writeFileSync(join(folder, 'report.csv'), 'older')
    t.preferences.downloadDirectory = folder
    const item = new FakeItem('../../report.csv')
    const offered = event()
    expect(
      t.downloads.offer(offered, item, page('https://news.example/a')),
    ).toBe('accepted')
    expect(offered.preventDefault).not.toHaveBeenCalled()
    expect(item.dialog).toBeNull()
    expect(item.savePath).toBe(join(folder, 'report (1).csv'))
    // Another download of the same name meanwhile gets the next one.
    const second = new FakeItem('report.csv')
    t.downloads.offer(event(), second, page('https://news.example/a'))
    expect(second.savePath).toBe(join(folder, 'report (2).csv'))
    item.complete()
    await settle()
    expect(t.quarantined).toEqual([join(folder, 'report (1).csv')])
    expect(readFileSync(join(folder, 'report.csv'), 'utf8')).toBe('older')
    expect(t.downloads.list()[1]).toMatchObject({
      name: 'report (1).csv',
      site: 'https://news.example',
      state: 'completed',
      bytes: 12,
      time: 1_000,
      exists: true,
    })
    expect(t.views.map((view) => [view.name, view.state])).toEqual([
      ['report (1).csv', 'progressing'],
      ['report (2).csv', 'progressing'],
      ['report (1).csv', 'completed'],
    ])
  })

  it('uses the system Downloads folder when none is set, or it is gone', () => {
    const t = setup()
    const into = (folder: string | null) => {
      t.preferences.downloadDirectory = folder
      const item = new FakeItem('notes.txt', 5, 'text/plain')
      t.downloads.offer(event(), item, page('https://a.example/'))
      return item.savePath
    }
    expect(into(null)).toBe(join(t.system, 'notes.txt'))
    expect(into(join(t.home, 'missing'))).toBe(join(t.system, 'notes (1).txt'))
    const file = join(t.home, 'a-file')
    writeFileSync(file, '')
    expect(into(file)).toBe(join(t.system, 'notes (2).txt'))
    expect(t.downloads.folder()).toBe(t.system)
  })

  it('asks where to save in the system dialog when the user wants that', async () => {
    const t = setup({ ask: true })
    const item = new FakeItem('Quarterly: report?.csv')
    expect(t.downloads.offer(event(), item, page('https://a.example/'))).toBe(
      'accepted',
    )
    expect(item.dialog).toEqual({
      defaultPath: join(t.system, 'Quarterly_ report_.csv'),
    })
    expect(item.savePath).toBe('')
    // The user picked another folder and name in the dialog.
    const chosen = join(t.home, 'picked.csv')
    item.savePath = chosen
    item.progress(4)
    item.complete()
    await settle()
    expect(t.downloads.list()[0]).toMatchObject({
      name: 'picked.csv',
      state: 'completed',
    })
    expect(t.downloads.completedFile(t.downloads.list()[0]!.id)).toBe(chosen)
    expect(t.quarantined).toEqual([chosen])
  })

  it('takes the page as the site, else where the file came from', () => {
    const t = setup()
    const site = (contents: { getURL(): string } | undefined, url: string) => {
      t.downloads.offer(
        event(),
        new FakeItem('a.csv', 1, 'text/csv', url),
        contents,
      )
      return t.downloads.list()[0]!.site
    }
    expect(site(page('https://news.example/x'), 'https://cdn.example/a')).toBe(
      'https://news.example',
    )
    expect(site(page('about:blank'), 'https://cdn.example/a')).toBe(
      'https://cdn.example',
    )
    expect(site(undefined, 'data:text/csv,a')).toBe('')
  })
})

describe('your downloads: the inbox checks', () => {
  it('refuses executables and installers before they download', () => {
    const t = setup()
    for (const [name, mime] of [
      ['setup.dmg', 'application/octet-stream'],
      ['tool', 'application/x-msdownload'],
      ['run.command.', 'text/plain'],
    ] as const) {
      const offered = event()
      const item = new FakeItem(name, 10, mime)
      expect(t.downloads.offer(offered, item, page('https://a.example/'))).toBe(
        'blocked',
      )
      expect(offered.preventDefault).toHaveBeenCalled()
      expect(item.savePath).toBe('')
    }
    expect(
      t.downloads.list().map((view) => [view.state, view.reason, view.bytes]),
    ).toEqual([
      ['blocked', 'executable', 0],
      ['blocked', 'executable', 0],
      ['blocked', 'executable', 0],
    ])
    expect(t.views.at(-1)).toMatchObject({
      name: 'run.command',
      state: 'blocked',
      reason: 'executable',
    })
  })

  it('stops a rename to an installer in the save dialog, and never deletes what was there', async () => {
    const t = setup({ ask: true })
    const item = new FakeItem('report.csv')
    t.downloads.offer(event(), item, page('https://a.example/'))
    // The user kept an older file under the chosen name.
    const chosen = join(t.home, 'report.pkg')
    writeFileSync(chosen, 'mine')
    item.savePath = chosen
    item.progress(4)
    expect(item.cancelled).toBe(true)
    await settle()
    expect(t.downloads.list()[0]).toMatchObject({
      name: 'report.pkg',
      state: 'blocked',
      reason: 'executable',
    })
    expect(readFileSync(chosen, 'utf8')).toBe('mine')
    expect(t.quarantined).toEqual([])
  })

  it('checks the saved name again when it finishes, and deletes a blocked file', async () => {
    const t = setup({ ask: true })
    const item = new FakeItem('report.csv')
    t.downloads.offer(event(), item, page('https://a.example/'))
    // Small files can finish before any progress update names the path.
    item.savePath = join(t.home, 'report.app')
    item.complete()
    await settle()
    expect(existsSync(item.savePath)).toBe(false)
    expect(t.downloads.list()[0]).toMatchObject({
      state: 'blocked',
      reason: 'executable',
    })
    expect(t.quarantined).toEqual([])
  })

  it('refuses files over the size limit, and stops one that grows past it', async () => {
    const t = setup({}, { maxBytes: 100 })
    const declared = event()
    expect(
      t.downloads.offer(
        declared,
        new FakeItem('big.zip', 101, 'application/zip'),
        page('https://a.example/'),
      ),
    ).toBe('blocked')
    expect(declared.preventDefault).toHaveBeenCalled()
    const streamed = new FakeItem('stream.zip', 0, 'application/zip')
    t.downloads.offer(event(), streamed, page('https://a.example/'))
    streamed.progress(101)
    expect(streamed.cancelled).toBe(true)
    await settle()
    expect(
      t.downloads.list().map((view) => [view.name, view.state, view.reason]),
    ).toEqual([
      ['stream.zip', 'blocked', 'too-large'],
      ['big.zip', 'blocked', 'too-large'],
    ])
    expect(USER_DOWNLOAD_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })

  it('completes even when the quarantine mark cannot be set', async () => {
    const t = setup(
      {},
      {
        quarantine: async () => {
          throw new Error('xattr failed')
        },
      },
    )
    const item = new FakeItem('report.csv')
    t.downloads.offer(event(), item, page('https://a.example/'))
    item.complete()
    await settle()
    expect(t.downloads.list()[0]?.state).toBe('completed')
  })

  it('records cancelled and interrupted downloads', async () => {
    const t = setup({ ask: true })
    const cancelled = new FakeItem('a.csv')
    t.downloads.offer(event(), cancelled, page('https://a.example/'))
    cancelled.finish('cancelled')
    const broken = new FakeItem('b.csv')
    t.downloads.offer(event(), broken, page('https://a.example/'))
    broken.finish('interrupted')
    await settle()
    expect(t.downloads.list().map((view) => view.state)).toEqual([
      'interrupted',
      'cancelled',
    ])
  })

  it('reports progress at most every 250 ms', () => {
    const t = setup()
    const item = new FakeItem('big.csv', 1_000)
    t.downloads.offer(event(), item, page('https://a.example/'))
    item.progress(100)
    t.clock.now += 100
    item.progress(200)
    t.clock.now += 200
    item.progress(300)
    expect(t.views.map((view) => view.bytes)).toEqual([0, 300])
    expect(t.views[1]).toMatchObject({
      state: 'progressing',
      totalBytes: 1_000,
    })
  })
})

describe('your downloads: the history', () => {
  it('lasts across restarts in a private file, newest first', async () => {
    const t = setup()
    const first = new FakeItem('a.csv')
    t.downloads.offer(event(), first, page('https://a.example/'))
    first.complete()
    t.clock.now += 1
    t.downloads.offer(
      event(),
      new FakeItem('setup.dmg', 1, 'application/x-apple-diskimage'),
      page('https://b.example/'),
    )
    const running = new FakeItem('c.csv')
    t.downloads.offer(event(), running, page('https://c.example/'))
    await settle()
    expect(statSync(t.recordPath).mode & 0o777).toBe(0o600)
    const onDisk = readFileSync(t.recordPath, 'utf8')
    expect(onDisk).not.toContain('files.example/r')
    const again = t.make()
    expect(again.list().map((view) => [view.name, view.state])).toEqual([
      // What was still downloading when Emperor quit did not finish.
      ['c.csv', 'interrupted'],
      ['setup.dmg', 'blocked'],
      ['a.csv', 'completed'],
    ])
    expect(again.list()[2]).toMatchObject({
      site: 'https://a.example',
      exists: true,
    })
  })

  it(`keeps the latest ${USER_DOWNLOAD_HISTORY_LIMIT}`, () => {
    const t = setup()
    for (let index = 0; index <= USER_DOWNLOAD_HISTORY_LIMIT; index += 1)
      t.downloads.offer(
        event(),
        new FakeItem(`app-${index}.exe`, 1, 'application/octet-stream'),
        page('https://a.example/'),
      )
    const list = t.make().list()
    expect(list).toHaveLength(USER_DOWNLOAD_HISTORY_LIMIT)
    expect(list[0]?.name).toBe(`app-${USER_DOWNLOAD_HISTORY_LIMIT}.exe`)
    expect(list.at(-1)?.name).toBe('app-1.exe')
  })

  it('drops entries from the list, and clears it, never the files', async () => {
    const t = setup()
    const done = new FakeItem('a.csv')
    t.downloads.offer(event(), done, page('https://a.example/'))
    done.complete()
    const running = new FakeItem('b.csv')
    t.downloads.offer(event(), running, page('https://a.example/'))
    t.downloads.offer(
      event(),
      new FakeItem('x.pkg', 1, 'application/octet-stream'),
      page('https://a.example/'),
    )
    await settle()
    const [blocked, progressing, completed] = t.downloads.list()
    expect(t.downloads.remove(progressing!.id)).toBe(false)
    expect(t.downloads.remove(blocked!.id)).toBe(true)
    expect(t.downloads.remove(blocked!.id)).toBe(false)
    expect(t.downloads.list().map((view) => view.name)).toEqual([
      'b.csv',
      'a.csv',
    ])
    t.downloads.clear()
    // A download still running carries on and stays listed.
    expect(t.downloads.list().map((view) => view.id)).toEqual([progressing!.id])
    expect(existsSync(done.savePath)).toBe(true)
    expect(
      t
        .make()
        .list()
        .map((view) => view.id),
    ).toEqual([progressing!.id])
    running.complete()
    await settle()
    expect(t.downloads.list()[0]).toMatchObject({
      id: progressing!.id,
      state: 'completed',
    })
    expect(completed!.state).toBe('completed')
  })

  it('opens and reveals only a finished file that is still there', async () => {
    const opened: string[] = []
    const revealed: string[] = []
    const t = setup(
      {},
      {
        openPath: async (path) => {
          opened.push(path)
          return ''
        },
        showItemInFolder: (path) => revealed.push(path),
      },
    )
    const done = new FakeItem('a.csv')
    t.downloads.offer(event(), done, page('https://a.example/'))
    done.complete()
    t.downloads.offer(
      event(),
      new FakeItem('x.pkg', 1, 'application/octet-stream'),
      page('https://a.example/'),
    )
    await settle()
    const [blocked, completed] = t.downloads.list()
    await expect(t.downloads.open(completed!.id)).resolves.toBe('')
    expect(t.downloads.reveal(completed!.id)).toBe(true)
    expect(opened).toEqual([done.savePath])
    expect(revealed).toEqual([done.savePath])
    await expect(t.downloads.open(blocked!.id)).resolves.toMatch(/找不到/)
    expect(t.downloads.reveal(blocked!.id)).toBe(false)
    expect(t.downloads.completedFile('ud_000000000000')).toBeUndefined()
    expect(t.downloads.completedFile('../etc/passwd')).toBeUndefined()
    // Moved away by the user: listed as gone, nothing to open.
    rmSync(done.savePath)
    expect(t.downloads.list()[1]?.exists).toBe(false)
    expect(t.downloads.reveal(completed!.id)).toBe(false)
    expect(opened).toHaveLength(1)
  })

  it('ignores a damaged or foreign history file', () => {
    const t = setup()
    mkdirSync(join(t.home, '.emperor', 'browser'), { recursive: true })
    writeFileSync(t.recordPath, '{not json')
    expect(t.make().list()).toEqual([])
    const good = {
      id: 'ud_0123456789ab',
      name: 'a.csv',
      site: 'https://a.example',
      path: join(t.system, 'a.csv'),
      time: 5,
      state: 'completed',
      bytes: 3,
    }
    writeFileSync(
      t.recordPath,
      JSON.stringify({
        version: 1,
        downloads: [
          good,
          { ...good, id: '../x' },
          { ...good, id: 'ud_0123456789ac', path: 'relative/a.csv' },
          { ...good, id: 'ud_0123456789ad', state: 'exploded' },
          { ...good, id: 'ud_0123456789ae', bytes: -1 },
          { ...good, id: 'ud_0123456789af', reason: 'because' },
          'nonsense',
        ],
      }),
    )
    expect(
      t
        .make()
        .list()
        .map((view) => view.id),
    ).toEqual(['ud_0123456789ab'])
  })
})

describe('quarantine mark', () => {
  it('marks a file the way macOS browsers do, and does nothing elsewhere', async () => {
    const calls: unknown[][] = []
    const execFile = (
      file: string,
      args: readonly string[],
      callback: (error: Error | null) => void,
    ) => {
      calls.push([file, args])
      callback(null)
    }
    const at = 0x6523_0000 * 1000
    await createQuarantine({ platform: 'darwin', execFile, now: () => at })(
      '/Users/me/Downloads/report.csv',
    )
    expect(calls).toEqual([
      [
        '/usr/bin/xattr',
        [
          '-w',
          'com.apple.quarantine',
          '0083;65230000;Emperor Agent;',
          '/Users/me/Downloads/report.csv',
        ],
      ],
    ])
    await createQuarantine({ platform: 'linux', execFile })('/tmp/a')
    await createQuarantine({ platform: 'win32', execFile })('C:\\a')
    expect(calls).toHaveLength(1)
    await expect(
      createQuarantine({
        platform: 'darwin',
        execFile: (_file, _args, callback) => callback(new Error('denied')),
      })('/x'),
    ).rejects.toThrow('denied')
  })
})
