import { describe, expect, it } from 'vitest'
import { createCoreBridge, type CoreBridge } from './core-ipc'

describe('preload core IPC bridge (MIG-IPC-002)', () => {
  it('invokes namespaced CoreApi channels by operation key', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const bridge = createCoreBridge({
      invoke: async (channel, ...args) => {
        calls.push({ channel, args })
        return { ok: true }
      },
    })

    await expect(
      bridge.invokeCore('sessions.create', { title: 'A' }),
    ).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      { channel: 'emperor:core:sessions:create', args: [{ title: 'A' }] },
    ])
  })
})

declare const typedBridge: CoreBridge

function _assertCoreBridgeTypes(): void {
  void typedBridge.invokeCore('sessions.rename', 's1', { title: 'Typed' })

  // @ts-expect-error operation keys are closed
  void typedBridge.invokeCore('missing.operation')

  // @ts-expect-error sessions.rename requires its patch argument
  void typedBridge.invokeCore('sessions.rename', 's1')

  // @ts-expect-error desktopPet.setEnabled requires a boolean
  void typedBridge.invokeCore('desktopPet.setEnabled', 'true')
}
