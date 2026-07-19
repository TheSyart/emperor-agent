export const MAX_CODE_GRAPH_FILE_BYTES = 5 * 1024 * 1024
export const CODE_GRAPH_PARSER_REVISION = 'typescript-5.9-code-graph-v1'

export type CodeSymbolKind =
  | 'class'
  | 'enum'
  | 'function'
  | 'import'
  | 'interface'
  | 'method'
  | 'module'
  | 'parameter'
  | 'property'
  | 'reference'
  | 'type'
  | 'variable'

export interface CodeGraphLocation {
  readonly symbol: string
  readonly path: string
  readonly line: number
  readonly column: number
  readonly endColumn: number
  readonly kind: CodeSymbolKind
}

export interface CodeGraphExtractInput {
  relativePath: string
  content: string
  bytes: number
  mtimeMs: number
}

export interface CodeGraphFileShard {
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
  readonly contentSha256: string
  readonly definitions: readonly CodeGraphLocation[]
  readonly references: readonly CodeGraphLocation[]
  readonly occurrences: readonly CodeGraphLocation[]
}

export interface CodeGraphExtractor {
  extract(input: CodeGraphExtractInput): Promise<CodeGraphFileShard>
}

export type CodeGraphFileEvent =
  | { kind: 'created' | 'modified' | 'removed'; path: string }
  | { kind: 'renamed'; path: string; nextPath: string }

export interface CodeGraphSnapshot {
  readonly version: number
  readonly fileCount: number
  readonly sourceBytes: number
  definitions(symbol: string): readonly CodeGraphLocation[]
  references(symbol: string): readonly CodeGraphLocation[]
  symbolAt(path: string, line: number, column: number): string | null
  file(path: string): CodeGraphFileShard | null
}

export type CodeGraphManagerState = 'idle' | 'building' | 'ready' | 'closed'

export interface CodeGraphDiagnostics {
  state: CodeGraphManagerState
  version: number
  indexedFiles: number
  sourceBytes: number
  parserLoads: number
  parseErrors: number
  skippedOversized: number
  skippedSymlinks: number
  skippedBinary: number
  skippedUnsupported: number
  skippedCapacity: number
  oversizedFileGateVerified: boolean
  cacheStatus: 'not_checked' | 'loaded' | 'rebuilt_missing' | 'rebuilt_corrupt'
  cacheBytes: number
}
