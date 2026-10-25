import {
  closeSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  resolveOwnedProject,
  WorkspaceOperationError,
  type ResolveWorkspaceProject,
  type WorkspaceProjectScope,
} from './common'

export interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'symlink'
  targetKind?: 'directory' | 'file' | 'other'
  bytes: number
  modifiedAt: number
  hidden: boolean
}

export interface WorkspaceFileListResult {
  projectRoot: string
  relativePath: string
  entries: WorkspaceFileEntry[]
  nextCursor: string | null
  /** The service stopped at its hard scan bound; results are intentionally partial. */
  truncated: boolean
}

export interface WorkspaceFileReadResult {
  projectRoot: string
  relativePath: string
  name: string
  /**
   * `video`, `audio`: never read here; the Files pane plays them
   * (files.mediaUrl). `document` (PDF, Office, iWork, RTF): read by the
   * preview converters (preview-convert.ts), not here (BUG-10).
   */
  kind: 'text' | 'image' | 'binary' | 'video' | 'audio' | 'document'
  mimeType: string
  bytes: number
  /** mtime (ms) of the file read; absent for recorded turn snapshots. */
  modifiedAt?: number
  truncated: boolean
  content?: string
  /** Text that is not UTF-8: `UTF-16LE`, `UTF-16BE` or `GB18030` (BUG-10). */
  encoding?: string
  dataBase64?: string
}

/** Size and mtime of a file, to tell whether a preview is still current. */
export interface WorkspaceFileStat {
  bytes: number
  modifiedAt: number
}

export interface WorkspaceFilesServiceOptions {
  resolveProject: ResolveWorkspaceProject
  maxTextBytes?: number
  maxImageBytes?: number
  maxDirectoryEntries?: number
  maxSearchEntries?: number
  filterIgnored?: (
    sessionId: string,
    projectRoot: string,
    paths: string[],
  ) => Promise<Set<string>>
}

export class WorkspaceFilesService {
  private readonly resolveProject: ResolveWorkspaceProject
  private readonly maxTextBytes: number
  private readonly maxImageBytes: number
  private readonly maxDirectoryEntries: number
  private readonly maxSearchEntries: number
  private readonly filterIgnored?: WorkspaceFilesServiceOptions['filterIgnored']
  private readonly searchCache = new Map<
    string,
    { expiresAt: number; entries: WorkspaceFileEntry[]; truncated: boolean }
  >()
  private readonly listCache = new Map<
    string,
    {
      expiresAt: number
      entries: WorkspaceFileEntry[]
      relativePath: string
      truncated: boolean
    }
  >()

  constructor(options: WorkspaceFilesServiceOptions) {
    this.resolveProject = options.resolveProject
    this.maxTextBytes = options.maxTextBytes ?? 1024 * 1024
    this.maxImageBytes = options.maxImageBytes ?? 8 * 1024 * 1024
    this.maxDirectoryEntries = options.maxDirectoryEntries ?? 20_000
    this.maxSearchEntries = options.maxSearchEntries ?? 20_000
    this.filterIgnored = options.filterIgnored
  }

  async list(input: {
    sessionId: string
    relativePath: string
    cursor?: string
    limit?: number
    showHidden?: boolean
    showIgnored?: boolean
  }): Promise<WorkspaceFileListResult> {
    const scope = this.scope(input.sessionId)
    const canonicalRoot = realpathSync(scope.projectRoot)
    const target = resolveSafePath(scope.projectRoot, input.relativePath, true)
    if (!statSync(target).isDirectory())
      throw new WorkspaceOperationError(
        'workspace_path_not_directory',
        '目标路径不是目录。',
      )

    const cacheKey = JSON.stringify([
      input.sessionId,
      canonicalRoot,
      target,
      Boolean(input.showHidden),
      Boolean(input.showIgnored),
    ])
    const cached = this.listCache.get(cacheKey)
    let visibleEntries: WorkspaceFileEntry[]
    let truncated: boolean
    let resultRelativePath: string
    if (cached && cached.expiresAt > Date.now()) {
      visibleEntries = cached.entries
      truncated = cached.truncated
      resultRelativePath = cached.relativePath
    } else {
      if (cached) this.listCache.delete(cacheKey)
      const entries: WorkspaceFileEntry[] = []
      let visited = 0
      let reachedBound = false
      const directory = await opendir(target)
      for await (const item of directory) {
        if (visited >= this.maxDirectoryEntries) {
          reachedBound = true
          break
        }
        visited += 1
        if (visited % 256 === 0) await yieldToEventLoop()
        if (item.name === '.git') continue
        if (!input.showHidden && item.name.startsWith('.')) continue
        const fullPath = resolve(target, item.name)
        let metadata
        let symlinkTarget: string | null = null
        try {
          metadata = await lstat(fullPath)
          if (metadata.isSymbolicLink())
            symlinkTarget = resolveSafePath(
              scope.projectRoot,
              relative(canonicalRoot, fullPath),
              true,
            )
        } catch {
          continue
        }
        entries.push({
          name: item.name,
          path: toProjectPath(canonicalRoot, fullPath),
          kind: metadata.isSymbolicLink()
            ? 'symlink'
            : metadata.isDirectory()
              ? 'directory'
              : 'file',
          ...(symlinkTarget
            ? { targetKind: targetKindFor(symlinkTarget) }
            : {}),
          bytes: metadata.size,
          modifiedAt: metadata.mtimeMs,
          hidden: item.name.startsWith('.'),
        })
      }
      visibleEntries = await this.withoutIgnored(
        input.sessionId,
        scope.projectRoot,
        entries,
        input.showIgnored,
      )
      visibleEntries.sort((left, right) => left.name.localeCompare(right.name))
      truncated = reachedBound
      resultRelativePath = toProjectPath(canonicalRoot, target)
      this.listCache.set(cacheKey, {
        expiresAt: Date.now() + 5_000,
        entries: visibleEntries,
        relativePath: resultRelativePath,
        truncated,
      })
      trimCache(this.listCache)
    }
    const { page, nextCursor } = paginate(
      visibleEntries,
      input.cursor,
      input.limit,
    )
    return {
      projectRoot: scope.projectRoot,
      relativePath: resultRelativePath,
      entries: page,
      nextCursor,
      truncated,
    }
  }

  async search(input: {
    sessionId: string
    query: string
    cursor?: string
    limit?: number
    showHidden?: boolean
    showIgnored?: boolean
  }): Promise<WorkspaceFileListResult> {
    const scope = this.scope(input.sessionId)
    const canonicalRoot = realpathSync(scope.projectRoot)
    const query = input.query.trim().toLocaleLowerCase()
    if (!query)
      return {
        projectRoot: scope.projectRoot,
        relativePath: '',
        entries: [],
        nextCursor: null,
        truncated: false,
      }

    const cacheKey = JSON.stringify([
      input.sessionId,
      canonicalRoot,
      query,
      Boolean(input.showHidden),
      Boolean(input.showIgnored),
    ])
    const cached = this.searchCache.get(cacheKey)
    let visibleResults: WorkspaceFileEntry[]
    let truncated: boolean
    if (cached && cached.expiresAt > Date.now()) {
      visibleResults = cached.entries
      truncated = cached.truncated
    } else {
      if (cached) this.searchCache.delete(cacheKey)
      const results: WorkspaceFileEntry[] = []
      const pending = [canonicalRoot]
      let visited = 0
      let reachedBound = false
      search: while (pending.length > 0 && visited < this.maxSearchEntries) {
        const directoryPath = pending.pop()
        if (!directoryPath) break
        let directory
        try {
          directory = await opendir(directoryPath)
        } catch {
          continue
        }
        for await (const item of directory) {
          if (visited >= this.maxSearchEntries) {
            reachedBound = true
            break search
          }
          visited += 1
          if (visited % 256 === 0) await yieldToEventLoop()
          if (item.name === '.git') continue
          if (!input.showHidden && item.name.startsWith('.')) continue
          const fullPath = resolve(directoryPath, item.name)
          let metadata
          let symlinkTarget: string | null = null
          try {
            metadata = await lstat(fullPath)
            if (metadata.isSymbolicLink())
              symlinkTarget = resolveSafePath(
                scope.projectRoot,
                relative(canonicalRoot, fullPath),
                true,
              )
          } catch {
            continue
          }
          const projectPath = toProjectPath(canonicalRoot, fullPath)
          if (projectPath.toLocaleLowerCase().includes(query))
            results.push({
              name: item.name,
              path: projectPath,
              kind: metadata.isSymbolicLink()
                ? 'symlink'
                : metadata.isDirectory()
                  ? 'directory'
                  : 'file',
              ...(symlinkTarget
                ? { targetKind: targetKindFor(symlinkTarget) }
                : {}),
              bytes: metadata.size,
              modifiedAt: metadata.mtimeMs,
              hidden: item.name.startsWith('.'),
            })
          if (metadata.isDirectory()) pending.push(fullPath)
        }
      }
      visibleResults = await this.withoutIgnored(
        input.sessionId,
        scope.projectRoot,
        results,
        input.showIgnored,
      )
      visibleResults.sort((left, right) => left.path.localeCompare(right.path))
      truncated = reachedBound
      this.searchCache.set(cacheKey, {
        expiresAt: Date.now() + 5_000,
        entries: visibleResults,
        truncated,
      })
      trimCache(this.searchCache)
    }
    const { page, nextCursor } = paginate(
      visibleResults,
      input.cursor,
      input.limit,
    )
    return {
      projectRoot: scope.projectRoot,
      relativePath: '',
      entries: page,
      nextCursor,
      truncated,
    }
  }

  async read(input: {
    sessionId: string
    relativePath: string
  }): Promise<WorkspaceFileReadResult> {
    const scope = this.scope(input.sessionId)
    const canonicalRoot = realpathSync(scope.projectRoot)
    const target = resolveSafePath(scope.projectRoot, input.relativePath, true)
    const metadata = statSync(target)
    if (!metadata.isFile())
      throw new WorkspaceOperationError(
        'workspace_path_not_file',
        '目标路径不是文件。',
      )
    const document = isDocument(target)
    const mimeType =
      document || !isZipOnlyDocument(target) ? mimeFor(target) : 'text/plain'
    const common = {
      projectRoot: scope.projectRoot,
      relativePath: toProjectPath(canonicalRoot, target),
      name: basename(target),
      mimeType,
      bytes: metadata.size,
      modifiedAt: metadata.mtimeMs,
    }
    if (metadata.size === 0)
      return { ...common, kind: 'text', truncated: false, content: '' }
    // A video or a song can be gigabytes: nothing is read, it streams when
    // played. Documents and HEIC/TIFF go to the preview converters.
    if (mimeType.startsWith('video/'))
      return { ...common, kind: 'video', truncated: false }
    if (mimeType.startsWith('audio/'))
      return { ...common, kind: 'audio', truncated: false }
    if (document) return { ...common, kind: 'document', truncated: false }
    if (CONVERTED_IMAGES.has(mimeType))
      return { ...common, kind: 'image', truncated: false }
    if (INLINE_IMAGES.has(mimeType)) {
      // Past the inline limit no data comes inline (`truncated`); the
      // Files pane streams it from its media address (BUG-10).
      if (metadata.size > this.maxImageBytes)
        return { ...common, kind: 'image', truncated: true }
      return {
        ...common,
        kind: 'image',
        truncated: false,
        dataBase64: readFileSync(target).toString('base64'),
      }
    }
    const read = readBounded(target, this.maxTextBytes)
    const decoded = decodeText(read, metadata.size > read.byteLength)
    if (!decoded) return { ...common, kind: 'binary', truncated: true }
    return {
      ...common,
      kind: 'text',
      truncated: metadata.size > read.byteLength,
      content: decoded.text,
      ...(decoded.encoding ? { encoding: decoded.encoding } : {}),
    }
  }

  /** The session's project folder, canonical (the 文件 pane watches it, BUG-11). */
  projectRoot(sessionId: string): string {
    return realpathSync(this.scope(sessionId).projectRoot)
  }

  /** Size and mtime only (no read): the same checks as read(). */
  stat(input: { sessionId: string; relativePath: string }): WorkspaceFileStat {
    const scope = this.scope(input.sessionId)
    const target = resolveSafePath(scope.projectRoot, input.relativePath, true)
    const metadata = statSync(target)
    if (!metadata.isFile())
      throw new WorkspaceOperationError(
        'workspace_path_not_file',
        '目标路径不是文件。',
      )
    return { bytes: metadata.size, modifiedAt: metadata.mtimeMs }
  }

  private scope(sessionId: string): WorkspaceProjectScope {
    return resolveOwnedProject(this.resolveProject, sessionId)
  }

  private async withoutIgnored(
    sessionId: string,
    projectRoot: string,
    entries: WorkspaceFileEntry[],
    showIgnored?: boolean,
  ): Promise<WorkspaceFileEntry[]> {
    if (showIgnored || !this.filterIgnored || entries.length === 0)
      return entries
    let ignored: Set<string>
    try {
      ignored = await this.filterIgnored(
        sessionId,
        projectRoot,
        entries.map((entry) => entry.path),
      )
    } catch {
      // A Build project does not have to be a Git repository. Ignore
      // classification is optional metadata and must not break file browsing.
      return entries
    }
    return entries.filter((entry) => !ignored.has(entry.path))
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield))
}

function trimCache(cache: Map<string, unknown>): void {
  while (cache.size > 16) cache.delete(cache.keys().next().value!)
}

function resolveSafePath(
  projectRoot: string,
  relativePath: string,
  requireExisting: boolean,
): string {
  if (isAbsolute(relativePath) || relativePath.includes('\0')) invalidPath()
  const normalized = normalizeRelative(relativePath)
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) invalidPath()
  const root = realpathSync(projectRoot)
  const candidate = resolve(root, normalized || '.')
  assertWithin(root, candidate)
  if (!requireExisting) return candidate
  let canonical: string
  try {
    canonical = realpathSync(candidate)
  } catch (error) {
    throw new WorkspaceOperationError(
      'workspace_path_missing',
      '文件或目录不存在。',
      { cause: error },
    )
  }
  assertWithin(root, canonical)
  return canonical
}

function assertWithin(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate)
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  )
    invalidPath()
}

function invalidPath(): never {
  throw new WorkspaceOperationError(
    'workspace_path_invalid',
    '路径必须位于当前项目内。',
  )
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function toProjectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function targetKindFor(path: string): 'directory' | 'file' | 'other' {
  const metadata = statSync(path)
  if (metadata.isDirectory()) return 'directory'
  if (metadata.isFile()) return 'file'
  return 'other'
}

function paginate<T>(
  entries: T[],
  cursor?: string,
  requestedLimit?: number,
): { page: T[]; nextCursor: string | null } {
  const start = cursor ? Number.parseInt(cursor, 10) : 0
  const offset = Number.isSafeInteger(start) && start >= 0 ? start : 0
  const limit = Math.max(1, Math.min(requestedLimit ?? 200, 500))
  const page = entries.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    page,
    nextCursor: nextOffset < entries.length ? String(nextOffset) : null,
  }
}

/** MIME types by extension; anything else is text/plain until it is read. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  key: 'application/vnd.apple.keynote',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdown: 'text/markdown',
  mkd: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
}

/** Shown from the bytes themselves (data: inline, or streamed past the limit). */
const INLINE_IMAGES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
])
/** Shown as the PNG sips makes of them (preview-convert.ts). */
const CONVERTED_IMAGES = new Set(['image/heic', 'image/heif', 'image/tiff'])
const DOCUMENTS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'pages',
  'numbers',
  'key',
  'rtf',
  'odt',
])
/** iWork files are zip packages; a `.key` that is not one is a key file (PEM). */
const ZIP_ONLY_DOCUMENTS = new Set(['pages', 'numbers', 'key'])

function extensionOf(path: string): string {
  const name = basename(path).toLocaleLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

function mimeFor(path: string): string {
  return MIME_TYPES[extensionOf(path)] ?? 'text/plain'
}

function isZipOnlyDocument(path: string): boolean {
  return ZIP_ONLY_DOCUMENTS.has(extensionOf(path))
}

function isDocument(path: string): boolean {
  const extension = extensionOf(path)
  if (!DOCUMENTS.has(extension)) return false
  if (!ZIP_ONLY_DOCUMENTS.has(extension)) return true
  const head = readBounded(path, 4)
  return head.length === 4 && head.readUInt32BE(0) === 0x504b0304
}

/**
 * Text in the encodings people actually have (BUG-10): UTF-16 by its byte
 * order mark, UTF-8 (a BOM is dropped), else GB18030 — the superset of
 * GBK and GB2312 — when every byte decodes. Null: binary. `truncated`: the
 * buffer is a cut of a longer file, so a split last character is dropped.
 */
export function decodeText(
  buffer: Buffer,
  truncated: boolean,
): { text: string; encoding?: string } | null {
  // A BOM first: UTF-16 has NUL bytes the binary check would trip on.
  if (buffer[0] === 0xff && buffer[1] === 0xfe)
    return utf16(buffer.subarray(2), 'utf-16le', 'UTF-16LE', truncated)
  if (buffer[0] === 0xfe && buffer[1] === 0xff)
    return utf16(buffer.subarray(2), 'utf-16be', 'UTF-16BE', truncated)
  const body =
    buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer
  // A cut at the byte limit can split a multi-byte character; drop the
  // partial tail so UTF-8 text is not mistaken for binary.
  const utf8 = truncated ? trimPartialUtf8(body) : body
  if (!looksBinary(utf8)) return { text: utf8.toString('utf8') }
  if (body.includes(0)) return null
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut += 1) {
    let text: string
    try {
      text = new TextDecoder('gb18030', { fatal: true }).decode(
        body.subarray(0, body.length - cut),
      )
    } catch {
      continue
    }
    return controlHeavy(text) ? null : { text, encoding: 'GB18030' }
  }
  return null
}

function utf16(
  body: Buffer,
  label: 'utf-16le' | 'utf-16be',
  encoding: string,
  truncated: boolean,
): { text: string; encoding: string } | null {
  if (body.length % 2 !== 0 && !truncated) return null
  const even = body.subarray(0, body.length - (body.length % 2))
  const text = new TextDecoder(label).decode(even)
  return controlHeavy(text) ? null : { text, encoding }
}

/** More than 1% control characters (other than tab, newlines, form feed). */
function controlHeavy(text: string): boolean {
  let controls = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)
      controls += 1
  }
  return text.length > 0 && controls / text.length > 0.01
}

/** Drop an incomplete UTF-8 sequence at the end of a truncated buffer. */
export function trimPartialUtf8(buffer: Buffer): Buffer {
  let lead = buffer.length - 1
  let continuation = 0
  while (lead >= 0 && continuation < 3 && (buffer[lead]! & 0xc0) === 0x80) {
    lead -= 1
    continuation += 1
  }
  if (lead < 0) return buffer
  const byte = buffer[lead]!
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
  return buffer.length - lead < width ? buffer.subarray(0, lead) : buffer
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return true
  }
  let controls = 0
  for (const byte of buffer) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)
      controls += 1
  }
  return buffer.length > 0 && controls / buffer.length > 0.01
}

function readBounded(path: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const bytesRead = readSync(descriptor, buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(descriptor)
  }
}
