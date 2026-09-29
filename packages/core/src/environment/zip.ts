import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, posix, win32 } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const DEFAULT_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_FILES = 1000
const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_PATH_BYTES = 4096
const DEFAULT_MAX_PATH_DEPTH = 64

export interface ExtractBoundedZipOptions {
  archive: string
  destination: string
  maxArchiveBytes?: number
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxPathBytes?: number
  maxPathDepth?: number
  /** Write Unix entries with an execute bit as 0700 (plugin scripts); everything else stays 0600. */
  preserveExecutable?: boolean
}

export interface ExtractBoundedZipResult {
  files: string[]
  totalBytes: number
}

interface ZipEntry {
  name: string
  rawName: Buffer
  flags: number
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  /** A Unix-made entry with any execute bit set. */
  executable: boolean
}

export function extractBoundedZip(
  opts: ExtractBoundedZipOptions,
): ExtractBoundedZipResult {
  const limits = {
    archive: boundedLimit(
      opts.maxArchiveBytes,
      DEFAULT_MAX_ARCHIVE_BYTES,
      DEFAULT_MAX_ARCHIVE_BYTES,
    ),
    files: boundedLimit(opts.maxFiles, DEFAULT_MAX_FILES, 10_000),
    file: boundedLimit(
      opts.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      DEFAULT_MAX_TOTAL_BYTES,
    ),
    total: boundedLimit(
      opts.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      DEFAULT_MAX_TOTAL_BYTES,
    ),
    path: boundedLimit(opts.maxPathBytes, DEFAULT_MAX_PATH_BYTES, 65_535),
    depth: boundedLimit(opts.maxPathDepth, DEFAULT_MAX_PATH_DEPTH, 256),
  }
  const stat = lstatSync(opts.archive)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limits.archive)
    throw new Error('unsafe ZIP archive or archive size limit exceeded')
  if (existsSync(opts.destination))
    throw new Error('ZIP destination already exists')
  const archive = readFileSync(opts.archive)
  if (archive.byteLength !== stat.size)
    throw new Error('ZIP archive changed while reading')
  const entries = readEntries(archive, limits)
  if (!entries.length) throw new Error('ZIP archive contains no regular files')
  const stage = `${opts.destination}.stage-${process.pid}-${randomBytes(5).toString('hex')}`
  mkdirSync(stage, { recursive: false })
  const files: string[] = []
  let totalBytes = 0
  try {
    for (const entry of entries) {
      const data = extractEntry(archive, entry, limits.file)
      totalBytes += data.byteLength
      if (totalBytes > limits.total)
        throw new Error('ZIP total size limit exceeded')
      const target = join(stage, ...entry.name.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data, {
        flag: 'wx',
        mode: opts.preserveExecutable && entry.executable ? 0o700 : 0o600,
      })
      files.push(entry.name)
    }
    renameSync(stage, opts.destination)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
  return { files: files.sort(), totalBytes }
}

function readEntries(
  archive: Buffer,
  limits: {
    files: number
    file: number
    total: number
    path: number
    depth: number
  },
): ZipEntry[] {
  const end = findEndOfCentralDirectory(archive)
  const disk = archive.readUInt16LE(end + 4)
  const centralDisk = archive.readUInt16LE(end + 6)
  const diskEntries = archive.readUInt16LE(end + 8)
  const entryCount = archive.readUInt16LE(end + 10)
  const centralSize = archive.readUInt32LE(end + 12)
  const centralOffset = archive.readUInt32LE(end + 16)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    entryCount > limits.files ||
    centralOffset + centralSize > end
  )
    throw new Error('invalid ZIP central directory or entry limit exceeded')
  const entries: ZipEntry[] = []
  const names = new Set<string>()
  let offset = centralOffset
  let declaredTotal = 0
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(archive, offset, 46)
    if (archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('invalid ZIP central directory entry')
    const madeBy = archive.readUInt16LE(offset + 4)
    const flags = archive.readUInt16LE(offset + 8)
    const method = archive.readUInt16LE(offset + 10)
    const crc = archive.readUInt32LE(offset + 16)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const externalAttributes = archive.readUInt32LE(offset + 38)
    const localOffset = archive.readUInt32LE(offset + 42)
    const recordLength = 46 + nameLength + extraLength + commentLength
    assertRange(archive, offset, recordLength)
    if ((flags & 0x1) !== 0 || (method !== 0 && method !== 8))
      throw new Error('unsafe or unsupported ZIP entry')
    if (uncompressedSize > limits.file)
      throw new Error('ZIP file size limit exceeded')
    declaredTotal += uncompressedSize
    if (declaredTotal > limits.total)
      throw new Error('ZIP total size limit exceeded')
    const rawName = Buffer.from(
      archive.subarray(offset + 46, offset + 46 + nameLength),
    )
    if (rawName.byteLength > limits.path)
      throw new Error('ZIP path length limit exceeded')
    const rawText = rawName.toString('utf8')
    if (rawText.includes('\u0000')) throw new Error('unsafe ZIP path')
    const directory = rawText.replace(/\\/g, '/').endsWith('/')
    const name = normalizeMember(rawText)
    if (name.split('/').length > limits.depth)
      throw new Error('ZIP path depth limit exceeded')
    assertRegularEntryType(madeBy, externalAttributes, directory)
    if (!directory) {
      const canonicalName = name.toLowerCase()
      if (names.has(canonicalName)) throw new Error('duplicate ZIP path')
      names.add(canonicalName)
      entries.push({
        name,
        rawName,
        flags,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localOffset,
        executable:
          madeBy >>> 8 === 3 && ((externalAttributes >>> 16) & 0o111) !== 0,
      })
    }
    offset += recordLength
  }
  if (offset !== centralOffset + centralSize)
    throw new Error('invalid ZIP central directory size')
  return entries
}

function extractEntry(
  archive: Buffer,
  entry: ZipEntry,
  maxFileBytes: number,
): Buffer {
  const offset = entry.localOffset
  assertRange(archive, offset, 30)
  if (archive.readUInt32LE(offset) !== 0x04034b50)
    throw new Error('invalid ZIP local header')
  const flags = archive.readUInt16LE(offset + 6)
  const method = archive.readUInt16LE(offset + 8)
  const nameLength = archive.readUInt16LE(offset + 26)
  const extraLength = archive.readUInt16LE(offset + 28)
  const dataOffset = offset + 30 + nameLength + extraLength
  assertRange(archive, offset, 30 + nameLength + extraLength)
  const localName = archive.subarray(offset + 30, offset + 30 + nameLength)
  if (
    flags !== entry.flags ||
    method !== entry.method ||
    !localName.equals(entry.rawName)
  )
    throw new Error('ZIP local header mismatch')
  assertRange(archive, dataOffset, entry.compressedSize)
  const compressed = archive.subarray(
    dataOffset,
    dataOffset + entry.compressedSize,
  )
  const data =
    entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: maxFileBytes })
  if (
    data.byteLength !== entry.uncompressedSize ||
    data.byteLength > maxFileBytes
  )
    throw new Error(
      'ZIP uncompressed size mismatch or file size limit exceeded',
    )
  if (crc32(data) !== entry.crc) throw new Error('ZIP CRC mismatch')
  return data
}

function normalizeMember(raw: string): string {
  const normalized = raw
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const rawParts = normalized.split('/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    rawParts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        hasUnsafePathCharacters(part) ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    )
  )
    throw new Error('unsafe ZIP path')
  const clean = posix.normalize(normalized)
  const parts = clean.split('/')
  if (
    clean === '.' ||
    clean.startsWith('../') ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('unsafe ZIP path')
  return parts.join('/')
}

function hasUnsafePathCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 || character === ':'
  })
}

function assertRegularEntryType(
  madeBy: number,
  externalAttributes: number,
  directory: boolean,
): void {
  if (madeBy >>> 8 !== 3) return
  const mode = (externalAttributes >>> 16) & 0xffff
  const type = mode & 0o170000
  const expected = directory ? 0o040000 : 0o100000
  if (type !== 0 && type !== expected)
    throw new Error('unsafe ZIP link or device entry')
}

function findEndOfCentralDirectory(archive: Buffer): number {
  if (archive.byteLength < 22) throw new Error('invalid ZIP archive')
  const minimum = Math.max(0, archive.byteLength - 65_557)
  for (let offset = archive.byteLength - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = archive.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === archive.byteLength) return offset
  }
  throw new Error('invalid ZIP end of central directory')
}

function assertRange(buffer: Buffer, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.byteLength
  )
    throw new Error('invalid ZIP bounds')
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error('invalid ZIP limit')
  return value
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
