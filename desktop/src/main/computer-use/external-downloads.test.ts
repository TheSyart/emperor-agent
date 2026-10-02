import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExternalDownloadLog } from './external-downloads'

function path(): string {
  return join(mkdtempSync(join(tmpdir(), 'external-downloads-')), 'log.json')
}

const entry = (id: string, time: number) => ({
  id,
  name: `${id}.pdf`,
  origin: 'https://files.example',
  browser: 'chrome' as const,
  state: 'completed' as const,
  bytes: 10,
  time,
})

describe('ExternalDownloadLog (下载历史记录 › Emperor 的下载, from Chrome/Edge)', () => {
  it('lists what it recorded, newest first, as Emperor downloads that left no file here', () => {
    const log = new ExternalDownloadLog(path())
    log.record(entry('xd_000000000001', 1_000))
    log.record({
      ...entry('xd_000000000002', 2_000),
      browser: 'edge',
      state: 'refused',
      reason: 'executable',
      bytes: 0,
    })
    expect(log.list()).toEqual([
      {
        downloadId: 'xd_000000000002',
        name: 'xd_000000000002.pdf',
        origin: 'https://files.example',
        time: 2_000,
        bytes: 0,
        exists: false,
        browser: 'edge',
        state: 'refused',
        reason: 'executable',
      },
      {
        downloadId: 'xd_000000000001',
        name: 'xd_000000000001.pdf',
        origin: 'https://files.example',
        time: 1_000,
        bytes: 10,
        exists: false,
        browser: 'chrome',
        state: 'completed',
      },
    ])
  })

  it('updates an entry in place and keeps it across restarts in a private file', () => {
    const file = path()
    const log = new ExternalDownloadLog(file)
    log.record({ ...entry('xd_000000000003', 1_000), state: 'refused' })
    log.record(entry('xd_000000000003', 3_000))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(new ExternalDownloadLog(file).list()).toEqual([
      expect.objectContaining({
        downloadId: 'xd_000000000003',
        state: 'completed',
        time: 3_000,
      }),
    ])
  })

  it('keeps the latest 200 and reads a damaged file as empty', () => {
    const file = path()
    const log = new ExternalDownloadLog(file)
    for (let index = 0; index < 205; index += 1)
      log.record(entry(`xd_${String(index).padStart(12, '0')}`, index))
    expect(log.list()).toHaveLength(200)
    expect(log.list().at(-1)?.downloadId).toBe('xd_000000000005')
    expect(JSON.parse(readFileSync(file, 'utf8')).entries).toHaveLength(200)
    writeFileSync(file, '{ broken')
    expect(new ExternalDownloadLog(file).list()).toEqual([])
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          entry('not-an-id', 1),
          { ...entry('xd_000000000009', 1), state: 'odd' },
        ],
      }),
    )
    expect(new ExternalDownloadLog(file).list()).toEqual([])
  })
})
