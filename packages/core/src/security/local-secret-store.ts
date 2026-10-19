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
 *   owned by this user, no access for group or others (any owner-only mode,
 *   so `chmod -R 700` keeps it working; SEC-09), exactly 32 bytes. A key
 *   whose only fault is access for group or others is `key-permissions`:
 *   unusable until the user asks for {@link LocalSecretStore.repairPermissions}.
 * - After link(2) publishes a new key, its directory is fsynced so the name
 *   survives a crash as well as the bytes.
 * - Values are AES-256-GCM sealed as `el1` · 12-byte nonce · ciphertext ·
 *   16-byte tag; the version prefix is also the associated data, followed
 *   by a NUL and the caller's context when one is given (SEC-06: a model
 *   key or an MCP token opens only in the field it was sealed for).
 * - Lives in Core so a run without the desktop main process (ACP,
 *   headless) seals with the same key file; main imports it from here.
 * - A key that is gone while data sealed under it remains
 *   (`sealedDataExists`) is lost, not new: sealing is refused until the user
 *   clears that data. A key file that fails its checks is never repaired or
 *   replaced on its own either; only `discardKey` (the user's 清空) removes it,
 *   and only `repairPermissions` (the user's 修复权限) tightens its modes.
 * - A restored backup can bring its key (`installKey`): published the same
 *   way, and only where no key exists.
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

export type LocalSecretProblem =
  'key-missing' | 'key-invalid' | 'key-permissions'

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
/** Group and other permission bits; any of them makes a key `loose`. */
const SHARED_BITS = 0o077

type KeyState =
  | { readonly state: 'ready'; readonly key: Buffer }
  | { readonly state: 'absent' }
  | { readonly state: 'invalid' }
  /** Owned, the right type and size, but open to group or others. */
  | { readonly state: 'loose' }

/**
 * Seal `value` as `el1` · nonce · ciphertext · tag under `key`, the format
 * {@link LocalSecretStore} writes. For a key held in memory, such as the one
 * inside a vault backup (SEC-09).
 */
export function sealWithKey(
  key: Buffer,
  value: string,
  context?: string,
): Buffer {
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
}

/** Open an `el1` envelope under `key`; {@link LocalSecretError} otherwise. */
export function openWithKey(
  key: Buffer,
  data: Buffer,
  context?: string,
): string {
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
  }
}

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
    if (current.state === 'loose') return 'key-permissions'
    return this.sealedDataExists() ? 'key-missing' : null
  }

  encryptString(value: string, context?: string): Buffer {
    const key = this.keyForSealing()
    try {
      return sealWithKey(key, value, context)
    } finally {
      key.fill(0)
    }
  }

  decryptString(data: Buffer, context?: string): string {
    const key = this.existingKey()
    try {
      return openWithKey(key, data, context)
    } finally {
      key.fill(0)
    }
  }

  /**
   * 修复权限: the user asked to make a `key-permissions` key private again
   * (directory 0700, file 0600). Only modes change, and only for a key that
   * is otherwise valid; true when the key is usable afterwards.
   */
  repairPermissions(): boolean {
    if (!this.posix || this.read().state !== 'loose') return false
    const directory = dirname(this.keyPath)
    try {
      const info = lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== this.uid)
        return false
      if ((info.mode & SHARED_BITS) !== 0) chmodSync(directory, 0o700)
      let fd: number
      try {
        fd = openSync(this.keyPath, constants.O_RDONLY | NOFOLLOW)
      } catch (error) {
        // Only the directory was open: nothing more to tighten.
        if (errno(error) === 'ENOENT') return this.problem() === null
        throw error
      }
      try {
        const file = fstatSync(fd)
        if (!file.isFile() || file.uid !== this.uid || file.size !== KEY_BYTES)
          return false
        if ((file.mode & SHARED_BITS) !== 0) fchmodSync(fd, 0o600)
      } finally {
        closeSync(fd)
      }
    } catch {
      return false
    }
    return this.problem() === null
  }

  /**
   * The key's bytes, for a password-protected vault backup (SEC-09). The
   * caller zeroes the buffer when done.
   */
  exportKey(): Buffer {
    return this.existingKey()
  }

  /**
   * Publish `key` (from a restored backup) as the local key when no key file
   * exists: same staging file and link(2) as a new key. False when a key is
   * already in place, which is never replaced.
   */
  installKey(key: Buffer): boolean {
    if (key.length !== KEY_BYTES)
      throw new LocalSecretError('key-invalid', 'a local key has 32 bytes')
    if (this.read().state !== 'absent') return false
    return this.publish(key)
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
      : current.state === 'loose'
        ? new LocalSecretError(
            'key-permissions',
            'the local key file is readable by other users',
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

  /**
   * `ready` when this user owns it and group and others have no access
   * (`(mode & 0o077) === 0 && uid === process.getuid()`), `loose` when only
   * the second half fails, `invalid` when the owner is someone else.
   */
  private access(info: Stats): 'ready' | 'loose' | 'invalid' {
    if (!this.posix) return 'ready'
    if (info.uid !== this.uid) return 'invalid'
    return (info.mode & SHARED_BITS) === 0 ? 'ready' : 'loose'
  }

  private directoryState(): 'ready' | 'absent' | 'invalid' | 'loose' {
    let info: Stats
    try {
      info = lstatSync(dirname(this.keyPath))
    } catch (error) {
      return errno(error) === 'ENOENT' ? 'absent' : 'invalid'
    }
    return info.isDirectory() && !info.isSymbolicLink()
      ? this.access(info)
      : 'invalid'
  }

  private read(): KeyState {
    const directory = this.directoryState()
    if (directory === 'absent' || directory === 'invalid')
      return { state: directory }
    // No key in a directory open to others: a new key would not be made
    // there either, so it is the directory that needs repairing.
    const missing = (error: unknown): KeyState =>
      errno(error) !== 'ENOENT'
        ? { state: 'invalid' }
        : { state: directory === 'loose' ? 'loose' : 'absent' }
    let link: Stats
    try {
      link = lstatSync(this.keyPath)
    } catch (error) {
      return missing(error)
    }
    if (!link.isFile() || link.isSymbolicLink()) return { state: 'invalid' }
    let fd: number
    try {
      fd = openSync(this.keyPath, constants.O_RDONLY | NOFOLLOW)
    } catch (error) {
      return missing(error)
    }
    try {
      const info = fstatSync(fd)
      if (
        !info.isFile() ||
        info.dev !== link.dev ||
        info.ino !== link.ino ||
        info.size !== KEY_BYTES
      )
        return { state: 'invalid' }
      const file = this.access(info)
      if (file === 'invalid') return { state: 'invalid' }
      // Group or other access on the file or its directory: report it, use
      // nothing, until the user repairs it.
      if (file === 'loose' || directory === 'loose') return { state: 'loose' }
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
    const key = randomBytes(KEY_BYTES)
    try {
      this.publish(key)
    } finally {
      key.fill(0)
    }
    return this.existingKey()
  }

  /**
   * Write `key` to a private staging file (O_EXCL), link(2) it into place,
   * then fsync the directory so the new name is durable too. True when this
   * call published it; false when another process published a key first
   * (its key is the key) or the directory is not ours.
   */
  private publish(key: Buffer): boolean {
    const directory = dirname(this.keyPath)
    const made = mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (made !== undefined && this.posix) chmodSync(directory, 0o700)
    if (this.directoryState() !== 'ready') return false
    const staging = join(
      directory,
      `.local.key.${randomBytes(6).toString('hex')}.tmp`,
    )
    let published = false
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
        published = true
      } catch (error) {
        // Another process published first: its key is the key.
        if (errno(error) !== 'EEXIST') throw error
      }
    } finally {
      try {
        unlinkSync(staging)
      } catch {
        // Never published (open failed) or already gone.
      }
    }
    if (published) syncDirectory(directory)
    return published
  }
}

/** fsync a directory so a link(2) or rename(2) inside it is durable. */
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
