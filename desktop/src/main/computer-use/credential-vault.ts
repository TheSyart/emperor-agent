/**
 * Main-process-only credential vault. The renderer may submit a secret from
 * Settings, but Core and the model only ever receive CredentialHandle data.
 * Each field is encrypted with Electron safeStorage; an optional master
 * password (scrypt) adds an AES-GCM layer. Decrypted values never persist; the
 * master key persists only when the user opts into biometric unlock, and then
 * only wrapped by safeStorage. The in-memory key is dropped after 30 idle
 * minutes (spec 00 §6.4).
 */
import * as crypto from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  UiError,
  type CredentialVaultPort,
  type UiErrorCode,
} from '@emperor/core/host-capabilities'
import type {
  CredentialBinding,
  CredentialField,
  CredentialHandle,
} from '@emperor/core/runtime-contract'

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(data: Buffer): string
  getSelectedStorageBackend?(): string
}

/** Argon2id cost; `memory` is in KiB, as Node's argon2 options take it. */
export interface Argon2Params {
  memory: number
  passes: number
  parallelism: number
  tagLength: 32
}

/** scrypt cost, named as Node's options; needs 128 × cost × blockSize bytes. */
export interface ScryptParams {
  cost: number
  blockSize: number
  parallelization: number
  keyLength: 32
}

/** How a master password becomes a key; stored with the salt. */
export type MasterKdf =
  | { kind: 'scrypt'; params: ScryptParams }
  | { kind: 'argon2id'; params: Argon2Params }

export interface VaultTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

interface StoredEntry {
  handleId: string
  label: string
  bindings: CredentialBinding[]
  revealUsername: boolean
  fillMode: 'auto' | 'confirm'
  fields: Partial<Record<CredentialField, string>>
  /** Last time a secret was released for filling (ms). Absent in older files. */
  lastUsedAt?: number
  /** Where that fill went: an origin or app bundle ID, never a value. */
  lastUsedTarget?: string
}

interface MasterRecord {
  kind: MasterKdf['kind']
  salt: string
  verifier: string
  /** Absent only in Argon2id files written before parameters were stored. */
  params?: Argon2Params | ScryptParams
  /**
   * Opt-in biometric unlock: the derived master key, base64, wrapped by
   * safeStorage (`s:` envelope). Lives inside the master record so a new or
   * removed master password drops it, even when an older build writes it.
   */
  biometricKey?: string
}

interface VaultFile {
  version: 1
  master?: MasterRecord
  entries: StoredEntry[]
}

export interface CredentialDraft {
  handleId?: string
  label: string
  bindings: CredentialBinding[]
  username?: string
  password?: string
  totpSecret?: string
  revealUsername?: boolean
  fillMode?: 'auto' | 'confirm'
}

/** Settings-only view of an entry; never handed to Core or the model. */
export interface CredentialVaultEntry extends CredentialHandle {
  readonly revealUsername: boolean
  readonly lastUsedAt?: number
  /** Origin or app bundle ID of the last fill, when the driver named one. */
  readonly lastUsedTarget?: string
}

/**
 * Where a secret is about to be written: the live page origin, or the app
 * binding the desktop driver matched. Either must be one of the entry's
 * bindings, and it is what the last-use record shows.
 */
export type CredentialFillTarget =
  string | Extract<CredentialBinding, { kind: 'app' }>

export interface MasterPasswordOptions {
  /** Also keep the key wrapped by safeStorage for system-verified unlock. */
  biometric?: boolean
}

/**
 * Stable, secret-free failure reasons. Callers branch on `reason`; messages
 * are fixed English text and never include a value, handle secret or path.
 */
export type CredentialVaultErrorReason =
  | 'vault-unavailable'
  | 'vault-locked'
  | 'vault-kdf-unavailable'
  | 'vault-file-invalid'
  | 'credential-not-found'
  | 'credential-field-missing'
  | 'credential-binding-mismatch'
  | 'credential-unreadable'
  | 'credential-empty'
  | 'invalid-label'
  | 'invalid-binding'
  | 'invalid-totp'
  | 'master-password-too-short'
  | 'biometric-unavailable'
  | 'biometric-key-invalid'

const REASON_CODE: Record<CredentialVaultErrorReason, UiErrorCode> = {
  'vault-unavailable': 'CAPABILITY_DISABLED',
  'vault-locked': 'PERMISSION_REQUIRED',
  'vault-kdf-unavailable': 'CAPABILITY_DISABLED',
  'vault-file-invalid': 'DRIVER_UNAVAILABLE',
  'credential-not-found': 'INVALID_REQUEST',
  'credential-field-missing': 'INVALID_REQUEST',
  'credential-binding-mismatch': 'PERMISSION_DENIED',
  'credential-unreadable': 'DRIVER_UNAVAILABLE',
  'credential-empty': 'INVALID_REQUEST',
  'invalid-label': 'INVALID_REQUEST',
  'invalid-binding': 'INVALID_REQUEST',
  'invalid-totp': 'INVALID_REQUEST',
  'master-password-too-short': 'INVALID_REQUEST',
  'biometric-unavailable': 'CAPABILITY_DISABLED',
  'biometric-key-invalid': 'PERMISSION_REQUIRED',
}

/** A UiError, so a driver that lets it escape still reports the right code. */
export class CredentialVaultError extends UiError {
  declare readonly reason: CredentialVaultErrorReason

  constructor(reason: CredentialVaultErrorReason, message: string) {
    super(REASON_CODE[reason], message, { reason })
    this.name = 'CredentialVaultError'
  }
}

const ID = /^cred_[0-9a-f]{24}$/
const IDLE_MS = 30 * 60_000
const ORIGIN_ONLY = /^https?:\/\//
const VERIFIER = 'emperor-vault-master-v1'
/** What every vault written before `params` existed used. Never change. */
const LEGACY_ARGON2: Argon2Params = {
  memory: 65536,
  passes: 3,
  parallelism: 4,
  tagLength: 32,
}
/**
 * For newly set master passwords; stored with the salt, so it may change.
 * scrypt rather than the spec's Argon2id: Electron's BoringSSL has no Argon2
 * (`argon2Sync` exists there but throws). Costs 128 MiB per derivation.
 */
const DEFAULT_KDF: MasterKdf = {
  kind: 'scrypt',
  params: { cost: 131_072, blockSize: 8, parallelization: 1, keyLength: 32 },
}

const systemTimers: VaultTimers = {
  // Idle relock must not keep the process alive.
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function exactOrigin(value: string): string {
  if (!ORIGIN_ONLY.test(value))
    throw new CredentialVaultError(
      'invalid-binding',
      'credential origin must be http(s)',
    )
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CredentialVaultError(
      'invalid-binding',
      'invalid credential origin',
    )
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value.endsWith('/')
  )
    throw new CredentialVaultError(
      'invalid-binding',
      'credential origin must contain only scheme, host and port',
    )
  return url.origin
}

function validateBindings(
  bindings: readonly CredentialBinding[],
): CredentialBinding[] {
  if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > 20)
    throw new CredentialVaultError(
      'invalid-binding',
      'at least one credential binding is required',
    )
  return bindings.map((binding) => {
    if (binding.kind === 'origin')
      return { kind: 'origin', origin: exactOrigin(binding.origin) }
    if (
      binding.kind === 'app' &&
      /^[A-Za-z0-9.-]{3,200}$/.test(binding.bundleId) &&
      ((typeof binding.teamId === 'string' &&
        /^[A-Z0-9]{3,32}$/.test(binding.teamId)) ||
        (typeof binding.path === 'string' &&
          binding.path.startsWith('/') &&
          binding.path.length <= 4096))
    )
      return {
        kind: 'app',
        bundleId: binding.bundleId,
        ...(binding.teamId ? { teamId: binding.teamId } : {}),
        ...(binding.path ? { path: binding.path } : {}),
      }
    throw new CredentialVaultError(
      'invalid-binding',
      'invalid credential binding',
    )
  })
}

/** Bounded so a tampered file cannot demand unbounded memory or time. */
function storedKdf(master: MasterRecord): MasterKdf {
  const int = (value: unknown, min: number, max: number): boolean =>
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  const invalid = () =>
    new CredentialVaultError(
      'vault-file-invalid',
      'unsupported master password parameters',
    )
  if (master.kind === 'scrypt') {
    const params = master.params as Partial<ScryptParams> | undefined
    if (
      typeof params !== 'object' ||
      params === null ||
      !int(params.cost, 1024, 1_048_576) ||
      (params.cost! & (params.cost! - 1)) !== 0 ||
      !int(params.blockSize, 1, 32) ||
      // At most 1 GiB of scrypt memory.
      params.cost! * params.blockSize! > 8_388_608 ||
      !int(params.parallelization, 1, 16) ||
      params.keyLength !== 32
    )
      throw invalid()
    return {
      kind: 'scrypt',
      params: {
        cost: params.cost!,
        blockSize: params.blockSize!,
        parallelization: params.parallelization!,
        keyLength: 32,
      },
    }
  }
  const params = (master.params ?? LEGACY_ARGON2) as Partial<Argon2Params>
  if (
    typeof params !== 'object' ||
    params === null ||
    !int(params.parallelism, 1, 16) ||
    !int(params.memory, 8 * params.parallelism!, 1_048_576) ||
    !int(params.passes, 1, 16) ||
    params.tagLength !== 32
  )
    throw invalid()
  return {
    kind: 'argon2id',
    params: {
      memory: params.memory!,
      passes: params.passes!,
      parallelism: params.parallelism!,
      tagLength: 32,
    },
  }
}

/**
 * The stored binding `target` names, as the last-use record shows it
 * (origin or bundle ID); null when the entry is not bound to it. Origins
 * compare exactly; an app must match bundle ID, Team ID and path together.
 */
function bound(
  entry: StoredEntry,
  target: CredentialFillTarget,
): string | null {
  if (typeof target === 'string') {
    let live: string | null
    try {
      live = exactOrigin(target)
    } catch {
      return null
    }
    return entry.bindings.some(
      (binding) => binding.kind === 'origin' && binding.origin === live,
    )
      ? live
      : null
  }
  if (!target.teamId && !target.path) return null
  return entry.bindings.some(
    (binding) =>
      binding.kind === 'app' &&
      binding.bundleId === target.bundleId &&
      binding.teamId === target.teamId &&
      binding.path === target.path,
  )
    ? target.bundleId
    : null
}

function withoutBiometricKey(master: MasterRecord): MasterRecord {
  const next = { ...master }
  delete next.biometricKey
  return next
}

function verifies(master: MasterRecord, key: Buffer): boolean {
  try {
    return unseal(master.verifier, key).toString('utf8') === VERIFIER
  } catch {
    return false
  }
}

function seal(data: Buffer, key: Buffer): string {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  return Buffer.concat([
    nonce,
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64')
}

function unseal(encoded: string, key: Buffer): Buffer {
  const data = Buffer.from(encoded, 'base64')
  if (data.length < 29) throw new Error('invalid credential envelope')
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    data.subarray(0, 12),
  )
  decipher.setAuthTag(data.subarray(-16))
  return Buffer.concat([
    decipher.update(data.subarray(12, -16)),
    decipher.final(),
  ])
}

function derive(password: string, salt: Buffer, kdf: MasterKdf): Buffer {
  if (kdf.kind === 'scrypt') {
    const { cost, blockSize, parallelization, keyLength } = kdf.params
    return crypto.scryptSync(password, salt, keyLength, {
      cost,
      blockSize,
      parallelization,
      // Node's 32 MiB default is below what these costs need; allow twice.
      maxmem: 256 * cost * blockSize,
    })
  }
  // Electron 42 embeds Node 24.16; @types/node 22 predates argon2Sync.
  const argon2 = (
    crypto as unknown as {
      argon2Sync: (
        algorithm: 'argon2id',
        options: {
          message: string
          nonce: Buffer
          parallelism: number
          tagLength: number
          memory: number
          passes: number
        },
      ) => Buffer
    }
  ).argon2Sync
  const unavailable = () =>
    new CredentialVaultError(
      'vault-kdf-unavailable',
      'Argon2id is unavailable in this runtime',
    )
  if (typeof argon2 !== 'function') throw unavailable()
  try {
    return argon2('argon2id', { message: password, nonce: salt, ...kdf.params })
  } catch (error) {
    // Electron's BoringSSL exposes argon2Sync but has no Argon2.
    if (
      (error as { code?: unknown }).code === 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED'
    )
      throw unavailable()
    throw error
  }
}

function totp(seed: string, now: number): string {
  const clean = seed.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '')
  if (!/^[A-Z2-7]{16,}$/.test(clean))
    throw new CredentialVaultError('invalid-totp', 'invalid TOTP seed')
  let bits = 0
  let count = 0
  const bytes: number[] = []
  for (const char of clean) {
    bits = (bits << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char)
    count += 5
    if (count >= 8) {
      count -= 8
      bytes.push((bits >>> count) & 255)
    }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)))
  const digest = crypto
    .createHmac('sha1', Buffer.from(bytes))
    .update(counter)
    .digest()
  const offset = digest[digest.length - 1]! & 15
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0')
}

export class CredentialVault implements CredentialVaultPort {
  private file: VaultFile
  private masterKey: Buffer | null = null
  private lastUse = 0
  private idleTimer: unknown = null
  private readonly now: () => number
  private readonly timers: VaultTimers
  private readonly platform: NodeJS.Platform

  constructor(
    private readonly options: {
      path: string
      storage: SafeStorageLike
      now?: () => number
      timers?: VaultTimers
      platform?: NodeJS.Platform
      /** KDF for a newly set master password (tests use a cheap one). */
      kdf?: MasterKdf
    },
  ) {
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? systemTimers
    this.platform = options.platform ?? process.platform
    this.file = existsSync(options.path)
      ? (JSON.parse(readFileSync(options.path, 'utf8')) as VaultFile)
      : { version: 1, entries: [] }
    if (this.file.version !== 1 || !Array.isArray(this.file.entries))
      throw new CredentialVaultError(
        'vault-file-invalid',
        'unsupported credential vault format',
      )
    if (
      this.file.master !== undefined &&
      this.file.master.kind !== 'scrypt' &&
      this.file.master.kind !== 'argon2id'
    )
      throw new CredentialVaultError(
        'vault-file-invalid',
        'unsupported master password format',
      )
  }

  get available(): boolean {
    if (!this.options.storage.isEncryptionAvailable()) return false
    return this.backend !== 'basic_text'
  }

  /**
   * The safeStorage key store: macOS Keychain and Windows DPAPI are fixed;
   * Linux reports its choice, and `basic_text` means no key service at all.
   */
  get backend(): string {
    if (this.platform === 'darwin') return 'keychain'
    if (this.platform === 'win32') return 'dpapi'
    if (this.platform !== 'linux') return 'unknown'
    try {
      return this.options.storage.getSelectedStorageBackend?.() ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  get hasMasterPassword(): boolean {
    return this.file.master !== undefined
  }

  /** The user opted into unlocking by system identity verification. */
  get biometricUnlock(): boolean {
    return typeof this.file.master?.biometricKey === 'string'
  }

  get locked(): boolean {
    if (!this.hasMasterPassword) return false
    if (this.masterKey !== null && this.now() - this.lastUse >= IDLE_MS)
      this.lock()
    return this.masterKey === null
  }

  list(): CredentialHandle[] {
    const locked = this.locked
    return this.file.entries.map((entry) => this.handle(entry, locked))
  }

  /** Settings view: the handle plus username visibility and last use. */
  entries(): CredentialVaultEntry[] {
    const locked = this.locked
    return this.file.entries.map((entry) => {
      const used = Number.isFinite(entry.lastUsedAt)
      const target = entry.lastUsedTarget
      return {
        ...this.handle(entry, locked),
        revealUsername: entry.revealUsername,
        ...(used ? { lastUsedAt: entry.lastUsedAt } : {}),
        ...(used && typeof target === 'string' && target.length <= 4096
          ? { lastUsedTarget: target }
          : {}),
      }
    })
  }

  save(draft: CredentialDraft): CredentialHandle {
    this.assertReady()
    const label = draft.label.trim()
    if (!label || label.length > 120)
      throw new CredentialVaultError(
        'invalid-label',
        'credential label is required (max 120 characters)',
      )
    const bindings = validateBindings(draft.bindings)
    const oldIndex =
      draft.handleId === undefined
        ? -1
        : this.file.entries.findIndex(
            (entry) => entry.handleId === draft.handleId,
          )
    if (draft.handleId !== undefined && oldIndex < 0)
      throw new CredentialVaultError(
        'credential-not-found',
        'credential handle not found',
      )
    const old = oldIndex < 0 ? undefined : this.file.entries[oldIndex]
    if (draft.totpSecret) totp(draft.totpSecret, this.now())
    const fields: StoredEntry['fields'] = { ...old?.fields }
    const patch: Array<[CredentialField, string | undefined]> = [
      ['username', draft.username],
      ['password', draft.password],
      ['totp', draft.totpSecret],
    ]
    for (const [field, value] of patch) {
      if (value === undefined) continue
      // An empty value clears the field; keep no undefined key behind.
      if (value) fields[field] = this.encrypt(value)
      else delete fields[field]
    }
    if (Object.keys(fields).length === 0)
      throw new CredentialVaultError(
        'credential-empty',
        'at least one credential field is required',
      )
    const entry: StoredEntry = {
      handleId:
        old?.handleId ?? `cred_${crypto.randomBytes(12).toString('hex')}`,
      label,
      bindings,
      revealUsername: draft.revealUsername ?? old?.revealUsername ?? true,
      fillMode: draft.fillMode ?? old?.fillMode ?? 'auto',
      fields,
      ...(old?.lastUsedAt === undefined ? {} : { lastUsedAt: old.lastUsedAt }),
      ...(old?.lastUsedTarget === undefined
        ? {}
        : { lastUsedTarget: old.lastUsedTarget }),
    }
    const prior = this.file.entries
    this.file.entries =
      oldIndex < 0
        ? [...prior, entry]
        : prior.map((item, index) => (index === oldIndex ? entry : item))
    try {
      this.persist()
    } catch (error) {
      this.file.entries = prior
      throw error
    }
    return this.handle(entry, false)
  }

  remove(handleId: string): void {
    this.assertReady()
    if (!ID.test(handleId))
      throw new CredentialVaultError(
        'credential-not-found',
        'invalid credential handle',
      )
    const next = this.file.entries.filter(
      (entry) => entry.handleId !== handleId,
    )
    if (next.length === this.file.entries.length)
      throw new CredentialVaultError(
        'credential-not-found',
        'credential handle not found',
      )
    const prior = this.file.entries
    this.file.entries = next
    try {
      this.persist()
    } catch (error) {
      this.file.entries = prior
      throw error
    }
  }

  /**
   * Plaintext for a driver about to fill `target` (a live origin, or the
   * matched app binding), which must be one of the entry's bindings. Records
   * the time and target of this use, never the value.
   * Throws {@link CredentialVaultError}; check `reason`, never the message.
   */
  secret(
    handleId: string,
    field: CredentialField,
    target?: CredentialFillTarget,
  ): string {
    const entry = this.readyEntry(handleId, field)
    const matched = target === undefined ? undefined : bound(entry, target)
    if (matched === null)
      throw new CredentialVaultError(
        'credential-binding-mismatch',
        'credential binding mismatch',
      )
    const plaintext = this.decrypt(entry.fields[field]!)
    const value = field === 'totp' ? totp(plaintext, this.now()) : plaintext
    entry.lastUsedAt = this.now()
    // A caller that names no target leaves no stale one beside the new time.
    if (matched === undefined) delete entry.lastUsedTarget
    else entry.lastUsedTarget = matched
    try {
      this.persist()
    } catch {
      // Last use is advisory; a failed write must not block the fill.
    }
    return value
  }

  /** Trusted Settings reveal after identity verification; not a use. */
  revealPassword(handleId: string): string {
    const entry = this.readyEntry(handleId, 'password')
    return this.decrypt(entry.fields.password!)
  }

  lock(): void {
    this.masterKey?.fill(0)
    this.masterKey = null
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * `biometric` opts into system-verified unlock, and only a correct
   * password can: the key it derived is then kept wrapped by safeStorage.
   */
  unlock(password: string, options: MasterPasswordOptions = {}): boolean {
    const master = this.file.master
    if (!master) return true
    if (options.biometric) this.assertAvailable()
    const candidate = derive(
      password,
      Buffer.from(master.salt, 'base64'),
      storedKdf(master),
    )
    if (!verifies(master, candidate)) {
      candidate.fill(0)
      return false
    }
    this.lock()
    this.masterKey = candidate
    this.touch()
    if (options.biometric) {
      // Rewrap even when enabled, so a fresh opt-in repairs a stale key.
      this.file.master = { ...master, biometricKey: this.wrapKey(candidate) }
      try {
        this.persist()
      } catch (error) {
        this.file.master = master
        throw error
      }
    }
    return true
  }

  /**
   * Unlock with the wrapped key. The caller has already verified the user's
   * identity with the system (Touch ID or login password); this only unwraps.
   * A key that no longer unwraps or verifies is removed for good.
   */
  unlockWithBiometrics(): void {
    this.assertAvailable()
    const master = this.file.master
    if (!master) return
    const wrapped = master.biometricKey
    if (typeof wrapped !== 'string')
      throw new CredentialVaultError(
        'biometric-unavailable',
        'biometric unlock is not enabled',
      )
    let key: Buffer | null = null
    try {
      if (!wrapped.startsWith('s:')) throw new Error('invalid envelope')
      key = Buffer.from(
        this.options.storage.decryptString(
          Buffer.from(wrapped.slice(2), 'base64'),
        ),
        'base64',
      )
    } catch {
      // safeStorage errors are not ours to vet; the reason says enough.
      key = null
    }
    if (key === null || key.length !== 32 || !verifies(master, key)) {
      key?.fill(0)
      this.file.master = withoutBiometricKey(master)
      try {
        this.persist()
      } catch {
        // Cleared in memory; the next successful write drops it on disk.
      }
      throw new CredentialVaultError(
        'biometric-key-invalid',
        'biometric unlock key could not be read; use the master password',
      )
    }
    this.lock()
    this.masterKey = key
    this.touch()
  }

  /** Needs no unlock: turning biometric unlock off only removes access. */
  disableBiometricUnlock(): void {
    const master = this.file.master
    if (master?.biometricKey === undefined) return
    this.file.master = withoutBiometricKey(master)
    try {
      this.persist()
    } catch (error) {
      this.file.master = master
      throw error
    }
  }

  /**
   * Replacing or removing the master password drops biometric unlock unless
   * `biometric` re-enables it for the new key.
   */
  setMasterPassword(
    password: string | null,
    options: MasterPasswordOptions = {},
  ): void {
    this.assertReady()
    if (password !== null && password.length < 12)
      throw new CredentialVaultError(
        'master-password-too-short',
        'master password must have at least 12 characters',
      )
    const plaintext = this.file.entries.map((entry) => ({
      entry,
      values: Object.entries(entry.fields).map(
        ([field, value]) => [field, this.decrypt(value)] as const,
      ),
    }))
    const kdf = this.options.kdf ?? DEFAULT_KDF
    const salt = password === null ? null : crypto.randomBytes(16)
    const key = password === null ? null : derive(password, salt!, kdf)
    const oldKey = this.masterKey
    const oldMaster = this.file.master
    const oldFields = this.file.entries.map((entry) => entry.fields)
    try {
      this.masterKey = key
      this.file.master =
        key && salt
          ? {
              kind: kdf.kind,
              salt: salt.toString('base64'),
              verifier: seal(Buffer.from(VERIFIER), key),
              params: { ...kdf.params },
              ...(options.biometric ? { biometricKey: this.wrapKey(key) } : {}),
            }
          : undefined
      for (const { entry, values } of plaintext)
        entry.fields = Object.fromEntries(
          values.map(([field, value]) => [field, this.encrypt(value)]),
        )
      this.persist()
      if (oldKey !== key) oldKey?.fill(0)
    } catch (error) {
      this.file.master = oldMaster
      this.file.entries.forEach((entry, index) => {
        entry.fields = oldFields[index]!
      })
      this.masterKey = oldKey
      key?.fill(0)
      throw error
    }
    if (key === null) this.lock()
    else this.touch()
  }

  private handle(entry: StoredEntry, locked: boolean): CredentialHandle {
    let username: string | undefined
    if (entry.revealUsername && !locked && entry.fields.username)
      try {
        username = this.decrypt(entry.fields.username)
      } catch {
        // An unreadable username only hides it; listing must still work.
      }
    return {
      handleId: entry.handleId,
      label: entry.label,
      bindings: entry.bindings.map((binding) => ({ ...binding })),
      fields: Object.keys(entry.fields) as CredentialField[],
      fillMode: entry.fillMode,
      ...(username === undefined ? {} : { username }),
    }
  }

  private readyEntry(handleId: string, field: CredentialField): StoredEntry {
    this.assertReady()
    const entry = this.file.entries.find((item) => item.handleId === handleId)
    if (!entry)
      throw new CredentialVaultError(
        'credential-not-found',
        'credential handle not found',
      )
    if (!entry.fields[field])
      throw new CredentialVaultError(
        'credential-field-missing',
        'credential field not found',
      )
    return entry
  }

  private assertAvailable(): void {
    if (!this.available)
      throw new CredentialVaultError(
        'vault-unavailable',
        'system credential encryption is unavailable',
      )
  }

  private assertReady(): void {
    this.assertAvailable()
    if (this.locked)
      throw new CredentialVaultError(
        'vault-locked',
        'credential vault is locked',
      )
    this.touch()
  }

  /** Marks activity; the idle timer rechecks elapsed time when it fires. */
  private touch(): void {
    this.lastUse = this.now()
    if (this.masterKey !== null && this.idleTimer === null)
      this.scheduleIdleLock(IDLE_MS)
  }

  private scheduleIdleLock(delay: number): void {
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null
      if (this.masterKey === null) return
      const idle = this.now() - this.lastUse
      if (idle >= IDLE_MS) this.lock()
      else this.scheduleIdleLock(IDLE_MS - idle)
    }, delay)
  }

  private wrapKey(key: Buffer): string {
    return `s:${this.options.storage.encryptString(key.toString('base64')).toString('base64')}`
  }

  private encrypt(value: string): string {
    const systemCipher = this.options.storage.encryptString(value)
    return this.masterKey
      ? `m:${seal(systemCipher, this.masterKey)}`
      : `s:${systemCipher.toString('base64')}`
  }

  private decrypt(value: string): string {
    if (value.startsWith('m:') && !this.masterKey)
      throw new CredentialVaultError(
        'vault-locked',
        'credential vault is locked',
      )
    try {
      const systemCipher = value.startsWith('m:')
        ? unseal(value.slice(2), this.masterKey!)
        : value.startsWith('s:')
          ? Buffer.from(value.slice(2), 'base64')
          : null
      if (systemCipher === null) throw new Error('invalid envelope')
      return this.options.storage.decryptString(systemCipher)
    } catch {
      // Crypto and safeStorage errors are not ours to vet; drop them whole.
      throw new CredentialVaultError(
        'credential-unreadable',
        'stored credential could not be decrypted',
      )
    }
  }

  private persist(): void {
    const dir = dirname(this.options.path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const tmp = `${this.options.path}.${crypto.randomBytes(6).toString('hex')}.tmp`
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(this.file))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(tmp, this.options.path)
    } catch (error) {
      unlinkSync(tmp)
      throw error
    }
    chmodSync(this.options.path, 0o600)
  }
}
