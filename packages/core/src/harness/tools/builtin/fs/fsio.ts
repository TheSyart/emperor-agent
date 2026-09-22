/**
 * Local filesystem mechanics for the fs tools (ported from dsh-fs-local
 * fsio + dsh-fs-sandbox containment, without the provider seam).
 *
 * - Targets carry a model-facing `displayPath` and a realpath-derived
 *   `targetKey`, so aliases (symlinks) share observation state and sandbox
 *   containment is checked on the real location.
 * - Versions are opaque tokens from high-resolution stat metadata.
 * - Writes stage a private file under Emperor Home and atomically publish it
 *   (`rename`, or a no-replace hard link for create-if-absent), so a temp
 *   file never appears inside the user's project; a target on another
 *   filesystem falls back to staging beside itself.
 */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  rename,
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { resolveWriteStagingRoot } from '../../../../runtime/paths'
import { ToolError } from '../../definition'

export type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_NOT_TEXT'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_SANDBOX_DENIED'
  | 'FS_ABORTED'
  | 'FS_IO_ERROR'

/** A structured fs failure; the model sees `Error: <message>`, the code rides `result.error.info`. */
export class FsError extends ToolError {
  constructor(
    message: string,
    readonly fsCode: FsErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, fsCode, options)
    this.name = 'FsError'
  }
}

/** A resolved filesystem target. */
export interface FsTarget {
  /** Absolute, model-facing path (`resolve(cwd, path)`). */
  readonly displayPath: string
  /** Realpath of the file, or of its nearest existing ancestor plus the missing suffix. */
  readonly targetKey: string
}

export interface PathInfo {
  version: string
  type: 'file' | 'directory' | 'other'
  size: number
  mode: number
}

/** Bytes sampled for a NUL byte to classify a file as binary. */
export const BINARY_SAMPLE_BYTES = 8192

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

function isMissing(error: unknown): boolean {
  const code = errnoCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  verb: string,
): void {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

function versionOf(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/**
 * Resolve `path` against `cwd`: realpath the file itself, or the nearest
 * existing ancestor plus the not-yet-created suffix.
 */
export async function resolveTarget(
  cwd: string,
  path: string,
): Promise<FsTarget> {
  if (path.trim().length === 0)
    throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = resolve(cwd, path)
  try {
    return { displayPath, targetKey: await realpath(displayPath) }
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOTDIR') {
      throw new FsError(
        `cannot resolve "${displayPath}": a parent path segment is not a directory`,
        'FS_NOT_FOUND',
      )
    }
    if (errnoCode(error) !== 'ENOENT') throw error
  }
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      return { displayPath, targetKey: join(realAncestor, ...missing) }
    } catch (error: unknown) {
      if (errnoCode(error) === 'ENOTDIR') {
        throw new FsError(
          `cannot resolve "${displayPath}": a parent path segment is not a directory`,
          'FS_NOT_FOUND',
        )
      }
      if (errnoCode(error) !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return { displayPath, targetKey: displayPath }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

/** Stat a path (following symlinks); `null` when absent. */
export async function probe(absolutePath: string): Promise<PathInfo | null> {
  let info: BigIntStats
  try {
    info = await stat(absolutePath, { bigint: true })
  } catch (error: unknown) {
    if (isMissing(error)) return null
    throw error
  }
  return {
    version: versionOf(info),
    type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
    size: Number(info.size),
    mode: Number(info.mode) & 0o7777,
  }
}

function decodeUtf8(
  buffer: Uint8Array,
  verb: 'read' | 'edit',
  displayPath: string,
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error
    throw new FsError(
      `cannot ${verb} "${displayPath}": invalid UTF-8 text`,
      'FS_NOT_TEXT',
    )
  }
}

async function readFileAbortable(
  path: string,
  verb: 'read' | 'edit',
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    return await readFile(path, signal === undefined ? undefined : { signal })
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new FsError(`${verb} aborted`, 'FS_ABORTED')
    throw error
  }
}

/** Read a whole regular UTF-8 text file; rejects NUL-byte binaries and invalid UTF-8. */
export async function readWholeText(
  target: FsTarget,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal, 'read')
  const raw = await readFileAbortable(target.targetKey, 'read', signal)
  throwIfAborted(signal, 'read')
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(
      `cannot read "${target.displayPath}": binary file`,
      'FS_NOT_TEXT',
    )
  }
  return decodeUtf8(raw, 'read', target.displayPath)
}

/** Stream a regular UTF-8 text file as decoded chunks (binary sample + fatal decoding). */
export async function* streamWholeText(
  target: FsTarget,
  signal?: AbortSignal,
): AsyncIterable<string> {
  throwIfAborted(signal, 'read')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampled = 0
  const decode = (chunk?: Uint8Array): string => {
    try {
      return chunk === undefined
        ? decoder.decode()
        : decoder.decode(chunk, { stream: true })
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error
      throw new FsError(
        `cannot read "${target.displayPath}": invalid UTF-8 text`,
        'FS_NOT_TEXT',
      )
    }
  }
  try {
    for await (const chunk of createReadStream(
      target.targetKey,
      signal === undefined ? {} : { signal },
    ) as AsyncIterable<Buffer>) {
      if (sampled < BINARY_SAMPLE_BYTES) {
        const sample = chunk.subarray(
          0,
          Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampled),
        )
        if (sample.includes(0))
          throw new FsError(
            `cannot read "${target.displayPath}": binary file`,
            'FS_NOT_TEXT',
          )
        sampled += sample.length
      }
      yield decode(chunk)
    }
    yield decode()
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }
}

export type LineEndings = 'LF' | 'CRLF'

export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

export function restoreLineEndings(
  content: string,
  lineEndings: LineEndings,
): string {
  return lineEndings === 'LF'
    ? content
    : normalizeLineEndings(content).split('\n').join('\r\n')
}

/** Read and decode a file for editing: LF-normalized content plus its original line-ending style. */
export async function readForEdit(
  target: FsTarget,
  signal?: AbortSignal,
): Promise<{ content: string; lineEndings: LineEndings }> {
  throwIfAborted(signal, 'edit')
  const buffer = await readFileAbortable(target.targetKey, 'edit', signal)
  throwIfAborted(signal, 'edit')
  if (buffer.includes(0))
    throw new FsError(
      `cannot edit "${target.displayPath}": binary file`,
      'FS_NOT_TEXT',
    )
  const raw = decodeUtf8(buffer, 'edit', target.displayPath)
  return {
    content: normalizeLineEndings(raw),
    lineEndings: detectLineEndings(raw),
  }
}

/** Best-effort overwrite diff basis: LF-normalized text, or null for large/binary/invalid/unreadable files. */
export async function readTextForDiff(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size >= maxBytes) return null
    const buffer = await readFile(path)
    if (buffer.length >= maxBytes || buffer.includes(0)) return null
    return normalizeLineEndings(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer),
    )
  } catch {
    return null
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/** Apply a literal replacement to LF-normalized content (unique match unless `replaceAll`). */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0)
    throw new FsError(
      'old_string must be a non-empty string',
      'FS_EDIT_NOT_FOUND',
    )
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(
      `old_string was not found in "${displayPath}"`,
      'FS_EDIT_NOT_FOUND',
    )
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

/** Mode for newly created files (dsh leaves them owner-only 0600; Emperor publishes conventional 0644). */
const NEW_FILE_MODE = 0o644

/** Emperor Home staging file names; also the sweep's allowlist. */
const STAGING_NAME = /^write-\d+-[0-9a-f-]{36}\.tmp$/
/** Staging files this old can only be residue of a killed process. */
const STAGING_SWEEP_AGE_MS = 60 * 60 * 1000
/** Upper bound on one sweep, so a crowded staging root never stalls a write. */
const STAGING_SWEEP_LIMIT = 500

export interface AtomicWriteOptions {
  /**
   * Publish with a no-replace hard link instead of a rename, preserving a
   * concurrent creator's file (`FS_NOT_OBSERVED`).
   */
  createIfAbsent?: { displayPath: string } | undefined
  /** Staging root outside the target tree; defaults to Emperor Home's. */
  stagingRoot?: string | undefined
}

/**
 * Atomically publish `content` at `absolutePath` through a private staging
 * file. Missing parent directories are created. Staging happens under Emperor
 * Home so nothing transient shows up in the user's project; when the target
 * lives on another filesystem (or in a setgid directory, whose group the
 * target must inherit) the staging file goes back beside the target, because
 * publication has to stay a single rename/link on one filesystem.
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  options: AtomicWriteOptions = {},
): Promise<void> {
  throwIfAborted(signal, 'write')
  const directory = dirname(absolutePath)
  await mkdir(directory, { recursive: true })
  throwIfAborted(signal, 'write')
  const staging = await prepareStagingRoot(directory, options.stagingRoot)
  if (staging !== null) {
    const tempPath = join(staging, `write-${process.pid}-${randomUUID()}.tmp`)
    let staged = false
    try {
      await writeStagedFile(tempPath, content, mode, signal)
      staged = true
      await publishStagedFile(tempPath, absolutePath, options, true)
      return
    } catch (error: unknown) {
      if (staged) {
        await rm(tempPath, { force: true }).catch(() => undefined)
      } else {
        // A staging root that has gone away is re-prepared on the next write.
        stagingRoots.delete(staging)
      }
      // Only an unusable staging root or a cross-filesystem publication may
      // be retried beside the target; every real write failure is the answer.
      if (error instanceof FsError) throw error
      if (staged && errnoCode(error) !== 'EXDEV') throw error
    }
  }
  const tempPath = join(
    directory,
    `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let staged = false
  try {
    await writeStagedFile(tempPath, content, mode, signal)
    staged = true
    await publishStagedFile(tempPath, absolutePath, options, false)
    staged = false
  } finally {
    if (staged) await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

/** Write the staged file with its final mode, cleaning up after itself on failure. */
async function writeStagedFile(
  tempPath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(tempPath, 'wx', 0o600)
    created = true
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(tempPath, mode ?? NEW_FILE_MODE)
    throwIfAborted(signal, 'write')
  } catch (error: unknown) {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    if (created) await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Move the staged file onto the target in one step. `canRestage` keeps a
 * cross-filesystem failure raw so the caller can stage beside the target
 * instead; otherwise every failure is reported as the write failure it is.
 */
async function publishStagedFile(
  tempPath: string,
  absolutePath: string,
  options: AtomicWriteOptions,
  canRestage: boolean,
): Promise<void> {
  const createIfAbsent = options.createIfAbsent
  if (createIfAbsent === undefined) {
    await rename(tempPath, absolutePath)
    return
  }
  try {
    await link(tempPath, absolutePath)
  } catch (error: unknown) {
    if (errnoCode(error) === 'EEXIST') {
      throw new FsError(
        `cannot overwrite existing "${createIfAbsent.displayPath}" without reading it first`,
        'FS_NOT_OBSERVED',
        { cause: error },
      )
    }
    if (canRestage && errnoCode(error) === 'EXDEV') throw error
    throw new FsError(
      `cannot write "${createIfAbsent.displayPath}": ${errorMessage(error)}`,
      'FS_IO_ERROR',
      { cause: error },
    )
  }
  await rm(tempPath, { force: true })
}

/** Device id of each prepared staging root; `null` once a root proves unusable. */
const stagingRoots = new Map<string, Promise<number | null>>()

/**
 * The staging root to use for a write into `targetDirectory`, or `null` when
 * the write has to stage beside its target.
 */
async function prepareStagingRoot(
  targetDirectory: string,
  configured: string | undefined,
): Promise<string | null> {
  const root = configured ?? resolveWriteStagingRoot()
  try {
    const device = await stagingDevice(root)
    if (device === null) return null
    const target = await stat(targetDirectory, { bigint: true })
    // A rename across filesystems fails (EXDEV) on POSIX and silently degrades
    // to a non-atomic copy on Windows, and a file created outside a setgid
    // directory would not inherit its group: both stay beside the target.
    if (Number(target.dev) !== device) return null
    if ((Number(target.mode) & 0o2000) !== 0) return null
    return root
  } catch {
    return null
  }
}

function stagingDevice(root: string): Promise<number | null> {
  const cached = stagingRoots.get(root)
  if (cached !== undefined) return cached
  const prepared = (async (): Promise<number | null> => {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') await chmod(root, 0o700)
      await sweepStagingRoot(root)
      const info = await stat(root, { bigint: true })
      const device = Number(info.dev)
      return Number.isFinite(device) && device !== 0 ? device : null
    } catch {
      return null
    }
  })()
  stagingRoots.set(root, prepared)
  return prepared
}

/** Drop staging files a killed process left behind. Hygiene only, never a precondition. */
async function sweepStagingRoot(root: string): Promise<void> {
  try {
    const deadline = Date.now() - STAGING_SWEEP_AGE_MS
    for (const name of (await readdir(root)).slice(0, STAGING_SWEEP_LIMIT)) {
      if (!STAGING_NAME.test(name)) continue
      const path = join(root, name)
      try {
        const info = await lstat(path)
        if (info.isFile() && info.mtimeMs < deadline)
          await rm(path, { force: true })
      } catch {
        // Residue that cannot be inspected is left alone.
      }
    }
  } catch {
    // An unreadable staging root is handled by the caller's stat.
  }
}

/** Serialize mutations per target key so read→guard→write windows never interleave. */
export class TargetLocks {
  private readonly locks = new Map<string, Promise<unknown>>()

  async with<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }
}

function isLexicallyUnder(
  path: string,
  root: string,
  caseSensitive: boolean,
): boolean {
  const target = caseSensitive ? path : path.toLowerCase()
  const base = caseSensitive ? root : root.toLowerCase()
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Whether canonical `path` is `root` or lies beneath it. Lexical fast path,
 * then a filesystem-identity walk over existing ancestors (case/alias-safe).
 */
export async function isPathUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== 'win32',
): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true
  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false
  let ancestor = path
  while (true) {
    const info = await statIfPresent(ancestor)
    if (
      info !== undefined &&
      info.dev === rootInfo.dev &&
      info.ino === rootInfo.ino
    )
      return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}
