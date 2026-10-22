import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  CLAUDE_REQUIRED_RANGE,
  KNOWN_CODEX_PROTOCOLS,
  claudeInitIssue,
  codexProtocolsFor,
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
it('requires a claude with auth status and auth login --console, never an exact build', () => {
  expect(CLAUDE_REQUIRED_RANGE).toBe('>= 2.1.79')
  for (const version of ['2.1.79', '2.1.290', '2.2.0', '3.0.1'])
    expect(
      claudeInitIssue(
        { claude_code_version: version },
        { requireVersion: true },
      ),
    ).toBeUndefined()
  for (const version of ['2.0.99', '2.1.78'])
    expect(
      claudeInitIssue(
        { claude_code_version: version },
        { requireVersion: true },
      ),
    ).toContain('>= 2.1.79')
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
it('accepts any patch of a verified Codex minor: 0.153 and, since AGT-13, 0.163', () => {
  expect(codexRequiredRange()).toBe('0.153.x / 0.163.x')
  for (const agent of [
    'codex/0.153.4',
    'codex/0.153.12',
    'codex/0.163.0',
    'codex/0.163.7',
    // What the real app-servers answer to Emperor's clientInfo.
    'emperor-agent/0.153.4 (Mac OS 26.4.1; arm64) unknown (emperor-agent; 0.1.0)',
    'emperor-agent/0.163.0 (Mac OS 26.4.1; arm64) unknown (emperor-agent; 0.1.0)',
  ])
    expect(codexUserAgentIssue(agent), agent).toBeUndefined()
  for (const agent of [
    'codex/0.154.0',
    'codex/0.162.9',
    'codex/0.164.0',
    'codex/1.163.0',
    'codex/1.153.4',
  ])
    expect(codexUserAgentIssue(agent), agent).toContain('0.153.x / 0.163.x')
  expect(codexUserAgentIssue(undefined)).toMatch(/version/)
})
it('a Codex is checked against the verified protocol of its own minor', () => {
  const versions = (text: string) =>
    codexProtocolsFor(parseVersion(text)!).map((p) => p.version)
  expect(versions('0.153.4')).toEqual(['0.153.4'])
  expect(versions('0.153.9')).toEqual(['0.153.4'])
  expect(versions('0.163.0')).toEqual(['0.163.0'])
  expect(versions('0.163.5')).toEqual(['0.163.0'])
  expect(versions('0.162.3')).toEqual([])
  expect(versions('0.164.0')).toEqual([])
})
it('the maintainer script computes the same digest as the runtime, for each verified protocol', () => {
  const repo = resolve(__dirname, '../../../../..')
  expect(KNOWN_CODEX_PROTOCOLS.map((p) => p.version)).toEqual([
    '0.153.4',
    '0.163.0',
  ])
  for (const protocol of KNOWN_CODEX_PROTOCOLS) {
    const output = execFileSync(
      process.execPath,
      [
        join(repo, 'scripts', 'codex-protocol-digest.mjs'),
        '--schema',
        join(__dirname, 'protocol', 'codex-' + protocol.version),
        '--version',
        protocol.version,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const record = JSON.parse(output)
    expect(record.files).toEqual(protocol.files)
    expect(record.digests).toEqual(protocol.digests)
  }
})
it('both verified protocols digest the same files, the user agent and model/list included', () => {
  const [older, newer] = KNOWN_CODEX_PROTOCOLS
  expect(newer!.files).toEqual(older!.files)
  expect(newer!.files).toEqual(
    expect.arrayContaining([
      'v1/InitializeResponse.json',
      'v2/ModelListResponse.json',
    ]),
  )
  expect(newer!.digests).not.toEqual(older!.digests)
})
