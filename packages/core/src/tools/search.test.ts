import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolExecutionContext } from './base'
import { GlobTool, GrepTool } from './builtin'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'emperor-search-'))
  roots.push(root)
  return root
}

async function put(root: string, path: string, content = ''): Promise<string> {
  const target = join(root, ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

function context(
  root: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): ToolExecutionContext {
  return {
    root,
    workspaceRoot: root,
    arguments: args,
    signal,
  }
}

async function glob(
  root: string,
  pattern: string,
  signal?: AbortSignal,
): Promise<string> {
  const args = { pattern }
  return String(
    await new GlobTool(root).execute(args, context(root, args, signal)),
  )
}

async function grep(
  root: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  return String(
    await new GrepTool(root).execute(args, context(root, args, signal)),
  )
}

describe('GlobTool node-native traversal', () => {
  it('keeps search code independent from child processes and shell execution', async () => {
    const searchSource = await readFile(
      new URL('./search.ts', import.meta.url),
      'utf8',
    )
    const builtinSource = await readFile(
      new URL('./builtin.ts', import.meta.url),
      'utf8',
    )

    expect(searchSource).not.toMatch(/node:child_process|\bexec(?:Sync)?\s*\(/)
    expect(builtinSource).not.toContain('execSync')
  })

  it('opens canonical targets and enforces the byte limit while streaming', async () => {
    const searchSource = await readFile(
      new URL('./search.ts', import.meta.url),
      'utf8',
    )

    expect(searchSource).toContain('opendir(physicalDirectory)')
    expect(searchSource).toContain('createReadStream(entry.realPath')
    expect(searchSource).toContain('bytesRead += chunk.length')
  })

  it('recursively matches entries and skips runtime noise directories', async () => {
    const root = await workspace()
    await put(root, 'src/index.ts')
    await put(root, 'src/nested/value.ts')
    await put(root, '.git/hidden.ts')
    await put(root, 'node_modules/pkg/hidden.ts')
    await put(root, '__pycache__/hidden.ts')
    await put(root, '.emperor/hidden.ts')
    await put(root, '.team/hidden.ts')
    await put(root, 'bundle.asar/hidden.ts')
    await put(root, 'bundle.asar.unpacked/visible.ts')

    const result = await glob(root, '**/*.ts')

    expect(result.split('\n').sort()).toEqual([
      'bundle.asar.unpacked/visible.ts',
      'src/index.ts',
      'src/nested/value.ts',
    ])
  })

  it('keeps the existing no-match response', async () => {
    const root = await workspace()

    expect(await glob(root, '**/*.missing')).toBe('(no matches)')
  })

  it('sorts matches from newest to oldest mtime', async () => {
    const root = await workspace()
    const older = await put(root, 'older.txt')
    const newer = await put(root, 'newer.txt')
    await utimes(older, new Date('2026-01-01'), new Date('2026-01-01'))
    await utimes(newer, new Date('2026-02-01'), new Date('2026-02-01'))

    expect(await glob(root, '*.txt')).toBe('newer.txt\nolder.txt')
  })

  it('normalizes Windows separators and preserves Unicode paths', async () => {
    const root = await workspace()
    await put(root, '资料/你好.ts')

    expect(await glob(root, '资料\\*.ts')).toBe('资料/你好.ts')
  })

  it('caps results at 200 entries', async () => {
    const root = await workspace()
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        put(root, `many/file-${String(index).padStart(3, '0')}.txt`),
      ),
    )

    expect((await glob(root, 'many/*.txt')).split('\n')).toHaveLength(200)
  })

  it('does not execute shell substitution, backticks, or semicolons', async () => {
    const root = await workspace()
    const canaries = ['canary-dollar', 'canary-backtick', 'canary-semicolon']

    await glob(root, '$(touch canary-dollar)')
    await glob(root, '`touch canary-backtick`')
    await glob(root, '*; touch canary-semicolon; #')

    for (const canary of canaries) {
      await expect(
        writeFile(join(root, canary), '', { flag: 'wx' }),
      ).resolves.toBe(undefined)
    }
  })

  it('returns a diagnostic error when cancelled', async () => {
    const root = await workspace()
    const controller = new AbortController()
    controller.abort()

    expect(await glob(root, '**/*', controller.signal)).toMatch(
      /^\[ERR\].*cancelled/i,
    )
  })

  it.skipIf(process.platform === 'win32')(
    'allows in-workspace symlinks and rejects escape targets and cycles',
    async () => {
      const root = await workspace()
      const outside = await workspace()
      await put(root, 'real/inside.txt')
      await put(outside, 'secret.txt', 'outside secret')
      await symlink(join(root, 'real'), join(root, 'inside-link'))

      const inside = await glob(root, 'inside-link/*.txt')
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
      const escaped = await glob(root, 'escape.txt')
      await rm(join(root, 'escape.txt'))
      await symlink(root, join(root, 'cycle'))
      const cycle = await glob(root, '**/*')

      expect(inside).toBe('inside-link/inside.txt')
      expect(escaped).toMatch(/^\[ERR\].*workspace policy/i)
      expect(escaped).not.toContain('outside secret')
      expect(cycle).toMatch(/^\[ERR\].*symlink cycle/i)
    },
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'returns a diagnostic error for permission failures',
    async () => {
      const root = await workspace()
      const denied = join(root, 'denied')
      await mkdir(denied)
      await chmod(denied, 0)
      try {
        expect(await glob(root, '**/*')).toMatch(
          /^\[ERR\].*(EACCES|permission)/i,
        )
      } finally {
        await chmod(denied, 0o700)
      }
    },
  )
})

describe('GrepTool node-native search', () => {
  it('supports files_with_matches mode with a glob filter', async () => {
    const root = await workspace()
    await put(root, 'src/a.ts', 'needle\n')
    await put(root, 'src/b.js', 'needle\n')
    await put(root, 'src/c.ts', 'other\n')

    expect(
      await grep(root, {
        pattern: 'needle',
        glob: '*.ts',
        output_mode: 'files_with_matches',
      }),
    ).toBe('src/a.ts')
  })

  it('supports count mode', async () => {
    const root = await workspace()
    await put(root, 'a.txt', 'needle\nother\nneedle again\n')

    expect(await grep(root, { pattern: 'needle', output_mode: 'count' })).toBe(
      'a.txt: 2',
    )
  })

  it('supports content mode with before and after context', async () => {
    const root = await workspace()
    await put(root, 'a.txt', 'zero\nbefore\nneedle\nafter\nlast\n')

    expect(
      await grep(root, {
        pattern: 'needle',
        output_mode: 'content',
        context_before: 1,
        context_after: 1,
      }),
    ).toBe('a.txt:3\n  2| before\n> 3| needle\n  4| after')
  })

  it('keeps the existing no-match response', async () => {
    const root = await workspace()
    await put(root, 'a.txt', 'haystack\n')

    expect(await grep(root, { pattern: 'needle' })).toBe('(no matches)')
  })

  it('returns a diagnostic error for an invalid regular expression', async () => {
    const root = await workspace()

    expect(await grep(root, { pattern: '[' })).toMatch(
      /^\[ERR\].*invalid regex/i,
    )
  })

  it('normalizes Windows path separators and searches Unicode content', async () => {
    const root = await workspace()
    await put(root, '资料/文件.txt', '你好，世界\n')

    expect(
      await grep(root, {
        pattern: '你好',
        path: '资料\\',
        output_mode: 'files_with_matches',
      }),
    ).toBe('资料/文件.txt')
    expect(
      await grep(root, {
        pattern: '你好',
        path: root,
        output_mode: 'files_with_matches',
      }),
    ).toBe('资料/文件.txt')
  })

  it('skips binary files and files larger than 2 MiB', async () => {
    const root = await workspace()
    await put(root, 'binary.dat', 'needle\u0000binary')
    await put(root, 'large.txt', `needle\n${'x'.repeat(2 * 1024 * 1024)}`)
    await put(root, 'small.txt', 'needle\n')

    expect(
      await grep(root, {
        pattern: 'needle',
        output_mode: 'files_with_matches',
      }),
    ).toBe('small.txt')
  })

  it('caps all output modes at 200 results', async () => {
    const root = await workspace()
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        put(
          root,
          `many/file-${String(index).padStart(3, '0')}.txt`,
          'needle\n',
        ),
      ),
    )

    const files = await grep(root, {
      pattern: 'needle',
      output_mode: 'files_with_matches',
    })
    const counts = await grep(root, {
      pattern: 'needle',
      output_mode: 'count',
    })
    const content = await grep(root, {
      pattern: 'needle',
      output_mode: 'content',
    })

    expect(files.split('\n')).toHaveLength(200)
    expect(counts.split('\n')).toHaveLength(200)
    expect(content.split('\n\n')).toHaveLength(200)
  })

  it('does not execute shell syntax in regex or glob inputs', async () => {
    const root = await workspace()
    await put(root, 'a.txt', 'plain\n')
    const canaries = [
      'grep-dollar',
      'grep-backtick',
      'grep-semicolon',
      'grep-glob',
    ]

    await grep(root, { pattern: '$(touch grep-dollar)' })
    await grep(root, { pattern: '`touch grep-backtick`' })
    await grep(root, { pattern: 'plain; touch grep-semicolon' })
    await grep(root, { pattern: 'plain', glob: '$(touch grep-glob)' })

    for (const canary of canaries) {
      await expect(
        writeFile(join(root, canary), '', { flag: 'wx' }),
      ).resolves.toBe(undefined)
    }
  })

  it('returns a diagnostic error when cancelled', async () => {
    const root = await workspace()
    const controller = new AbortController()
    controller.abort()

    expect(await grep(root, { pattern: 'needle' }, controller.signal)).toMatch(
      /^\[ERR\].*cancelled/i,
    )
  })

  it.skipIf(process.platform === 'win32')(
    'searches in-workspace symlinks and rejects escape targets',
    async () => {
      const root = await workspace()
      const outside = await workspace()
      await put(root, 'real/inside.txt', 'inside needle\n')
      await put(outside, 'secret.txt', 'outside needle\n')
      await symlink(join(root, 'real'), join(root, 'inside-link'))
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))

      expect(
        await grep(root, {
          pattern: 'needle',
          path: 'inside-link',
          output_mode: 'files_with_matches',
        }),
      ).toBe('inside-link/inside.txt')
      const escaped = await grep(root, {
        pattern: 'needle',
        path: 'escape.txt',
      })
      expect(escaped).toMatch(/^\[ERR\].*workspace policy/i)
      expect(escaped).not.toContain('outside needle')
    },
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'returns a diagnostic error for permission failures',
    async () => {
      const root = await workspace()
      const denied = await put(root, 'denied/file.txt', 'needle\n')
      await chmod(dirname(denied), 0)
      try {
        expect(await grep(root, { pattern: 'needle' })).toMatch(
          /^\[ERR\].*(EACCES|permission)/i,
        )
      } finally {
        await chmod(dirname(denied), 0o700)
      }
    },
  )
})
