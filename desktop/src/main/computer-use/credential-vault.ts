/**
 * Main-process-only credential vault. The renderer may submit a secret from
 * Settings, but Core and the model only ever receive CredentialHandle data.
 * Each field is sealed with Emperor's local key (`l:`, local-secret-store.ts;
 * no Keychain); an optional master password (scrypt) adds an AES-GCM layer
 * around it (`m:`). Decrypted values and the master key never persist; the
 * in-memory key is dropped after 30 idle minutes (spec 00 §6.4).
 *
 * `vault.json` is version 3 (SEC-09): every field is bound to its entry's
 * `{handleId, bindings, fillMode, field}` as AES-GCM associated data, in
 * both layers, so a binding edited on disk makes that entry unreadable.
 * Version 2 (no binding) is migrated once it can be re-sealed (at load, or
 * at the first unlock with a master password), after a copy is kept as
 * `vault.json.v2-backup-<ms>`. Version 1 sealed fields with the macOS
 * Keychain; such a file is deleted on load and the vault starts over (plan
 * rev 5).
 *
 * A file that cannot be read or parsed (`vault-unreadable`) or that a newer
 * Emperor wrote (`vault-newer`) never stops main from starting: the vault is
 * unavailable, the original stays untouched, and Settings offers 从备份恢复
 * (an exported `.emperor-vault`) or 重新开始（先备份）, which moves it aside.
 * A local key that is lost or fails its checks leaves the vault unavailable
 * with a reason until the user resets it (清空) or, for a key open to other
 * users, repairs its permissions (修复权限).
 *
 * Master password derivation runs on libuv's thread pool (`crypto.scrypt`),
 * never on main's event loop; after 5 wrong master passwords in a row each
 * attempt waits, doubling from 5 s up to 5 minutes. Changing or removing it
 * needs the current one; setting one needs it typed twice.
 */
import * as crypto from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'
import {
  openWithKey,
  UiError,
  type CredentialVaultPort,
  type UiErrorCode,
} from '@emperor/core/host-capabilities'
import type {
  CredentialBinding,
  CredentialField,
  CredentialHandle,
} from '@emperor/core/runtime-contract'

/** Why the local key cannot be used (LocalSecretStore.problem). */
export type LocalKeyProblem = 'key-missing' | 'key-invalid' | 'key-permissions'

/** Why `vault.json` itself cannot be used; the file is kept as it is. */
export type VaultFileProblem = 'vault-unreadable' | 'vault-newer'

export type CredentialVaultProblem = LocalKeyProblem | VaultFileProblem

/** The local key store's surface (LocalSecretStore); tests pass stand-ins. */
interface SecretStoreLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string, context?: string): Buffer
  decryptString(data: Buffer, context?: string): string
  getSelectedStorageBackend?(): string
  /** Why encryption is unavailable, when the store can tell. */
  problem?(): LocalKeyProblem | null
  /** Forget an unusable key so a reset vault can start over. */
  discardKey?(): void
  /** 修复权限: make a key open to other users private again. */
  repairPermissions?(): boolean
  /** The key's bytes, for a backup; the caller zeroes them. */
  exportKey?(): Buffer
  /** Publish a restored key where none exists; false if one does. */
  installKey?(key: Buffer): boolean
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
}

interface VaultFile {
  /** 2: fields not bound to their entry; migrated to 3 when possible. */
  version: 2 | 3
  master?: MasterRecord
  entries: StoredEntry[]
}

/** What this build writes. */
const VAULT_VERSION = 3

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

/**
 * Stable, secret-free failure reasons. Callers branch on `reason`; messages
 * are fixed English text and never include a value, handle secret or path.
 */
export type CredentialVaultErrorReason =
  | 'vault-unavailable'
  | 'vault-unreadable'
  | 'vault-newer'
  | 'vault-key-missing'
  | 'vault-key-invalid'
  | 'vault-key-permissions'
  | 'vault-locked'
  | 'vault-backoff'
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
  | 'master-password-mismatch'
  | 'master-password-wrong'
  | 'passphrase-too-short'
  | 'passphrase-mismatch'
  | 'backup-invalid'
  | 'backup-passphrase-wrong'

const REASON_CODE: Record<CredentialVaultErrorReason, UiErrorCode> = {
  'vault-unavailable': 'CAPABILITY_DISABLED',
  'vault-unreadable': 'CAPABILITY_DISABLED',
  'vault-newer': 'CAPABILITY_DISABLED',
  'vault-key-missing': 'CAPABILITY_DISABLED',
  'vault-key-invalid': 'CAPABILITY_DISABLED',
  'vault-key-permissions': 'CAPABILITY_DISABLED',
  'vault-locked': 'PERMISSION_REQUIRED',
  'vault-backoff': 'PERMISSION_DENIED',
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
  'master-password-mismatch': 'INVALID_REQUEST',
  'master-password-wrong': 'PERMISSION_DENIED',
  'passphrase-too-short': 'INVALID_REQUEST',
  'passphrase-mismatch': 'INVALID_REQUEST',
  'backup-invalid': 'INVALID_REQUEST',
  'backup-passphrase-wrong': 'PERMISSION_DENIED',
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
/** Wrong master passwords in a row before each attempt has to wait. */
const BACKOFF_AFTER = 5
const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000
const MIN_PASSWORD = 12
/** `.emperor-vault` files (SEC-09): a passphrase-sealed vault and local key. */
export const BACKUP_FORMAT = 'emperor-vault-backup'
export const BACKUP_EXTENSION = 'emperor-vault'
const BACKUP_VERSION = 1
/** Larger is not a backup this build wrote. */
export const BACKUP_MAX_BYTES = 8 * 1024 * 1024
const FIELDS: readonly CredentialField[] = ['username', 'password', 'totp']
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

function verifies(master: MasterRecord, key: Buffer): boolean {
  try {
    return unseal(master.verifier, key).toString('utf8') === VERIFIER
  } catch {
    return false
  }
}

function seal(data: Buffer, key: Buffer, aad?: Buffer): string {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  if (aad) cipher.setAAD(aad)
  return Buffer.concat([
    nonce,
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64')
}

function unseal(encoded: string, key: Buffer, aad?: Buffer): Buffer {
  const data = Buffer.from(encoded, 'base64')
  if (data.length < 29) throw new Error('invalid credential envelope')
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    data.subarray(0, 12),
  )
  if (aad) decipher.setAAD(aad)
  decipher.setAuthTag(data.subarray(-16))
  return Buffer.concat([
    decipher.update(data.subarray(12, -16)),
    decipher.final(),
  ])
}

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>

/**
 * The key a password stands for. scrypt runs on libuv's thread pool, so
 * main's event loop keeps serving windows and IPC meanwhile (MAIN-30).
 * Argon2id is only for vaults written where it existed; Electron has none.
 */
async function derive(
  password: string,
  salt: Buffer,
  kdf: MasterKdf,
): Promise<Buffer> {
  if (kdf.kind === 'scrypt') {
    const { cost, blockSize, parallelization, keyLength } = kdf.params
    return await scrypt(password, salt, keyLength, {
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

/**
 * Associated data binding a field to its entry (version 3): the handle,
 * the bindings in a fixed shape, the fill mode and the field name.
 */
function entryContext(
  entry: Pick<StoredEntry, 'handleId' | 'bindings' | 'fillMode'>,
  field: CredentialField,
): string {
  return `vault.json#entry\u0000${JSON.stringify({
    handleId: entry.handleId,
    bindings: entry.bindings.map((binding) =>
      binding.kind === 'origin'
        ? { kind: 'origin', origin: binding.origin }
        : {
            kind: 'app',
            bundleId: binding.bundleId,
            teamId: binding.teamId ?? null,
            path: binding.path ?? null,
          },
    ),
    fillMode: entry.fillMode,
    field,
  })}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** A binding as this build writes it; anything else makes the file unreadable. */
function storedBinding(value: unknown): CredentialBinding | null {
  if (!isRecord(value)) return null
  if (value.kind === 'origin' && typeof value.origin === 'string')
    return { kind: 'origin', origin: value.origin }
  if (
    value.kind === 'app' &&
    typeof value.bundleId === 'string' &&
    optionalString(value.teamId) &&
    optionalString(value.path)
  )
    return {
      kind: 'app',
      bundleId: value.bundleId,
      ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
      ...(typeof value.path === 'string' ? { path: value.path } : {}),
    }
  return null
}

/** One stored entry, checked field by field; null when it is not one. */
function storedEntry(value: unknown): StoredEntry | null {
  if (
    !isRecord(value) ||
    typeof value.handleId !== 'string' ||
    !ID.test(value.handleId) ||
    typeof value.label !== 'string' ||
    !Array.isArray(value.bindings) ||
    !isRecord(value.fields) ||
    (value.revealUsername !== undefined &&
      typeof value.revealUsername !== 'boolean') ||
    (value.fillMode !== undefined &&
      value.fillMode !== 'auto' &&
      value.fillMode !== 'confirm') ||
    (value.lastUsedAt !== undefined && typeof value.lastUsedAt !== 'number') ||
    !optionalString(value.lastUsedTarget)
  )
    return null
  const bindings = value.bindings.map(storedBinding)
  if (bindings.some((binding) => binding === null)) return null
  const fields: StoredEntry['fields'] = {}
  for (const [name, sealed] of Object.entries(value.fields)) {
    if (!FIELDS.includes(name as CredentialField) || typeof sealed !== 'string')
      return null
    fields[name as CredentialField] = sealed
  }
  return {
    handleId: value.handleId,
    label: value.label,
    bindings: bindings as CredentialBinding[],
    revealUsername: value.revealUsername ?? true,
    fillMode: value.fillMode ?? 'auto',
    fields,
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }),
    ...(typeof value.lastUsedTarget === 'string'
      ? { lastUsedTarget: value.lastUsedTarget }
      : {}),
  }
}

function storedMaster(value: unknown): MasterRecord | null {
  if (
    !isRecord(value) ||
    (value.kind !== 'scrypt' && value.kind !== 'argon2id') ||
    typeof value.salt !== 'string' ||
    typeof value.verifier !== 'string'
  )
    return null
  return {
    kind: value.kind,
    salt: value.salt,
    verifier: value.verifier,
    ...(value.params === undefined
      ? {}
      : { params: value.params as Argon2Params | ScryptParams }),
  }
}

/** Version 2 or 3 contents, or null when they are not what we write. */
function storedVault(
  version: 2 | 3,
  parsed: Record<string, unknown>,
): VaultFile | null {
  if (!Array.isArray(parsed.entries)) return null
  const entries = parsed.entries.map(storedEntry)
  if (entries.some((entry) => entry === null)) return null
  const master =
    parsed.master === undefined ? undefined : storedMaster(parsed.master)
  if (master === null) return null
  return {
    version,
    ...(master ? { master } : {}),
    entries: entries as StoredEntry[],
  }
}

/** Names only, from a newer file we may not interpret: nothing to decrypt. */
function listedOnly(parsed: Record<string, unknown>): StoredEntry[] {
  if (!Array.isArray(parsed.entries)) return []
  return parsed.entries.flatMap((value): StoredEntry[] => {
    if (
      !isRecord(value) ||
      typeof value.handleId !== 'string' ||
      !ID.test(value.handleId) ||
      typeof value.label !== 'string' ||
      !Array.isArray(value.bindings)
    )
      return []
    const bindings = value.bindings.map(storedBinding)
    if (bindings.some((binding) => binding === null)) return []
    return [
      {
        handleId: value.handleId,
        label: value.label,
        bindings: bindings as CredentialBinding[],
        revealUsername: false,
        fillMode: value.fillMode === 'auto' ? 'auto' : 'confirm',
        fields: Object.fromEntries(
          (isRecord(value.fields) ? Object.keys(value.fields) : [])
            .filter((name) => FIELDS.includes(name as CredentialField))
            .map((name) => [name, '']),
        ),
      },
    ]
  })
}

/** A new master password or backup passphrase: long enough, typed twice. */
function checkNewSecret(
  value: string,
  confirmation: string,
  kind: 'master' | 'passphrase',
): void {
  if (value.length < MIN_PASSWORD)
    throw kind === 'master'
      ? new CredentialVaultError(
          'master-password-too-short',
          'master password must have at least 12 characters',
        )
      : new CredentialVaultError(
          'passphrase-too-short',
          'backup passphrase must have at least 12 characters',
        )
  if (value !== confirmation)
    throw kind === 'master'
      ? new CredentialVaultError(
          'master-password-mismatch',
          'the two master passwords differ',
        )
      : new CredentialVaultError(
          'passphrase-mismatch',
          'the two backup passphrases differ',
        )
}

/** The cleartext header of a backup file, bound into its ciphertext. */
interface BackupHeader {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  kdf: { kind: 'scrypt'; params: ScryptParams }
  salt: string
}

/** Fixed key order, so writer and reader bind the same bytes. */
function backupAad(header: BackupHeader): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: header.format,
      version: header.version,
      kdf: {
        kind: 'scrypt',
        params: {
          cost: header.kdf.params.cost,
          blockSize: header.kdf.params.blockSize,
          parallelization: header.kdf.params.parallelization,
          keyLength: header.kdf.params.keyLength,
        },
      },
      salt: header.salt,
    }),
  )
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** What a backup's payload holds once decrypted. */
interface BackupPayload {
  vault: VaultFile
  localKey: Buffer
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
  private file: VaultFile = { version: VAULT_VERSION, entries: [] }
  /** Set while `vault.json` cannot be used; nothing is written then. */
  private fileProblem: VaultFileProblem | null = null
  private masterKey: Buffer | null = null
  private lastUse = 0
  private idleTimer: unknown = null
  /** Wrong master passwords in a row, and when the next try may run. */
  private failures = 0
  private blockedUntil = 0
  /** Runs master-password and backup work one at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private readonly timers: VaultTimers

  constructor(
    private readonly options: {
      path: string
      /** The local key store (LocalSecretStore). */
      storage: SecretStoreLike
      now?: () => number
      timers?: VaultTimers
      /** KDF for a new master password or backup (tests use a cheap one). */
      kdf?: MasterKdf
    },
  ) {
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? systemTimers
    this.load()
    this.migrate()
  }

  get available(): boolean {
    return this.fileProblem === null && this.keyAvailable()
  }

  /** Where secrets are sealed: `emperor-local`, the local key file. */
  get backend(): string {
    try {
      return this.options.storage.getSelectedStorageBackend?.() ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * Why the vault is unavailable: `vault.json` cannot be read or is newer
   * than this build (从备份恢复 / 重新开始（先备份）), the local key is gone
   * while entries need it or failed its checks (清空), or the key is open to
   * other users (修复权限 first).
   */
  get problem(): CredentialVaultProblem | null {
    return this.fileProblem ?? this.keyProblem()
  }

  /**
   * Whether any entry holds a value sealed under the local key. While one
   * does, a missing key is lost rather than new (main wires this into the
   * key store), so no new key is made over it. A file we cannot interpret
   * may hold such values, so it counts as holding them.
   */
  get hasSealedData(): boolean {
    return (
      this.fileProblem !== null ||
      this.file.entries.some((entry) => Object.keys(entry.fields).length > 0)
    )
  }

  get hasMasterPassword(): boolean {
    return this.file.master !== undefined
  }

  get locked(): boolean {
    if (!this.hasMasterPassword) return false
    if (this.masterKey !== null && this.now() - this.lastUse >= IDLE_MS)
      this.lock()
    return this.masterKey === null
  }

  /** How long until another master password may be tried (0: now). */
  get retryAfterMs(): number {
    return Math.max(0, this.blockedUntil - this.now())
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

  /**
   * Save several drafts with one write: all of them, or none if any is
   * invalid or the write fails (browser import, MAIN-7).
   */
  saveMany(drafts: readonly CredentialDraft[]): CredentialHandle[] {
    this.assertReady()
    const prior = this.file.entries
    const saved: StoredEntry[] = []
    try {
      for (const draft of drafts) saved.push(this.stage(draft))
      this.persist()
    } catch (error) {
      this.file.entries = prior
      throw error
    }
    return saved.map((entry) => this.handle(entry, false))
  }

  save(draft: CredentialDraft): CredentialHandle {
    this.assertReady()
    const prior = this.file.entries
    try {
      const entry = this.stage(draft)
      this.persist()
      return this.handle(entry, false)
    } catch (error) {
      this.file.entries = prior
      throw error
    }
  }

  /** Validate one draft and put it into `file.entries` (not yet on disk). */
  private stage(draft: CredentialDraft): StoredEntry {
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
    const shape = {
      handleId:
        old?.handleId ?? `cred_${crypto.randomBytes(12).toString('hex')}`,
      bindings,
      fillMode: draft.fillMode ?? old?.fillMode ?? 'auto',
    }
    const fields: StoredEntry['fields'] = {}
    // Kept fields follow the entry: an edited binding or fill mode re-seals
    // them under the new associated data. One that cannot be opened stays
    // as it was (it was unreadable before too).
    for (const [field, value] of Object.entries(old?.fields ?? {}) as Array<
      [CredentialField, string]
    >) {
      if (
        this.file.version < 3 ||
        entryContext(old!, field) === entryContext(shape, field)
      ) {
        fields[field] = value
        continue
      }
      try {
        fields[field] = this.encrypt(shape, field, this.decrypt(old!, field))
      } catch {
        fields[field] = value
      }
    }
    const patch: Array<[CredentialField, string | undefined]> = [
      ['username', draft.username],
      ['password', draft.password],
      ['totp', draft.totpSecret],
    ]
    for (const [field, value] of patch) {
      if (value === undefined) continue
      // An empty value clears the field; keep no undefined key behind.
      if (value) fields[field] = this.encrypt(shape, field, value)
      else delete fields[field]
    }
    if (Object.keys(fields).length === 0)
      throw new CredentialVaultError(
        'credential-empty',
        'at least one credential field is required',
      )
    const entry: StoredEntry = {
      handleId: shape.handleId,
      label,
      bindings,
      revealUsername: draft.revealUsername ?? old?.revealUsername ?? true,
      fillMode: shape.fillMode,
      fields,
      ...(old?.lastUsedAt === undefined ? {} : { lastUsedAt: old.lastUsedAt }),
      ...(old?.lastUsedTarget === undefined
        ? {}
        : { lastUsedTarget: old.lastUsedTarget }),
    }
    const current = this.file.entries
    this.file.entries =
      oldIndex < 0
        ? [...current, entry]
        : current.map((item, index) => (index === oldIndex ? entry : item))
    return entry
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
    const plaintext = this.decrypt(entry, field)
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
    return this.decrypt(entry, 'password')
  }

  /**
   * 清空: forget every entry and the master password, plus a local key file
   * that failed its checks, so the vault starts over. The way out of a lost
   * or unusable key; only ever done at the user's request. A `vault.json`
   * this build cannot read is moved aside rather than deleted.
   */
  reset(): void {
    this.lock()
    if (this.fileProblem) this.moveAside(this.fileProblem)
    else rmSync(this.options.path, { force: true })
    this.startEmpty()
  }

  /**
   * 重新开始（先备份）: move `vault.json` aside (`vault.json.unreadable-<ms>`,
   * `.newer-<ms>` or `.backup-<ms>`, 0600) and start an empty vault. Returns
   * the backup's file name, or null when there was no file.
   */
  startOver(): { backup: string | null } {
    this.lock()
    const backup = existsSync(this.options.path)
      ? this.moveAside(this.fileProblem ?? 'backup')
      : null
    this.startEmpty()
    return { backup }
  }

  /**
   * 修复权限: make a local key that group or others can read private again.
   * True when the key is usable afterwards; false when there was nothing to
   * repair or it cannot be (another owner, a symlink, a damaged file).
   */
  repairKeyPermissions(): boolean {
    if (this.keyProblem() !== 'key-permissions') return false
    return this.options.storage.repairPermissions?.() ?? false
  }

  lock(): void {
    this.masterKey?.fill(0)
    this.masterKey = null
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * False for a wrong password. After 5 in a row each try first waits
   * (`vault-backoff`, {@link retryAfterMs}); the right one resets the count.
   */
  unlock(password: string): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertFileReadable()
      const master = this.file.master
      if (!master) return true
      this.checkBackoff()
      this.assertAvailable()
      const candidate = await derive(
        password,
        Buffer.from(master.salt, 'base64'),
        storedKdf(master),
      )
      if (this.file.master !== master || !verifies(master, candidate)) {
        candidate.fill(0)
        if (this.file.master === master) this.recordFailure()
        return false
      }
      this.recordSuccess()
      this.lock()
      this.masterKey = candidate
      this.touch()
      this.migrate()
      return true
    })
  }

  /** Protect the vault with a first master password, typed twice. */
  setMasterPassword(password: string, confirmation: string): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady()
      if (this.file.master)
        throw new CredentialVaultError(
          'master-password-wrong',
          'the current master password is required to change it',
        )
      checkNewSecret(password, confirmation, 'master')
      await this.resealWith(password)
    })
  }

  /** Replace the master password; the current one must be given. */
  changeMasterPassword(
    current: string,
    password: string,
    confirmation: string,
  ): Promise<void> {
    return this.exclusive(async () => {
      this.checkBackoff()
      this.assertReady()
      checkNewSecret(password, confirmation, 'master')
      await this.verifyCurrent(current)
      await this.resealWith(password)
    })
  }

  /** Drop the master password (danger); the current one must be given. */
  removeMasterPassword(current: string): Promise<void> {
    return this.exclusive(async () => {
      this.checkBackoff()
      this.assertReady()
      if (!this.file.master) return
      await this.verifyCurrent(current)
      this.reseal(null, undefined)
    })
  }

  /**
   * 导出凭据备份: every entry (still sealed under the local key, outside any
   * master password) and the local key itself, in one AES-256-GCM envelope
   * under a key scrypt derives from `passphrase`. The header (format, KDF,
   * salt) is bound as associated data. Needs an unlocked vault.
   */
  exportBackup(passphrase: string, confirmation: string): Promise<Buffer> {
    return this.exclusive(async () => {
      this.assertReady()
      checkNewSecret(passphrase, confirmation, 'passphrase')
      const exportKey = this.options.storage.exportKey
      if (!exportKey)
        throw new CredentialVaultError(
          'vault-unavailable',
          'this key store cannot export its key',
        )
      const entries = this.file.entries.map((entry) => ({
        ...entry,
        bindings: entry.bindings.map((binding) => ({ ...binding })),
        fields: Object.fromEntries(
          Object.entries(entry.fields).map(([field, value]) => [
            field,
            `l:${this.localEnvelope(entry, field as CredentialField, value).toString('base64')}`,
          ]),
        ),
      }))
      const key = exportKey.call(this.options.storage)
      let payload: Buffer
      try {
        payload = Buffer.from(
          JSON.stringify({
            createdAt: this.now(),
            vault: { version: this.file.version, entries },
            localKey: key.toString('base64'),
          }),
        )
      } finally {
        key.fill(0)
      }
      const kdf = this.backupKdf()
      const header: BackupHeader = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        kdf,
        salt: crypto.randomBytes(16).toString('base64'),
      }
      const derived = await derive(
        passphrase,
        Buffer.from(header.salt, 'base64'),
        kdf,
      )
      try {
        const nonce = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv('aes-256-gcm', derived, nonce)
        cipher.setAAD(backupAad(header))
        const sealed = Buffer.concat([
          cipher.update(payload),
          cipher.final(),
          cipher.getAuthTag(),
        ])
        return Buffer.from(
          `${JSON.stringify(
            {
              ...header,
              nonce: nonce.toString('base64'),
              ciphertext: sealed.toString('base64'),
            },
            null,
            2,
          )}\n`,
        )
      } finally {
        payload.fill(0)
        derived.fill(0)
      }
    })
  }

  /**
   * 导入凭据备份 / 从备份恢复: open a `.emperor-vault` with its passphrase
   * and merge its entries in (same handle: the backup's wins), sealed the
   * way this vault seals (its local key, its master password if any). A
   * `vault.json` this build cannot read is first moved aside; with no local
   * key yet, the backup's key becomes the local key, which also reopens
   * model keys and pairings sealed under it. The vault before the import is
   * kept as `vault.json.before-import-<ms>`.
   */
  importBackup(
    data: Buffer,
    passphrase: string,
  ): Promise<{ imported: number }> {
    return this.exclusive(async () => {
      const backup = await this.openBackup(data, passphrase)
      try {
        // Every backup field opens before anything here changes.
        const opened = backup.vault.entries.map((entry) => ({
          entry,
          values: (Object.keys(entry.fields) as CredentialField[]).map(
            (field) =>
              [
                field,
                this.openBackupField(
                  backup,
                  entry,
                  field,
                  entry.fields[field]!,
                ),
              ] as const,
          ),
        }))
        // Everything below is synchronous: nothing else interleaves.
        const key = this.keyProblem()
        if (key === 'key-invalid' || key === 'key-permissions')
          throw this.keyError(key)
        if (this.fileProblem) {
          this.lock()
          this.moveAside(this.fileProblem)
          this.startEmpty()
        }
        this.options.storage.installKey?.(backup.localKey)
        this.assertReady()
        const imported = opened.map(({ entry, values }) => ({
          ...entry,
          fields: Object.fromEntries(
            values.map(([field, value]) => [
              field,
              this.encrypt(entry, field, value),
            ]),
          ),
        }))
        if (existsSync(this.options.path))
          this.keepCopy(
            'before-import',
            readFileSync(this.options.path, 'utf8'),
          )
        const prior = this.file.entries
        const incoming = new Map(
          imported.map((entry) => [entry.handleId, entry]),
        )
        this.file.entries = [
          ...prior.map((entry) => incoming.get(entry.handleId) ?? entry),
          ...imported.filter(
            (entry) => !prior.some((item) => item.handleId === entry.handleId),
          ),
        ]
        try {
          this.persist()
        } catch (error) {
          this.file.entries = prior
          throw error
        }
        return { imported: imported.length }
      } finally {
        backup.localKey.fill(0)
      }
    })
  }

  private handle(entry: StoredEntry, locked: boolean): CredentialHandle {
    let username: string | undefined
    if (
      entry.revealUsername &&
      !locked &&
      !this.fileProblem &&
      entry.fields.username
    )
      try {
        username = this.decrypt(entry, 'username')
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

  /** Read `vault.json` without ever failing construction (MAIN-11). */
  private load(): void {
    const path = this.options.path
    if (!existsSync(path)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      this.fileProblem = 'vault-unreadable'
      return
    }
    const version = isRecord(parsed) ? parsed.version : undefined
    if (!isRecord(parsed) || !Number.isInteger(version)) {
      this.fileProblem = 'vault-unreadable'
      return
    }
    if (version === 1) {
      // Sealed by the macOS Keychain, which Emperor no longer uses: the user
      // chose to drop these entries and start over (plan rev 5).
      unlinkSync(path)
      return
    }
    if ((version as number) > VAULT_VERSION) {
      // A newer Emperor wrote it: list the names it shows, change nothing.
      this.fileProblem = 'vault-newer'
      this.file = { version: VAULT_VERSION, entries: listedOnly(parsed) }
      return
    }
    const file =
      version === 2 || version === 3 ? storedVault(version, parsed) : null
    if (!file) {
      this.fileProblem = 'vault-unreadable'
      return
    }
    this.file = file
  }

  /**
   * Version 2 → 3: once every field can be opened (the local key is usable
   * and, with a master password, the vault is unlocked), re-seal each one
   * bound to its entry and write version 3, after keeping the original as
   * `vault.json.v2-backup-<ms>`. Best effort: a failure leaves version 2.
   */
  private migrate(): void {
    if (
      this.file.version !== 2 ||
      this.fileProblem ||
      !this.keyAvailable() ||
      (this.file.master && !this.masterKey)
    )
      return
    const before = this.file
    try {
      const original = existsSync(this.options.path)
        ? readFileSync(this.options.path, 'utf8')
        : null
      const next: VaultFile = {
        ...before,
        version: VAULT_VERSION,
        entries: before.entries.map((entry) => ({
          ...entry,
          fields: Object.fromEntries(
            Object.entries(entry.fields).map(([field, value]) => {
              try {
                const plain = this.decryptAs(
                  2,
                  entry,
                  field as CredentialField,
                  value,
                )
                return [
                  field,
                  this.encryptAs(
                    VAULT_VERSION,
                    entry,
                    field as CredentialField,
                    plain,
                  ),
                ]
              } catch {
                // Already unreadable: keep it; it stays unreadable.
                return [field, value]
              }
            }),
          ),
        })),
      }
      if (original !== null) this.keepCopy('v2-backup', original)
      this.file = next
      this.persist()
    } catch {
      this.file = before
    }
  }

  private keyProblem(): LocalKeyProblem | null {
    try {
      return this.options.storage.problem?.() ?? null
    } catch {
      return null
    }
  }

  private keyAvailable(): boolean {
    try {
      return this.options.storage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private startEmpty(): void {
    const key = this.keyProblem()
    this.file = { version: VAULT_VERSION, entries: [] }
    this.fileProblem = null
    if (key === 'key-invalid' || key === 'key-permissions')
      this.options.storage.discardKey?.()
  }

  private assertFileReadable(): void {
    if (this.fileProblem === 'vault-unreadable')
      throw new CredentialVaultError(
        'vault-unreadable',
        'the credential vault file cannot be read; it was left unchanged',
      )
    if (this.fileProblem === 'vault-newer')
      throw new CredentialVaultError(
        'vault-newer',
        'a newer Emperor wrote the credential vault; it was left unchanged',
      )
  }

  private assertAvailable(): void {
    this.assertFileReadable()
    if (this.keyAvailable()) return
    throw this.keyError(this.keyProblem())
  }

  private keyError(problem: LocalKeyProblem | null): CredentialVaultError {
    return problem === 'key-missing'
      ? new CredentialVaultError(
          'vault-key-missing',
          'the local key is missing; stored credentials cannot be decrypted',
        )
      : problem === 'key-invalid'
        ? new CredentialVaultError(
            'vault-key-invalid',
            'the local key file failed its ownership or permission checks',
          )
        : problem === 'key-permissions'
          ? new CredentialVaultError(
              'vault-key-permissions',
              'the local key file is readable by other users',
            )
          : new CredentialVaultError(
              'vault-unavailable',
              'local credential encryption is unavailable',
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
    this.migrate()
  }

  private checkBackoff(): void {
    const wait = this.retryAfterMs
    if (wait > 0)
      throw new CredentialVaultError(
        'vault-backoff',
        `too many wrong master passwords; retry in ${Math.ceil(wait / 1000)} s`,
      )
  }

  private recordFailure(): void {
    this.failures += 1
    if (this.failures >= BACKOFF_AFTER)
      this.blockedUntil =
        this.now() +
        Math.min(
          BACKOFF_MAX_MS,
          BACKOFF_BASE_MS * 2 ** (this.failures - BACKOFF_AFTER),
        )
  }

  private recordSuccess(): void {
    this.failures = 0
    this.blockedUntil = 0
  }

  /** The current master password, checked like an unlock (with backoff). */
  private async verifyCurrent(current: string): Promise<void> {
    const master = this.file.master
    if (!master)
      throw new CredentialVaultError(
        'master-password-wrong',
        'there is no master password',
      )
    const candidate = await derive(
      current,
      Buffer.from(master.salt, 'base64'),
      storedKdf(master),
    )
    const right = this.file.master === master && verifies(master, candidate)
    candidate.fill(0)
    if (!right) {
      this.recordFailure()
      throw new CredentialVaultError(
        'master-password-wrong',
        'the current master password is wrong',
      )
    }
    this.recordSuccess()
  }

  /** Derive a key for `password`, then re-seal every field under it. */
  private async resealWith(password: string): Promise<void> {
    const kdf = this.options.kdf ?? DEFAULT_KDF
    const salt = crypto.randomBytes(16)
    const key = await derive(password, salt, kdf)
    try {
      // The derivation awaited: the vault may have locked meanwhile.
      this.assertReady()
    } catch (error) {
      key.fill(0)
      throw error
    }
    this.reseal(key, {
      kind: kdf.kind,
      salt: salt.toString('base64'),
      verifier: seal(Buffer.from(VERIFIER), key),
      params: { ...kdf.params },
    })
  }

  /** Re-seals every field: with the new master key, or without one. */
  private reseal(key: Buffer | null, master: MasterRecord | undefined): void {
    const plaintext = this.file.entries.map((entry) => ({
      entry,
      values: (Object.keys(entry.fields) as CredentialField[]).map(
        (field) => [field, this.decrypt(entry, field)] as const,
      ),
    }))
    const oldKey = this.masterKey
    const oldMaster = this.file.master
    const oldFields = this.file.entries.map((entry) => entry.fields)
    try {
      this.masterKey = key
      if (master) this.file.master = master
      else delete this.file.master
      for (const { entry, values } of plaintext)
        entry.fields = Object.fromEntries(
          values.map(([field, value]) => [
            field,
            this.encrypt(entry, field, value),
          ]),
        )
      this.persist()
      if (oldKey !== key) oldKey?.fill(0)
    } catch (error) {
      if (oldMaster) this.file.master = oldMaster
      else delete this.file.master
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

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private backupKdf(): { kind: 'scrypt'; params: ScryptParams } {
    const kdf = this.options.kdf ?? DEFAULT_KDF
    return kdf.kind === 'scrypt'
      ? { kind: 'scrypt', params: { ...kdf.params } }
      : { kind: 'scrypt', params: { ...(DEFAULT_KDF.params as ScryptParams) } }
  }

  /** Parse, check and decrypt a backup file; nothing is changed yet. */
  private async openBackup(
    data: Buffer,
    passphrase: string,
  ): Promise<BackupPayload> {
    const invalid = () =>
      new CredentialVaultError(
        'backup-invalid',
        'the file is not an Emperor credential backup',
      )
    let parsed: unknown
    try {
      if (data.length > BACKUP_MAX_BYTES) throw invalid()
      parsed = JSON.parse(data.toString('utf8'))
    } catch {
      throw invalid()
    }
    if (
      !isRecord(parsed) ||
      parsed.format !== BACKUP_FORMAT ||
      parsed.version !== BACKUP_VERSION ||
      !isRecord(parsed.kdf) ||
      parsed.kdf.kind !== 'scrypt' ||
      typeof parsed.salt !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.ciphertext !== 'string' ||
      !BASE64.test(parsed.salt) ||
      !BASE64.test(parsed.nonce) ||
      !BASE64.test(parsed.ciphertext)
    )
      throw invalid()
    let kdf: MasterKdf
    try {
      kdf = storedKdf({
        kind: 'scrypt',
        salt: '',
        verifier: '',
        params: parsed.kdf.params as ScryptParams,
      })
    } catch {
      throw invalid()
    }
    const header: BackupHeader = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      kdf: kdf as { kind: 'scrypt'; params: ScryptParams },
      salt: parsed.salt,
    }
    const nonce = Buffer.from(parsed.nonce, 'base64')
    const sealed = Buffer.from(parsed.ciphertext, 'base64')
    if (nonce.length !== 12 || sealed.length < 17) throw invalid()
    const derived = await derive(
      passphrase,
      Buffer.from(header.salt, 'base64'),
      kdf,
    )
    let payload: Buffer
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', derived, nonce)
      decipher.setAAD(backupAad(header))
      decipher.setAuthTag(sealed.subarray(-16))
      payload = Buffer.concat([
        decipher.update(sealed.subarray(0, -16)),
        decipher.final(),
      ])
    } catch {
      throw new CredentialVaultError(
        'backup-passphrase-wrong',
        'the backup passphrase is wrong or the file was changed',
      )
    } finally {
      derived.fill(0)
    }
    try {
      const body = JSON.parse(payload.toString('utf8')) as unknown
      if (
        !isRecord(body) ||
        !isRecord(body.vault) ||
        typeof body.localKey !== 'string' ||
        !BASE64.test(body.localKey)
      )
        throw invalid()
      const version = body.vault.version
      const vault =
        version === 2 || version === 3 ? storedVault(version, body.vault) : null
      const localKey = Buffer.from(body.localKey, 'base64')
      if (!vault || vault.master || localKey.length !== 32) {
        localKey.fill(0)
        throw invalid()
      }
      return { vault, localKey }
    } catch {
      throw invalid()
    } finally {
      payload.fill(0)
    }
  }

  /** A backup field's plaintext, opened with the backup's own key. */
  private openBackupField(
    backup: BackupPayload,
    entry: StoredEntry,
    field: CredentialField,
    value: string,
  ): string {
    try {
      if (!value.startsWith('l:') || !BASE64.test(value.slice(2)))
        throw new Error('not a local envelope')
      return openWithKey(
        backup.localKey,
        Buffer.from(value.slice(2), 'base64'),
        backup.vault.version >= 3 ? entryContext(entry, field) : undefined,
      )
    } catch {
      throw new CredentialVaultError(
        'backup-invalid',
        'a credential in the backup cannot be opened',
      )
    }
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

  private encrypt(
    entry: Pick<StoredEntry, 'handleId' | 'bindings' | 'fillMode'>,
    field: CredentialField,
    value: string,
  ): string {
    return this.encryptAs(this.file.version, entry, field, value)
  }

  private encryptAs(
    version: VaultFile['version'],
    entry: Pick<StoredEntry, 'handleId' | 'bindings' | 'fillMode'>,
    field: CredentialField,
    value: string,
  ): string {
    const context = version >= 3 ? entryContext(entry, field) : undefined
    const local = this.options.storage.encryptString(value, context)
    return this.masterKey
      ? `m:${seal(local, this.masterKey, context === undefined ? undefined : Buffer.from(context))}`
      : `l:${local.toString('base64')}`
  }

  private decrypt(entry: StoredEntry, field: CredentialField): string {
    return this.decryptAs(
      this.file.version,
      entry,
      field,
      entry.fields[field] ?? '',
    )
  }

  private decryptAs(
    version: VaultFile['version'],
    entry: Pick<StoredEntry, 'handleId' | 'bindings' | 'fillMode'>,
    field: CredentialField,
    value: string,
  ): string {
    if (value.startsWith('m:') && !this.masterKey)
      throw new CredentialVaultError(
        'vault-locked',
        'credential vault is locked',
      )
    const context = version >= 3 ? entryContext(entry, field) : undefined
    try {
      const local = this.localEnvelopeAs(version, entry, field, value)
      return this.options.storage.decryptString(local, context)
    } catch {
      // Crypto and key store errors are not ours to vet; drop them whole.
      throw new CredentialVaultError(
        'credential-unreadable',
        'stored credential could not be decrypted',
      )
    }
  }

  /** The local key's envelope inside a field (unwrapping `m:`). */
  private localEnvelope(
    entry: StoredEntry,
    field: CredentialField,
    value: string,
  ): Buffer {
    try {
      return this.localEnvelopeAs(this.file.version, entry, field, value)
    } catch {
      throw new CredentialVaultError(
        'credential-unreadable',
        'stored credential could not be decrypted',
      )
    }
  }

  private localEnvelopeAs(
    version: VaultFile['version'],
    entry: Pick<StoredEntry, 'handleId' | 'bindings' | 'fillMode'>,
    field: CredentialField,
    value: string,
  ): Buffer {
    if (value.startsWith('m:')) {
      if (!this.masterKey) throw new Error('locked')
      return unseal(
        value.slice(2),
        this.masterKey,
        version >= 3 ? Buffer.from(entryContext(entry, field)) : undefined,
      )
    }
    if (value.startsWith('l:')) return Buffer.from(value.slice(2), 'base64')
    throw new Error('invalid envelope')
  }

  /** `vault.json.<marker>-<ms>` (never over an existing file), 0600. */
  private backupPath(marker: string): string {
    const base = `${this.options.path}.${marker}-${this.now()}`
    let candidate = base
    for (let index = 1; existsSync(candidate); index += 1)
      candidate = `${base}-${index}`
    return candidate
  }

  /** Move `vault.json` aside, keeping it private; returns its file name. */
  private moveAside(marker: string): string {
    const target = this.backupPath(
      marker === 'vault-unreadable'
        ? 'unreadable'
        : marker === 'vault-newer'
          ? 'newer'
          : marker,
    )
    renameSync(this.options.path, target)
    chmodSync(target, 0o600)
    syncDirectory(dirname(this.options.path))
    return basename(target)
  }

  /** Write a private copy of `text` beside the vault (O_EXCL, fsync). */
  private keepCopy(marker: string, text: string): string {
    const target = this.backupPath(marker)
    const fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    try {
      writeFileSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(target, 0o600)
    syncDirectory(dirname(target))
    return basename(target)
  }

  private persist(): void {
    // A file this build cannot read is never overwritten.
    this.assertFileReadable()
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
    syncDirectory(dir)
  }
}

/** fsync a directory so a rename(2) inside it survives a crash. */
function syncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Durability of the name is best effort; the data itself was fsynced.
  }
}
