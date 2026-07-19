import { describe, expect, it, vi } from 'vitest'
import { CoreUnavailableError } from '@emperor/core'
import { channelForCoreOperation } from '../shared/ipc-contract'
import { coreOperationKeys, registerCoreHostIpc } from './core-host'
import type { CoreApiLike } from './ipc'

describe('desktop CoreApi host (MIG-IPC-002)', () => {
  it('registers every CoreApi operation on the Electron IPC boundary', () => {
    const ipc = new FakeIpcMain()
    registerCoreHostIpc(ipc, {
      bootstrap: async () => ({ app: 'Emperor Agent' }),
    } as unknown as CoreApiLike)

    expect(coreOperationKeys()).toContain('bootstrap')
    expect(coreOperationKeys()).toContain('control.answerInteraction')
    expect(coreOperationKeys()).toEqual(
      expect.arrayContaining([
        'goals.start',
        'goals.list',
        'goals.get',
        'goals.pause',
        'goals.resume',
        'goals.cancel',
      ]),
    )
    expect(ipc.channels()).toContain(channelForCoreOperation('bootstrap'))
    expect(ipc.channels()).toContain(
      channelForCoreOperation('control.answerInteraction'),
    )
    expect(ipc.channels()).toHaveLength(coreOperationKeys().length)
    expect(coreOperationKeys()).toEqual(
      expect.arrayContaining([
        'hooks.getConfig',
        'hooks.saveConfig',
        'hooks.getAudit',
        'hooks.testRun',
        'hooks.getMetadata',
        'hooks.validateConfig',
        'hooks.setProjectTrust',
        'hooks.testMatch',
        'hooks.cancelRun',
        'environment.getStatus',
        'environment.createInstallPlan',
        'environment.install',
        'environment.cancelInstall',
        'environment.getInstallLog',
        'fileCheckpoints.list',
        'fileCheckpoints.preview',
        'fileCheckpoints.rewind',
        'fileCheckpoints.rewindGit',
        'skills.previewInstall',
        'skills.confirmInstall',
      ]),
    )
  })

  it('returns the standard safe error envelope for Goal operation failures', async () => {
    const ipc = new FakeIpcMain()
    registerCoreHostIpc(ipc, {
      goals: {
        get: async () => {
          throw {
            toSafe: () => ({
              code: 'goal_not_found',
              message: 'Goal does not exist.',
            }),
          }
        },
      },
    } as unknown as CoreApiLike)

    await expect(
      ipc.invoke(channelForCoreOperation('goals.get'), 'goal_missing'),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'goal_not_found', message: 'Goal does not exist.' },
    })
  })

  it('returns typed unavailable before lifecycle ready without invoking CoreApi', async () => {
    const ipc = new FakeIpcMain()
    const bootstrap = vi.fn()
    registerCoreHostIpc(ipc, {
      loop: {
        lifecycleSupervisor: {
          assertReady: () => {
            throw new CoreUnavailableError('starting')
          },
        },
      },
      bootstrap,
    } as unknown as CoreApiLike)

    await expect(
      ipc.invoke(channelForCoreOperation('bootstrap')),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'core_unavailable',
        message: 'Core runtime is not ready (starting).',
        action: 'retry',
      },
    })
    expect(bootstrap).not.toHaveBeenCalled()
  })
})

type Handler = (_event: unknown, ...args: unknown[]) => unknown

class FakeIpcMain {
  private readonly handlers = new Map<string, Handler>()

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler)
  }

  channels(): string[] {
    return [...this.handlers.keys()].sort()
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return await handler({}, ...args)
  }
}
