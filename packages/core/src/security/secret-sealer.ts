/**
 * Secrets in Emperor's own config files (SEC-06): model API keys in
 * `model_config.json`, secret-named MCP `headers` / `env` values in
 * `mcp_config.json`. On disk such a value is `el1:` + base64 of the local
 * key's envelope (local-secret-store.ts), bound to the field it belongs to
 * (`context`), so a value copied into another field does not open.
 *
 * The port is implemented by the desktop main process with the
 * `LocalSecretStore` it already uses for the credential vault, and by
 * {@link createLocalKeySealer} for runs without main (ACP, headless). Both
 * read the same key file, `<stateRoot>/computer-use/secrets/local.key`, with
 * the same rule for a key that has gone: while credential-vault entries
 * still need it, no new key is made (sealing is unavailable); otherwise the
 * next seal makes one and values sealed under the old key need re-entering.
 * Never the macOS Keychain.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalSecretStore } from './local-secret-store'

export const SEALED_SECRET_PREFIX = 'el1:'

/** Header and env names whose values are sealed in `mcp_config.json`. */
export const SECRET_FIELD_NAME = /(key|token|secret|authorization|password)/i

export interface SecretSealer {
  /** `el1:<base64>`; throws {@link SecretSealError} `unavailable`. */
  seal(plain: string, context: string): string
  /** Throws {@link SecretSealError}: `not-sealed`, or `unreadable` (key gone or changed, other context, damaged). */
  open(sealed: string, context: string): string
  /** Whether sealing works now: the key is usable, or absent and may be made. */
  readonly available: boolean
}

export type SecretSealErrorReason = 'unavailable' | 'unreadable' | 'not-sealed'

/** Stable, value-free reasons; messages never quote a secret. */
export class SecretSealError extends Error {
  constructor(
    readonly reason: SecretSealErrorReason,
    message: string,
  ) {
    super(message)
    this.name = 'SecretSealError'
  }
}

/** The surface of `LocalSecretStore` a sealer needs. */
export interface SecretStoreLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string, context?: string): Buffer
  decryptString(data: Buffer, context?: string): string
}

export function isSealedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_SECRET_PREFIX)
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** A sealer over Emperor's local key store (main passes its own instance). */
export function sealerFromSecretStore(store: SecretStoreLike): SecretSealer {
  return {
    get available() {
      try {
        return store.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    seal(plain, context) {
      let sealed: Buffer
      try {
        sealed = store.encryptString(plain, context)
      } catch {
        throw new SecretSealError(
          'unavailable',
          'the local key is not available for sealing',
        )
      }
      return `${SEALED_SECRET_PREFIX}${sealed.toString('base64')}`
    },
    open(value, context) {
      if (!isSealedSecret(value))
        throw new SecretSealError('not-sealed', 'value is not sealed')
      const body = value.slice(SEALED_SECRET_PREFIX.length)
      if (!BASE64.test(body))
        throw new SecretSealError('unreadable', 'sealed value is damaged')
      try {
        return store.decryptString(Buffer.from(body, 'base64'), context)
      } catch {
        throw new SecretSealError(
          'unreadable',
          'sealed value cannot be opened with the local key',
        )
      }
    },
  }
}

/** `<stateRoot>/computer-use/secrets/local.key`, the one local key file. */
export function localSecretKeyPath(stateRoot: string): string {
  return join(stateRoot, 'computer-use', 'secrets', 'local.key')
}

/**
 * Whether `vault.json` holds a value sealed under the local key: the guard
 * main wires from `CredentialVault.hasSealedData`. Missing → false; a file
 * that cannot be read or parsed counts as data present.
 */
export function vaultHasSealedData(vaultPath: string): boolean {
  if (!existsSync(vaultPath)) return false
  try {
    const parsed = JSON.parse(readFileSync(vaultPath, 'utf8')) as {
      entries?: unknown
    }
    if (!Array.isArray(parsed.entries)) return true
    return parsed.entries.some((entry) => {
      const fields = (entry as { fields?: unknown } | null)?.fields
      return (
        fields !== null &&
        typeof fields === 'object' &&
        Object.keys(fields).length > 0
      )
    })
  } catch {
    return true
  }
}

/**
 * The sealer for a run without the desktop main process: the same key file
 * and the same lost-key guard as main (see the module comment).
 */
export function createLocalKeySealer(stateRoot: string): SecretSealer {
  const vault = join(stateRoot, 'computer-use', 'vault.json')
  return sealerFromSecretStore(
    new LocalSecretStore({
      keyPath: localSecretKeyPath(stateRoot),
      sealedDataExists: () => vaultHasSealedData(vault),
    }),
  )
}
