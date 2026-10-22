/**
 * Claude Code's keychain under the dedicated HOME (FIX-19).
 *
 * Every Claude Code process Emperor starts runs with HOME under Emperor
 * Home (AGT-12), where macOS finds no login keychain. Claude Code keeps its
 * login in the keychain first, calling `security` from PATH, so a token
 * refresh raised the system 「找不到钥匙串」 dialog. With this `security`
 * first on PATH its password calls are answered as unavailable: a read
 * finds nothing (44) and a write fails without being transient (1, never
 * the "locked" 36), so Claude Code keeps its login in its own
 * `.credentials.json` — as Codex does with `cli_auth_credentials_store =
 * "file"`. Emperor never reads it. Every other call (certificates, signing
 * identities) reaches the system tool unchanged.
 *
 * The folder is not one a task may write (Seatbelt), so a task cannot
 * replace the script; it is rewritten whenever its bytes differ.
 */
import { chmodSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableReplaceSync } from '../../store/persistence'

const SYSTEM_SECURITY = '/usr/bin/security'

/** The script; `real` is the system tool (a recording fake in tests). */
export function claudeSecurityScript(real = SYSTEM_SECURITY): string {
  return [
    '#!/bin/sh',
    '# Emperor (FIX-19): Claude Code runs with a dedicated HOME, where macOS',
    '# has no login keychain. Its keychain password calls are answered as',
    '# unavailable, so it keeps its login in its own .credentials.json',
    '# instead of raising the system "keychain not found" dialog.',
    'case "$1" in',
    '  find-generic-password|delete-generic-password) exit 44 ;;',
    '  add-generic-password|show-keychain-info) exit 1 ;;',
    '  -i)',
    '    input=$(cat)',
    '    case "$input" in *generic-password*) exit 1 ;; esac',
    `    printf '%s\\n' "$input" | ${real} -i`,
    '    exit $?',
    '    ;;',
    'esac',
    `exec ${real} "$@"`,
    '',
  ].join('\n')
}

/** `<bin>/security`, written when missing or different; returns its path. */
export function installClaudeSecurity(bin: string): string {
  const path = join(bin, 'security')
  const script = claudeSecurityScript()
  let current: string | null = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    current = null
  }
  if (current !== script)
    durableReplaceSync(path, script, { directoryMode: 0o700, fileMode: 0o755 })
  else if ((statSync(path).mode & 0o777) !== 0o755) chmodSync(path, 0o755)
  return path
}
