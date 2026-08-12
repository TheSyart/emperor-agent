import { createReadStream, type Stats } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, join, matchesGlob, relative, resolve } from 'node:path'
import {
  formatWorkspacePolicyError,
  workspacePolicyForTool,
  type WorkspacePathDecision,
  type WorkspacePolicy,
} from '../permissions/workspace-policy'
import { pathsEqual } from '../util/paths'
import { Tool, type ToolExecutionContext } from './base'
import { S, toolParamsSchema } from './schema'

const MAX_RESULTS = 200
const MAX_FILE_BYTES = 2 * 1024 * 1024
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.emperor',
  '.team',
])

interface SearchEntry {
  logicalPath: string
  realPath: string
  relativePath: string
  stats: Stats
  isSymlink: boolean
}

interface SearchRoot extends SearchEntry {
  workspacePath: string
}

interface ContentLine {
  lineNumber: number
  text: string
}

interface ContentBlock {
  matchLine: number
  lines: ContentLine[]
}

interface PendingContentBlock extends ContentBlock {
  remainingAfter: number
}

interface FileScanResult {
  count: number
  blocks: ContentBlock[]
}

class SearchDiagnostic extends Error {}

class BinaryFile extends Error {}

class OversizedFile extends Error {}

/** Node-native recursive glob implementation shared by all agent entry points. */
export class GlobTool extends Tool {
  override name = 'glob'
  override description =
    '按 glob 模式查找文件或目录，结果按修改时间从新到旧排序；默认跳过 .git、node_modules、__pycache__ 等噪声目录。' +
    '查找文件名或目录结构时优先使用它，不要用 run_command/find/ls 代替；开放式多轮探索可考虑 dispatch_subagent。'
  override parameters = toolParamsSchema(
    { pattern: S('glob 模式（如 **/*.ts）') },
    ['pattern'],
  )
  override readOnly = true
  override evidencePolicy = 'eligible' as const
  override maxResultChars = 8000

  private readonly workspace: string

  constructor(root: string) {
    super()
    this.workspace = root
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const signal = ctx?.signal ?? undefined
    try {
      throwIfCancelled(signal)
      const pattern = normalizeGlobPattern(String(args.pattern ?? ''))
      if (!pattern) return '(no matches)'
      assertWorkspaceRelative(pattern, 'glob pattern')

      const workspace = ctx?.workspaceRoot ?? ctx?.root ?? this.workspace
      const policy = workspacePolicyForTool(ctx, this.workspace, 'glob')
      const root = await resolveSearchRoot(workspace, workspace, policy, signal)
      if (!root.stats.isDirectory()) {
        throw new SearchDiagnostic('[ERR] glob root is not a directory')
      }

      const matches: Array<{ path: string; mtimeMs: number }> = []
      for await (const entry of walkDirectory(
        root.logicalPath,
        root.realPath,
        root.workspacePath,
        policy,
        signal,
        new Set([root.realPath]),
      )) {
        if (matchesSearchGlob(entry.relativePath, pattern)) {
          matches.push({
            path: entry.relativePath,
            mtimeMs: entry.stats.mtimeMs,
          })
        }
      }

      matches.sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs || comparePaths(left.path, right.path),
      )
      return (
        matches
          .slice(0, MAX_RESULTS)
          .map((entry) => entry.path)
          .join('\n') || '(no matches)'
      )
    } catch (error) {
      return diagnosticError(error, signal)
    }
  }
}

/** Node-native streaming regular-expression search shared by all agent entry points. */
export class GrepTool extends Tool {
  override name = 'grep'
  override description =
    '在文件内容中搜索正则或纯文本模式。默认只返回匹配文件路径；需要查看命中行时使用 content 模式；会跳过二进制文件和超过 2MB 的文件。' +
    '内容搜索专用工具优先，不要用 run_command/grep/rg 代替；结果过宽时收窄 glob、type 或 pattern。'
  override parameters = toolParamsSchema(
    {
      pattern: S('正则或纯文本搜索模式'),
      path: S('搜索目录（默认 workspace）'),
      output_mode: S('content | files_with_matches | count'),
      glob: S('文件过滤 glob'),
      context_before: { type: 'integer', description: '前置上下文行数' },
      context_after: { type: 'integer', description: '后置上下文行数' },
    },
    ['pattern'],
  )
  override readOnly = true
  override evidencePolicy = 'eligible' as const
  override maxResultChars = 20_000

  private readonly workspace: string

  constructor(root: string) {
    super()
    this.workspace = root
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string> {
    const signal = ctx?.signal ?? undefined
    try {
      throwIfCancelled(signal)
      const pattern = String(args.pattern ?? '')
      let regex: RegExp
      try {
        regex = new RegExp(pattern)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new SearchDiagnostic(`[ERR] invalid regex: ${message}`)
      }

      const outputMode = String(args.output_mode ?? 'files_with_matches')
      if (!['content', 'files_with_matches', 'count'].includes(outputMode)) {
        throw new SearchDiagnostic(
          `[ERR] unsupported output_mode: ${outputMode || '(empty)'}`,
        )
      }
      const contextBefore = normalizeContext(args.context_before)
      const contextAfter = normalizeContext(args.context_after)
      const fileGlob = normalizeGlobPattern(String(args.glob ?? ''))
      if (fileGlob) assertWorkspaceRelative(fileGlob, 'grep glob')

      const workspace = ctx?.workspaceRoot ?? ctx?.root ?? this.workspace
      const requestedPath = normalizePortablePath(String(args.path ?? '.'))
      const policy = workspacePolicyForTool(ctx, this.workspace, 'grep')
      const root = await resolveSearchRoot(
        requestedPath || '.',
        workspace,
        policy,
        signal,
      )
      if (!root.stats.isDirectory() && !root.stats.isFile()) {
        throw new SearchDiagnostic('[ERR] grep path is not a file or directory')
      }

      const files: string[] = []
      const counts: string[] = []
      const blocks: string[] = []
      for await (const entry of walkFiles(root, policy, signal)) {
        if (fileGlob && !matchesSearchGlob(entry.relativePath, fileGlob)) {
          continue
        }
        if (entry.stats.size > MAX_FILE_BYTES) continue

        const scan = await scanTextFile(
          entry,
          regex,
          contextBefore,
          contextAfter,
          MAX_RESULTS - blocks.length,
          signal,
        )
        if (!scan || scan.count === 0) continue

        if (outputMode === 'files_with_matches') {
          files.push(entry.relativePath)
          if (files.length >= MAX_RESULTS) break
          continue
        }
        if (outputMode === 'count') {
          counts.push(`${entry.relativePath}: ${scan.count}`)
          if (counts.length >= MAX_RESULTS) break
          continue
        }

        for (const block of scan.blocks) {
          blocks.push(formatContentBlock(entry.relativePath, block))
          if (blocks.length >= MAX_RESULTS) break
        }
        if (blocks.length >= MAX_RESULTS) break
      }

      if (outputMode === 'files_with_matches') {
        return files.join('\n') || '(no matches)'
      }
      if (outputMode === 'count') return counts.join('\n') || '(no matches)'
      return blocks.join('\n\n') || '(no matches)'
    } catch (error) {
      return diagnosticError(error, signal)
    }
  }
}

async function resolveSearchRoot(
  requestedPath: string,
  workspacePath: string,
  policy: WorkspacePolicy,
  signal?: AbortSignal,
): Promise<SearchRoot> {
  throwIfCancelled(signal)
  const decision = policy.resolvePath(requestedPath || '.', 'read', {
    baseRoot: workspacePath,
  })
  assertPolicyAllowed(decision)
  const entry = await inspectEntry(
    decision.resolvedPath,
    decision.resolvedPath,
    workspacePath,
    policy,
    signal,
  )
  return { ...entry, workspacePath: resolve(workspacePath) }
}

async function inspectEntry(
  logicalPath: string,
  physicalPath: string,
  workspacePath: string,
  policy: WorkspacePolicy,
  signal?: AbortSignal,
): Promise<SearchEntry> {
  throwIfCancelled(signal)
  const linkStats = await lstat(physicalPath)
  const canonicalPath = await realpath(physicalPath)
  const decision = policy.resolvePath(logicalPath, 'read')
  assertPolicyAllowed(decision)
  if (!pathsEqual(decision.realPath, canonicalPath)) {
    throw new SearchDiagnostic(
      `[ERR] workspace policy canonical path mismatch: ${toPosixPath(logicalPath)}`,
    )
  }
  const stats = linkStats.isSymbolicLink()
    ? await lstat(canonicalPath)
    : linkStats
  return {
    logicalPath,
    realPath: canonicalPath,
    relativePath: displayPath(logicalPath, workspacePath),
    stats,
    isSymlink: linkStats.isSymbolicLink(),
  }
}

async function* walkDirectory(
  logicalDirectory: string,
  physicalDirectory: string,
  workspacePath: string,
  policy: WorkspacePolicy,
  signal: AbortSignal | undefined,
  ancestors: Set<string>,
): AsyncGenerator<SearchEntry> {
  throwIfCancelled(signal)
  const directory = await opendir(physicalDirectory)
  const names: string[] = []
  for await (const directoryEntry of directory) {
    if (
      !IGNORED_DIRECTORIES.has(directoryEntry.name) &&
      !directoryEntry.name.toLowerCase().endsWith('.asar')
    ) {
      names.push(directoryEntry.name)
    }
  }
  names.sort(comparePaths)

  for (const name of names) {
    throwIfCancelled(signal)
    const entry = await inspectEntry(
      join(logicalDirectory, name),
      join(physicalDirectory, name),
      workspacePath,
      policy,
      signal,
    )
    yield entry
    if (!entry.stats.isDirectory()) continue
    if (ancestors.has(entry.realPath)) {
      throw new SearchDiagnostic(
        `[ERR] symlink cycle detected: ${entry.relativePath}`,
      )
    }
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(entry.realPath)
    yield* walkDirectory(
      entry.logicalPath,
      entry.realPath,
      workspacePath,
      policy,
      signal,
      nextAncestors,
    )
  }
}

async function* walkFiles(
  root: SearchRoot,
  policy: WorkspacePolicy,
  signal?: AbortSignal,
): AsyncGenerator<SearchEntry> {
  if (root.stats.isFile()) {
    yield root
    return
  }
  for await (const entry of walkDirectory(
    root.logicalPath,
    root.realPath,
    root.workspacePath,
    policy,
    signal,
    new Set([root.realPath]),
  )) {
    if (entry.stats.isFile()) yield entry
  }
}

async function scanTextFile(
  entry: SearchEntry,
  regex: RegExp,
  contextBefore: number,
  contextAfter: number,
  maxBlocks: number,
  signal?: AbortSignal,
): Promise<FileScanResult | null> {
  const beforeLines: ContentLine[] = []
  const pending: PendingContentBlock[] = []
  const blocks: ContentBlock[] = []
  let count = 0
  let lineNumber = 0
  let remainder = ''
  let bytesRead = 0
  let sampleBytes = 0
  let sampleControlBytes = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })

  const processLine = (text: string): void => {
    lineNumber += 1
    const line = { lineNumber, text }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const block = pending[index]
      if (!block) continue
      block.lines.push(line)
      block.remainingAfter -= 1
      if (block.remainingAfter <= 0) {
        blocks.push(block)
        pending.splice(index, 1)
      }
    }

    regex.lastIndex = 0
    if (regex.test(text)) {
      count += 1
      if (blocks.length + pending.length < maxBlocks) {
        const block: PendingContentBlock = {
          matchLine: lineNumber,
          lines: [...beforeLines, line],
          remainingAfter: contextAfter,
        }
        if (contextAfter > 0) pending.push(block)
        else blocks.push(block)
      }
    }

    beforeLines.push(line)
    if (beforeLines.length > contextBefore) beforeLines.shift()
  }

  const processText = (text: string): void => {
    remainder += text
    let newline = remainder.indexOf('\n')
    while (newline >= 0) {
      const rawLine = remainder.slice(0, newline)
      processLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
      remainder = remainder.slice(newline + 1)
      newline = remainder.indexOf('\n')
    }
  }

  try {
    const stream = createReadStream(entry.realPath, {
      highWaterMark: 64 * 1024,
      signal,
    })
    for await (const rawChunk of stream) {
      throwIfCancelled(signal)
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      bytesRead += chunk.length
      if (bytesRead > MAX_FILE_BYTES) throw new OversizedFile()
      if (chunk.includes(0)) throw new BinaryFile()
      if (sampleBytes < 4096) {
        const sample = chunk.subarray(0, 4096 - sampleBytes)
        sampleBytes += sample.length
        for (const byte of sample) {
          if (byte < 9 || (byte > 13 && byte < 32)) sampleControlBytes += 1
        }
      }
      try {
        processText(decoder.decode(chunk, { stream: true }))
      } catch {
        throw new BinaryFile()
      }
    }
    try {
      processText(decoder.decode())
    } catch {
      throw new BinaryFile()
    }
    if (sampleBytes > 0 && sampleControlBytes / sampleBytes > 0.2) {
      throw new BinaryFile()
    }
  } catch (error) {
    if (error instanceof BinaryFile || error instanceof OversizedFile)
      return null
    throw error
  }

  if (remainder)
    processLine(remainder.endsWith('\r') ? remainder.slice(0, -1) : remainder)
  blocks.push(...pending)
  blocks.sort((left, right) => left.matchLine - right.matchLine)
  return { count, blocks: blocks.slice(0, maxBlocks) }
}

function formatContentBlock(path: string, block: ContentBlock): string {
  return [
    `${path}:${block.matchLine}`,
    ...block.lines.map((line) => {
      const marker = line.lineNumber === block.matchLine ? '>' : ' '
      return `${marker} ${line.lineNumber}| ${line.text}`
    }),
  ].join('\n')
}

function matchesSearchGlob(path: string, pattern: string): boolean {
  return (
    matchesGlob(path, pattern) ||
    (!pattern.includes('/') && matchesGlob(basename(path), pattern))
  )
}

function normalizeGlobPattern(pattern: string): string {
  return normalizePortablePath(pattern.trim()).replace(/^\.\/+/, '')
}

function normalizePortablePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function assertWorkspaceRelative(path: string, label: string): void {
  if (
    isPortableAbsolute(path) ||
    path.split('/').some((segment) => segment === '..')
  ) {
    throw new SearchDiagnostic(
      `[ERR] workspace policy rejected ${label}: ${path}`,
    )
  }
}

function isPortableAbsolute(path: string): boolean {
  return (
    path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith('//')
  )
}

function displayPath(path: string, workspacePath: string): string {
  return toPosixPath(relative(resolve(workspacePath), path)) || '.'
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function comparePaths(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function normalizeContext(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(20, Math.max(0, Math.trunc(parsed)))
}

function assertPolicyAllowed(decision: WorkspacePathDecision): void {
  if (decision.allowed) return
  throw new SearchDiagnostic(
    `[ERR] workspace policy rejected path: ${formatWorkspacePolicyError(decision)}`,
  )
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SearchDiagnostic('[ERR] search cancelled')
  }
}

function diagnosticError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return '[ERR] search cancelled'
  if (error instanceof SearchDiagnostic) return error.message
  if (error instanceof Error && error.name === 'AbortError') {
    return '[ERR] search cancelled'
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return `[ERR] search traversal failed${code ? ` (${code})` : ''}: ${message}`
}
