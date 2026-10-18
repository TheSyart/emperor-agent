// SEC-11 (PLAN-V020, finding CORE-40): an approval answer counts as allowed
// only when it carries the allow option id. 「不允许」 matched /允许/ before.
import { describe, expect, it } from 'vitest'
import type { Agent } from '../agent/agent'
import { PendingInteractions } from './interactions'

async function answerWith(answer: unknown) {
  const pending = new PendingInteractions()
  const outcome = pending.approvalAnswerer({
    id: 'a1',
    agent: { id: 's1' } as unknown as Agent,
    toolName: 'bash',
  } as Parameters<PendingInteractions['approvalAnswerer']>[0])
  pending.answer('approval_a1', { permission: answer } as never)
  return outcome
}

describe('approval answers', () => {
  it('rejects a free-text 不允许 without an option id', async () => {
    await expect(answerWith({ choice: '不允许' })).resolves.toBe('rejected')
  })

  it('rejects a free-text allow without an option id', async () => {
    await expect(answerWith({ choice: 'allow' })).resolves.toBe('rejected')
  })

  it('allows only the allow option id', async () => {
    await expect(
      answerWith({ option_id: 'allow_once', choice: '本次允许' }),
    ).resolves.toBe('allowed-once')
    await expect(
      answerWith({ option_id: 'deny', choice: '拒绝' }),
    ).resolves.toBe('rejected')
  })
})
