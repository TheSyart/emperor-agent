import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EncryptedFilePairingStore,
  electronPairingCipher,
  type PairingCipher,
} from './nm-bridge-store'

const fixtureCipher: PairingCipher = {
  encrypt: (text) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0x5a)),
  decrypt: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a)).toString(),
}

describe.skipIf(process.platform !== 'darwin')(
  'encrypted browser pairing store',
  () => {
    let directory: string | null = null

    afterEach(async () => {
      if (directory) await rm(directory, { recursive: true, force: true })
      directory = null
    })

    it('persists 0600 ciphertext, reloads, revokes, and rejects loose permissions', async () => {
      directory = await mkdtemp(join(tmpdir(), 'pair-store-test-'))
      await chmod(directory, 0o700)
      const file = join(directory, 'pairings.json')
      const pairing = {
        pairingId: randomBytes(16).toString('base64url'),
        extensionId: 'a'.repeat(32),
        secret: randomBytes(32).toString('base64url'),
        createdAt: '2026-09-24T00:00:00.000Z',
      }
      const store = new EncryptedFilePairingStore(file, fixtureCipher)
      await store.put(pairing)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(await readFile(file, 'utf8')).not.toContain(pairing.secret)
      // Listing never decrypts or exposes the secret.
      expect(
        await new EncryptedFilePairingStore(file, {
          ...fixtureCipher,
          decrypt: () => {
            throw new Error('list must not decrypt')
          },
        }).list(),
      ).toEqual([
        {
          pairingId: pairing.pairingId,
          extensionId: pairing.extensionId,
          createdAt: pairing.createdAt,
        },
      ])
      expect(
        await new EncryptedFilePairingStore(file, fixtureCipher).get(
          pairing.pairingId,
        ),
      ).toEqual(pairing)
      await chmod(file, 0o644)
      await expect(
        new EncryptedFilePairingStore(file, fixtureCipher).get(
          pairing.pairingId,
        ),
      ).rejects.toThrow('0600')
      await chmod(file, 0o600)
      await store.remove(pairing.pairingId)
      expect(await store.list()).toEqual([])
      expect(
        await new EncryptedFilePairingStore(file, fixtureCipher).get(
          pairing.pairingId,
        ),
      ).toBeNull()
    })

    it('fails closed when Electron has no encryption key', () => {
      const cipher = electronPairingCipher({
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('must not encrypt')
        },
        decryptString: () => {
          throw new Error('must not decrypt')
        },
      })
      expect(() => cipher.encrypt('secret')).toThrow('unavailable')
      expect(() => cipher.decrypt(Buffer.from('ciphertext'))).toThrow(
        'unavailable',
      )
    })
  },
)
