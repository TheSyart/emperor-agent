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
  kind: 'text' | 'image' | 'binary'
  mimeType: string
  bytes: number
  truncated: boolean
  content?: string
  dataBase64?: string
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
    const mimeType = mimeFor(target)
    const common = {
      projectRoot: scope.projectRoot,
      relativePath: toProjectPath(canonicalRoot, target),
      name: basename(target),
      mimeType,
      bytes: metadata.size,
    }
    if (isPreviewableImageMime(mimeType)) {
      if (metadata.size > this.maxImageBytes)
        return { ...common, kind: 'image', truncated: true }
      return {
        ...common,
        kind: 'image',
        truncated: false,
        dataBase64: readFileSync(target).toString('base64'),
      }
    }
    const bounded = readBounded(target, this.maxTextBytes)
    if (looksBinary(bounded))
      return { ...common, kind: 'binary', truncated: metadata.size > 0 }
    return {
      ...common,
      kind: 'text',
      truncated: metadata.size > bounded.byteLength,
      content: bounded.toString('utf8'),
    }
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

function mimeFor(path: string): string {
  const extension = path.toLocaleLowerCase().split('.').pop()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'svg') return 'image/svg+xml'
  if (extension === 'json') return 'application/json'
  if (extension === 'html') return 'text/html'
  if (extension === 'css') return 'text/css'
  if (extension === 'md') return 'text/markdown'
  return 'text/plain'
}

function isPreviewableImageMime(mimeType: string): boolean {
  return new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).has(
    mimeType,
  )
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
