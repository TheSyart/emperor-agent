import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeSecurityScript, installClaudeSecurity } from './claude-keychain'
import { delegationTestDirectory } from './testing'

/**
 * FIX-19 · Claude Code runs with a dedicated HOME (AGT-12), where macOS has
 * no login keychain: its keychain calls raised the system 「找不到钥匙串」
 * dialog. Emperor's `security` answers its password calls as unavailable,
 * so Claude Code keeps its login in its own `.credentials.json`; every
 * other call reaches the real tool (a recording fake here).
 */

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((c) => c()))

function fixture() {
  const f = delegationTestDirectory()
  cleanups.push(f.cleanup)
  const calls = join(f.root, 'real-security.log')
  const real = join(f.root, 'real-security')
  writeFileSync(
    real,
    [
      '#!/bin/sh',
      `printf 'ARGS %s\\n' "$*" >> '${calls}'`,
      `if [ "$1" = "-i" ]; then printf 'STDIN %s\\n' "$(cat)" >> '${calls}'; fi`,
      'exit 7',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const bin = join(f.root, 'bin')
  mkdirSync(bin, { recursive: true })
  const script = join(bin, 'security')
  writeFileSync(script, claudeSecurityScript(real), { mode: 0o755 })
  const security = (args: string[], input = '') => {
    const result = spawnSync('/bin/sh', [script, ...args], { input })
    return result.status
  }
  const recorded = () => {
    try {
      return readFileSync(calls, 'utf8')
    } catch {
      return ''
    }
  }
  return { root: f.root, security, recorded }
}

describe('FIX-19 · the security Claude Code finds first', () => {
  it('answers the keychain password calls as unavailable, without the real tool', () => {
    const s = fixture()
    const service = ['-a', 'ada', '-s', 'Claude Code-credentials-1a2b3c4d']
    // Read and delete: 「the item could not be found」 (44), so Claude Code
    // reads its .credentials.json and treats a delete as done.
    expect(s.security(['find-generic-password', ...service, '-w'])).toBe(44)
    expect(s.security(['delete-generic-password', ...service])).toBe(44)
    // Writes fail without being transient, so Claude Code falls back to the
    // file; the lock check is not 36, so the keychain does not look locked.
    expect(
      s.security(['add-generic-password', '-U', ...service, '-X', '00']),
    ).toBe(1)
    expect(s.security(['show-keychain-info'])).toBe(1)
    expect(
      s.security(
        ['-i'],
        'add-generic-password -U -a ada -s "Claude Code-credentials" -X 7b7d\n',
      ),
    ).toBe(1)
    expect(s.recorded()).toBe('')
  })

  it('passes every other call to the real tool, stdin included', () => {
    const s = fixture()
    expect(s.security(['find-certificate', '-a', '-p'])).toBe(7)
    expect(s.security(['-i'], 'list-keychains\n')).toBe(7)
    expect(s.recorded()).toBe(
      'ARGS find-certificate -a -p\nARGS -i\nSTDIN list-keychains\n',
    )
  })

  it('is written once as an executable, and put back when changed', () => {
    const f = delegationTestDirectory()
    cleanups.push(f.cleanup)
    const bin = join(f.root, 'claude-code', 'bin')
    mkdirSync(bin, { recursive: true, mode: 0o700 })
    const path = installClaudeSecurity(bin)
    expect(path).toBe(join(bin, 'security'))
    expect(readFileSync(path, 'utf8')).toBe(claudeSecurityScript())
    expect(readFileSync(path, 'utf8')).toContain('exec /usr/bin/security "$@"')
    expect(statSync(path).mode & 0o777).toBe(0o755)
    const written = statSync(path).mtimeMs
    installClaudeSecurity(bin)
    expect(statSync(path).mtimeMs).toBe(written)
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    installClaudeSecurity(bin)
    expect(readFileSync(path, 'utf8')).toBe(claudeSecurityScript())
    expect(statSync(path).mode & 0o777).toBe(0o755)
  })
})
