import { describe, expect, it, vi } from 'vitest'
import type { CredentialHandle } from '@emperor/core/runtime-contract'
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
      backend: 'keychain',
      locked: false,
      hasMasterPassword: false,
      entries: vi.fn(() => [{ ...handle, revealUsername: true }]),
      save: vi.fn(() => handle),
      remove: vi.fn(),
      unlock: vi.fn(() => true),
      lock: vi.fn(),
      setMasterPassword: vi.fn(),
      revealPassword: vi.fn(() => 'private'),
      biometricUnlock: false,
      unlockWithBiometrics: vi.fn(),
      disableBiometricUnlock: vi.fn(),
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
      backend: 'keychain',
      locked: false,
      hasMasterPassword: false,
      biometricUnlock: false,
      biometricSupported: false,
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
    await call(VAULT_MASTER_CHANNEL, { password: 'long master passphrase' })
    await call(VAULT_BIOMETRIC_DISABLE_CHANNEL)
    expect(authorize).toHaveBeenCalledTimes(7)
    expect(vault.unlock).toHaveBeenCalledWith('master')
    expect(vault.setMasterPassword).toHaveBeenCalledWith(
      'long master passphrase',
    )
    expect(vault.disableBiometricUnlock).toHaveBeenCalledTimes(1)
    expect(vault.save).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'secret' }),
    )
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

  it('unlocks by biometrics only after the system check passes', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const vault = {
      biometricUnlock: true,
      unlockWithBiometrics: vi.fn(),
    }
    let authorized = false
    const authenticateReveal = vi.fn(async () => authorized)
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize: vi.fn(),
      // No dedicated unlock check: the reveal prompt gates both.
      authenticateReveal,
      vault: vault as never,
    })
    const unlock = handlers.get(VAULT_BIOMETRIC_UNLOCK_CHANNEL)!
    await expect(unlock({}, undefined)).rejects.toThrow(
      '[credential-vault:unlock-unverified]',
    )
    expect(vault.unlockWithBiometrics).not.toHaveBeenCalled()
    authorized = true
    await expect(unlock({}, undefined)).resolves.toEqual({ unlocked: true })
    expect(vault.unlockWithBiometrics).toHaveBeenCalledTimes(1)
    expect(authenticateReveal).toHaveBeenCalledTimes(2)

    // Not opted in: fail before raising a system prompt.
    vault.biometricUnlock = false
    await expect(unlock({}, undefined)).rejects.toThrow(
      '[credential-vault:biometric-unavailable]',
    )
    expect(authenticateReveal).toHaveBeenCalledTimes(2)

    // A key that no longer unwraps surfaces the vault's own reason.
    vault.biometricUnlock = true
    vault.unlockWithBiometrics.mockImplementation(() => {
      throw new CredentialVaultError(
        'biometric-key-invalid',
        'biometric unlock key could not be read; use the master password',
      )
    })
    await expect(unlock({}, undefined)).rejects.toThrow(
      '[credential-vault:biometric-key-invalid]',
    )
  })

  it('opts into biometric unlock only with a password and a system check', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const register = (authenticateUnlock?: () => Promise<boolean>) => {
      const vault = {
        available: true,
        backend: 'keychain',
        locked: true,
        hasMasterPassword: true,
        biometricUnlock: false,
        entries: () => [],
        unlock: vi.fn(() => true),
        setMasterPassword: vi.fn(),
        unlockWithBiometrics: vi.fn(),
      }
      registerCredentialVaultIpc({
        ipcMain: {
          handle: (channel, callback) => {
            handlers.set(channel, callback)
          },
        },
        authorize: vi.fn(),
        ...(authenticateUnlock ? { authenticateUnlock } : {}),
        vault: vault as never,
      })
      return vault
    }
    const call = async (channel: string, payload?: unknown) =>
      await handlers.get(channel)!({}, payload)

    const supported = register(async () => true)
    expect(await call(VAULT_STATUS_CHANNEL)).toMatchObject({
      biometricUnlock: false,
      biometricSupported: true,
    })
    await call(VAULT_UNLOCK_CHANNEL, {
      password: 'correct horse battery',
      biometric: true,
    })
    expect(supported.unlock).toHaveBeenCalledWith('correct horse battery', {
      biometric: true,
    })
    await call(VAULT_MASTER_CHANNEL, {
      password: 'correct horse battery',
      biometric: true,
    })
    expect(supported.setMasterPassword).toHaveBeenCalledWith(
      'correct horse battery',
      { biometric: true },
    )
    await expect(
      call(VAULT_UNLOCK_CHANNEL, { password: 'x', biometric: 'yes' }),
    ).rejects.toThrow('[credential-vault:invalid-request]')

    const unsupported = register()
    expect(await call(VAULT_STATUS_CHANNEL)).toMatchObject({
      biometricSupported: false,
    })
    await expect(
      call(VAULT_UNLOCK_CHANNEL, {
        password: 'correct horse battery',
        biometric: true,
      }),
    ).rejects.toThrow('[credential-vault:biometric-unsupported]')
    await expect(
      call(VAULT_MASTER_CHANNEL, {
        password: 'correct horse battery',
        biometric: true,
      }),
    ).rejects.toThrow('[credential-vault:biometric-unsupported]')
    await expect(call(VAULT_BIOMETRIC_UNLOCK_CHANNEL)).rejects.toThrow(
      '[credential-vault:biometric-unsupported]',
    )
    expect(unsupported.unlock).not.toHaveBeenCalled()
    expect(unsupported.setMasterPassword).not.toHaveBeenCalled()
    expect(unsupported.unlockWithBiometrics).not.toHaveBeenCalled()
  })

  it('reauthorizes after the biometric system check before unlocking', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    let trusted = true
    const unlockWithBiometrics = vi.fn()
    registerCredentialVaultIpc({
      ipcMain: {
        handle: (channel, callback) => {
          handlers.set(channel, callback)
        },
      },
      authorize: () => {
        if (!trusted) throw new Error('renderer changed')
      },
      authenticateUnlock: async () => {
        trusted = false
        return true
      },
      vault: { biometricUnlock: true, unlockWithBiometrics } as never,
    })
    await expect(
      handlers.get(VAULT_BIOMETRIC_UNLOCK_CHANNEL)!({}, undefined),
    ).rejects.toThrow('renderer changed')
    expect(unlockWithBiometrics).not.toHaveBeenCalled()
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
      handlers.get(VAULT_MASTER_CHANNEL)!(
        {},
        { password: 'long master passphrase' },
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
})
