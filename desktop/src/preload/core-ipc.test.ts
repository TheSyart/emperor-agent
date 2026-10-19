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

    await bridge.invokeCore('delegations.get', { id: 'dlg-one' })
    await bridge.invokeCore('executors.list')
    calls.length = 0
    await expect(
      bridge.invokeCore('sessions.create', { title: 'A' }),
    ).resolves.toEqual({ ok: true })
    // Every call carries the session the window shows (KRN-01).
    expect(calls).toEqual([
      {
        channel: 'emperor:core:sessions:create',
        args: [
          { emperorCoreCall: 1, view: { sessionId: null } },
          { title: 'A' },
        ],
      },
    ])
    calls.length = 0
    bridge.setViewingSession('s1')
    await bridge.invokeCore('plugins.list')
    bridge.setViewingSession(null)
    await bridge.invokeCore('plugins.list')
    expect(calls.map((call) => call.args)).toEqual([
      [{ emperorCoreCall: 1, view: { sessionId: 's1' } }],
      [{ emperorCoreCall: 1, view: { sessionId: null } }],
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

  void typedBridge.invokeCore('delegations.send', {
    id: 'dlg-one',
    messageId: 'dgm-one',
    text: 'continue',
    delivery: 'queue',
  })
  void typedBridge.invokeCore('delegations.interrupt', {
    id: 'dlg-one',
    runId: 'dgr-one',
  })
  void typedBridge.invokeCore('executors.probe', {
    profileId: 'codex-default',
    // @ts-expect-error executor startup environment is not exposed
    env: { KEY: 'secret' },
  })
  void typedBridge.invokeCore('environment.getStatus', { forceRefresh: true })
  void typedBridge.invokeCore('environment.createInstallPlan', {
    toolIds: ['git', 'node'],
  })

  void typedBridge.invokeCore('environment.install', {
    planId: 'plan_1',
    acceptedLicenseIds: [],
    confirmedStepIds: [],
    // @ts-expect-error renderer cannot submit executable commands
    command: 'curl evil',
  })
}
