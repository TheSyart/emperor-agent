import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defaultExecutorConfig } from './config'
import {
  bundledClaudeExecutable,
  claudeExecutableSource,
  executorExecutable,
} from './executable'

const roots: string[] = []
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
)
const [claude, codex] = defaultExecutorConfig().profiles

it('finds the SDK platform binary the way the SDK launcher does', () => {
  const path = bundledClaudeExecutable()
  expect(path).toMatch(
    new RegExp(
      `claude-agent-sdk-${process.platform}-${process.arch}[\\\\/]claude$`,
    ),
  )
  expect(bundledClaudeExecutable({ platform: 'linux', arch: 'ppc64' })).toBe(
    undefined,
  )
})
it('runs the packaged binary from app.asar.unpacked', () => {
  const resources = mkdtempSync(join(tmpdir(), 'emperor-resources-'))
  roots.push(resources)
  const binary = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk-darwin-x64',
    'claude',
  )
  mkdirSync(join(binary, '..'), { recursive: true })
  writeFileSync(binary, 'native', { mode: 0o755 })
  expect(
    bundledClaudeExecutable({
      platform: 'darwin',
      arch: 'x64',
      resourcesPath: resources,
    }),
  ).toBe(binary)
})
it('chooses the bundled Claude unless the installed claude is selected', () => {
  expect(claudeExecutableSource(claude!)).toBe('bundled')
  expect(
    claudeExecutableSource({ ...claude!, executableSource: undefined }),
  ).toBe('bundled')
  expect(claudeExecutableSource(codex!)).toBeUndefined()
  expect(executorExecutable(claude!, () => '/bundled/claude')).toBe(
    '/bundled/claude',
  )
  expect(
    executorExecutable(
      { ...claude!, executableSource: 'system', executablePath: '/usr/x' },
      () => '/bundled/claude',
    ),
  ).toBe('/usr/x')
  expect(executorExecutable(codex!, () => '/bundled/claude')).toBe('codex')
  expect(() => executorExecutable(claude!, () => undefined)).toThrow(
    /EXECUTOR_MISSING.*reinstall Emperor/,
  )
})
