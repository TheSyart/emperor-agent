import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { constants, type Dirent, type Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalizeExistingPath, isPathWithin } from '../util/paths'
import { createTypeScriptCodeGraphExtractor } from './extractor'
import {
  CODE_GRAPH_PARSER_REVISION,
  MAX_CODE_GRAPH_FILE_BYTES,
  type CodeGraphDiagnostics,
  type CodeGraphExtractor,
  type CodeGraphFileEvent,
  type CodeGraphFileShard,
  type CodeGraphLocation,
  type CodeGraphManagerState,
  type CodeGraphSnapshot,
  type CodeSymbolKind,
} from './models'

const SUPPORTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
])
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.emperor',
  '.team',
  'node_modules',
  'dist',
  'out',
  'coverage',
])
const MAX_INDEXED_FILES = 200
const MAX_SOURCE_BYTES = MAX_CODE_GRAPH_FILE_BYTES
const MAX_CACHE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
const CACHE_PERSIST_DEBOUNCE_MS = 1_000
const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const EMPTY_LOCATIONS = Object.freeze([]) as readonly CodeGraphLocation[]
const CODE_SYMBOL_KINDS = new Set<CodeSymbolKind>([
  'class',
  'enum',
  'function',
  'import',
  'interface',
  'method',
  'module',
  'parameter',
  'property',
  'reference',
  'type',
  'variable',
])

interface IndexState {
  version: number
  files: ReadonlyMap<string, CodeGraphFileShard>
  definitions: ReadonlyMap<string, readonly CodeGraphLocation[]>
  references: ReadonlyMap<string, readonly CodeGraphLocation[]>
  sourceBytes: number
}

interface ScannedFile {
  absolutePath: string
  relativePath: string
  stats: Stats
}

interface StoredIndex {
  schemaVersion: 1
  parserRevision: string
  workspaceDigest: string
  version: number
  files: CodeGraphFileShard[]
}

export interface CodeGraphIndexManagerOptions {
  workspaceRoot: string
  cacheRoot: string
  loadExtractor?: () => Promise<CodeGraphExtractor>
}

export class CodeGraphIndexManager {
  readonly requestedWorkspaceRoot: string
  readonly cacheRoot: string
  readonly cachePath: string
  private readonly loadExtractor: () => Promise<CodeGraphExtractor>
  private workspaceRoot: string | null = null
  private state: CodeGraphManagerState = 'idle'
  private index: IndexState = emptyState()
  private extractor: CodeGraphExtractor | null = null
  private queue: Promise<void> = Promise.resolve()
  private parserLoads = 0
  private parseErrors = 0
  private skippedOversized = 0
  private skippedSymlinks = 0
  private skippedBinary = 0
  private skippedUnsupported = 0
  private skippedCapacity = 0
  private oversizedFileGateVerified = false
  private cacheStatus: CodeGraphDiagnostics['cacheStatus'] = 'not_checked'
  private cacheBytes = 0
  private cacheDirty = false
  private cacheTimer: NodeJS.Timeout | null = null

  constructor(opts: CodeGraphIndexManagerOptions) {
    this.requestedWorkspaceRoot = resolve(opts.workspaceRoot)
    this.cacheRoot = resolve(opts.cacheRoot)
    this.cachePath = join(this.cacheRoot, 'graph.v1.json.gz')
    this.loadExtractor =
      opts.loadExtractor ?? createTypeScriptCodeGraphExtractor
  }

  async ensureStarted(signal?: AbortSignal): Promise<void> {
    await this.enqueue(async () => {
      throwIfAborted(signal)
      if (this.state === 'ready') return
      if (this.state === 'closed')
        throw new Error('code graph manager is closed')
      this.state = 'building'
      try {
        const workspaceRoot = await realpath(this.requestedWorkspaceRoot)
        const rootStats = await stat(workspaceRoot)
        if (!rootStats.isDirectory())
          throw new Error('workspace root is not a directory')
        throwIfAborted(signal)
        this.workspaceRoot = workspaceRoot
        await this.loadCache(workspaceRoot)
        await this.refreshInternal(signal, true)
        this.state = 'ready'
      } catch (error) {
        if (isAbortError(error)) {
          this.index = emptyState()
          this.workspaceRoot = null
          this.state = 'idle'
        } else {
          this.state = 'idle'
        }
        throw error
      }
    })
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    await this.ensureStarted(signal)
    await this.enqueue(async () => await this.refreshInternal(signal))
  }

  async apply(
    events: readonly CodeGraphFileEvent[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureStarted(signal)
    await this.enqueue(async () => {
      throwIfAborted(signal)
      let changed = false
      for (const event of events) {
        throwIfAborted(signal)
        if (event.kind === 'renamed') {
          changed = this.removePath(event.path) || changed
          changed = (await this.upsertPath(event.nextPath, signal)) || changed
        } else if (event.kind === 'removed') {
          changed = this.removePath(event.path) || changed
        } else {
          changed = (await this.upsertPath(event.path, signal)) || changed
        }
      }
      if (changed) {
        this.cacheDirty = true
        this.scheduleCachePersist()
      }
    })
  }

  snapshot(): CodeGraphSnapshot {
    return new ImmutableCodeGraphSnapshot(this.index)
  }

  diagnostics(): CodeGraphDiagnostics {
    return {
      state: this.state,
      version: this.index.version,
      indexedFiles: this.index.files.size,
      sourceBytes: this.index.sourceBytes,
      parserLoads: this.parserLoads,
      parseErrors: this.parseErrors,
      skippedOversized: this.skippedOversized,
      skippedSymlinks: this.skippedSymlinks,
      skippedBinary: this.skippedBinary,
      skippedUnsupported: this.skippedUnsupported,
      skippedCapacity: this.skippedCapacity,
      oversizedFileGateVerified: this.oversizedFileGateVerified,
      cacheStatus: this.cacheStatus,
      cacheBytes: this.cacheBytes,
    }
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      if (this.cacheTimer) clearTimeout(this.cacheTimer)
      this.cacheTimer = null
      if (this.cacheDirty) await this.persistCache()
      this.state = 'closed'
      this.extractor = null
    })
  }

  private async refreshInternal(
    signal?: AbortSignal,
    persistImmediately = false,
  ): Promise<void> {
    if (!this.workspaceRoot) throw new Error('workspace root is unavailable')
    throwIfAborted(signal)
    this.skippedOversized = 0
    this.skippedSymlinks = 0
    this.skippedBinary = 0
    this.skippedUnsupported = 0
    this.skippedCapacity = 0
    const scanned = await this.scanWorkspace(this.workspaceRoot, signal)
    const seen = new Set(scanned.map((item) => item.relativePath))
    let changed = false
    for (const path of [...this.index.files.keys()]) {
      if (!seen.has(path)) changed = this.removePath(path) || changed
    }
    for (const file of scanned) {
      throwIfAborted(signal)
      const current = this.index.files.get(file.relativePath)
      if (
        current &&
        current.bytes === file.stats.size &&
        current.mtimeMs === file.stats.mtimeMs
      )
        continue
      changed = (await this.upsertScannedFile(file, signal)) || changed
    }
    this.oversizedFileGateVerified = true
    if (changed) this.cacheDirty = true
    if (
      persistImmediately &&
      (this.cacheDirty || this.cacheStatus !== 'loaded')
    )
      await this.persistCache()
    else if (changed) this.scheduleCachePersist()
  }

  private async scanWorkspace(
    root: string,
    signal?: AbortSignal,
  ): Promise<ScannedFile[]> {
    const out: ScannedFile[] = []
    let acceptedBytes = 0
    const walk = async (directory: string): Promise<void> => {
      throwIfAborted(signal)
      const entries: Dirent[] = []
      const opened = await opendir(directory)
      for await (const entry of opened) entries.push(entry)
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        throwIfAborted(signal)
        const absolutePath = join(directory, entry.name)
        const entryStats = await lstat(absolutePath)
        if (entryStats.isSymbolicLink()) {
          this.skippedSymlinks += 1
          continue
        }
        if (entryStats.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolutePath)
          continue
        }
        if (!entryStats.isFile()) continue
        if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          this.skippedUnsupported += 1
          continue
        }
        if (entryStats.size > MAX_CODE_GRAPH_FILE_BYTES) {
          this.skippedOversized += 1
          continue
        }
        if (
          out.length >= MAX_INDEXED_FILES ||
          acceptedBytes + entryStats.size > MAX_SOURCE_BYTES
        ) {
          this.skippedCapacity += 1
          continue
        }
        const canonical = await realpath(absolutePath)
        if (!isPathWithin(canonical, root)) {
          this.skippedSymlinks += 1
          continue
        }
        const relativePath = toRelativePath(root, absolutePath)
        acceptedBytes += entryStats.size
        out.push({ absolutePath, relativePath, stats: entryStats })
      }
    }
    await walk(root)
    return out.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )
  }

  private async upsertPath(
    value: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const root = this.workspaceRoot
    if (!root) throw new Error('workspace root is unavailable')
    const absolutePath = resolveEventPath(root, value)
    if (!isPathWithin(absolutePath, root)) return false
    let entryStats: Stats
    try {
      entryStats = await lstat(absolutePath)
    } catch (error) {
      if (isMissingError(error)) return this.removePath(value)
      throw error
    }
    if (entryStats.isSymbolicLink()) {
      this.skippedSymlinks += 1
      return this.removePath(value)
    }
    if (!entryStats.isFile()) return this.removePath(value)
    const relativePath = toRelativePath(root, absolutePath)
    if (!SUPPORTED_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
      this.skippedUnsupported += 1
      return this.removePath(relativePath)
    }
    if (entryStats.size > MAX_CODE_GRAPH_FILE_BYTES) {
      this.skippedOversized += 1
      this.oversizedFileGateVerified = true
      return this.removePath(relativePath)
    }
    const canonical = await realpath(absolutePath)
    if (!isPathWithin(canonical, root)) {
      this.skippedSymlinks += 1
      return this.removePath(relativePath)
    }
    return await this.upsertScannedFile(
      { absolutePath, relativePath, stats: entryStats },
      signal,
    )
  }

  private async upsertScannedFile(
    file: ScannedFile,
    signal?: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal)
    const bytes = await readFile(file.absolutePath)
    throwIfAborted(signal)
    if (bytes.includes(0)) {
      this.skippedBinary += 1
      return this.removePath(file.relativePath)
    }
    const content = bytes.toString('utf8')
    try {
      const extractor = await this.ensureExtractor()
      throwIfAborted(signal)
      const shard = await extractor.extract({
        relativePath: file.relativePath,
        content,
        bytes: bytes.length,
        mtimeMs: file.stats.mtimeMs,
      })
      throwIfAborted(signal)
      const current = this.index.files.get(file.relativePath)
      if (current?.contentSha256 === shard.contentSha256) return false
      this.replaceShard(freezeShard(shard))
      return true
    } catch (error) {
      if (isAbortError(error)) throw error
      this.parseErrors += 1
      return this.removePath(file.relativePath)
    }
  }

  private async ensureExtractor(): Promise<CodeGraphExtractor> {
    if (this.extractor) return this.extractor
    this.extractor = await this.loadExtractor()
    this.parserLoads += 1
    return this.extractor
  }

  private replaceShard(shard: CodeGraphFileShard): void {
    const previous = this.index.files.get(shard.path) ?? null
    const files = new Map(this.index.files)
    files.set(shard.path, shard)
    this.index = {
      version: this.index.version + 1,
      files,
      definitions: updateSymbolMap(
        this.index.definitions,
        shard.path,
        previous?.definitions ?? EMPTY_LOCATIONS,
        shard.definitions,
      ),
      references: updateSymbolMap(
        this.index.references,
        shard.path,
        previous?.references ?? EMPTY_LOCATIONS,
        shard.references,
      ),
      sourceBytes:
        this.index.sourceBytes - (previous?.bytes ?? 0) + shard.bytes,
    }
  }

  private removePath(value: string): boolean {
    const root = this.workspaceRoot ?? this.requestedWorkspaceRoot
    const path = normalizeEventRelativePath(root, value)
    const previous = this.index.files.get(path)
    if (!previous) return false
    const files = new Map(this.index.files)
    files.delete(path)
    this.index = {
      version: this.index.version + 1,
      files,
      definitions: updateSymbolMap(
        this.index.definitions,
        path,
        previous.definitions,
        EMPTY_LOCATIONS,
      ),
      references: updateSymbolMap(
        this.index.references,
        path,
        previous.references,
        EMPTY_LOCATIONS,
      ),
      sourceBytes: Math.max(0, this.index.sourceBytes - previous.bytes),
    }
    return true
  }

  private async loadCache(workspaceRoot: string): Promise<void> {
    let compressed: Buffer
    try {
      const cacheStats = await stat(this.cachePath)
      if (!cacheStats.isFile() || cacheStats.size > MAX_SOURCE_BYTES)
        throw new Error('derived cache exceeds resource limit')
      compressed = await readFile(this.cachePath)
    } catch (error) {
      if (isMissingError(error)) {
        this.cacheStatus = 'rebuilt_missing'
        return
      }
      this.cacheStatus = 'rebuilt_corrupt'
      return
    }
    try {
      const raw = (
        await gunzipAsync(compressed, {
          maxOutputLength: MAX_CACHE_UNCOMPRESSED_BYTES,
        })
      ).toString('utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isStoredIndex(parsed)) throw new Error('invalid cache schema')
      if (
        parsed.parserRevision !== CODE_GRAPH_PARSER_REVISION ||
        parsed.workspaceDigest !== sha256(workspaceRoot)
      )
        throw new Error('cache identity mismatch')
      this.index = stateFromShards(
        parsed.version,
        parsed.files.map(freezeShard),
      )
      this.cacheStatus = 'loaded'
      this.cacheBytes = compressed.length
    } catch {
      this.index = emptyState()
      this.cacheStatus = 'rebuilt_corrupt'
    }
  }

  private async persistCache(): Promise<void> {
    const workspaceRoot = this.workspaceRoot
    if (!workspaceRoot) return
    const stored: StoredIndex = {
      schemaVersion: 1,
      parserRevision: CODE_GRAPH_PARSER_REVISION,
      workspaceDigest: sha256(workspaceRoot),
      version: this.index.version,
      files: [...this.index.files.values()],
    }
    const payload = Buffer.from(`${JSON.stringify(stored)}\n`, 'utf8')
    const compressed = await gzipAsync(payload, { level: 9 })
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 })
    const tmp = join(this.cacheRoot, `.graph.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(
        tmp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      await handle.writeFile(compressed)
      await handle.sync()
      await handle.close()
      handle = null
      await rename(tmp, this.cachePath)
      const directory = await open(this.cacheRoot, constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      this.cacheBytes = compressed.length
      this.cacheDirty = false
    } finally {
      await handle?.close().catch(() => {})
      await unlink(tmp).catch(() => {})
    }
  }

  private async enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return await result
  }

  private scheduleCachePersist(): void {
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null
      void this.enqueue(async () => {
        if (this.state === 'closed' || !this.cacheDirty) return
        await this.persistCache()
      }).catch(() => undefined)
    }, CACHE_PERSIST_DEBOUNCE_MS)
    this.cacheTimer.unref?.()
  }
}

class ImmutableCodeGraphSnapshot implements CodeGraphSnapshot {
  readonly version: number
  readonly fileCount: number
  readonly sourceBytes: number
  private readonly files: ReadonlyMap<string, CodeGraphFileShard>
  private readonly definitionMap: ReadonlyMap<
    string,
    readonly CodeGraphLocation[]
  >
  private readonly referenceMap: ReadonlyMap<
    string,
    readonly CodeGraphLocation[]
  >

  constructor(state: IndexState) {
    this.version = state.version
    this.fileCount = state.files.size
    this.sourceBytes = state.sourceBytes
    this.files = state.files
    this.definitionMap = state.definitions
    this.referenceMap = state.references
    Object.freeze(this)
  }

  definitions(symbol: string): readonly CodeGraphLocation[] {
    return this.definitionMap.get(String(symbol)) ?? EMPTY_LOCATIONS
  }

  references(symbol: string): readonly CodeGraphLocation[] {
    return this.referenceMap.get(String(symbol)) ?? EMPTY_LOCATIONS
  }

  symbolAt(
    pathValue: string,
    lineValue: number,
    columnValue: number,
  ): string | null {
    const path = normalizeRelativePath(pathValue)
    const line = Math.max(1, Math.trunc(Number(lineValue) || 0))
    const column = Math.max(1, Math.trunc(Number(columnValue) || 0))
    const occurrence = this.files
      .get(path)
      ?.occurrences.find(
        (item) =>
          item.line === line &&
          item.column <= column &&
          item.endColumn >= column,
      )
    return occurrence?.symbol ?? null
  }

  file(pathValue: string): CodeGraphFileShard | null {
    return this.files.get(normalizeRelativePath(pathValue)) ?? null
  }
}

function updateSymbolMap(
  current: ReadonlyMap<string, readonly CodeGraphLocation[]>,
  path: string,
  previous: readonly CodeGraphLocation[],
  next: readonly CodeGraphLocation[],
): ReadonlyMap<string, readonly CodeGraphLocation[]> {
  const affected = new Set([
    ...previous.map((item) => item.symbol),
    ...next.map((item) => item.symbol),
  ])
  if (!affected.size) return current
  const updated = new Map(current)
  for (const symbol of affected) {
    const retained = (current.get(symbol) ?? EMPTY_LOCATIONS).filter(
      (item) => item.path !== path,
    )
    const additions = next.filter((item) => item.symbol === symbol)
    const values = stableLocations([...retained, ...additions])
    if (values.length) updated.set(symbol, values)
    else updated.delete(symbol)
  }
  return updated
}

function stateFromShards(
  version: number,
  shards: readonly CodeGraphFileShard[],
): IndexState {
  let state = emptyState()
  for (const shard of shards) {
    const files = new Map(state.files)
    files.set(shard.path, shard)
    state = {
      version: Math.max(0, Math.trunc(Number(version) || 0)),
      files,
      definitions: updateSymbolMap(
        state.definitions,
        shard.path,
        EMPTY_LOCATIONS,
        shard.definitions,
      ),
      references: updateSymbolMap(
        state.references,
        shard.path,
        EMPTY_LOCATIONS,
        shard.references,
      ),
      sourceBytes: state.sourceBytes + shard.bytes,
    }
  }
  return state
}

function emptyState(): IndexState {
  return {
    version: 0,
    files: new Map(),
    definitions: new Map(),
    references: new Map(),
    sourceBytes: 0,
  }
}

function freezeShard(value: CodeGraphFileShard): CodeGraphFileShard {
  const definitions = stableLocations(value.definitions.map(freezeLocation))
  const references = stableLocations(value.references.map(freezeLocation))
  const shared = new Map(
    [...definitions, ...references].map((location) => [
      locationIdentityKey(location),
      location,
    ]),
  )
  const occurrences = stableLocations(
    value.occurrences.map((location) => {
      const key = locationIdentityKey(location)
      return shared.get(key) ?? freezeLocation(location)
    }),
  )
  return Object.freeze({
    path: normalizeRelativePath(value.path),
    bytes: Math.max(0, Math.trunc(Number(value.bytes) || 0)),
    mtimeMs: Math.max(0, Number(value.mtimeMs) || 0),
    contentSha256: String(value.contentSha256),
    definitions,
    references,
    occurrences,
  })
}

function locationIdentityKey(value: CodeGraphLocation): string {
  return [
    value.symbol,
    normalizeRelativePath(value.path),
    value.line,
    value.column,
    value.endColumn,
    value.kind,
  ].join('\0')
}

function freezeLocation(value: CodeGraphLocation): CodeGraphLocation {
  return Object.freeze({
    symbol: String(value.symbol),
    path: normalizeRelativePath(value.path),
    line: Math.max(1, Math.trunc(Number(value.line) || 0)),
    column: Math.max(1, Math.trunc(Number(value.column) || 0)),
    endColumn: Math.max(1, Math.trunc(Number(value.endColumn) || 0)),
    kind: value.kind,
  })
}

function stableLocations(
  values: readonly CodeGraphLocation[],
): readonly CodeGraphLocation[] {
  return Object.freeze(
    [...values].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column ||
        left.symbol.localeCompare(right.symbol) ||
        left.kind.localeCompare(right.kind),
    ),
  )
}

function resolveEventPath(root: string, value: string): string {
  const raw = String(value ?? '').trim()
  return canonicalizeExistingPath(
    resolve(isAbsolute(raw) ? raw : join(root, raw)),
  )
}

function normalizeEventRelativePath(root: string, value: string): string {
  const absolute = resolveEventPath(root, value)
  if (!isPathWithin(absolute, root)) return normalizeRelativePath(value)
  return toRelativePath(root, absolute)
}

function toRelativePath(root: string, absolutePath: string): string {
  return normalizeRelativePath(relative(root, absolutePath))
}

function normalizeRelativePath(value: string): string {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .split(sep)
    .join('/')
    .replace(/^\.\//, '')
}

function isStoredIndex(value: unknown): value is StoredIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === 1 &&
    typeof record.parserRevision === 'string' &&
    typeof record.workspaceDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(record.workspaceDigest) &&
    Number.isFinite(Number(record.version)) &&
    Array.isArray(record.files) &&
    record.files.every(isStoredShard)
  )
}

function isStoredShard(value: unknown): value is CodeGraphFileShard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.path === 'string' &&
    !isAbsolute(record.path) &&
    !record.path.split(/[\\/]+/).includes('..') &&
    Number.isFinite(Number(record.bytes)) &&
    Number(record.bytes) >= 0 &&
    Number(record.bytes) <= MAX_CODE_GRAPH_FILE_BYTES &&
    Number.isFinite(Number(record.mtimeMs)) &&
    typeof record.contentSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(record.contentSha256) &&
    Array.isArray(record.definitions) &&
    Array.isArray(record.references) &&
    Array.isArray(record.occurrences) &&
    [...record.definitions, ...record.references, ...record.occurrences].every(
      isStoredLocation,
    )
  )
}

function isStoredLocation(value: unknown): value is CodeGraphLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.symbol === 'string' &&
    typeof record.path === 'string' &&
    Number.isFinite(Number(record.line)) &&
    Number.isFinite(Number(record.column)) &&
    Number.isFinite(Number(record.endColumn)) &&
    typeof record.kind === 'string' &&
    CODE_SYMBOL_KINDS.has(record.kind as CodeSymbolKind)
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('code graph operation cancelled')
  error.name = 'AbortError'
  throw error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    String((error as NodeJS.ErrnoException).code) === 'ENOENT'
  )
}
