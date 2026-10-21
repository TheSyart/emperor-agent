import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// DS-06: the design system's specs live in docs/design/. Every page there has
// the four-line status header (docs/DOCUMENTATION.md) and is listed in both
// indexes; scripts/check_public_docs.mjs enforces it in ./scripts/check.sh.

const REPO = join(new URL('.', import.meta.url).pathname, '../../../..')

interface DesignDocsModule {
  statusHeaderProblems: (source: string) => string[]
  checkDesignDocs: (root: string) => string[]
}

async function load(): Promise<DesignDocsModule> {
  const url = pathToFileURL(join(REPO, 'scripts/lib/design-docs.mjs')).href
  return (await import(/* @vite-ignore */ url)) as DesignDocsModule
}

const HEADER = [
  '# 示例',
  '',
  '> 文档状态：Active<br>',
  '> 面向读者：设计者<br>',
  '> 最后核验：2026-10-21<br>',
  '> 事实源：`desktop/src/renderer/src/theme/`',
  '',
  '正文。',
].join('\n')

describe('design docs (DS-06)', () => {
  it('has the design system specs', () => {
    for (const name of [
      'tokens',
      'color',
      'typography',
      'layout',
      'components',
      'motion',
      'overlays',
    ])
      expect(existsSync(join(REPO, 'docs/design', `${name}.md`)), name).toBe(
        true,
      )
  })

  it('accepts the four-line status header and names what is missing (test 4)', async () => {
    const { statusHeaderProblems } = await load()
    expect(statusHeaderProblems(HEADER)).toEqual([])
    expect(
      statusHeaderProblems(HEADER.replace('> 面向读者：设计者<br>\n', '')),
    ).toEqual([expect.stringContaining('面向读者')])
    expect(statusHeaderProblems(HEADER.replace('2026-10-21', '十月'))).toEqual([
      expect.stringContaining('YYYY-MM-DD'),
    ])
    // REL-06: the date may name the commit the page was checked against.
    expect(
      statusHeaderProblems(
        HEADER.replace('2026-10-21', '2026-10-21（对照 `ce55ee4a`）'),
      ),
    ).toEqual([])
    expect(
      statusHeaderProblems(
        HEADER.replace('2026-10-21', '2026-10-21（对照 main）'),
      ),
    ).toEqual([expect.stringContaining('YYYY-MM-DD')])
    expect(statusHeaderProblems(HEADER.replace('Active', 'Draft'))).toEqual([
      expect.stringContaining('Active'),
    ])
    expect(statusHeaderProblems('# 没有状态头\n\n正文。')).not.toEqual([])
  })

  it('gives every design doc the status header and an entry in both indexes (test 4)', async () => {
    const { checkDesignDocs } = await load()
    expect(checkDesignDocs(REPO)).toEqual([])
  })

  it(
    'passes the public documentation check (test 3)',
    { timeout: 60_000 },
    () => {
      expect(() =>
        execFileSync(process.execPath, ['scripts/check_public_docs.mjs'], {
          cwd: REPO,
          stdio: 'pipe',
        }),
      ).not.toThrow()
    },
  )
})
