import { describe, expect, it } from 'vitest'
import * as TypeScript from 'typescript'
import { createTypeScriptCodeGraphExtractor } from './extractor'
import { CODE_GRAPH_PARSER_REVISION } from './models'

describe('TypeScript code graph extractor', () => {
  it('binds the parser receipt revision to the exact installed compiler line', () => {
    expect(CODE_GRAPH_PARSER_REVISION).toBe(
      `typescript-${TypeScript.versionMajorMinor}-code-graph-v1`,
    )
  })

  it('extracts TypeScript and JavaScript definitions and references with source locations', async () => {
    const extractor = await createTypeScriptCodeGraphExtractor()
    const typescript = await extractor.extract({
      relativePath: 'src/math.ts',
      content:
        'export function alpha(value: number) { return value + 1 }\n' +
        'export class Calculator { run() { return alpha(1) } }\n',
      bytes: 120,
      mtimeMs: 1,
    })
    const javascript = await extractor.extract({
      relativePath: 'src/value.js',
      content: 'const answer = 42\nconsole.log(answer)\n',
      bytes: 42,
      mtimeMs: 2,
    })

    expect(typescript.definitions.map((item) => item.symbol)).toEqual(
      expect.arrayContaining(['alpha', 'value', 'Calculator', 'run']),
    )
    expect(
      typescript.references.filter((item) => item.symbol === 'alpha'),
    ).toMatchObject([{ path: 'src/math.ts', line: 2, kind: 'reference' }])
    expect(javascript.definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'answer', line: 1 }),
      ]),
    )
    expect(javascript.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'answer', line: 2 }),
      ]),
    )
  })

  it('does not count declaration names as references and deduplicates stable locations', async () => {
    const extractor = await createTypeScriptCodeGraphExtractor()
    const shard = await extractor.extract({
      relativePath: 'src/model.ts',
      content:
        'interface User { name: string }\n' +
        'const UserAlias = User\n' +
        'function read(user: User) { return user.name }\n',
      bytes: 100,
      mtimeMs: 1,
    })

    expect(
      shard.references.filter((item) => item.symbol === 'User'),
    ).toHaveLength(2)
    expect(new Set(shard.occurrences.map(locationKey)).size).toBe(
      shard.occurrences.length,
    )
  })

  it('resolves the symbol at a 1-based line and column', async () => {
    const content =
      'function target() { return 1 }\nfunction caller() { return target() }\n'
    const extractor = await createTypeScriptCodeGraphExtractor()
    const shard = await extractor.extract({
      relativePath: 'src/call.ts',
      content,
      bytes: Buffer.byteLength(content),
      mtimeMs: 1,
    })
    const column = content.split('\n')[1]!.indexOf('target') + 1
    const occurrence = shard.occurrences.find(
      (item) =>
        item.line === 2 && item.column <= column && item.endColumn >= column,
    )

    expect(occurrence).toMatchObject({
      symbol: 'target',
      path: 'src/call.ts',
      kind: 'reference',
    })
  })

  it('returns a bounded shard for syntactically incomplete source instead of throwing', async () => {
    const extractor = await createTypeScriptCodeGraphExtractor()
    const shard = await extractor.extract({
      relativePath: 'src/incomplete.ts',
      content: 'export function partial( {\nconst stillVisible = 1\n',
      bytes: 51,
      mtimeMs: 1,
    })

    expect(shard.definitions.length).toBeLessThan(20)
    expect(shard.definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: 'partial' })]),
    )
  })
})

function locationKey(item: {
  symbol: string
  path: string
  line: number
  column: number
  kind: string
}): string {
  return [item.symbol, item.path, item.line, item.column, item.kind].join(':')
}
