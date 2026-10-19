import { describe, expect, it, vi } from 'vitest'
import type { CredentialHandle } from '@emperor/core/runtime-contract'
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
import { CredentialVaultError } from './credential-vault'
import { registerCredentialVaultIpc } from './credential-vault-ipc'

describe('credential vault IPC', () => {
  it('authorizes every operation and returns handles only', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const authorize = vi.fn()
    const handle: CredentialHandle = {
      handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa',
      label: 'Site',
      bindings: [],
      fields: ['password'],
      fillMode: 'auto',
    }
    const vault = {
      available: true,
      backend: 'emperor-local',
      problem: null,
      locked: false,
      hasMasterPassword: false,
      entries: vi.fn(() => [{ ...handle, revealUsername: true }]),
      save: vi.fn(() => handle),
      remove: vi.fn(),
      unlock: vi.fn(async () => true),
      lock: vi.fn(),
      setMasterPassword: vi.fn(async () => undefined),
      changeMasterPassword: vi.fn(async () => undefined),
      removeMasterPassword: vi.fn(async () => undefined),
      revealPassword: vi.fn(() => 'private'),
      reset: vi.fn(),
      startOver: vi.fn(() => ({ backup: null })),
      repairKeyPermissions: vi.fn(() => false),
      exportBackup: vi.fn(async () => Buffer.alloc(0)),
      importBackup: vi.fn(async () => ({ imported: 0 })),
    }
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize,
      vault,
    })
    const call = async (channel: string, payload?: unknown) =>
      await handlers.get(channel)!({}, payload)
    expect(await call(VAULT_STATUS_CHANNEL)).toEqual({
      available: true,
      backend: 'emperor-local',
      locked: false,
      hasMasterPassword: false,
      handles: [{ ...handle, revealUsername: true }],
    })
    expect(
      await call(VAULT_SAVE_CHANNEL, {
        label: 'Site',
        bindings: [{ kind: 'origin', origin: 'https://site.test' }],
        password: 'secret',
      }),
    ).toEqual(handle)
    await call(VAULT_REMOVE_CHANNEL, {
      handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(await call(VAULT_UNLOCK_CHANNEL, { password: 'master' })).toEqual({
      unlocked: true,
    })
    await call(VAULT_LOCK_CHANNEL)
    await call(VAULT_MASTER_CHANNEL, {
      action: 'set',
      password: 'long master passphrase',
      confirmPassword: 'long master passphrase',
    })
    expect(await call(VAULT_RESET_CHANNEL)).toEqual({ ok: true })
    expect(authorize).toHaveBeenCalledTimes(7)
    expect(vault.unlock).toHaveBeenCalledWith('master')
    expect(vault.setMasterPassword).toHaveBeenCalledWith(
      'long master passphrase',
      'long master passphrase',
    )
    expect(vault.reset).toHaveBeenCalledTimes(1)
    // Touch ID unlock is gone: no channel, and an old flag unlocks nothing more.
    expect([...handlers.keys()].some((name) => /biometric/.test(name))).toBe(
      false,
    )
    await call(VAULT_UNLOCK_CHANNEL, { password: 'master', biometric: true })
    expect(vault.unlock).toHaveBeenLastCalledWith('master')
    expect(vault.save).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'secret' }),
    )
  })

  it('reports a lost local key and clears the vault only on request', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const vault = {
      available: false,
      backend: 'emperor-local',
      problem: 'key-missing' as 'key-missing' | null,
      locked: false,
      hasMasterPassword: false,
      entries: () => [],
      reset: vi.fn(() => {
        vault.available = true
        vault.problem = null
      }),
    }
    const authorize = vi.fn()
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize,
      vault: vault as never,
    })
    const call = async (channel: string, payload?: unknown) =>
      await handlers.get(channel)!({}, payload)
    expect(await call(VAULT_STATUS_CHANNEL)).toEqual({
      available: false,
      backend: 'emperor-local',
      problem: 'key-missing',
      locked: false,
      hasMasterPassword: false,
      handles: [],
    })
    expect(vault.reset).not.toHaveBeenCalled()
    await call(VAULT_RESET_CHANNEL)
    expect(vault.reset).toHaveBeenCalledTimes(1)
    expect(await call(VAULT_STATUS_CHANNEL)).not.toHaveProperty('problem')
    // A reset that fails leaves with the vault's own reason.
    vault.reset.mockImplementation(() => {
      throw new CredentialVaultError(
        'vault-key-invalid',
        'the local key file failed its ownership or permission checks',
      )
    })
    await expect(call(VAULT_RESET_CHANNEL)).rejects.toThrow(
      '[credential-vault:vault-key-invalid]',
    )
    expect(authorize).toHaveBeenCalledTimes(4)
  })

  it('reveals a password only after native identity verification', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const revealPassword = vi.fn(() => 'private')
    let authorized = false
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize: vi.fn(),
      authenticateReveal: async () => authorized,
      vault: { revealPassword } as never,
    })
    const reveal = handlers.get(VAULT_REVEAL_CHANNEL)!
    await expect(
      reveal({}, { handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa' }),
    ).rejects.toThrow('[credential-vault:reveal-unverified]')
    expect(revealPassword).not.toHaveBeenCalled()
    authorized = true
    await expect(
      reveal({}, { handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa' }),
    ).resolves.toEqual({ password: 'private' })
    expect(revealPassword).toHaveBeenCalledWith('cred_aaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('rejects unauthorised renderer before reading a secret payload', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const vault = { save: vi.fn() }
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize: () => {
        throw new Error('untrusted renderer')
      },
      vault: vault as never,
    })
    expect(() =>
      handlers.get(VAULT_SAVE_CHANNEL)!({}, { password: 'private' }),
    ).toThrow('untrusted renderer')
    expect(vault.save).not.toHaveBeenCalled()
  })

  it('reauthorizes after native verification before revealing', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    let trusted = true
    const revealPassword = vi.fn(() => 'private')
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize: () => {
        if (!trusted) throw new Error('renderer changed')
      },
      authenticateReveal: async () => {
        trusted = false
        return true
      },
      vault: { revealPassword } as never,
    })
    await expect(
      handlers.get(VAULT_REVEAL_CHANNEL)!(
        {},
        {
          handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ),
    ).rejects.toThrow('renderer changed')
    expect(revealPassword).not.toHaveBeenCalled()
  })

  it('tags vault failures with their reason and replaces foreign errors', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const vault = {
      save: vi.fn(() => {
        throw new CredentialVaultError(
          'vault-locked',
          'credential vault is locked',
        )
      }),
      setMasterPassword: vi.fn(() => {
        // A foreign error could quote its input; it must never leave main.
        throw new Error('backend echoed long master passphrase')
      }),
    }
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize: vi.fn(),
      vault: vault as never,
    })
    expect(() =>
      handlers.get(VAULT_SAVE_CHANNEL)!(
        {},
        {
          label: 'Site',
          bindings: [{ kind: 'origin', origin: 'https://site.test' }],
          password: 'secret',
        },
      ),
    ).toThrow('[credential-vault:vault-locked] credential vault is locked')
    let foreign: unknown
    try {
      await handlers.get(VAULT_MASTER_CHANNEL)!(
        {},
        {
          action: 'set',
          password: 'long master passphrase',
          confirmPassword: 'long master passphrase',
        },
      )
    } catch (error) {
      foreign = error
    }
    expect(String(foreign)).toContain('[credential-vault:internal]')
    expect(String(foreign)).not.toContain('passphrase')
    expect(() => handlers.get(VAULT_SAVE_CHANNEL)!({}, 'not a record')).toThrow(
      '[credential-vault:invalid-request]',
    )
  })

  function register(vault: unknown, extra: Record<string, unknown> = {}) {
    const handlers = new Map<
      string,
      (event: unknown, payload?: unknown) => unknown
    >()
    const authorize = vi.fn()
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize,
      vault: vault as never,
      ...extra,
    })
    const call = async (channel: string, payload?: unknown) =>
      await handlers.get(channel)!({}, payload)
    return { call, authorize, handlers }
  }

  it('sets the master password typed twice and needs the current one to change or remove it (SEC-09 #5 #6)', async () => {
    const vault = {
      setMasterPassword: vi.fn(async (password: string, confirm: string) => {
        if (password !== confirm)
          throw new CredentialVaultError(
            'master-password-mismatch',
            'the two master passwords differ',
          )
      }),
      changeMasterPassword: vi.fn(async () => undefined),
      removeMasterPassword: vi.fn(async () => undefined),
    }
    const { call } = register(vault)
    await expect(
      call(VAULT_MASTER_CHANNEL, {
        action: 'set',
        password: 'correct horse battery',
        confirmPassword: 'correct horse batterY',
      }),
    ).rejects.toThrow('[credential-vault:master-password-mismatch]')
    // Without a confirmation, no current password, or the old shape: refused
    // before the vault is asked.
    for (const payload of [
      { action: 'set', password: 'correct horse battery' },
      { action: 'remove' },
      { action: 'remove', currentPassword: 42 },
      { action: 'change', password: 'n', confirmPassword: 'n' },
      { password: null },
      { password: 'correct horse battery' },
      { action: 'disable', currentPassword: 'x' },
    ])
      await expect(call(VAULT_MASTER_CHANNEL, payload)).rejects.toThrow(
        '[credential-vault:invalid-request]',
      )
    expect(vault.removeMasterPassword).not.toHaveBeenCalled()
    expect(vault.changeMasterPassword).not.toHaveBeenCalled()
    expect(
      await call(VAULT_MASTER_CHANNEL, {
        action: 'change',
        currentPassword: 'correct horse battery',
        password: 'another passphrase',
        confirmPassword: 'another passphrase',
      }),
    ).toEqual({ ok: true })
    expect(vault.changeMasterPassword).toHaveBeenCalledWith(
      'correct horse battery',
      'another passphrase',
      'another passphrase',
    )
    expect(
      await call(VAULT_MASTER_CHANNEL, {
        action: 'remove',
        currentPassword: 'another passphrase',
      }),
    ).toEqual({ ok: true })
    expect(vault.removeMasterPassword).toHaveBeenCalledWith(
      'another passphrase',
    )
  })

  it('reports an unreadable vault and starts over only after a backup (SEC-09 #1)', async () => {
    const vault = {
      available: false,
      backend: 'emperor-local',
      problem: 'vault-unreadable' as string | null,
      locked: false,
      hasMasterPassword: false,
      entries: () => [],
      startOver: vi.fn(() => {
        vault.problem = null
        return { backup: 'vault.json.unreadable-1700000000000' }
      }),
    }
    const { call } = register(vault)
    expect(await call(VAULT_STATUS_CHANNEL)).toMatchObject({
      available: false,
      problem: 'vault-unreadable',
      handles: [],
    })
    expect(await call(VAULT_START_OVER_CHANNEL)).toEqual({
      ok: true,
      backup: 'vault.json.unreadable-1700000000000',
    })
    expect(await call(VAULT_STATUS_CHANNEL)).not.toHaveProperty('problem')
  })

  it('repairs the local key permissions on request (SEC-09 #3)', async () => {
    const vault = { repairKeyPermissions: vi.fn(() => true) }
    const { call, authorize } = register(vault)
    expect(await call(VAULT_REPAIR_KEY_CHANNEL)).toEqual({ repaired: true })
    expect(vault.repairKeyPermissions).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('exports to a file the user picks and imports a picked backup (SEC-09 #4)', async () => {
    const backup = Buffer.from('{"format":"emperor-vault-backup"}')
    const vault = {
      exportBackup: vi.fn(async () => backup),
      importBackup: vi.fn(async () => ({ imported: 3 })),
    }
    const files = {
      chooseExportPath: vi.fn(async (): Promise<string | null> => null),
      chooseImportPath: vi.fn(async (): Promise<string | null> => null),
      read: vi.fn(async () => backup),
      write: vi.fn(async () => undefined),
    }
    const { call } = register(vault, { backupFiles: files })
    const passphrases = {
      passphrase: 'backup passphrase 1',
      confirmPassphrase: 'backup passphrase 1',
    }
    // Cancelled save dialog: nothing derived, nothing written.
    expect(await call(VAULT_EXPORT_CHANNEL, passphrases)).toEqual({
      canceled: true,
    })
    expect(vault.exportBackup).not.toHaveBeenCalled()
    files.chooseExportPath.mockResolvedValue(
      '/Users/a/Desktop/备份.emperor-vault',
    )
    expect(await call(VAULT_EXPORT_CHANNEL, passphrases)).toEqual({
      ok: true,
      name: '备份.emperor-vault',
    })
    expect(vault.exportBackup).toHaveBeenCalledWith(
      'backup passphrase 1',
      'backup passphrase 1',
    )
    expect(files.write).toHaveBeenCalledWith(
      '/Users/a/Desktop/备份.emperor-vault',
      backup,
    )
    await expect(
      call(VAULT_EXPORT_CHANNEL, { passphrase: 'backup passphrase 1' }),
    ).rejects.toThrow('[credential-vault:invalid-request]')

    // Import: nothing picked yet → refused; a picked file is read once.
    await expect(
      call(VAULT_IMPORT_CHANNEL, { passphrase: 'backup passphrase 1' }),
    ).rejects.toThrow('[credential-vault:invalid-request]')
    expect(await call(VAULT_IMPORT_PICK_CHANNEL)).toEqual({ canceled: true })
    files.chooseImportPath.mockResolvedValue(
      '/Users/a/Desktop/备份.emperor-vault',
    )
    expect(await call(VAULT_IMPORT_PICK_CHANNEL)).toEqual({
      name: '备份.emperor-vault',
    })
    expect(
      await call(VAULT_IMPORT_CHANNEL, { passphrase: 'backup passphrase 1' }),
    ).toEqual({ imported: 3 })
    expect(vault.importBackup).toHaveBeenCalledWith(
      backup,
      'backup passphrase 1',
    )
    // Used up: a second import needs a new pick.
    await expect(
      call(VAULT_IMPORT_CHANNEL, { passphrase: 'backup passphrase 1' }),
    ).rejects.toThrow('[credential-vault:invalid-request]')
  })
})
