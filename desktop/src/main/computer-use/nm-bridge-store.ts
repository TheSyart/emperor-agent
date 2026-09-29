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
import { parseToken } from './nm-bridge-crypto'

export interface BrowserPairing {
  readonly pairingId: string
  readonly extensionId: string
  /** 32-byte HKDF output, base64url; only main's encrypted store holds it. */
  readonly secret: string
  readonly createdAt: string
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
  decrypt(ciphertext: Buffer): string
}

/** Pass Electron's main-process safeStorage; never call this from a renderer. */
export function electronPairingCipher(safeStorage: {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}): PairingCipher {
  return {
    encrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('encrypted browser pairing storage unavailable')
      return safeStorage.encryptString(value)
    },
    decrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('encrypted browser pairing storage unavailable')
      return safeStorage.decryptString(value)
    },
  }
}

interface StoredRecord {
  readonly pairingId: string
  readonly extensionId: string
  readonly ciphertext: string
  readonly createdAt: string
}

/** Atomic 0600 snapshot. A malformed/loose file fails closed. */
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
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
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
        !/^[A-Za-z0-9+/=]+$/.test(record.ciphertext)
      )
        throw new Error('invalid pairing record')
    }
    this.records = records as StoredRecord[]
    return this.records
  }

  async get(pairingId: string): Promise<BrowserPairing | null> {
    const record = (await this.load()).find(
      (item) => item.pairingId === pairingId,
    )
    if (!record) return null
    const secret = this.cipher.decrypt(Buffer.from(record.ciphertext, 'base64'))
    parseToken(secret, 32)
    return {
      pairingId: record.pairingId,
      extensionId: record.extensionId,
      secret,
      createdAt: record.createdAt,
    }
  }

  async list(): Promise<readonly PairingSummary[]> {
    return (await this.load()).map(({ pairingId, extensionId, createdAt }) => ({
      pairingId,
      extensionId,
      createdAt,
    }))
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
      await handle.writeFile(JSON.stringify({ version: 1, records }))
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
        !/^[a-p]{32}$/.test(pairing.extensionId)
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
