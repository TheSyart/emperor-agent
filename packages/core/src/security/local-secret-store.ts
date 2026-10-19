/**
 * Emperor's own key for secrets at rest (plan rev 5 §3). It stands where
 * Electron's Keychain-backed storage used to, with the same four methods, so
 * nothing Emperor stores asks the macOS Keychain for anything.
 *
 * - One 32-byte random key in `<stateRoot>/computer-use/secrets/local.key`
 *   (directory 0700, file 0600), made on first use: written to a private
 *   staging file opened with O_EXCL, then published with link(2), which never
 *   replaces a key another Emperor process published first.
 * - Every use re-reads it with the pairing store's checks: not a symlink,
 *   owned by this user, exact permissions, exactly 32 bytes.
 * - Values are AES-256-GCM sealed as `el1` · 12-byte nonce · ciphertext ·
 *   16-byte tag; the version prefix is also the associated data, followed
 *   by a NUL and the caller's context when one is given (SEC-06: a model
 *   key or an MCP token opens only in the field it was sealed for).
 * - Lives in Core so a run without the desktop main process (ACP,
 *   headless) seals with the same key file; main imports it from here.
 * - A key that is gone while data sealed under it remains
 *   (`sealedDataExists`) is lost, not new: sealing is refused until the user
 *   clears that data. A key file that fails its checks is never repaired or
 *   replaced on its own either; only `discardKey` (the user's 清空) removes it.
 *
 * Programs running as this user can read the key just as they can read the
 * data, so this is basic protection; the vault's master password is what
 * keeps them out (Settings says so).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { dirname, join } from 'node:path'

export type LocalSecretProblem = 'key-missing' | 'key-invalid'

/** Stable, value-free reasons; messages never quote a secret or a path. */
export class LocalSecretError extends Error {
  constructor(
    readonly reason: LocalSecretProblem | 'ciphertext-invalid',
    message: string,
  ) {
    super(message)
    this.name = 'LocalSecretError'
  }
}

export interface LocalSecretStoreOptions {
  /** `<stateRoot>/computer-use/secrets/local.key` */
  keyPath: string
  /**
   * Whether data sealed under an earlier key still exists. A missing key is
   * then lost rather than not made yet, and no new key is made over it. A
   * guard that throws counts as data present.
   */
  sealedDataExists?: () => boolean
  /** The owner the key must have; defaults to this process's user. */
  uid?: number
  /** Defaults to `process.platform`; win32 has no POSIX owner or modes. */
  platform?: NodeJS.Platform
}

const FORMAT = Buffer.from('el1', 'ascii')

/** Associated data: the format, then NUL and the context when one is given. */
function associatedData(context: string | undefined): Buffer {
  return context === undefined
    ? FORMAT
    : Buffer.concat([FORMAT, Buffer.from([0]), Buffer.from(context, 'utf8')])
}
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

type KeyState =
  | { readonly state: 'ready'; readonly key: Buffer }
  | { readonly state: 'absent' }
  | { readonly state: 'invalid' }

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

export class LocalSecretStore {
  private readonly keyPath: string
  private readonly posix: boolean
  private readonly uid: number | undefined

  constructor(private readonly options: LocalSecretStoreOptions) {
    this.keyPath = options.keyPath
    this.posix = (options.platform ?? process.platform) !== 'win32'
    this.uid = options.uid ?? process.getuid?.()
  }

  getSelectedStorageBackend(): 'emperor-local' {
    return 'emperor-local'
  }

  isEncryptionAvailable(): boolean {
    return this.problem() === null
  }

  /** Null while the key is usable, or absent with nothing sealed under it. */
  problem(): LocalSecretProblem | null {
    const current = this.read()
    if (current.state === 'ready') {
      current.key.fill(0)
      return null
    }
    if (current.state === 'invalid') return 'key-invalid'
    return this.sealedDataExists() ? 'key-missing' : null
  }

  encryptString(value: string, context?: string): Buffer {
    const key = this.keyForSealing()
    try {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(associatedData(context))
      return Buffer.concat([
        FORMAT,
        nonce,
        cipher.update(value, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ])
    } finally {
      key.fill(0)
    }
  }

  decryptString(data: Buffer, context?: string): string {
    const key = this.existingKey()
    try {
      const body = FORMAT.length + NONCE_BYTES
      if (
        data.length < body + TAG_BYTES ||
        !data.subarray(0, FORMAT.length).equals(FORMAT)
      )
        throw new Error('not a local secret envelope')
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        data.subarray(FORMAT.length, body),
      )
      decipher.setAAD(associatedData(context))
      decipher.setAuthTag(data.subarray(data.length - TAG_BYTES))
      return Buffer.concat([
        decipher.update(data.subarray(body, data.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      // Crypto errors are not ours to vet; the reason says enough.
      throw new LocalSecretError(
        'ciphertext-invalid',
        'local secret could not be decrypted',
      )
    } finally {
      key.fill(0)
    }
  }

  /**
   * The user chose to start over (清空): forget the key and the directory
   * holding it, so the next seal makes a new one. A symlinked directory is
   * unlinked, never followed.
   */
  discardKey(): void {
    rmSync(dirname(this.keyPath), { recursive: true, force: true })
  }

  private sealedDataExists(): boolean {
    try {
      return this.options.sealedDataExists?.() ?? false
    } catch {
      return true
    }
  }

  private existingKey(): Buffer {
    const current = this.read()
    if (current.state === 'ready') return current.key
    throw current.state === 'invalid'
      ? new LocalSecretError(
          'key-invalid',
          'the local key file failed its ownership or permission checks',
        )
      : new LocalSecretError('key-missing', 'the local key is missing')
  }

  private keyForSealing(): Buffer {
    const current = this.read()
    if (current.state === 'ready') return current.key
    if (current.state === 'absent' && !this.sealedDataExists())
      return this.create()
    return this.existingKey()
  }

  private owned(info: Stats, mode: number): boolean {
    return (
      !this.posix || (info.uid === this.uid && (info.mode & 0o777) === mode)
    )
  }

  private directoryState(): 'ready' | 'absent' | 'invalid' {
    let info: Stats
    try {
      info = lstatSync(dirname(this.keyPath))
    } catch (error) {
      return errno(error) === 'ENOENT' ? 'absent' : 'invalid'
    }
    return info.isDirectory() &&
      !info.isSymbolicLink() &&
      this.owned(info, 0o700)
      ? 'ready'
      : 'invalid'
  }

  private read(): KeyState {
    const directory = this.directoryState()
    if (directory !== 'ready') return { state: directory }
    let link: Stats
    try {
      link = lstatSync(this.keyPath)
    } catch (error) {
      return { state: errno(error) === 'ENOENT' ? 'absent' : 'invalid' }
    }
    if (!link.isFile() || link.isSymbolicLink()) return { state: 'invalid' }
    let fd: number
    try {
      fd = openSync(this.keyPath, constants.O_RDONLY | NOFOLLOW)
    } catch (error) {
      return { state: errno(error) === 'ENOENT' ? 'absent' : 'invalid' }
    }
    try {
      const info = fstatSync(fd)
      if (
        !info.isFile() ||
        info.dev !== link.dev ||
        info.ino !== link.ino ||
        info.size !== KEY_BYTES ||
        !this.owned(info, 0o600)
      )
        return { state: 'invalid' }
      const key = Buffer.alloc(KEY_BYTES)
      if (readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) {
        key.fill(0)
        return { state: 'invalid' }
      }
      return { state: 'ready', key }
    } finally {
      closeSync(fd)
    }
  }

  /** First seal ever (or after 清空): make and publish a new key. */
  private create(): Buffer {
    const directory = dirname(this.keyPath)
    const made = mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (made !== undefined && this.posix) chmodSync(directory, 0o700)
    if (this.directoryState() !== 'ready') return this.existingKey()
    const staging = join(
      directory,
      `.local.key.${randomBytes(6).toString('hex')}.tmp`,
    )
    const key = randomBytes(KEY_BYTES)
    try {
      const fd = openSync(
        staging,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      )
      try {
        if (this.posix) fchmodSync(fd, 0o600)
        writeSync(fd, key)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      try {
        linkSync(staging, this.keyPath)
      } catch (error) {
        // Another process published first: its key is the key.
        if (errno(error) !== 'EEXIST') throw error
      }
    } finally {
      key.fill(0)
      try {
        unlinkSync(staging)
      } catch {
        // Never published (open failed) or already gone.
      }
    }
    return this.existingKey()
  }
}
