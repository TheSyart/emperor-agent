import { expect, it, vi } from 'vitest'
import { sendDelegationMessage } from './delegations'
const { invokeCore } = vi.hoisted(() => ({ invokeCore: vi.fn() }))
vi.mock('./backend', () => ({ invokeCore }))
it('sends one message with exact conversation/run identities through the controlled bridge', async () => {
  invokeCore.mockResolvedValue({
    messageId: 'dgm-one',
    state: 'accepted',
    runId: 'dgr-one',
  })
  const input = {
    id: 'dlg-one',
    messageId: 'dgm-one',
    text: 'continue',
    delivery: 'steer' as const,
    expectedRunId: 'dgr-one',
  }
  expect(await sendDelegationMessage(input)).toMatchObject({
    state: 'accepted',
  })
  expect(invokeCore).toHaveBeenCalledTimes(1)
  expect(invokeCore).toHaveBeenCalledWith('delegations.send', input)
})
