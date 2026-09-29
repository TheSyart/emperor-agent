import { describe, expect, it } from 'vitest'
import {
  downloadBucket,
  isExecutableDownload,
  safeDownloadName,
} from './downloads'

describe('download inbox rules', () => {
  it.each([
    'setup.exe',
    'Setup.EXE',
    'x.exe.',
    'x.exe . ',
    'installer.dmg',
    'tool.pkg',
    'run.sh',
    'App.app',
  ])('refuses %s', (name) => expect(isExecutableDownload(name)).toBe(true))

  it.each(['report.pdf', 'data.csv', 'archive.zip', 'photo.png', 'README'])(
    'accepts %s',
    (name) => expect(isExecutableDownload(name)).toBe(false),
  )

  it('refuses executable MIME types whatever the name', () => {
    expect(
      isExecutableDownload('file.bin.txt', 'application/x-msdownload'),
    ).toBe(true)
    expect(isExecutableDownload('file.txt', 'text/plain; charset=utf-8')).toBe(
      false,
    )
  })

  it('makes names safe and keeps checks on the saved name', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('passwd')
    expect(safeDownloadName('..\\\\evil.txt')).toBe('evil.txt')
    expect(safeDownloadName('a<b>:c|d?.txt')).toBe('a_b__c_d_.txt')
    expect(safeDownloadName('.hidden')).toBe('hidden')
    expect(safeDownloadName('x.exe.')).toBe('x.exe')
    expect(isExecutableDownload(safeDownloadName('x.exe:stream'))).toBe(false)
    expect(safeDownloadName('   ')).toBe('download')
    const long = `${'a'.repeat(200)}.pdf`
    expect(safeDownloadName(long)).toHaveLength(120)
    expect(safeDownloadName(long).endsWith('.pdf')).toBe(true)
  })

  it('turns task ids into distinct safe bucket names', () => {
    expect(downloadBucket('task/../1')).toMatch(/^task-1-[0-9a-f]{8}$/)
    expect(downloadBucket('a b')).not.toBe(downloadBucket('a/b'))
    // No dots or slashes survive, so a bucket can never leave the inbox.
    expect(downloadBucket('***')).toMatch(/^-+[0-9a-f]{8}$/)
    expect(downloadBucket('..')).not.toMatch(/[./]/)
  })
})
