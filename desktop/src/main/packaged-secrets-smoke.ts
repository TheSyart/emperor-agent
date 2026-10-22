import { join } from 'node:path'
import { CredentialVault } from './computer-use/credential-vault'
import { LocalSecretStore } from './local-secret-store'

/**
 * Packaged smoke (plan rev 5 §3): secrets need no Keychain. Seals and opens a
 * probe with a fresh local key under the smoke's own state root, then stores
 * an entry behind a master password and reads it back. The master-password
 * KDF must exist in Electron's crypto, which lacks some of Node's (no
 * Argon2), so the default one is derived for real, on the thread pool
 * (SEC-09). A password-protected backup of that vault is then restored into
 * a second, empty one. The smoke runs with a synthetic HOME on every
 * platform, so a Keychain dependency fails here.
 */
export async function verifyPackagedSecrets(
  stateRoot: string,
): Promise<{ ok: true }> {
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
  const master = `${probe}-master`
  await vault.setMasterPassword(master, master)
  vault.lock()
  if (
    !(await vault.unlock(master)) ||
    vault.revealPassword(handle.handleId) !== probe
  )
    throw new Error('packaged credential vault round trip failed')
  const passphrase = `${probe}-backup`
  const backup = await vault.exportBackup(passphrase, passphrase)
  vault.lock()
  const restored = new CredentialVault({
    path: join(root, 'restored', 'vault.json'),
    storage: new LocalSecretStore({
      keyPath: join(root, 'restored', 'secrets', 'local.key'),
    }),
  })
  await restored.importBackup(backup, passphrase)
  if (restored.revealPassword(handle.handleId) !== probe)
    throw new Error('packaged credential backup round trip failed')
  return { ok: true }
}
