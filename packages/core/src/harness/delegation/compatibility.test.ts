import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  CLAUDE_REQUIRED_RANGE,
  KNOWN_CODEX_PROTOCOLS,
  claudeInitIssue,
  codexRequiredRange,
  codexUserAgentIssue,
  parseVersion,
} from './compatibility'

it('reads versions from CLI banners and user agents', () => {
  expect(parseVersion('2.1.281 (Claude Code)')).toEqual({
    major: 2,
    minor: 1,
    patch: 281,
  })
  expect(parseVersion('codex-cli 0.153.4')).toMatchObject({ minor: 153 })
  expect(parseVersion('codex_cli_rs/0.153.9 (Mac OS 26.4.0; arm64)')).toEqual({
    major: 0,
    minor: 153,
    patch: 9,
  })
  expect(parseVersion('no version')).toBeUndefined()
})
it('requires at least the bundled Claude minor, never an exact build', () => {
  expect(CLAUDE_REQUIRED_RANGE).toBe('>= 2.1')
  for (const version of ['2.1.0', '2.1.290', '2.2.0', '3.0.1'])
    expect(
      claudeInitIssue(
        { claude_code_version: version },
        { requireVersion: true },
      ),
    ).toBeUndefined()
  expect(
    claudeInitIssue(
      { claude_code_version: '2.0.99' },
      { requireVersion: true },
    ),
  ).toContain('>= 2.1')
  // The bundled binary is ours; a missing field only matters for the installed one.
  expect(claudeInitIssue({}, { requireVersion: false })).toBeUndefined()
  expect(claudeInitIssue({}, { requireVersion: true })).toMatch(/version/)
  expect(
    claudeInitIssue(
      { claude_code_version: '2.1.281', permissionMode: 'default', tools: [] },
      { requireVersion: true },
    ),
  ).toBeUndefined()
  expect(claudeInitIssue({ tools: 'Read' }, { requireVersion: false })).toMatch(
    /tool list/,
  )
})
it('accepts any patch of a verified Codex minor', () => {
  expect(codexRequiredRange()).toBe('0.153.x')
  expect(codexUserAgentIssue('codex/0.153.4')).toBeUndefined()
  expect(codexUserAgentIssue('codex/0.153.12')).toBeUndefined()
  expect(codexUserAgentIssue('codex/0.154.0')).toContain('0.153.x')
  expect(codexUserAgentIssue('codex/1.153.4')).toContain('0.153.x')
  expect(codexUserAgentIssue(undefined)).toMatch(/version/)
})
it('the maintainer script computes the same digest as the runtime', () => {
  const repo = resolve(__dirname, '../../../../..')
  const output = execFileSync(
    process.execPath,
    [
      join(repo, 'scripts', 'codex-protocol-digest.mjs'),
      '--schema',
      join(__dirname, 'protocol', 'codex-0.153.4'),
      '--version',
      '0.153.4',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const record = JSON.parse(output)
  expect(record.files).toEqual(KNOWN_CODEX_PROTOCOLS[0]!.files)
  expect(record.digests).toEqual(KNOWN_CODEX_PROTOCOLS[0]!.digests)
})
