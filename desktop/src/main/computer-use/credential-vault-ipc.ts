/** Trusted Settings-only IPC; secrets never pass through CoreApi or tool logs. */
import { basename } from 'node:path'
import {
  VAULT_EXPORT_CHANNEL,
  VAULT_IMPORT_CHANNEL,
  VAULT_IMPORT_PICK_CHANNEL,
  VAULT_LOCK_CHANNEL,
  VAULT_MASTER_CHANNEL,
  VAULT_REMOVE_CHANNEL,
  VAULT_REPAIR_KEY_CHANNEL,
  VAULT_RESET_CHANNEL,
  VAULT_SAVE_CHANNEL,
  VAULT_START_OVER_CHANNEL,
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
    readonly reason: 'invalid-request' | 'reveal-unverified',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Electron logs a handler's error and forwards only its message, so every
 * failure leaves as `[credential-vault:<reason>] <fixed text>`. Anything not
 * raised by the vault or this module (the key store, crypto, fs) is replaced
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

async function guardedAsync<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
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

/**
 * 主密码 requests: `set` (typed twice), `change` (current + new twice) and
 * `remove` (current; its own danger action). The old `{ password }` shape,
 * whose null removed protection without a check, is refused.
 */
type MasterRequest =
  | { action: 'set'; password: string; confirmPassword: string }
  | {
      action: 'change'
      currentPassword: string
      password: string
      confirmPassword: string
    }
  | { action: 'remove'; currentPassword: string }

function masterRequest(value: unknown): MasterRequest {
  const input = record(value)
  if (input.action === 'set')
    return {
      action: 'set',
      password: string(input.password, 4096),
      confirmPassword: string(input.confirmPassword, 4096),
    }
  if (input.action === 'change')
    return {
      action: 'change',
      currentPassword: string(input.currentPassword, 4096),
      password: string(input.password, 4096),
      confirmPassword: string(input.confirmPassword, 4096),
    }
  if (input.action === 'remove')
    return {
      action: 'remove',
      currentPassword: string(input.currentPassword, 4096),
    }
  throw new VaultRequestError(
    'invalid-request',
    'invalid master password request',
  )
}

/** Main's own save and open dialogs, and file access for backups. */
export interface VaultBackupFiles {
  /** A path the user chose to save a `.emperor-vault`, or null. */
  chooseExportPath(): Promise<string | null>
  /** A `.emperor-vault` the user chose to open, or null. */
  chooseImportPath(): Promise<string | null>
  read(path: string): Promise<Buffer>
  write(path: string, data: Buffer): Promise<void>
}

/** A picked backup waits this long for its passphrase. */
const PICKED_TTL_MS = 10 * 60_000

export function registerCredentialVaultIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  /**
   * System identity check before 查看密码 (Touch ID or the login password,
   * LocalAuthentication only); absent: no reveal. It unlocks nothing else.
   */
  authenticateReveal?(): Promise<boolean>
  vault: Pick<
    CredentialVault,
    | 'available'
    | 'backend'
    | 'problem'
    | 'locked'
    | 'hasMasterPassword'
    | 'entries'
    | 'save'
    | 'remove'
    | 'unlock'
    | 'lock'
    | 'setMasterPassword'
    | 'changeMasterPassword'
    | 'removeMasterPassword'
    | 'revealPassword'
    | 'reset'
    | 'startOver'
    | 'repairKeyPermissions'
    | 'exportBackup'
    | 'importBackup'
  >
  /** Save/open dialogs for 导出 and 导入; absent: no backup channels work. */
  backupFiles?: VaultBackupFiles
  now?: () => number
}): void {
  const { ipcMain, vault } = input
  const now = input.now ?? Date.now
  // The file picked for import; its bytes never reach the renderer.
  let picked: { data: Buffer; at: number } | null = null
  // Authorization stays outside `guarded`: an untrusted sender is rejected
  // before any payload is read, with the policy's own error.
  ipcMain.handle(VAULT_STATUS_CHANNEL, (event) => {
    input.authorize(event)
    return guarded(() => {
      const problem = vault.problem
      return {
        available: vault.available,
        backend: vault.backend,
        ...(problem ? { problem } : {}),
        locked: vault.locked,
        hasMasterPassword: vault.hasMasterPassword,
        handles: vault.entries(),
      }
    })
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
    return guardedAsync(async () => ({
      unlocked: await vault.unlock(string(record(payload).password, 4096)),
    }))
  })
  ipcMain.handle(VAULT_LOCK_CHANNEL, (event) => {
    input.authorize(event)
    vault.lock()
    return { ok: true }
  })
  ipcMain.handle(VAULT_MASTER_CHANNEL, (event, payload) => {
    input.authorize(event)
    return guardedAsync(async () => {
      const request = masterRequest(payload)
      if (request.action === 'set')
        await vault.setMasterPassword(request.password, request.confirmPassword)
      else if (request.action === 'change')
        await vault.changeMasterPassword(
          request.currentPassword,
          request.password,
          request.confirmPassword,
        )
      else await vault.removeMasterPassword(request.currentPassword)
      return { ok: true }
    })
  })
  // Settings asks the user to confirm first; nothing else ever clears.
  ipcMain.handle(VAULT_RESET_CHANNEL, (event) => {
    input.authorize(event)
    guarded(() => vault.reset())
    return { ok: true }
  })
  // Settings confirms first; the old file is kept beside the new vault.
  ipcMain.handle(VAULT_START_OVER_CHANNEL, (event) => {
    input.authorize(event)
    return guarded(() => ({ ok: true, ...vault.startOver() }))
  })
  ipcMain.handle(VAULT_REPAIR_KEY_CHANNEL, (event) => {
    input.authorize(event)
    return guarded(() => ({ repaired: vault.repairKeyPermissions() }))
  })
  ipcMain.handle(VAULT_EXPORT_CHANNEL, (event, payload) => {
    input.authorize(event)
    return guardedAsync(async () => {
      const request = record(payload)
      const passphrase = string(request.passphrase, 4096)
      const confirmPassphrase = string(request.confirmPassphrase, 4096)
      const files = backupFiles()
      const path = await files.chooseExportPath()
      if (!path) return { canceled: true }
      const data = await vault.exportBackup(passphrase, confirmPassphrase)
      await files.write(path, data)
      return { ok: true, name: basename(path) }
    })
  })
  ipcMain.handle(VAULT_IMPORT_PICK_CHANNEL, (event) => {
    input.authorize(event)
    return guardedAsync(async () => {
      const files = backupFiles()
      const path = await files.chooseImportPath()
      if (!path) return { canceled: true }
      picked = { data: await files.read(path), at: now() }
      return { name: basename(path) }
    })
  })
  ipcMain.handle(VAULT_IMPORT_CHANNEL, (event, payload) => {
    input.authorize(event)
    return guardedAsync(async () => {
      const passphrase = string(record(payload).passphrase, 4096)
      const file = picked
      if (!file || now() - file.at > PICKED_TTL_MS) {
        picked = null
        throw new VaultRequestError(
          'invalid-request',
          'choose a backup file first',
        )
      }
      // A wrong passphrase keeps the file picked, so the user can retry.
      const result = await vault.importBackup(file.data, passphrase)
      if (picked === file) picked = null
      return result
    })
  })
  function backupFiles(): VaultBackupFiles {
    if (!input.backupFiles)
      throw new VaultRequestError(
        'invalid-request',
        'credential backups are unavailable here',
      )
    return input.backupFiles
  }
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
