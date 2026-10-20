/**
 * 备份与恢复 over IPC (REL-03): the trusted main window asks; main alone
 * picks paths (its save and open dialogs) and restarts after a restore.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  HOME_BACKUP_DISCARD_CHANNEL,
  HOME_BACKUP_EXPORT_CHANNEL,
  HOME_BACKUP_OPEN_CHANNEL,
  HOME_BACKUP_PLAN_CHANNEL,
  HOME_BACKUP_RESTORE_CHANNEL,
  HOME_BACKUP_REVEAL_CHANNEL,
} from '../shared/ipc-contract'
import { CredentialVaultError } from './computer-use/credential-vault'
import { registerHomeBackupIpc, type HomeBackupStore } from './home-backup-ipc'

type Handler = (event: unknown, payload?: unknown) => unknown

function setup(overrides: Partial<HomeBackupStore> = {}) {
  const handlers = new Map<string, Handler>()
  const store: HomeBackupStore = {
    plan: vi.fn(async () => ({
      name: 'Emperor 备份 2026-10-20',
      categories: [],
      excluded: [],
      vault: { state: 'empty' as const, entries: 0 },
    })),
    export: vi.fn(async (_input, target: string) => ({
      name: 'x.emperor-backup.zip',
      path: target,
      credentials: false,
    })),
    open: vi.fn(async () => ({
      id: 'r_0123456789ab',
      name: 'x.emperor-backup.zip',
      createdAt: '2026-10-20T10:00:00.000Z',
      appVersion: '0.2.0',
      categories: ['config'],
      credentials: false,
      files: 1,
      bytes: 10,
      newer: false,
    })),
    restore: vi.fn(async () => undefined),
    discard: vi.fn(),
    ...overrides,
  }
  const authorize = vi.fn()
  const relaunch = vi.fn()
  const reveal = vi.fn()
  const chooseTarget = vi.fn(
    async (): Promise<string | null> =>
      '/Users/me/Desktop/x.emperor-backup.zip',
  )
  const chooseBackup = vi.fn(
    async (): Promise<string | null> =>
      '/Users/me/Desktop/x.emperor-backup.zip',
  )
  registerHomeBackupIpc({
    ipcMain: {
      handle: (channel, listener) => void handlers.set(channel, listener),
    },
    authorize,
    backups: async () => store,
    chooseTarget,
    chooseBackup,
    reveal,
    relaunch,
    homeDir: '/Users/me',
  })
  const call = (channel: string, payload?: unknown) =>
    handlers.get(channel)!({ sender: 1 }, payload)
  return {
    handlers,
    store,
    authorize,
    relaunch,
    reveal,
    chooseTarget,
    chooseBackup,
    call,
  }
}

describe('registerHomeBackupIpc', () => {
  it('registers six channels, each behind the trusted-window check', async () => {
    const { handlers, authorize, call } = setup()
    expect([...handlers.keys()].sort()).toEqual(
      [
        HOME_BACKUP_PLAN_CHANNEL,
        HOME_BACKUP_EXPORT_CHANNEL,
        HOME_BACKUP_REVEAL_CHANNEL,
        HOME_BACKUP_OPEN_CHANNEL,
        HOME_BACKUP_RESTORE_CHANNEL,
        HOME_BACKUP_DISCARD_CHANNEL,
      ].sort(),
    )
    await call(HOME_BACKUP_PLAN_CHANNEL)
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('exports where the save dialog says and shows the place with ~', async () => {
    const { call, store, chooseTarget } = setup()
    const result = await call(HOME_BACKUP_EXPORT_CHANNEL, {
      includeSessions: true,
      passphrase: 'twelve chars ok',
      confirmation: 'twelve chars ok',
      path: '/etc/evil',
    })
    expect(chooseTarget).toHaveBeenCalledWith(
      'Emperor 备份 2026-10-20.emperor-backup.zip',
    )
    expect(store.export).toHaveBeenCalledWith(
      {
        includeSessions: true,
        passphrase: 'twelve chars ok',
        confirmation: 'twelve chars ok',
      },
      '/Users/me/Desktop/x.emperor-backup.zip',
    )
    expect(result).toEqual({
      ok: true,
      name: 'x.emperor-backup.zip',
      location: '~/Desktop',
      credentials: false,
    })
  })

  it('reports a cancelled dialog and a vault failure without throwing', async () => {
    const { call, chooseTarget } = setup({
      export: vi.fn(async () => {
        throw new CredentialVaultError('vault-locked', 'the vault is locked')
      }),
    })
    chooseTarget.mockResolvedValueOnce(null)
    expect(
      await call(HOME_BACKUP_EXPORT_CHANNEL, { includeSessions: false }),
    ).toEqual({ ok: false, canceled: true })
    expect(
      await call(HOME_BACKUP_EXPORT_CHANNEL, { includeSessions: false }),
    ).toEqual({
      ok: false,
      error: '[credential-vault:vault-locked] the vault is locked',
    })
    expect(
      await call(HOME_BACKUP_EXPORT_CHANNEL, { includeSessions: 'yes' }),
    ).toMatchObject({
      ok: false,
    })
  })

  it('opens a backup the open dialog picked, by id from then on', async () => {
    const { call, store, chooseBackup } = setup()
    expect(await call(HOME_BACKUP_OPEN_CHANNEL)).toMatchObject({
      ok: true,
      backup: { id: 'r_0123456789ab' },
    })
    expect(store.open).toHaveBeenCalledWith(
      '/Users/me/Desktop/x.emperor-backup.zip',
    )
    chooseBackup.mockResolvedValueOnce(null)
    expect(await call(HOME_BACKUP_OPEN_CHANNEL)).toEqual({
      ok: false,
      canceled: true,
    })
    expect(
      await call(HOME_BACKUP_DISCARD_CHANNEL, { id: 'r_0123456789ab' }),
    ).toEqual({ ok: true })
    expect(store.discard).toHaveBeenCalledWith('r_0123456789ab')
    expect(
      await call(HOME_BACKUP_DISCARD_CHANNEL, { id: '../x' }),
    ).toMatchObject({ ok: false })
  })

  it('restarts only after a restore was scheduled', async () => {
    vi.useFakeTimers()
    try {
      const failing = setup({
        restore: vi.fn(async () => {
          throw new CredentialVaultError(
            'backup-passphrase-wrong',
            'wrong passphrase',
          )
        }),
      })
      expect(
        await failing.call(HOME_BACKUP_RESTORE_CHANNEL, {
          id: 'r_0123456789ab',
          passphrase: 'nope nope nope',
        }),
      ).toEqual({
        ok: false,
        error: '[credential-vault:backup-passphrase-wrong] wrong passphrase',
      })
      vi.runAllTimers()
      expect(failing.relaunch).not.toHaveBeenCalled()

      const { call, store, relaunch } = setup()
      expect(
        await call(HOME_BACKUP_RESTORE_CHANNEL, { id: 'r_0123456789ab' }),
      ).toEqual({ ok: true })
      expect(store.restore).toHaveBeenCalledWith('r_0123456789ab', undefined)
      expect(relaunch).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(relaunch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reveals only a backup this window exported', async () => {
    const { call, reveal } = setup()
    expect(await call(HOME_BACKUP_REVEAL_CHANNEL)).toMatchObject({ ok: false })
    await call(HOME_BACKUP_EXPORT_CHANNEL, { includeSessions: true })
    expect(await call(HOME_BACKUP_REVEAL_CHANNEL)).toEqual({ ok: true })
    expect(reveal).toHaveBeenCalledWith(
      '/Users/me/Desktop/x.emperor-backup.zip',
    )
  })
})
