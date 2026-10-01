import { join } from 'node:path'
import { CredentialVault } from './computer-use/credential-vault'
import { LocalSecretStore } from './local-secret-store'

/**
 * Packaged smoke (plan rev 5 §3): secrets need no Keychain. Seals and opens a
 * probe with a fresh local key under the smoke's own state root, then stores
 * an entry behind a master password and reads it back. The master-password
 * KDF must exist in Electron's crypto, which lacks some of Node's (no
 * Argon2), so the default one is derived for real. The smoke runs with a
 * synthetic HOME on every platform, so a Keychain dependency fails here.
 */
export function verifyPackagedSecrets(stateRoot: string): { ok: true } {
  const root = join(stateRoot, 'packaged-smoke')
  const secrets = new LocalSecretStore({
    keyPath: join(root, 'secrets', 'local.key'),
  })
  const probe = 'emperor-packaged-local-secret-probe'
  if (secrets.decryptString(secrets.encryptString(probe)) !== probe)
    throw new Error('packaged local secret round trip failed')
  const vault = new CredentialVault({
    path: join(root, 'vault.json'),
    storage: secrets,
  })
  const handle = vault.save({
    label: 'packaged smoke',
    bindings: [{ kind: 'origin', origin: 'https://smoke.invalid' }],
    password: probe,
  })
  vault.setMasterPassword(`${probe}-master`)
  vault.lock()
  if (
    !vault.unlock(`${probe}-master`) ||
    vault.revealPassword(handle.handleId) !== probe
  )
    throw new Error('packaged credential vault round trip failed')
  vault.lock()
  return { ok: true }
}
