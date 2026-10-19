import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyPackagedSecrets } from './packaged-secrets-smoke'

describe('packaged smoke: secrets without the Keychain', () => {
  it('round-trips a local-key secret, a real master password and a backup under the state root', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-smoke-secrets-'))
    expect(await verifyPackagedSecrets(stateRoot)).toEqual({ ok: true })
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
    expect(file.version).toBe(3)
    // The default KDF, as Electron's crypto must derive it.
    expect(file.master.kind).toBe('scrypt')
    expect(file.entries[0]!.fields.password).toMatch(/^m:/)
    expect(vault).not.toContain('emperor-packaged-local-secret-probe')
    // The backup restored into a second vault under the same key.
    expect(
      readFileSync(join(root, 'restored', 'secrets', 'local.key')).equals(
        readFileSync(key),
      ),
    ).toBe(true)
  }, 30_000)
})
