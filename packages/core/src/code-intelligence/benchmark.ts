import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { EffectiveCodeIntelligenceCapability } from './capability'
import type { CodeIntelligenceEvaluationReport } from './eval'
import { CodeGraphIndexManager } from './index-manager'
import { CODE_GRAPH_PARSER_REVISION, MAX_CODE_GRAPH_FILE_BYTES } from './models'
import { CodeIntelligenceService } from './service'

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
const DEFINITION_PATTERN =
  /\b(?:class|enum|function|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g

export interface CodeIntelligenceBenchmarkOptions {
  sourceRoot: string
  maxFiles?: number
  incrementalRuns?: number
  fullRebuildRuns?: number
  indexedQueryRuns?: number
  diskQueryRuns?: number
}

interface BenchmarkFile {
  absolutePath: string
  relativePath: string
  bytes: number
  contentSha256: string
}

/**
 * Copies a deterministic real-source sample before mutation and returns only
 * aggregate/hash metrics. The source root is read-only and never appears in
 * the report.
 */
export async function runCodeIntelligenceBenchmark(
  opts: CodeIntelligenceBenchmarkOptions,
): Promise<CodeIntelligenceEvaluationReport> {
  const sourceRoot = await realpath(resolve(opts.sourceRoot))
  const sourceStats = await stat(sourceRoot)
  if (!sourceStats.isDirectory())
    throw new Error('benchmark source is not a directory')
  const files = await discoverFiles(
    sourceRoot,
    boundedCount(opts.maxFiles, 200, 100, 2_000),
  )
  if (files.length < 100)
    throw new Error('benchmark requires at least 100 supported source files')
  const datasetSha256 = datasetDigest(files)
  const sourceBytes = files.reduce((total, file) => total + file.bytes, 0)
  const beforeSourceDigest = datasetSha256
  const tempRoot = await mkdtemp(join(tmpdir(), 'emperor-code-benchmark-'))
  try {
    const workspaceRoot = join(tempRoot, 'workspace')
    const cacheRoot = join(tempRoot, 'cache', 'cold')
    await mkdir(workspaceRoot, { recursive: true })
    const candidates = new Map<string, number>()
    for (const file of files) {
      const content = await readFile(file.absolutePath)
      const target = join(workspaceRoot, ...file.relativePath.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
      collectDefinitionCandidates(content.toString('utf8'), candidates)
    }
    await writeFile(
      join(workspaceRoot, 'benchmark-oversized.ts'),
      Buffer.alloc(MAX_CODE_GRAPH_FILE_BYTES + 1, 'x'),
    )

    await collectGarbage()
    const rssBeforeBuild = process.memoryUsage().rss
    const manager = new CodeGraphIndexManager({ workspaceRoot, cacheRoot })
    const coldStarted = performance.now()
    await manager.ensureStarted()
    const coldBuildMs = elapsed(coldStarted)
    await collectGarbage()
    const rssDeltaBytes = Math.max(
      0,
      process.memoryUsage().rss - rssBeforeBuild,
    )
    const initialSnapshot = manager.snapshot()
    const symbol = selectMeasuredSymbol(initialSnapshot, candidates)
    const measuredDefinition = initialSnapshot.definitions(symbol)[0] ?? null

    const indexedQueryTimes: number[] = []
    const indexedQueryRuns = boundedCount(opts.indexedQueryRuns, 80, 20, 500)
    for (let index = 0; index < indexedQueryRuns; index += 1) {
      const started = performance.now()
      initialSnapshot.definitions(symbol)
      initialSnapshot.references(symbol)
      indexedQueryTimes.push(elapsed(started))
    }
    const diskQueryTimes: number[] = []
    const diskQueryRuns = boundedCount(opts.diskQueryRuns, 7, 3, 30)
    for (let index = 0; index < diskQueryRuns; index += 1) {
      const started = performance.now()
      await diskWordScan(workspaceRoot, files, symbol)
      diskQueryTimes.push(elapsed(started))
    }

    const mutationTarget = join(
      workspaceRoot,
      ...files[0]!.relativePath.split('/'),
    )
    const original = await readFile(mutationTarget, 'utf8')
    const isolationSymbol = '__emperorBenchmarkIsolation'
    const oldSnapshot = manager.snapshot()
    await writeFile(
      mutationTarget,
      `${original}\nexport const ${isolationSymbol} = 1\n`,
    )
    await manager.apply([{ kind: 'modified', path: mutationTarget }])
    const snapshotIsolationVerified =
      oldSnapshot.definitions(isolationSymbol).length === 0 &&
      manager.snapshot().definitions(isolationSymbol).length === 1
    await writeFile(mutationTarget, original)
    await manager.apply([{ kind: 'modified', path: mutationTarget }])

    const incrementalTimes: number[] = []
    await collectGarbage()
    const incrementalRssBefore = process.memoryUsage().rss
    const incrementalRuns = boundedCount(opts.incrementalRuns, 10, 3, 50)
    for (let index = 0; index < incrementalRuns; index += 1) {
      const next = `${original}\nexport const __emperorIncremental${index} = ${index}\n`
      await writeFile(mutationTarget, next)
      const started = performance.now()
      await manager.apply([{ kind: 'modified', path: mutationTarget }])
      incrementalTimes.push(elapsed(started))
      await writeFile(mutationTarget, original)
      await manager.apply([{ kind: 'modified', path: mutationTarget }])
    }
    await collectGarbage()
    const incrementalRssGrowthBytes = Math.max(
      0,
      process.memoryUsage().rss - incrementalRssBefore,
    )

    const fullRebuildTimes: number[] = []
    const fullRebuildRuns = boundedCount(opts.fullRebuildRuns, 3, 2, 10)
    for (let index = 0; index < fullRebuildRuns; index += 1) {
      const rebuilt = new CodeGraphIndexManager({
        workspaceRoot,
        cacheRoot: join(tempRoot, 'cache', `full-${index}`),
      })
      const started = performance.now()
      await rebuilt.ensureStarted()
      fullRebuildTimes.push(elapsed(started))
      await rebuilt.close()
    }

    const fallbackVerified = measuredDefinition
      ? await verifyGraphFallback({
          workspaceRoot,
          stateRoot: join(tempRoot, 'fallback-state'),
          filePath: join(workspaceRoot, ...measuredDefinition.path.split('/')),
          line: measuredDefinition.line,
          column: measuredDefinition.column,
          symbol,
        })
      : false
    const diagnostics = manager.diagnostics()
    await manager.close()
    const afterSourceDigest = datasetDigest(
      await discoverExactFiles(sourceRoot, files),
    )
    if (beforeSourceDigest !== afterSourceDigest)
      throw new Error('benchmark source changed during evaluation')

    return {
      schemaVersion: 1,
      datasetId: 'real-typescript-source-sample-v1',
      datasetSha256,
      parserRevision: CODE_GRAPH_PARSER_REVISION,
      indexedFiles: diagnostics.indexedFiles,
      skippedOversized: diagnostics.skippedOversized,
      sourceBytes,
      cacheBytes: diagnostics.cacheBytes,
      coldBuildMs,
      incrementalP95Ms: percentile95(incrementalTimes),
      fullRebuildP95Ms: percentile95(fullRebuildTimes),
      indexedQueryP95Ms: percentile95(indexedQueryTimes),
      diskScanQueryP95Ms: percentile95(diskQueryTimes),
      rssDeltaBytes,
      incrementalRssGrowthBytes,
      oversizedFileGateVerified:
        diagnostics.oversizedFileGateVerified &&
        diagnostics.skippedOversized >= 1,
      snapshotIsolationVerified,
      fallbackVerified,
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function discoverFiles(
  root: string,
  maxFiles: number,
): Promise<BenchmarkFile[]> {
  const paths: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = []
    const opened = await opendir(directory)
    for await (const entry of opened) entries.push(entry)
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (paths.length >= maxFiles) return
      const absolutePath = join(directory, entry.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolutePath)
        continue
      }
      if (
        info.isFile() &&
        info.size <= MAX_CODE_GRAPH_FILE_BYTES &&
        SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())
      )
        paths.push(absolutePath)
    }
  }
  await walk(root)
  return await Promise.all(
    paths.sort().map(async (absolutePath) => {
      const bytes = await readFile(absolutePath)
      return {
        absolutePath,
        relativePath: portableRelative(root, absolutePath),
        bytes: bytes.length,
        contentSha256: sha256(bytes),
      }
    }),
  )
}

async function discoverExactFiles(
  root: string,
  expected: readonly BenchmarkFile[],
): Promise<BenchmarkFile[]> {
  return await Promise.all(
    expected.map(async (file) => {
      const absolutePath = join(root, ...file.relativePath.split('/'))
      const bytes = await readFile(absolutePath)
      return {
        absolutePath,
        relativePath: file.relativePath,
        bytes: bytes.length,
        contentSha256: sha256(bytes),
      }
    }),
  )
}

function collectDefinitionCandidates(
  content: string,
  candidates: Map<string, number>,
): void {
  DEFINITION_PATTERN.lastIndex = 0
  for (
    let match = DEFINITION_PATTERN.exec(content);
    match;
    match = DEFINITION_PATTERN.exec(content)
  ) {
    const symbol = match[1]!
    candidates.set(symbol, (candidates.get(symbol) ?? 0) + 1)
  }
}

function selectMeasuredSymbol(
  snapshot: ReturnType<CodeGraphIndexManager['snapshot']>,
  candidates: ReadonlyMap<string, number>,
): string {
  const ranked = [...candidates].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )
  let selected = ''
  let score = -1
  for (const [symbol] of ranked.slice(0, 100)) {
    const current =
      snapshot.definitions(symbol).length + snapshot.references(symbol).length
    if (current > score) {
      selected = symbol
      score = current
    }
  }
  if (!selected || snapshot.definitions(selected).length === 0)
    throw new Error('benchmark could not select a measured symbol')
  return selected
}

async function diskWordScan(
  workspaceRoot: string,
  files: readonly BenchmarkFile[],
  symbol: string,
): Promise<number> {
  const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g')
  let matches = 0
  for (const file of files) {
    const content = await readFile(
      join(workspaceRoot, ...file.relativePath.split('/')),
      'utf8',
    )
    pattern.lastIndex = 0
    matches += [...content.matchAll(pattern)].length
  }
  return matches
}

async function verifyGraphFallback(input: {
  workspaceRoot: string
  stateRoot: string
  filePath: string
  line: number
  column: number
  symbol: string
}): Promise<boolean> {
  const service = new CodeIntelligenceService({
    stateRoot: input.stateRoot,
    capability: enabledCapability(),
    processRuntime: null,
    lspDescriptors: [],
    lspSupervisor: {
      syncDocument: async () => undefined,
      request: async () => {
        throw new Error('benchmark LSP unavailable')
      },
      diagnostics: () => [],
      stopSession: async () => undefined,
      close: async () => undefined,
    },
  })
  try {
    const result = await service.query(
      {
        operation: 'go_to_definition',
        path: portableRelative(input.workspaceRoot, input.filePath),
        line: input.line,
        column: input.column,
      },
      { workspaceRoot: input.workspaceRoot, sessionId: 'benchmark-session' },
    )
    return (
      result.strategy === 'graph_fallback' &&
      result.fallbackReason === 'lsp_failed' &&
      result.symbol === input.symbol &&
      result.locations.length > 0
    )
  } finally {
    await service.close()
  }
}

function enabledCapability(): EffectiveCodeIntelligenceCapability {
  return {
    requestedMode: 'on',
    effectiveMode: 'on',
    toolAllowed: true,
    reason: 'enabled',
    evaluationDatasetSha256: 'a'.repeat(64),
    parserRevision: CODE_GRAPH_PARSER_REVISION,
  }
}

function datasetDigest(files: readonly BenchmarkFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  ))
    hash.update(
      `${file.relativePath}\0${file.bytes}\0${file.contentSha256}\n`,
      'utf8',
    )
  return hash.digest('hex')
}

function percentile95(values: readonly number[]): number {
  if (!values.length) throw new Error('benchmark metric has no samples')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ]!
}

function elapsed(started: number): number {
  return Math.max(Number.EPSILON, performance.now() - started)
}

function boundedCount(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Number(value)))
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function collectGarbage(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) return
  gc()
  gc()
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
}
