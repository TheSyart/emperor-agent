import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalSecretStore } from '../local-secret-store'
import {
  EncryptedFilePairingStore,
  localPairingCipher,
  type BrowserPairing,
  type PairingCipher,
} from './nm-bridge-store'

const fixtureCipher: PairingCipher = {
  encrypt: (text) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0x5a)),
  decrypt: (bytes) => Buffer.from(bytes.map((byte) => byte ^ 0x5a)).toString(),
}

function pairing(over: Partial<BrowserPairing> = {}): BrowserPairing {
  return {
    pairingId: randomBytes(16).toString('base64url'),
    extensionId: 'a'.repeat(32),
    secret: randomBytes(32).toString('base64url'),
    createdAt: '2026-09-24T00:00:00.000Z',
    ...over,
  }
}

describe.skipIf(process.platform !== 'darwin')(
  'encrypted browser pairing store',
  () => {
    let directory: string | null = null

    afterEach(async () => {
      if (directory) await rm(directory, { recursive: true, force: true })
      directory = null
    })

    async function privateDirectory(): Promise<string> {
      directory = await mkdtemp(join(tmpdir(), 'pair-store-test-'))
      await chmod(directory, 0o700)
      return directory
    }

    it('persists 0600 ciphertext, reloads, revokes, and rejects loose permissions', async () => {
      const file = join(await privateDirectory(), 'pairings.json')
      const item = pairing()
      const store = new EncryptedFilePairingStore(file, fixtureCipher)
      await store.put(item)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      const disk = await readFile(file, 'utf8')
      expect(disk).not.toContain(item.secret)
      expect((JSON.parse(disk) as { version: number }).version).toBe(2)
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
          pairingId: item.pairingId,
          extensionId: item.extensionId,
          createdAt: item.createdAt,
        },
      ])
      expect(
        await new EncryptedFilePairingStore(file, fixtureCipher).get(
          item.pairingId,
        ),
      ).toEqual(item)
      await chmod(file, 0o644)
      await expect(
        new EncryptedFilePairingStore(file, fixtureCipher).get(item.pairingId),
      ).rejects.toThrow('0600')
      await chmod(file, 0o600)
      await store.remove(item.pairingId)
      expect(await store.list()).toEqual([])
      expect(
        await new EncryptedFilePairingStore(file, fixtureCipher).get(
          item.pairingId,
        ),
      ).toBeNull()
    })

    it('keeps the browser that paired, and only chrome or edge', async () => {
      const file = join(await privateDirectory(), 'pairings.json')
      const store = new EncryptedFilePairingStore(file, fixtureCipher)
      const edge = pairing({ browser: 'edge' })
      const unnamed = pairing({ extensionId: 'b'.repeat(32) })
      await store.put(edge)
      await store.put(unnamed)
      const reopened = new EncryptedFilePairingStore(file, fixtureCipher)
      expect(await reopened.list()).toEqual([
        {
          pairingId: edge.pairingId,
          extensionId: edge.extensionId,
          createdAt: edge.createdAt,
          browser: 'edge',
        },
        {
          pairingId: unnamed.pairingId,
          extensionId: unnamed.extensionId,
          createdAt: unnamed.createdAt,
        },
      ])
      expect(await reopened.get(edge.pairingId)).toEqual(edge)
      await expect(
        store.put(pairing({ browser: 'firefox' as never })),
      ).rejects.toThrow('invalid pairing identity')
      // A tampered record fails closed rather than passing an odd name on.
      const data = JSON.parse(await readFile(file, 'utf8')) as {
        records: Array<Record<string, unknown>>
      }
      data.records[0]!.browser = 'safari'
      await writeFile(file, JSON.stringify(data), { mode: 0o600 })
      await expect(
        new EncryptedFilePairingStore(file, fixtureCipher).list(),
      ).rejects.toThrow('invalid pairing record')
    })

    it('deletes a version 1 store sealed by the Keychain and starts over', async () => {
      const file = join(await privateDirectory(), 'pairings.json')
      const old = pairing()
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          records: [
            {
              pairingId: old.pairingId,
              extensionId: old.extensionId,
              ciphertext: Buffer.from('keychain-sealed').toString('base64'),
              createdAt: old.createdAt,
            },
          ],
        }),
        { mode: 0o600 },
      )
      const store = new EncryptedFilePairingStore(file, {
        ...fixtureCipher,
        decrypt: () => {
          throw new Error('a version 1 secret is never opened')
        },
      })
      expect(await store.get(old.pairingId)).toBeNull()
      expect(existsSync(file)).toBe(false)
      expect(await store.list()).toEqual([])
      const fresh = pairing()
      await store.put(fresh)
      expect(
        (JSON.parse(await readFile(file, 'utf8')) as { version: number })
          .version,
      ).toBe(2)
      // Formats it does not know still fail closed.
      await writeFile(file, JSON.stringify({ version: 3, records: [] }), {
        mode: 0o600,
      })
      await expect(
        new EncryptedFilePairingStore(file, fixtureCipher).list(),
      ).rejects.toThrow('invalid pairing store')
    })

    it('seals with the local key and forgets a pairing that key can no longer open', async () => {
      const root = await privateDirectory()
      const file = join(root, 'browser-pairings', 'pairings.json')
      const keyPath = join(root, 'secrets', 'local.key')
      const cipher = () => localPairingCipher(new LocalSecretStore({ keyPath }))
      const store = new EncryptedFilePairingStore(file, cipher())
      const kept = pairing()
      const lost = pairing({ browser: 'chrome' })
      await store.put(kept)
      await store.put(lost)
      expect(
        await new EncryptedFilePairingStore(file, cipher()).get(lost.pairingId),
      ).toEqual(lost)
      expect(await readFile(file, 'utf8')).not.toContain(lost.secret)

      // An unusable key file fails closed and keeps the pairing.
      await chmod(keyPath, 0o644)
      await expect(
        new EncryptedFilePairingStore(file, cipher()).get(lost.pairingId),
      ).rejects.toThrow()
      expect(
        await new EncryptedFilePairingStore(file, cipher()).list(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pairingId: lost.pairingId }),
        ]),
      )
      await chmod(keyPath, 0o600)

      // Sealed under another key (the key was replaced): forgotten, so the
      // extension hears the pairing is unknown and pairs again.
      const data = JSON.parse(await readFile(file, 'utf8')) as {
        records: Array<{ pairingId: string; ciphertext: string }>
      }
      const foreign = new LocalSecretStore({
        keyPath: join(root, 'foreign', 'local.key'),
      })
        .encryptString(lost.secret)
        .toString('base64')
      data.records.find(
        (item) => item.pairingId === lost.pairingId,
      )!.ciphertext = foreign
      await writeFile(file, JSON.stringify(data), { mode: 0o600 })
      const reader = new EncryptedFilePairingStore(file, cipher())
      expect(await reader.get(lost.pairingId)).toBeNull()
      expect(
        (await new EncryptedFilePairingStore(file, cipher()).list()).map(
          (item) => item.pairingId,
        ),
      ).toEqual([kept.pairingId])

      // The key itself is gone: every pairing it sealed is forgotten too.
      await rm(keyPath)
      const keyless = new EncryptedFilePairingStore(file, cipher())
      expect(await keyless.get(kept.pairingId)).toBeNull()
      expect(await keyless.list()).toEqual([])
      expect(existsSync(keyPath)).toBe(false)
    })
  },
)
