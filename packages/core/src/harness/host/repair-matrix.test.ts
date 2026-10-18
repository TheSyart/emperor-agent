// SEC-03 (PLAN-V020, findings CORE-3 / CORE-43): every start/end pair of log
// markers has a crash-repair step. The matrix reads every `SessionEventMap`
// declaration in the source, so a new `foo/start` without a contributor
// fails here before it ships.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { TURN_REPAIR } from '../../session-log/store'
import {
  EXEMPT_OPENERS,
  lifecycleOpeners,
  REPAIR_CONTRIBUTORS,
  unrepairedOpeners,
} from './repair-contributors'

const SRC = join(__dirname, '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : []
  })
}

/** Every key of every `interface SessionEventMap` declaration under src/. */
function sessionEventTypes(): Map<string, string> {
  const types = new Map<string, string>()
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('interface SessionEventMap')) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (
        ts.isInterfaceDeclaration(node) &&
        node.name.text === 'SessionEventMap'
      )
        for (const member of node.members)
          if (member.name !== undefined)
            types.set(
              member.name.getText(source).replace(/^'|'$/g, ''),
              relative(SRC, file),
            )
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return types
}

const ALL = [TURN_REPAIR, ...REPAIR_CONTRIBUTORS]

describe('crash repair matrix', () => {
  const types = sessionEventTypes()

  it('finds the event vocabulary', () => {
    expect(types.get('turn/start')).toBe('session-log/types.ts')
    expect(types.get('compaction/start')).toBe('harness/compaction/events.ts')
    expect(types.size).toBeGreaterThan(50)
  })

  it('gives every start marker in the source a repair step', () => {
    expect(unrepairedOpeners([...types.keys()], ALL)).toEqual([])
  })

  it('fails for a new pair nobody repairs', () => {
    const extended = [...types.keys(), 'foo/start', 'foo/end']
    expect(unrepairedOpeners(extended, ALL)).toEqual(['foo/start'])
  })

  it('recognises the opener spellings in use', () => {
    expect(
      lifecycleOpeners([
        'a/start',
        'b/run-start',
        'c/started',
        'd/asked',
        'e/grant-requested',
        'f/target-opened',
        'g/action-prepared',
        'h/action-dispatched',
        'i/begin',
        'j/end',
        'k/summary',
      ]),
    ).toEqual([
      'a/start',
      'b/run-start',
      'c/started',
      'd/asked',
      'e/grant-requested',
      'f/target-opened',
      'g/action-prepared',
      'h/action-dispatched',
      'i/begin',
    ])
  })

  it('names only real events in every declared pair', () => {
    for (const contributor of ALL)
      for (const [start, end] of contributor.pairs) {
        expect(types.has(start), `${contributor.id}: ${start}`).toBe(true)
        expect(types.has(end), `${contributor.id}: ${end}`).toBe(true)
      }
    for (const opener of Object.keys(EXEMPT_OPENERS))
      expect(types.has(opener), opener).toBe(true)
  })

  it('keeps contributor ids unique', () => {
    const ids = ALL.map((contributor) => contributor.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
