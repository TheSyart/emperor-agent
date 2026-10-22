import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractBoundedZip } from './zip'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-zip-'))
}

describe('extractBoundedZip', () => {
  it('extracts regular stored files into a new destination', () => {
    const base = root()
    const archive = join(base, 'tool.zip')
    const destination = join(base, 'tool')
    writeFileSync(
      archive,
      zip([
        { name: 'bin/rg.exe', data: Buffer.from('binary') },
        { name: 'LICENSE', data: Buffer.from('license') },
      ]),
    )

    const result = extractBoundedZip({ archive, destination })

    expect(result.files).toEqual(['LICENSE', 'bin/rg.exe'])
    expect(readFileSync(join(destination, 'bin', 'rg.exe'), 'utf8')).toBe(
      'binary',
    )
  })

  it('keeps the owner execute bit only when asked, as 0700; everything else is 0600', () => {
    const base = root()
    const archive = join(base, 'plugin.zip')
    writeFileSync(
      archive,
      zip([
        {
          name: 'bin/server',
          data: Buffer.from('#!/bin/sh'),
          unixMode: 0o100755,
        },
        { name: 'README.md', data: Buffer.from('readme'), unixMode: 0o100644 },
      ]),
    )
    const mode = (path: string) => statSync(path).mode & 0o777
    const kept = join(base, 'kept')
    extractBoundedZip({ archive, destination: kept, preserveExecutable: true })
    expect(mode(join(kept, 'bin', 'server'))).toBe(0o700)
    expect(mode(join(kept, 'README.md'))).toBe(0o600)
    const plain = join(base, 'plain')
    extractBoundedZip({ archive, destination: plain })
    expect(mode(join(plain, 'bin', 'server'))).toBe(0o600)
  })

  it('rejects traversal, absolute, and drive-letter members', () => {
    for (const name of [
      '../escape.exe',
      'a/../escape.exe',
      '/absolute.exe',
      'C:/escape.exe',
    ]) {
      const base = root()
      const archive = join(base, 'tool.zip')
      writeFileSync(archive, zip([{ name, data: Buffer.from('bad') }]))

      expect(() =>
        extractBoundedZip({ archive, destination: join(base, 'tool') }),
      ).toThrow(/unsafe|path/i)
      expect(existsSync(join(base, 'escape.exe'))).toBe(false)
    }
  })

  it('rejects symlink entries from Unix-created archives', () => {
    const base = root()
    const archive = join(base, 'tool.zip')
    writeFileSync(
      archive,
      zip([
        {
          name: 'link.exe',
          data: Buffer.from('target.exe'),
          unixMode: 0o120777,
        },
      ]),
    )

    expect(() =>
      extractBoundedZip({ archive, destination: join(base, 'tool') }),
    ).toThrow(/link|unsafe/i)
  })

  it('skips and lists symlink entries when asked to (KRN-13)', () => {
    const base = root()
    const archive = join(base, 'tool.zip')
    writeFileSync(
      archive,
      zip([
        { name: 'kept.txt', data: Buffer.from('kept') },
        {
          name: 'link.txt',
          data: Buffer.from('kept.txt'),
          unixMode: 0o120777,
        },
      ]),
    )
    const result = extractBoundedZip({
      archive,
      destination: join(base, 'tool'),
      skipLinks: true,
    })
    expect(result.files).toEqual(['kept.txt'])
    expect(result.skippedLinks).toEqual(['link.txt'])
    expect(existsSync(join(base, 'tool', 'link.txt'))).toBe(false)
  })

  it('still refuses a device entry when links are skipped', () => {
    const base = root()
    const archive = join(base, 'tool.zip')
    writeFileSync(
      archive,
      zip([{ name: 'dev', data: Buffer.from(''), unixMode: 0o060644 }]),
    )
    expect(() =>
      extractBoundedZip({
        archive,
        destination: join(base, 'tool'),
        skipLinks: true,
      }),
    ).toThrow(/unsafe/i)
  })

  it('enforces entry, per-file, and total uncompressed limits', () => {
    const base = root()
    const archive = join(base, 'tool.zip')
    writeFileSync(
      archive,
      zip([
        { name: 'a', data: Buffer.alloc(8) },
        { name: 'b', data: Buffer.alloc(8) },
      ]),
    )

    expect(() =>
      extractBoundedZip({
        archive,
        destination: join(base, 'entry-limit'),
        maxFiles: 1,
      }),
    ).toThrow(/file|entry|limit/i)
    expect(() =>
      extractBoundedZip({
        archive,
        destination: join(base, 'file-limit'),
        maxFileBytes: 4,
      }),
    ).toThrow(/file|size|limit/i)
    expect(() =>
      extractBoundedZip({
        archive,
        destination: join(base, 'total-limit'),
        maxTotalBytes: 12,
      }),
    ).toThrow(/total|size|limit/i)
  })

  it('rejects case-folded duplicates and excessive path depth', () => {
    const base = root()
    const duplicate = join(base, 'duplicate.zip')
    writeFileSync(
      duplicate,
      zip([
        { name: 'Skill/SKILL.md', data: Buffer.from('first') },
        { name: 'skill/skill.md', data: Buffer.from('second') },
      ]),
    )
    expect(() =>
      extractBoundedZip({
        archive: duplicate,
        destination: join(base, 'duplicate'),
      }),
    ).toThrow(/duplicate/i)

    const deep = join(base, 'deep.zip')
    writeFileSync(
      deep,
      zip([
        {
          name: `${Array.from({ length: 65 }, () => 'a').join('/')}/file`,
          data: Buffer.from('deep'),
        },
      ]),
    )
    expect(() =>
      extractBoundedZip({ archive: deep, destination: join(base, 'deep') }),
    ).toThrow(/depth|path/i)

    for (const name of ['skill/CON', 'skill/file.', 'skill/file:stream']) {
      const archive = join(base, `${Buffer.from(name).toString('hex')}.zip`)
      writeFileSync(archive, zip([{ name, data: Buffer.from('unsafe') }]))
      expect(() =>
        extractBoundedZip({
          archive,
          destination: join(base, `${Buffer.from(name).toString('hex')}-out`),
        }),
      ).toThrow(/unsafe|path/i)
    }

    const unicode = join(base, 'unicode.zip')
    writeFileSync(
      unicode,
      zip([
        { name: 'skill/caf\u00e9', data: Buffer.from('first') },
        { name: 'skill/cafe\u0301', data: Buffer.from('second') },
      ]),
    )
    expect(() =>
      extractBoundedZip({
        archive: unicode,
        destination: join(base, 'unicode'),
      }),
    ).toThrow(/duplicate/i)
  })
})

function zip(
  entries: Array<{ name: string; data: Buffer; unixMode?: number }>,
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.byteLength, 18)
    local.writeUInt32LE(entry.data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.byteLength, 20)
    central.writeUInt32LE(entry.data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.byteLength + name.byteLength + entry.data.byteLength
  }
  const centralSize = centralParts.reduce(
    (size, part) => size + part.byteLength,
    0,
  )
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
