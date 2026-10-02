import { describe, expect, it, vi } from 'vitest'
import type { CredentialHandle } from '@emperor/core/runtime-contract'
import {
  VAULT_LOCK_CHANNEL,
  VAULT_MASTER_CHANNEL,
  VAULT_REMOVE_CHANNEL,
  VAULT_RESET_CHANNEL,
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
      backend: 'emperor-local',
      problem: null,
      locked: false,
      hasMasterPassword: false,
      entries: vi.fn(() => [{ ...handle, revealUsername: true }]),
      save: vi.fn(() => handle),
      remove: vi.fn(),
      unlock: vi.fn(() => true),
      lock: vi.fn(),
      setMasterPassword: vi.fn(),
      revealPassword: vi.fn(() => 'private'),
      reset: vi.fn(),
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
    await call(VAULT_MASTER_CHANNEL, { password: 'long master passphrase' })
    expect(await call(VAULT_RESET_CHANNEL)).toEqual({ ok: true })
    expect(authorize).toHaveBeenCalledTimes(7)
    expect(vault.unlock).toHaveBeenCalledWith('master')
    expect(vault.setMasterPassword).toHaveBeenCalledWith(
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
