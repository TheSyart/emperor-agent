import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { OwnedProcessRuntime } from '../processes/runtime'
import { canonicalizeExistingPath, isPathWithin } from '../util/paths'
import type { EffectiveCodeIntelligenceCapability } from './capability'
import {
  CodeGraphIndexManager,
  type CodeGraphIndexManagerOptions,
} from './index-manager'
import {
  LspSupervisor,
  type LspSupervisorDiagnostics,
  type TrustedLspServerDescriptor,
} from './lsp-supervisor'
import type {
  CodeGraphDiagnostics,
  CodeGraphFileEvent,
  CodeGraphLocation,
} from './models'

const MAX_RESULT_LOCATIONS = 200

export type CodeIntelligenceQuery =
  | { operation: 'find_definitions'; symbol: string }
  | { operation: 'find_references'; symbol: string }
  | {
      operation: 'go_to_definition'
      path: string
      line: number
      column: number
    }
  | {
      operation: 'find_position_references'
      path: string
      line: number
      column: number
    }

export interface CodeIntelligenceContext {
  workspaceRoot: string
  sessionId: string
  signal?: AbortSignal | null
  internalEvaluation?: boolean
}

export interface CodeIntelligenceResult {
  operation: CodeIntelligenceQuery['operation']
  strategy: 'graph' | 'lsp' | 'graph_fallback'
  symbol: string | null
  locations: CodeGraphLocation[]
  fallbackReason: 'lsp_unavailable' | 'lsp_failed' | null
  truncated: boolean
  complete: boolean
  limitations: string[]
}

export interface CodeIntelligenceServiceDiagnostics {
  capability: EffectiveCodeIntelligenceCapability
  graphManagers: number
  queries: number
  lspQueries: number
  graphFallbacks: number
  notifications: number
  lastStrategy: CodeIntelligenceResult['strategy'] | null
  lastLatencyMs: number | null
  graph: CodeGraphDiagnostics
  lsp: LspSupervisorDiagnostics[]
}

interface CodeGraphManagerPort {
  ensureStarted(signal?: AbortSignal): Promise<void>
  refresh(signal?: AbortSignal): Promise<void>
  apply(
    events: readonly CodeGraphFileEvent[],
    signal?: AbortSignal,
  ): Promise<void>
  snapshot(): ReturnType<CodeGraphIndexManager['snapshot']>
  diagnostics(): CodeGraphDiagnostics
  close(): Promise<void>
}

interface LspSupervisorPort {
  request(input: {
    workspaceRoot: string
    sessionId: string
    filePath: string
    method: string
    params: unknown
    signal?: AbortSignal
  }): Promise<unknown>
  syncDocument(input: {
    workspaceRoot: string
    sessionId: string
    filePath: string
    text: string
    version: number
  }): Promise<void>
  diagnostics(): LspSupervisorDiagnostics[]
  stopSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

export interface CodeIntelligenceServiceOptions {
  stateRoot: string
  capability: EffectiveCodeIntelligenceCapability
  processRuntime: Pick<OwnedProcessRuntime, 'spawn'> | null
  lspDescriptors: readonly TrustedLspServerDescriptor[]
  lspSupervisor?: LspSupervisorPort | null
  graphManagerFactory?: (
    opts: CodeGraphIndexManagerOptions,
  ) => CodeGraphManagerPort
}

interface GraphEntry {
  workspaceRoot: string
  manager: CodeGraphManagerPort
}

/** Capability-gated composition of the derived graph and optional trusted LSP. */
export class CodeIntelligenceService {
  readonly capability: EffectiveCodeIntelligenceCapability
  private readonly stateRoot: string
  private readonly graphManagerFactory: NonNullable<
    CodeIntelligenceServiceOptions['graphManagerFactory']
  >
  private readonly lsp: LspSupervisorPort | null
  private readonly graphs = new Map<string, GraphEntry>()
  private queries = 0
  private lspQueries = 0
  private graphFallbacks = 0
  private notifications = 0
  private lastStrategy: CodeIntelligenceResult['strategy'] | null = null
  private lastLatencyMs: number | null = null
  private closed = false

  constructor(opts: CodeIntelligenceServiceOptions) {
    this.stateRoot = resolve(opts.stateRoot)
    this.capability = Object.freeze({ ...opts.capability })
    this.graphManagerFactory =
      opts.graphManagerFactory ??
      ((options) => new CodeGraphIndexManager(options))
    if (opts.lspSupervisor !== undefined) {
      this.lsp = opts.lspSupervisor
    } else if (
      this.capability.effectiveMode !== 'off' &&
      opts.processRuntime &&
      opts.lspDescriptors.length > 0
    ) {
      this.lsp = new LspSupervisor({
        processRuntime: opts.processRuntime,
        stateRoot: this.stateRoot,
        descriptors: opts.lspDescriptors,
      })
    } else {
      this.lsp = null
    }
  }

  async query(
    input: CodeIntelligenceQuery,
    context: CodeIntelligenceContext,
  ): Promise<CodeIntelligenceResult> {
    this.assertQueryAllowed(context)
    const started = performance.now()
    const workspaceRoot = await canonicalWorkspace(context.workspaceRoot)
    const entry = await this.graphFor(workspaceRoot)
    const signal = context.signal ?? undefined
    if (entry.manager.diagnostics().state === 'idle')
      await entry.manager.ensureStarted(signal)
    else await entry.manager.refresh(signal)
    let result: CodeIntelligenceResult
    if (
      input.operation === 'find_definitions' ||
      input.operation === 'find_references'
    ) {
      const symbol = cleanSymbol(input.symbol)
      const snapshot = entry.manager.snapshot()
      result = boundedResult({
        operation: input.operation,
        strategy: 'graph',
        symbol,
        locations:
          input.operation === 'find_definitions'
            ? snapshot.definitions(symbol)
            : snapshot.references(symbol),
        fallbackReason: null,
      })
    } else {
      result = await this.positionQuery(input, context, workspaceRoot, entry)
    }
    result = applyCoverage(result, entry.manager.diagnostics())
    this.queries += 1
    if (result.strategy === 'lsp') this.lspQueries += 1
    if (result.strategy === 'graph_fallback') this.graphFallbacks += 1
    this.lastStrategy = result.strategy
    this.lastLatencyMs = Math.max(0, performance.now() - started)
    return result
  }

  async notify(
    events: readonly CodeGraphFileEvent[],
    context: CodeIntelligenceContext,
  ): Promise<void> {
    if (
      this.closed ||
      this.capability.effectiveMode === 'off' ||
      !events.length
    )
      return
    const workspaceRoot = await canonicalWorkspace(context.workspaceRoot)
    const entry = this.graphs.get(workspaceDigest(workspaceRoot))
    if (!entry) return
    await entry.manager.apply(events, context.signal ?? undefined)
    this.notifications += events.length
  }

  diagnostics(): CodeIntelligenceServiceDiagnostics {
    const graphDiagnostics = [...this.graphs.values()].map((entry) =>
      entry.manager.diagnostics(),
    )
    return {
      capability: { ...this.capability },
      graphManagers: this.graphs.size,
      queries: this.queries,
      lspQueries: this.lspQueries,
      graphFallbacks: this.graphFallbacks,
      notifications: this.notifications,
      lastStrategy: this.lastStrategy,
      lastLatencyMs: this.lastLatencyMs,
      graph: aggregateGraphDiagnostics(graphDiagnostics),
      lsp: this.lsp?.diagnostics() ?? [],
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.lsp?.stopSession(String(sessionId ?? '').trim())
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.lsp?.close()
    await Promise.all(
      [...this.graphs.values()].map((entry) => entry.manager.close()),
    )
    this.graphs.clear()
  }

  private assertQueryAllowed(context: CodeIntelligenceContext): void {
    if (this.closed) throw new Error('Code intelligence service is closed')
    const evaluationAllowed =
      this.capability.effectiveMode === 'eval' &&
      context.internalEvaluation === true
    if (!this.capability.toolAllowed && !evaluationAllowed)
      throw new Error('Code intelligence is disabled by capability gate')
  }

  private async graphFor(workspaceRoot: string): Promise<GraphEntry> {
    const digest = workspaceDigest(workspaceRoot)
    const existing = this.graphs.get(digest)
    if (existing) return existing
    const entry = {
      workspaceRoot,
      manager: this.graphManagerFactory({
        workspaceRoot,
        cacheRoot: join(
          this.stateRoot,
          'code-intelligence',
          'projects',
          digest,
        ),
      }),
    }
    this.graphs.set(digest, entry)
    return entry
  }

  private async positionQuery(
    input: Extract<
      CodeIntelligenceQuery,
      { operation: 'go_to_definition' | 'find_position_references' }
    >,
    context: CodeIntelligenceContext,
    workspaceRoot: string,
    entry: GraphEntry,
  ): Promise<CodeIntelligenceResult> {
    const relativePath = validateRelativePath(input.path)
    const absolutePath = resolve(workspaceRoot, ...relativePath.split('/'))
    if (!isPathWithin(absolutePath, workspaceRoot))
      throw new Error('Code intelligence path is outside the workspace')
    const line = positiveInteger(input.line, 'line')
    const column = positiveInteger(input.column, 'column')
    const snapshot = entry.manager.snapshot()
    const symbol = snapshot.symbolAt(relativePath, line, column)
    let fallbackReason: CodeIntelligenceResult['fallbackReason'] = null
    if (this.lsp) {
      try {
        const text = await readFile(absolutePath, 'utf8')
        await this.lsp.syncDocument({
          workspaceRoot,
          sessionId: context.sessionId,
          filePath: absolutePath,
          text,
          version: Math.max(1, snapshot.version),
        })
        const method =
          input.operation === 'go_to_definition'
            ? 'textDocument/definition'
            : 'textDocument/references'
        const raw = await this.lsp.request({
          workspaceRoot,
          sessionId: context.sessionId,
          filePath: absolutePath,
          method,
          params: {
            textDocument: { uri: pathToFileURL(absolutePath).href },
            position: { line: line - 1, character: column - 1 },
            ...(input.operation === 'find_position_references'
              ? { context: { includeDeclaration: true } }
              : {}),
          },
          signal: context.signal ?? undefined,
        })
        return boundedResult({
          operation: input.operation,
          strategy: 'lsp',
          symbol,
          locations: normalizeLspLocations(raw, workspaceRoot),
          fallbackReason: null,
        })
      } catch {
        fallbackReason = 'lsp_failed'
      }
    } else {
      fallbackReason = 'lsp_unavailable'
    }
    const locations = symbol
      ? input.operation === 'go_to_definition'
        ? snapshot.definitions(symbol)
        : snapshot.references(symbol)
      : []
    return boundedResult({
      operation: input.operation,
      strategy: 'graph_fallback',
      symbol,
      locations,
      fallbackReason,
    })
  }
}

function normalizeLspLocations(
  value: unknown,
  workspaceRoot: string,
): CodeGraphLocation[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  const out: CodeGraphLocation[] = []
  for (const raw of values) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const uri = String(record.uri ?? record.targetUri ?? '')
    if (!uri.startsWith('file:')) continue
    let absolutePath: string
    try {
      absolutePath = canonicalizeExistingPath(resolve(fileURLToPath(uri)))
    } catch {
      continue
    }
    if (!isPathWithin(absolutePath, workspaceRoot)) continue
    const range = (record.range ?? record.targetRange) as
      Record<string, unknown> | undefined
    const start = range?.start as Record<string, unknown> | undefined
    const end = range?.end as Record<string, unknown> | undefined
    const line = zeroBasedCoordinate(start?.line) + 1
    const column = zeroBasedCoordinate(start?.character) + 1
    const endColumn = Math.max(
      column,
      zeroBasedCoordinate(end?.character ?? start?.character) + 1,
    )
    out.push({
      symbol: '',
      path: portableRelative(workspaceRoot, absolutePath),
      line,
      column,
      endColumn,
      kind: 'reference',
    })
  }
  return out
}

function boundedResult(
  input: Omit<
    CodeIntelligenceResult,
    'locations' | 'truncated' | 'complete' | 'limitations'
  > & {
    locations: readonly CodeGraphLocation[]
  },
): CodeIntelligenceResult {
  const ordered = [...input.locations]
    .sort(compareLocation)
    .slice(0, MAX_RESULT_LOCATIONS)
    .map((location) => ({ ...location }))
  return {
    ...input,
    locations: ordered,
    truncated: input.locations.length > MAX_RESULT_LOCATIONS,
    complete: true,
    limitations: [],
  }
}

function applyCoverage(
  result: CodeIntelligenceResult,
  diagnostics: CodeGraphDiagnostics,
): CodeIntelligenceResult {
  if (result.strategy === 'lsp') return result
  const limitations: string[] = []
  if (diagnostics.skippedCapacity > 0) limitations.push('capacity_limited')
  if (diagnostics.skippedOversized > 0)
    limitations.push('oversized_files_skipped')
  if (diagnostics.skippedSymlinks > 0) limitations.push('symlinks_skipped')
  if (diagnostics.skippedBinary > 0) limitations.push('binary_files_skipped')
  if (diagnostics.parseErrors > 0) limitations.push('parse_errors')
  return {
    ...result,
    complete: limitations.length === 0,
    limitations,
  }
}

function aggregateGraphDiagnostics(
  values: readonly CodeGraphDiagnostics[],
): CodeGraphDiagnostics {
  const state = values.some((item) => item.state === 'building')
    ? 'building'
    : values.some((item) => item.state === 'ready')
      ? 'ready'
      : values.some((item) => item.state === 'closed')
        ? 'closed'
        : 'idle'
  return {
    state,
    version: sum(values, 'version'),
    indexedFiles: sum(values, 'indexedFiles'),
    sourceBytes: sum(values, 'sourceBytes'),
    parserLoads: sum(values, 'parserLoads'),
    parseErrors: sum(values, 'parseErrors'),
    skippedOversized: sum(values, 'skippedOversized'),
    skippedSymlinks: sum(values, 'skippedSymlinks'),
    skippedBinary: sum(values, 'skippedBinary'),
    skippedUnsupported: sum(values, 'skippedUnsupported'),
    skippedCapacity: sum(values, 'skippedCapacity'),
    oversizedFileGateVerified:
      values.length > 0 &&
      values.every((item) => item.oversizedFileGateVerified),
    cacheStatus: values.some((item) => item.cacheStatus === 'rebuilt_corrupt')
      ? 'rebuilt_corrupt'
      : values.some((item) => item.cacheStatus === 'rebuilt_missing')
        ? 'rebuilt_missing'
        : values.some((item) => item.cacheStatus === 'loaded')
          ? 'loaded'
          : 'not_checked',
    cacheBytes: sum(values, 'cacheBytes'),
  }
}

function sum(
  values: readonly CodeGraphDiagnostics[],
  key: keyof CodeGraphDiagnostics,
): number {
  return values.reduce((total, value) => {
    const metric = value[key]
    return total + (typeof metric === 'number' ? metric : 0)
  }, 0)
}

function validateRelativePath(value: string): string {
  const path = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
  if (
    !path ||
    isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '..')
  )
    throw new Error('Code intelligence path must be workspace-relative')
  return path
}

function cleanSymbol(value: string): string {
  const symbol = String(value ?? '').trim()
  if (!symbol || symbol.length > 256)
    throw new Error('Code intelligence symbol is invalid')
  return symbol
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Code intelligence ${label} must be a positive integer`)
  return value
}

async function canonicalWorkspace(value: string): Promise<string> {
  const root = await realpath(resolve(String(value ?? '')))
  return root
}

function portableRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/')
}

function zeroBasedCoordinate(value: unknown): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function compareLocation(
  left: CodeGraphLocation,
  right: CodeGraphLocation,
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.symbol.localeCompare(right.symbol)
  )
}

function workspaceDigest(root: string): string {
  return createHash('sha256').update(root, 'utf8').digest('hex')
}
