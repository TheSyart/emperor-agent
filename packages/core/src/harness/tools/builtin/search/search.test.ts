// Ports key dsh tool-fs-search cases (argv shape, basename matching, caps,
// grouping, include filter, spill of over-cap results) onto the plain harness.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { userText } from '../../../../llm/message'
import { createTestHarness } from '../../../testing'
import { textOf } from '../../definition'
import type { ToolServices } from '../../services'
import {
  buildGlobCommand,
  buildGrepCommand,
  createSearchTools,
  installSearchPromptSections,
  parseGrepArgs,
  parseGrepMatches,
  previewLine,
  ripgrepBinary,
  toWorkdirRelative,
} from './index'

const rgAvailable = spawnSync('rg', ['--version']).status === 0

/** A resolveBinary that forces the spawn to fail with ENOENT → pure-JS fallback. */
const missingBinary = (): string =>
  join(tmpdir(), 'emperor-no-such-dir', 'rg-missing')

/** Both engines run the same behavioral suites so their output stays identical. */
const engines = [
  { name: 'ripgrep', enabled: rgAvailable, resolveBinary: undefined },
  { name: 'js fallback', enabled: true, resolveBinary: missingBinary },
] as const

function setup(resolveBinary?: () => string | undefined) {
  const workdir = mkdtempSync(join(tmpdir(), 'emperor-search-'))
  const spillRoot = mkdtempSync(join(tmpdir(), 'emperor-spill-'))
  const services = {
    spillRoot,
    ...(resolveBinary !== undefined ? { resolveBinary } : {}),
  } as unknown as ToolServices
  const tools = createSearchTools(services)
  const h = createTestHarness()
  h.tools.register(tools.glob)
  h.tools.register(tools.grep)
  h.sessions.create({ id: 'search', cwd: workdir })
  const agent = h.agent('search')
  const run = (name: string, args: unknown) =>
    h.tools.execute({
      callId: `c-${Math.random()}`,
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
  return { workdir, spillRoot, h, run, tools, agent }
}

function write(
  root: string,
  rel: string,
  text: string,
  mtimeSec?: number,
): void {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec)
}

describe('search argv and parsing', () => {
  it('glob: fixed rg --files argv with newest-first sort and paired VCS excludes', () => {
    const argv = buildGlobCommand({ pattern: '*.md', path: 'docs dir' })
    expect(argv.slice(0, 5)).toEqual([
      '--files',
      '--glob=*.md',
      '--sortr=modified',
      '--no-ignore',
      '--hidden',
    ])
    expect(argv).toContain('--glob=!**/.git')
    expect(argv).toContain('--glob=!**/.git/**')
    expect(argv.slice(-2)).toEqual(['--', 'docs dir'])
  })

  it('grep: pattern in --regexp= form, include as --glob=, path behind --', () => {
    expect(
      buildGrepCommand({ pattern: '-foo', include: '*.ts', path: '-dir' }),
    ).toEqual(['--json', '--regexp=-foo', '--glob=*.ts', '--', '-dir'])
  })

  it('grep: validates include (negated, comma list) but accepts brace alternation and whitespace pattern', () => {
    expect(() => parseGrepArgs({ pattern: '' })).toThrow(/non-empty/)
    expect(() => parseGrepArgs({ pattern: 'x', include: '!*.ts' })).toThrow(
      /positive glob/,
    )
    expect(() => parseGrepArgs({ pattern: 'x', include: '*.ts,*.js' })).toThrow(
      /comma-separated/,
    )
    expect(parseGrepArgs({ pattern: ' ', include: '*.{ts,tsx}' })).toEqual({
      pattern: ' ',
      include: '*.{ts,tsx}',
    })
  })

  it('parses rg --json match records, strips CRLF, and placeholders non-UTF-8 lines', () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: {} }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'a.ts' },
          line_number: 3,
          lines: { text: 'hit\r\n' },
        },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'b.ts' },
          line_number: 1,
          lines: { bytes: 'AAA=' },
        },
      }),
      '',
    ].join('\n')
    expect(parseGrepMatches(stdout)).toEqual([
      { path: 'a.ts', lineNumber: 3, line: 'hit' },
      { path: 'b.ts', lineNumber: 1, line: '(line is not valid UTF-8)' },
    ])
    expect(() => parseGrepMatches('not json')).toThrow(/malformed/)
  })

  it('previews long lines at a UTF-8 boundary', () => {
    expect(previewLine('ab€cd', 3)).toBe('ab (line truncated)')
    expect(previewLine('short', 10)).toBe('short')
  })

  it('relativizes in-workdir absolute paths only', () => {
    expect(toWorkdirRelative('/w/a/b.ts', '/w')).toBe(join('a', 'b.ts'))
    expect(toWorkdirRelative('/other/b.ts', '/w')).toBe('/other/b.ts')
    expect(toWorkdirRelative('rel.ts', '/w')).toBe('rel.ts')
  })

  it('resolves rg through services.resolveBinary, else PATH', () => {
    expect(ripgrepBinary({})).toBe('rg')
    expect(ripgrepBinary({ resolveBinary: () => '/opt/rg' })).toBe('/opt/rg')
    expect(ripgrepBinary({ resolveBinary: () => undefined })).toBe('rg')
  })

  it('declares concurrency safety, the 30s timeout, and the prompt sections', () => {
    const { tools, h } = setup()
    expect(tools.glob.isConcurrencySafe?.({ pattern: '*' })).toBe(true)
    expect(tools.grep.isConcurrencySafe?.({ pattern: 'x' })).toBe(true)
    expect(tools.glob.timeoutMs).toBe(30_000)
    expect(tools.grep.timeoutMs).toBe(30_000)
    installSearchPromptSections(h.prompt)
    const sections = h.prompt.assemble().sections
    expect(sections.map((s) => s.name)).toEqual(['tool:glob', 'tool:grep'])
    expect(sections[0]?.text).toContain(
      'keeps the modification-time-ordered head',
    )
  })
})

for (const engine of engines) {
  describe.skipIf(!engine.enabled)(`glob (${engine.name})`, () => {
    it('matches basenames at any depth, newest first, hidden included, .git excluded', async () => {
      const { workdir, run } = setup(engine.resolveBinary)
      write(workdir, 'src/alpha.ts', 'a', 1_000)
      write(workdir, 'src/deep/beta.ts', 'b', 3_000)
      write(workdir, '.hidden/gamma.ts', 'c', 2_000)
      write(workdir, '.git/objects/x.ts', 'git', 4_000)
      write(workdir, 'readme.md', 'r', 5_000)
      const result = await run('glob', { pattern: '*.ts' })
      expect(result.isError).toBe(false)
      expect(textOf(result.content).split('\n')).toEqual([
        join('src', 'deep', 'beta.ts'),
        join('.hidden', 'gamma.ts'),
        join('src', 'alpha.ts'),
      ])
      expect(result.meta).toEqual({
        matches: 3,
        truncated: false,
        files: textOf(result.content).split('\n'),
      })
    })

    it('anchors a pattern with a separator and resolves a relative path against the session cwd', async () => {
      const { workdir, run } = setup(engine.resolveBinary)
      write(workdir, 'src/a.ts', 'a')
      write(workdir, 'src/sub/b.ts', 'b')
      write(workdir, 'other/c.ts', 'c')
      const anchored = await run('glob', { pattern: 'src/*.ts' })
      expect(textOf(anchored.content)).toBe(join('src', 'a.ts'))
      const scoped = await run('glob', { pattern: '*.ts', path: 'other' })
      expect(textOf(scoped.content)).toBe(join('other', 'c.ts'))
    })

    it('reports no files', async () => {
      const { run } = setup(engine.resolveBinary)
      const result = await run('glob', { pattern: '*.none' })
      expect(textOf(result.content)).toBe('No files found')
      expect(result.meta).toEqual({ matches: 0, truncated: false, files: [] })
    })

    it('caps at 100 paths and saves the FULL sorted list to a spill file', async () => {
      const { workdir, spillRoot, run } = setup(engine.resolveBinary)
      for (let i = 0; i < 120; i++)
        write(workdir, `f${String(i).padStart(3, '0')}.txt`, 'x', 1_000 + i)
      const result = await run('glob', { pattern: '*.txt' })
      const text = textOf(result.content)
      const lines = text.split('\n')
      expect(lines.slice(0, 100)).toHaveLength(100)
      expect(lines[0]).toBe('f119.txt')
      const footer =
        /\(Showing 100 of 120 paths\. Full sorted result stored at: (.+)\. Use read with offset\/limit, or grep this path to search within it\.\)$/.exec(
          text,
        )
      expect(footer).not.toBeNull()
      const spillPath = footer![1]!
      expect(spillPath.startsWith(spillRoot)).toBe(true)
      const full = readFileSync(spillPath, 'utf8').split('\n')
      expect(full).toHaveLength(120)
      expect(full[119]).toBe('f000.txt')
      expect(result.meta).toMatchObject({ matches: 120, truncated: true })
      expect((result.meta as { files: string[] }).files).toHaveLength(100)
    })
  })

  describe.skipIf(!engine.enabled)(`grep (${engine.name})`, () => {
    it('groups matches by file with line numbers', async () => {
      const { workdir, run } = setup(engine.resolveBinary)
      write(workdir, 'a.ts', 'needle one\nhay\nneedle two\n')
      write(workdir, 'b.js', 'needle three\n')
      const result = await run('grep', { pattern: 'needle' })
      const text = textOf(result.content)
      expect(text.startsWith('Found 3 matches\n\n')).toBe(true)
      expect(text).toContain('a.ts\nLine 1: needle one\nLine 3: needle two')
      expect(text).toContain('b.js\nLine 1: needle three')
      expect(result.meta).toMatchObject({ matches: 3, truncated: false })
      expect([...(result.meta as { files: string[] }).files].sort()).toEqual([
        'a.ts',
        'b.js',
      ])
    })

    it('applies the include filter and reports a single match in the singular', async () => {
      const { workdir, run } = setup(engine.resolveBinary)
      write(workdir, 'a.ts', 'needle\n')
      write(workdir, 'b.js', 'needle\n')
      const result = await run('grep', { pattern: 'needle', include: '*.ts' })
      expect(textOf(result.content)).toBe(
        'Found 1 match\n\na.ts\nLine 1: needle',
      )
    })

    it('previews lines at 2000 bytes', async () => {
      const { workdir, run } = setup(engine.resolveBinary)
      write(workdir, 'long.txt', `needle${'x'.repeat(5000)}\n`)
      const result = await run('grep', { pattern: 'needle' })
      const line = textOf(result.content)
        .split('\n')
        .find((l) => l.startsWith('Line 1: '))!
      expect(line.endsWith(' (line truncated)')).toBe(true)
      expect(
        Buffer.byteLength(
          line.slice('Line 1: '.length, -' (line truncated)'.length),
        ),
      ).toBe(2000)
    })

    it('caps at 250 matches and spills the complete formatted match list', async () => {
      const { workdir, spillRoot, run } = setup(engine.resolveBinary)
      write(
        workdir,
        'many.txt',
        Array.from({ length: 300 }, (_, i) => `needle ${i}`).join('\n'),
      )
      const result = await run('grep', { pattern: 'needle' })
      const text = textOf(result.content)
      expect(text.startsWith('Found 250 of 300 matches\n\n')).toBe(true)
      expect(text).toContain('Line 250: needle 249')
      expect(text).not.toContain('Line 251:')
      const footer =
        /\(Full grep result stored at: (.+)\. Use read with offset\/limit, or grep this path to search within it\.\)$/.exec(
          text,
        )
      expect(footer).not.toBeNull()
      expect(footer![1]!.startsWith(spillRoot)).toBe(true)
      const full = readFileSync(footer![1]!, 'utf8')
      expect(full.startsWith('Found 300 matches\n\n')).toBe(true)
      expect(full).toContain('Line 300: needle 299')
      expect(result.meta).toEqual({
        matches: 300,
        truncated: true,
        files: ['many.txt'],
      })
    })

    it('reports no matches and classifies an invalid regex', async () => {
      const { workdir, run } = setup(engine.resolveBinary)
      write(workdir, 'a.txt', 'hay\n')
      expect(textOf((await run('grep', { pattern: 'needle' })).content)).toBe(
        'No matches found',
      )
      const bad = await run('grep', { pattern: '(' })
      expect(bad.isError).toBe(true)
      expect(bad.error?.info?.code).toBe('SEARCH_INVALID_PATTERN')
    })

    it('runs end to end in an agent turn', async () => {
      const { workdir, h, agent } = setup(engine.resolveBinary)
      write(workdir, 'a.ts', 'needle\n')
      h.adapter.push(
        { tools: [{ name: 'grep', args: { pattern: 'needle' } }] },
        { text: 'done' },
      )
      agent.followup(userText('find it'))
      await agent.whenIdle()
      const second = h.adapter.requests[1]
      expect(JSON.stringify(second?.messages)).toContain('Found 1 match')
    })
  })
}

describe('js fallback engine (ripgrep binary missing)', () => {
  it('detects the missing binary and still lists files through glob with a path filter', async () => {
    const { workdir, run } = setup(missingBinary)
    write(workdir, 'src/a.ts', 'a', 1_000)
    write(workdir, 'src/b.js', 'b', 2_000)
    write(workdir, 'lib/c.ts', 'c', 3_000)
    write(workdir, 'node_modules/pkg/d.ts', 'd', 4_000)
    const all = await run('glob', { pattern: '**/*.ts' })
    expect(all.isError).toBe(false)
    expect(textOf(all.content).split('\n')).toEqual([
      join('node_modules', 'pkg', 'd.ts'),
      join('lib', 'c.ts'),
      join('src', 'a.ts'),
    ])
    const scoped = await run('glob', { pattern: '*.{ts,js}', path: 'src' })
    expect(textOf(scoped.content).split('\n')).toEqual([
      join('src', 'b.js'),
      join('src', 'a.ts'),
    ])
    const absolute = await run('glob', {
      pattern: '*.ts',
      path: join(workdir, 'lib'),
    })
    expect(textOf(absolute.content)).toBe(join('lib', 'c.ts'))
  })

  it('reports no files and a missing search path', async () => {
    const { workdir, run } = setup(missingBinary)
    write(workdir, 'a.md', 'x')
    const none = await run('glob', { pattern: '*.none' })
    expect(textOf(none.content)).toBe('No files found')
    expect(none.meta).toEqual({ matches: 0, truncated: false, files: [] })
    const missing = await run('glob', { pattern: '*', path: 'nope' })
    expect(missing.isError).toBe(true)
    expect(missing.error?.info?.code).toBe('SEARCH_FAILED')
  })

  it('grep: include and path filters, hidden and gitignored files skipped, include overrides', async () => {
    const { workdir, run } = setup(missingBinary)
    mkdirSync(join(workdir, '.git'))
    write(workdir, '.gitignore', 'dist/\n*.log\n')
    write(workdir, 'src/a.ts', 'needle a\n')
    write(workdir, 'src/b.js', 'needle b\n')
    write(workdir, 'lib/c.ts', 'hay\nneedle c\n')
    write(workdir, 'dist/out.ts', 'needle dist\n')
    write(workdir, 'debug.log', 'needle log\n')
    write(workdir, '.env', 'needle env\n')
    write(workdir, 'bin.dat', 'needle\u0000binary')

    const all = await run('grep', { pattern: 'needle' })
    expect(textOf(all.content)).toBe(
      [
        'Found 3 matches',
        '',
        `${join('lib', 'c.ts')}\nLine 2: needle c`,
        '',
        `${join('src', 'a.ts')}\nLine 1: needle a`,
        '',
        `${join('src', 'b.js')}\nLine 1: needle b`,
      ].join('\n'),
    )

    // Like ripgrep: an include match overrides hidden/gitignore for files, but an ignored directory stays pruned.
    const included = await run('grep', { pattern: 'needle', include: '*.ts' })
    expect(textOf(included.content)).not.toContain(join('dist', 'out.ts'))
    expect(textOf(included.content)).not.toContain('b.js')
    expect(
      textOf(
        (await run('grep', { pattern: 'needle', include: '*.log' })).content,
      ),
    ).toBe('Found 1 match\n\ndebug.log\nLine 1: needle log')
    expect(
      textOf(
        (await run('grep', { pattern: 'needle', include: '.env' })).content,
      ),
    ).toBe('Found 1 match\n\n.env\nLine 1: needle env')

    const scoped = await run('grep', {
      pattern: 'needle',
      path: 'src',
      include: '*.js',
    })
    expect(textOf(scoped.content)).toBe(
      `Found 1 match\n\n${join('src', 'b.js')}\nLine 1: needle b`,
    )

    const file = await run('grep', { pattern: 'needle', path: 'debug.log' })
    expect(textOf(file.content)).toBe(
      'Found 1 match\n\ndebug.log\nLine 1: needle log',
    )
  })

  it('grep: no matches, inline (?i) flag, and an invalid regex classification', async () => {
    const { workdir, run } = setup(missingBinary)
    write(workdir, 'a.txt', 'Hay\r\nNEEDLE\n')
    expect(textOf((await run('grep', { pattern: 'needle' })).content)).toBe(
      'No matches found',
    )
    expect(textOf((await run('grep', { pattern: '(?i)needle' })).content)).toBe(
      'Found 1 match\n\na.txt\nLine 2: NEEDLE',
    )
    const bad = await run('grep', { pattern: '(' })
    expect(bad.isError).toBe(true)
    expect(bad.error?.info?.code).toBe('SEARCH_INVALID_PATTERN')
  })
})
