import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalSecretError } from '../local-secret-store'
import { parseToken } from './nm-bridge-crypto'

/** The browser an extension said it runs in when it paired. */
export type PairingBrowser = 'chrome' | 'edge'

export interface BrowserPairing {
  readonly pairingId: string
  readonly extensionId: string
  /** 32-byte HKDF output, base64url; only main's encrypted store holds it. */
  readonly secret: string
  readonly createdAt: string
  /** Reported by the extension at `pair.begin`; display only, not proven. */
  readonly browser?: PairingBrowser
}

/** A pairing without its secret; enough to maintain host manifests. */
export type PairingSummary = Omit<BrowserPairing, 'secret'>

export interface PairingStore {
  get(pairingId: string): Promise<BrowserPairing | null>
  /** Every stored pairing, without decrypting any secret. */
  list(): Promise<readonly PairingSummary[]>
  put(pairing: BrowserPairing): Promise<void>
  remove(pairingId: string): Promise<void>
}

export interface PairingCipher {
  encrypt(plaintext: string): Buffer
  /** Throws {@link PairingSecretLost} when the secret can never be read. */
  decrypt(ciphertext: Buffer): string
}

/**
 * The record's secret is gone for good: its key is missing, or it was sealed
 * under another key. The store forgets such a pairing; the extension then
 * hears `PAIRING_UNKNOWN` and pairs again.
 */
export class PairingSecretLost extends Error {
  constructor(options?: ErrorOptions) {
    super('browser pairing secret can no longer be read', options)
    this.name = 'PairingSecretLost'
  }
}

/** Seals pairing secrets with Emperor's local key (local-secret-store.ts). */
export function localPairingCipher(secrets: {
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}): PairingCipher {
  return {
    encrypt: (value) => secrets.encryptString(value),
    decrypt: (value) => {
      try {
        return secrets.decryptString(value)
      } catch (cause) {
        // An unusable key file fails closed instead: fixing it keeps pairings.
        if (
          cause instanceof LocalSecretError &&
          (cause.reason === 'key-missing' ||
            cause.reason === 'ciphertext-invalid')
        )
          throw new PairingSecretLost({ cause })
        throw cause
      }
    },
  }
}

interface StoredRecord {
  readonly pairingId: string
  readonly extensionId: string
  readonly ciphertext: string
  readonly createdAt: string
  readonly browser?: PairingBrowser
}

function pairingBrowser(value: unknown): value is PairingBrowser {
  return value === 'chrome' || value === 'edge'
}

/**
 * Atomic 0600 snapshot, version 2. Version 1 sealed secrets with the macOS
 * Keychain: such a file is deleted on load and pairing starts over (plan
 * rev 5). A malformed/loose file fails closed.
 */
export class EncryptedFilePairingStore implements PairingStore {
  private records: StoredRecord[] | null = null
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly cipher: PairingCipher,
  ) {}

  private async load(): Promise<StoredRecord[]> {
    if (this.records !== null) return this.records
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await lstat(directory)
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw new Error('pairing directory permissions are not 0700')
    let data: string
    try {
      const file = await lstat(this.path)
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.uid !== process.getuid?.() ||
        (file.mode & 0o777) !== 0o600
      )
        throw new Error('pairing file permissions are not 0600')
      data = await readFile(this.path, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = []
        return this.records
      }
      throw cause
    }
    const parsed: unknown = JSON.parse(data)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      parsed.version === 1
    ) {
      // Keychain-sealed secrets from before Emperor's local key: dropped.
      await unlink(this.path).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause
      })
      this.records = []
      return this.records
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      parsed.version !== 2 ||
      !('records' in parsed) ||
      !Array.isArray(parsed.records)
    )
      throw new Error('invalid pairing store')
    const records = parsed.records as unknown[]
    if (records.length > 100) throw new Error('too many browser pairings')
    for (const record of records) {
      if (
        !record ||
        typeof record !== 'object' ||
        !('pairingId' in record) ||
        !('extensionId' in record) ||
        !('ciphertext' in record) ||
        !('createdAt' in record) ||
        typeof record.pairingId !== 'string' ||
        typeof record.extensionId !== 'string' ||
        typeof record.ciphertext !== 'string' ||
        typeof record.createdAt !== 'string' ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(record.pairingId) ||
        !/^[a-p]{32}$/.test(record.extensionId) ||
        !/^[A-Za-z0-9+/=]+$/.test(record.ciphertext) ||
        ('browser' in record && !pairingBrowser(record.browser))
      )
        throw new Error('invalid pairing record')
    }
    this.records = records as StoredRecord[]
    return this.records
  }

  /** Null for an unknown pairing, or one whose secret is lost (forgotten). */
  async get(pairingId: string): Promise<BrowserPairing | null> {
    const record = (await this.load()).find(
      (item) => item.pairingId === pairingId,
    )
    if (!record) return null
    let secret: string
    try {
      secret = this.cipher.decrypt(Buffer.from(record.ciphertext, 'base64'))
    } catch (cause) {
      if (!(cause instanceof PairingSecretLost)) throw cause
      await this.remove(pairingId)
      return null
    }
    parseToken(secret, 32)
    return {
      pairingId: record.pairingId,
      extensionId: record.extensionId,
      secret,
      createdAt: record.createdAt,
      ...(record.browser ? { browser: record.browser } : {}),
    }
  }

  async list(): Promise<readonly PairingSummary[]> {
    return (await this.load()).map(
      ({ pairingId, extensionId, createdAt, browser }) => ({
        pairingId,
        extensionId,
        createdAt,
        ...(browser ? { browser } : {}),
      }),
    )
  }

  private async save(records: StoredRecord[]): Promise<void> {
    const temporary = join(
      dirname(this.path),
      `.browser-pairings-${randomUUID()}.tmp`,
    )
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    try {
      await handle.writeFile(JSON.stringify({ version: 2, records }))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
    } catch (cause) {
      await unlink(temporary).catch(() => undefined)
      throw cause
    }
    this.records = records
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.mutation.then(operation)
    this.mutation = task.catch(() => undefined)
    return task
  }

  put(pairing: BrowserPairing): Promise<void> {
    return this.enqueue(async () => {
      if (
        !/^[A-Za-z0-9_-]{8,128}$/.test(pairing.pairingId) ||
        !/^[a-p]{32}$/.test(pairing.extensionId) ||
        (pairing.browser !== undefined && !pairingBrowser(pairing.browser))
      )
        throw new Error('invalid pairing identity')
      parseToken(pairing.secret, 32)
      const records = [...(await this.load())].filter(
        (item) => item.pairingId !== pairing.pairingId,
      )
      records.push({
        pairingId: pairing.pairingId,
        extensionId: pairing.extensionId,
        ciphertext: this.cipher.encrypt(pairing.secret).toString('base64'),
        createdAt: pairing.createdAt,
        ...(pairing.browser ? { browser: pairing.browser } : {}),
      })
      if (records.length > 100) throw new Error('too many browser pairings')
      await this.save(records)
    })
  }

  remove(pairingId: string): Promise<void> {
    return this.enqueue(async () => {
      const records = [...(await this.load())].filter(
        (item) => item.pairingId !== pairingId,
      )
      await this.save(records)
    })
  }
}
