import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const HEADER = Buffer.from('EMPEROR-LOCAL-1\0')

/** Main-process local file encryption; never calls an OS key service. */
export class LocalSecretStorage {
  constructor(readonly keyPath: string) {}
  getSelectedStorageBackend(): string {
    return 'local-file'
  }
  isEncryptionAvailable(): boolean {
    try {
      this.readKey().fill(0)
      return true
    } catch {
      return false
    }
  }
  encryptString(value: string): Buffer {
    const key = this.readKey()
    try {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(HEADER)
      const bytes = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ])
      return Buffer.concat([HEADER, nonce, cipher.getAuthTag(), bytes])
    } finally {
      key.fill(0)
    }
  }
  decryptString(value: Buffer): string {
    if (
      value.length < HEADER.length + 28 ||
      !value.subarray(0, HEADER.length).equals(HEADER)
    )
      throw new Error(
        'unsupported secret ciphertext; re-enter the stored value',
      )
    const key = this.readKey()
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        value.subarray(HEADER.length, HEADER.length + 12),
      )
      decipher.setAAD(HEADER)
      decipher.setAuthTag(
        value.subarray(HEADER.length + 12, HEADER.length + 28),
      )
      return Buffer.concat([
        decipher.update(value.subarray(HEADER.length + 28)),
        decipher.final(),
      ]).toString('utf8')
    } finally {
      key.fill(0)
    }
  }
  private readKey(): Buffer {
    const directory = dirname(this.keyPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const parent = lstatSync(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error('invalid local secret directory')
    chmodSync(directory, 0o700)
    let created: number | undefined
    try {
      created = openSync(
        this.keyPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      const key = randomBytes(32)
      try {
        writeFileSync(created, key)
        fsyncSync(created)
      } finally {
        key.fill(0)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      if (created !== undefined) closeSync(created)
    }
    const fd = openSync(
      this.keyPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== 32 ||
        (process.platform !== 'win32' &&
          ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      )
        throw new Error(
          'local secret key must be a private 32-byte regular file',
        )
      return readFileSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}
