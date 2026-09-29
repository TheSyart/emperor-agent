/** Trusted Settings-only IPC; secrets never pass through CoreApi or tool logs. */
import {
  VAULT_BIOMETRIC_DISABLE_CHANNEL,
  VAULT_BIOMETRIC_UNLOCK_CHANNEL,
  VAULT_LOCK_CHANNEL,
  VAULT_MASTER_CHANNEL,
  VAULT_REMOVE_CHANNEL,
  VAULT_SAVE_CHANNEL,
  VAULT_STATUS_CHANNEL,
  VAULT_UNLOCK_CHANNEL,
  VAULT_REVEAL_CHANNEL,
} from '../../shared/ipc-contract'
import {
  CredentialVaultError,
  type CredentialDraft,
  type CredentialVault,
} from './credential-vault'
import type { CredentialBinding } from '@emperor/core/runtime-contract'

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void
}

/** Failures of this IPC layer itself; same secret-free contract as the vault. */
class VaultRequestError extends Error {
  constructor(
    readonly reason:
      | 'invalid-request'
      | 'reveal-unverified'
      | 'unlock-unverified'
      | 'biometric-unsupported',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Electron logs a handler's error and forwards only its message, so every
 * failure leaves as `[credential-vault:<reason>] <fixed text>`. Anything not
 * raised by the vault or this module (safeStorage, crypto, fs) is replaced
 * wholesale: its text is not ours to vet and could echo input.
 */
function sanitize(error: unknown): Error {
  if (
    error instanceof CredentialVaultError ||
    error instanceof VaultRequestError
  )
    return new Error(`[credential-vault:${error.reason}] ${error.message}`)
  return new Error(
    '[credential-vault:internal] credential vault operation failed',
  )
}

function guarded<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    throw sanitize(error)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new VaultRequestError('invalid-request', 'invalid credential request')
  return value as Record<string, unknown>
}

function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max)
    throw new VaultRequestError('invalid-request', 'invalid credential field')
  return value
}

function draft(value: unknown): CredentialDraft {
  const input = record(value)
  if (!Array.isArray(input.bindings) || input.bindings.length > 20)
    throw new VaultRequestError(
      'invalid-request',
      'invalid credential bindings',
    )
  const bindings = input.bindings.map((item): CredentialBinding => {
    const binding = record(item)
    if (binding.kind === 'origin')
      return { kind: 'origin', origin: string(binding.origin, 2048) }
    if (binding.kind === 'app')
      return {
        kind: 'app',
        bundleId: string(binding.bundleId, 200),
        ...(binding.teamId === undefined
          ? {}
          : { teamId: string(binding.teamId, 100) }),
        ...(binding.path === undefined
          ? {}
          : { path: string(binding.path, 4096) }),
      }
    throw new VaultRequestError('invalid-request', 'invalid credential binding')
  })
  if (
    input.fillMode !== undefined &&
    input.fillMode !== 'auto' &&
    input.fillMode !== 'confirm'
  )
    throw new VaultRequestError(
      'invalid-request',
      'invalid credential fill mode',
    )
  if (
    input.revealUsername !== undefined &&
    typeof input.revealUsername !== 'boolean'
  )
    throw new VaultRequestError(
      'invalid-request',
      'invalid username visibility',
    )
  return {
    label: string(input.label, 120),
    bindings,
    ...(input.handleId === undefined
      ? {}
      : { handleId: string(input.handleId, 40) }),
    ...(input.username === undefined
      ? {}
      : { username: string(input.username, 4096) }),
    ...(input.password === undefined
      ? {}
      : { password: string(input.password, 16_384) }),
    ...(input.totpSecret === undefined
      ? {}
      : { totpSecret: string(input.totpSecret, 4096) }),
    ...(input.revealUsername === undefined
      ? {}
      : { revealUsername: input.revealUsername }),
    ...(input.fillMode === undefined ? {} : { fillMode: input.fillMode }),
  }
}

export function registerCredentialVaultIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  /** System identity check (Touch ID or login password); absent: no reveal. */
  authenticateReveal?(): Promise<boolean>
  /**
   * Gate for biometric unlock; defaults to `authenticateReveal`, the same
   * native check. Absent both, biometric unlock is unsupported.
   */
  authenticateUnlock?(): Promise<boolean>
  vault: Pick<
    CredentialVault,
    | 'available'
    | 'backend'
    | 'locked'
    | 'hasMasterPassword'
    | 'entries'
    | 'save'
    | 'remove'
    | 'unlock'
    | 'lock'
    | 'setMasterPassword'
    | 'revealPassword'
    | 'biometricUnlock'
    | 'unlockWithBiometrics'
    | 'disableBiometricUnlock'
  >
}): void {
  const { ipcMain, vault } = input
  const authenticateUnlock =
    input.authenticateUnlock ?? input.authenticateReveal
  /** Opting into biometric unlock needs a way to verify the user later. */
  const optIn = (value: unknown): boolean => {
    if (value === undefined || value === false) return false
    if (value !== true)
      throw new VaultRequestError('invalid-request', 'invalid biometric option')
    if (!authenticateUnlock)
      throw new VaultRequestError(
        'biometric-unsupported',
        'biometric unlock is not supported on this system',
      )
    return true
  }
  // Authorization stays outside `guarded`: an untrusted sender is rejected
  // before any payload is read, with the policy's own error.
  ipcMain.handle(VAULT_STATUS_CHANNEL, (event) => {
    input.authorize(event)
    return guarded(() => ({
      available: vault.available,
      backend: vault.backend,
      locked: vault.locked,
      hasMasterPassword: vault.hasMasterPassword,
      biometricUnlock: vault.biometricUnlock,
      biometricSupported: authenticateUnlock !== undefined,
      handles: vault.entries(),
    }))
  })
  ipcMain.handle(VAULT_SAVE_CHANNEL, (event, payload) => {
    input.authorize(event)
    return guarded(() => vault.save(draft(payload)))
  })
  ipcMain.handle(VAULT_REMOVE_CHANNEL, (event, payload) => {
    input.authorize(event)
    guarded(() => vault.remove(string(record(payload).handleId, 40)))
    return { ok: true }
  })
  ipcMain.handle(VAULT_UNLOCK_CHANNEL, (event, payload) => {
    input.authorize(event)
    return guarded(() => {
      const request = record(payload)
      const password = string(request.password, 4096)
      return {
        unlocked: optIn(request.biometric)
          ? vault.unlock(password, { biometric: true })
          : vault.unlock(password),
      }
    })
  })
  ipcMain.handle(VAULT_LOCK_CHANNEL, (event) => {
    input.authorize(event)
    vault.lock()
    return { ok: true }
  })
  ipcMain.handle(VAULT_MASTER_CHANNEL, (event, payload) => {
    input.authorize(event)
    guarded(() => {
      const request = record(payload)
      const raw = request.password
      const password = raw === null ? null : string(raw, 4096)
      if (optIn(request.biometric) && password !== null)
        vault.setMasterPassword(password, { biometric: true })
      else vault.setMasterPassword(password)
    })
    return { ok: true }
  })
  ipcMain.handle(VAULT_BIOMETRIC_UNLOCK_CHANNEL, async (event) => {
    input.authorize(event)
    if (!authenticateUnlock)
      throw sanitize(
        new VaultRequestError(
          'biometric-unsupported',
          'biometric unlock is not supported on this system',
        ),
      )
    // Do not raise a system prompt that could not unlock anything.
    if (!guarded(() => vault.biometricUnlock))
      throw sanitize(
        new CredentialVaultError(
          'biometric-unavailable',
          'biometric unlock is not enabled',
        ),
      )
    const verified = await authenticateUnlock().catch(() => false)
    if (!verified)
      throw sanitize(
        new VaultRequestError(
          'unlock-unverified',
          'system identity verification was cancelled or unavailable',
        ),
      )
    input.authorize(event)
    return guarded(() => {
      vault.unlockWithBiometrics()
      return { unlocked: true }
    })
  })
  ipcMain.handle(VAULT_BIOMETRIC_DISABLE_CHANNEL, (event) => {
    input.authorize(event)
    guarded(() => {
      vault.disableBiometricUnlock()
    })
    return { ok: true }
  })
  ipcMain.handle(VAULT_REVEAL_CHANNEL, async (event, payload) => {
    input.authorize(event)
    const handleId = guarded(() => string(record(payload).handleId, 40))
    const verified = input.authenticateReveal
      ? await input.authenticateReveal().catch(() => false)
      : false
    if (!verified)
      throw sanitize(
        new VaultRequestError(
          'reveal-unverified',
          'system identity verification was cancelled or unavailable',
        ),
      )
    input.authorize(event)
    // Only this trusted Settings route may receive plaintext; the model and
    // Core tool APIs have no reveal operation. Viewing is not a fill, so it
    // does not update the entry's last use.
    return guarded(() => ({ password: vault.revealPassword(handleId) }))
  })
}
