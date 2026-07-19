import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CODE_GRAPH_FILE_BYTES, type CodeGraphExtractor } from './models'
import {
  CodeGraphIndexManager,
  type CodeGraphIndexManagerOptions,
} from './index-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture(): Promise<{ workspace: string; stateRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'emperor-code-graph-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const stateRoot = join(root, 'state')
  await mkdir(workspace, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  return { workspace, stateRoot }
}

async function put(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

function manager(
  workspace: string,
  stateRoot: string,
  opts: Pick<CodeGraphIndexManagerOptions, 'loadExtractor'> = {},
): CodeGraphIndexManager {
  return new CodeGraphIndexManager({
    workspaceRoot: workspace,
    cacheRoot: join(stateRoot, 'projects', 'project-a', 'code-intelligence'),
    ...opts,
  })
}

describe('CodeGraphIndexManager', () => {
  it('does not scan or load the parser until first ensure/query and singleflights concurrent starts', async () => {
    const { workspace, stateRoot } = await fixture()
    await put(workspace, 'src/a.ts', 'export const alpha = 1\n')
    let parserLoads = 0
    const graph = manager(workspace, stateRoot, {
      loadExtractor: async () => {
        parserLoads += 1
        return stubExtractor()
      },
    })

    expect(graph.diagnostics()).toMatchObject({
      state: 'idle',
      parserLoads: 0,
      indexedFiles: 0,
    })
    expect(parserLoads).toBe(0)
    await Promise.all([graph.ensureStarted(), graph.ensureStarted()])

    expect(parserLoads).toBe(1)
    expect(graph.diagnostics()).toMatchObject({
      state: 'ready',
      parserLoads: 1,
      indexedFiles: 1,
    })
  })

  it('indexes real TypeScript definitions/references and resolves a position', async () => {
    const { workspace, stateRoot } = await fixture()
    const content =
      'export function alpha() { return 1 }\n' +
      'export function caller() { return alpha() }\n'
    await put(workspace, 'src/a.ts', content)
    const graph = manager(workspace, stateRoot)

    await graph.ensureStarted()
    const snapshot = graph.snapshot()
    const column = content.split('\n')[1]!.indexOf('alpha') + 1

    expect(snapshot.definitions('alpha')).toMatchObject([
      { path: 'src/a.ts', line: 1, kind: 'function' },
    ])
    expect(snapshot.references('alpha')).toMatchObject([
      { path: 'src/a.ts', line: 2, kind: 'reference' },
    ])
    expect(snapshot.symbolAt('src/a.ts', 2, column)).toBe('alpha')
    const file = snapshot.file('src/a.ts')!
    expect(
      file.occurrences.find(
        (location) =>
          location.symbol === 'alpha' && location.kind === 'function',
      ),
    ).toBe(file.definitions.find((location) => location.symbol === 'alpha'))
  })

  it('updates one shard with copy-on-write while old snapshots and unchanged shard identities stay stable', async () => {
    const { workspace, stateRoot } = await fixture()
    await put(workspace, 'src/a.ts', 'export const alpha = 1\n')
    await put(workspace, 'src/b.ts', 'export const stable = 2\n')
    const graph = manager(workspace, stateRoot)
    await graph.ensureStarted()
    const before = graph.snapshot()
    const unchangedShard = before.file('src/b.ts')

    await put(workspace, 'src/a.ts', 'export const gamma = 1\n')
    await graph.apply([{ kind: 'modified', path: 'src/a.ts' }])
    const after = graph.snapshot()

    expect(before.definitions('alpha')).toHaveLength(1)
    expect(before.definitions('gamma')).toHaveLength(0)
    expect(after.definitions('alpha')).toHaveLength(0)
    expect(after.definitions('gamma')).toHaveLength(1)
    expect(after.file('src/b.ts')).toBe(unchangedShard)
    expect(after.version).toBe(before.version + 1)
  })

  it('applies create/delete/rename events idempotently with deterministic order', async () => {
    const { workspace, stateRoot } = await fixture()
    await put(workspace, 'z.ts', 'export const shared = 1\n')
    const graph = manager(workspace, stateRoot)
    await graph.ensureStarted()
    await put(workspace, 'a.ts', 'export const shared = 2\n')
    await graph.apply([
      { kind: 'created', path: 'a.ts' },
      { kind: 'created', path: 'a.ts' },
    ])

    expect(
      graph
        .snapshot()
        .definitions('shared')
        .map((item) => item.path),
    ).toEqual(['a.ts', 'z.ts'])

    await put(workspace, 'renamed.ts', 'export const renamed = 3\n')
    await rm(join(workspace, 'a.ts'))
    await graph.apply([
      { kind: 'renamed', path: 'a.ts', nextPath: 'renamed.ts' },
      { kind: 'removed', path: 'z.ts' },
    ])

    expect(graph.snapshot().fileCount).toBe(1)
    expect(graph.snapshot().definitions('shared')).toEqual([])
    expect(graph.snapshot().definitions('renamed')).toHaveLength(1)
  })

  it('indexes exactly 5 MiB, skips larger files before parser invocation, and records the gate', async () => {
    const { workspace, stateRoot } = await fixture()
    await put(workspace, 'exact.ts', 'a'.repeat(MAX_CODE_GRAPH_FILE_BYTES))
    await put(
      workspace,
      'oversized.ts',
      'b'.repeat(MAX_CODE_GRAPH_FILE_BYTES + 1),
    )
    const seen: string[] = []
    const graph = manager(workspace, stateRoot, {
      loadExtractor: async () => stubExtractor(seen),
    })

    await graph.ensureStarted()

    expect(seen).toEqual(['exact.ts'])
    expect(graph.diagnostics()).toMatchObject({
      indexedFiles: 1,
      skippedOversized: 1,
      oversizedFileGateVerified: true,
    })
  })

  it.skipIf(process.platform === 'win32')(
    'skips symlinks and never reads an outside workspace target',
    async () => {
      const { workspace, stateRoot } = await fixture()
      const outside = join(dirname(workspace), 'outside.ts')
      await writeFile(outside, 'export const secretOutside = 1\n')
      await put(workspace, 'inside.ts', 'export const inside = 1\n')
      await symlink(outside, join(workspace, 'escape.ts'))
      const graph = manager(workspace, stateRoot)

      await graph.ensureStarted()

      expect(graph.snapshot().definitions('inside')).toHaveLength(1)
      expect(graph.snapshot().definitions('secretOutside')).toEqual([])
      expect(graph.diagnostics().skippedSymlinks).toBe(1)
    },
  )

  it('ignores a corrupt derived cache and rebuilds without changing source bytes', async () => {
    const { workspace, stateRoot } = await fixture()
    await put(workspace, 'src/a.ts', 'export const alpha = 1\n')
    const first = manager(workspace, stateRoot)
    await first.ensureStarted()
    const cachePath = first.cachePath
    const before = sha256(await readFile(join(workspace, 'src/a.ts')))
    await first.close()
    await writeFile(cachePath, '{bad cache', 'utf8')

    const second = manager(workspace, stateRoot)
    await second.ensureStarted()

    expect(second.snapshot().definitions('alpha')).toHaveLength(1)
    expect(second.diagnostics().cacheStatus).toBe('rebuilt_corrupt')
    expect(sha256(await readFile(join(workspace, 'src/a.ts')))).toBe(before)
  })

  it('keeps the compressed derived cache smaller than repetitive indexed sources', async () => {
    const { workspace, stateRoot } = await fixture()
    const repeated =
      'export function sharedName(value: number) { return value + 1 }\n'.repeat(
        20,
      )
    for (let index = 0; index < 120; index += 1)
      await put(workspace, `src/file-${index}.ts`, repeated)
    const graph = manager(workspace, stateRoot)

    await graph.ensureStarted()
    const diagnostics = graph.diagnostics()

    expect(diagnostics.indexedFiles).toBe(120)
    expect(diagnostics.cacheBytes).toBeGreaterThan(0)
    expect(diagnostics.cacheBytes).toBeLessThan(diagnostics.sourceBytes)
  })

  it('enforces the evaluated file-count capacity and reports partial coverage', async () => {
    const { workspace, stateRoot } = await fixture()
    for (let index = 0; index < 205; index += 1)
      await put(
        workspace,
        `src/cap-${index}.ts`,
        `export const cap${index} = 1\n`,
      )
    const graph = manager(workspace, stateRoot, {
      loadExtractor: async () => stubExtractor(),
    })

    await graph.ensureStarted()

    expect(graph.diagnostics()).toMatchObject({
      indexedFiles: 200,
      skippedCapacity: 5,
    })
  })

  it('enforces the evaluated aggregate source-byte capacity before parsing', async () => {
    const { workspace, stateRoot } = await fixture()
    const oneMiB = 'x'.repeat(1024 * 1024)
    for (let index = 0; index < 6; index += 1)
      await put(workspace, `src/bytes-${index}.ts`, oneMiB)
    const graph = manager(workspace, stateRoot, {
      loadExtractor: async () => stubExtractor(),
    })

    await graph.ensureStarted()

    expect(graph.diagnostics()).toMatchObject({
      indexedFiles: 5,
      sourceBytes: 5 * 1024 * 1024,
      skippedCapacity: 1,
    })
  })

  it('honors an already-aborted start without loading the parser or writing cache', async () => {
    const { workspace, stateRoot } = await fixture()
    await put(workspace, 'a.ts', 'export const alpha = 1\n')
    let parserLoads = 0
    const graph = manager(workspace, stateRoot, {
      loadExtractor: async () => {
        parserLoads += 1
        return stubExtractor()
      },
    })
    const controller = new AbortController()
    controller.abort('cancelled fixture')

    await expect(graph.ensureStarted(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(parserLoads).toBe(0)
    expect(graph.diagnostics().state).toBe('idle')
    await expect(readFile(graph.cachePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('serializes concurrent mutations through one extractor owner', async () => {
    const { workspace, stateRoot } = await fixture()
    let active = 0
    let maximum = 0
    const extractor = stubExtractor()
    const graph = manager(workspace, stateRoot, {
      loadExtractor: async () => ({
        async extract(input) {
          active += 1
          maximum = Math.max(maximum, active)
          await new Promise((resolve) => setTimeout(resolve, 10))
          try {
            return await extractor.extract(input)
          } finally {
            active -= 1
          }
        },
      }),
    })
    await graph.ensureStarted()
    await put(workspace, 'a.ts', 'export const a = 1\n')
    await put(workspace, 'b.ts', 'export const b = 1\n')

    await Promise.all([
      graph.apply([{ kind: 'created', path: 'a.ts' }]),
      graph.apply([{ kind: 'created', path: 'b.ts' }]),
    ])

    expect(maximum).toBe(1)
    expect(graph.snapshot().fileCount).toBe(2)
  })

  it('isolates one extractor failure and keeps other files queryable', async () => {
    const { workspace, stateRoot } = await fixture()
    await put(workspace, 'bad.ts', 'export const bad = 1\n')
    await put(workspace, 'good.ts', 'export const good = 1\n')
    const fallback = stubExtractor()
    const graph = manager(workspace, stateRoot, {
      loadExtractor: async () => ({
        async extract(input) {
          if (input.relativePath === 'bad.ts')
            throw new Error('PRIVATE SOURCE PARSE FAILURE')
          return await fallback.extract(input)
        },
      }),
    })

    await graph.ensureStarted()

    expect(graph.snapshot().definitions('good')).toHaveLength(1)
    expect(graph.snapshot().definitions('bad')).toEqual([])
    expect(graph.diagnostics()).toMatchObject({ parseErrors: 1 })
    expect(JSON.stringify(graph.diagnostics())).not.toContain('PRIVATE SOURCE')
  })
})

function stubExtractor(seen: string[] = []): CodeGraphExtractor {
  return {
    async extract(input) {
      seen.push(input.relativePath)
      const match = /(?:const|function|class)\s+([A-Za-z_$][\w$]*)/.exec(
        input.content.slice(0, 1024),
      )
      const symbol = match?.[1]
      const location = symbol
        ? Object.freeze({
            symbol,
            path: input.relativePath,
            line: 1,
            column: Math.max(1, (match?.index ?? 0) + 1),
            endColumn: Math.max(1, (match?.index ?? 0) + symbol.length),
            kind: 'variable' as const,
          })
        : null
      return Object.freeze({
        path: input.relativePath,
        bytes: input.bytes,
        mtimeMs: input.mtimeMs,
        contentSha256: sha256(input.content),
        definitions: Object.freeze(location ? [location] : []),
        references: Object.freeze([]),
        occurrences: Object.freeze(location ? [location] : []),
      })
    },
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
