import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  CLAUDE_INSTALL_COMMAND,
  findExecutable,
  locateExecutable,
} from './executable'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
)
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'emperor-executable-'))
  roots.push(dir)
  return dir
}

it('finds an executable file on PATH, by name or by absolute path (AGT-12)', () => {
  const dir = root()
  const a = join(dir, 'a'),
    b = join(dir, 'b')
  mkdirSync(a)
  mkdirSync(b)
  writeFileSync(join(a, 'claude'), 'not executable', { mode: 0o644 })
  writeFileSync(join(b, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  mkdirSync(join(a, 'codex'))
  expect(findExecutable('claude', `${a}:${b}`)).toBe(join(b, 'claude'))
  expect(findExecutable('codex', a)).toBeUndefined()
  expect(findExecutable(join(b, 'claude'), '')).toBe(join(b, 'claude'))
  expect(findExecutable(join(a, 'claude'), '')).toBeUndefined()
  expect(findExecutable('bin/claude', b)).toBeUndefined()
  expect(findExecutable('claude', 'relative:')).toBeUndefined()
  // A Homebrew or npm link counts.
  symlinkSync(join(b, 'claude'), join(a, 'linked'))
  expect(findExecutable('linked', a)).toBe(join(a, 'linked'))
})

it('asks the login shell for its PATH only when PATH has no claude', async () => {
  const dir = root()
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  const asked: string[][] = []
  const shell = {
    read: async (names: readonly string[]) => {
      asked.push([...names])
      return { PATH: dir }
    },
  }
  expect(
    await locateExecutable('claude', { path: dir, loginShell: shell }),
  ).toBe(join(dir, 'claude'))
  expect(asked).toEqual([])
  expect(
    await locateExecutable('claude', { path: '/usr/bin', loginShell: shell }),
  ).toBe(join(dir, 'claude'))
  expect(asked).toEqual([['PATH']])
  expect(await locateExecutable('claude', { path: '/usr/bin' })).toBeUndefined()
})

it('quotes the official install command (code.claude.com/docs/en/setup)', () => {
  expect(CLAUDE_INSTALL_COMMAND).toBe(
    'curl -fsSL https://claude.ai/install.sh | bash',
  )
})
