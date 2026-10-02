import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyPackagedSecrets } from './packaged-secrets-smoke'

describe('packaged smoke: secrets without the Keychain', () => {
  it('round-trips a local-key secret and a real master password under the state root', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-smoke-secrets-'))
    expect(verifyPackagedSecrets(stateRoot)).toEqual({ ok: true })
    const root = join(stateRoot, 'packaged-smoke')
    const key = join(root, 'secrets', 'local.key')
    expect(statSync(key).mode & 0o777).toBe(0o600)
    expect(statSync(key).size).toBe(32)
    const vault = readFileSync(join(root, 'vault.json'), 'utf8')
    const file = JSON.parse(vault) as {
      version: number
      master: { kind: string }
      entries: Array<{ fields: Record<string, string> }>
    }
    expect(file.version).toBe(2)
    // The default KDF, as Electron's crypto must derive it.
    expect(file.master.kind).toBe('scrypt')
    expect(file.entries[0]!.fields.password).toMatch(/^m:/)
    expect(vault).not.toContain('emperor-packaged-local-secret-probe')
  })
})
