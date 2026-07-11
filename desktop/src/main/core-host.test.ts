import { describe, expect, it } from 'vitest'
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
        'skills.previewInstall',
        'skills.confirmInstall',
      ]),
    )
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
}
