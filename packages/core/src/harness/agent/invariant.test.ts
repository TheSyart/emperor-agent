import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../../llm/types'
import { userText } from '../../llm/message'
import { createTestHarness, replyChunks } from '../testing'
import { assertRequestInvariant, RequestInvariantError } from './invariant'

describe('request-reconstruction invariant', () => {
  it('accepts the loop request and rejects a tampered copy at dispatch time', async () => {
    const checks: Array<() => void> = []
    const harness = createTestHarness({
      replies: [
        (request) => {
          const lookup = (id: string) => harness.sessions.get(id)
          checks.push(() => {
            expect(() => assertRequestInvariant(request, lookup)).not.toThrow()
            const tampered: GenerateOptions = {
              ...request,
              messages: [...request.messages, userText('never logged')],
            }
            expect(() => assertRequestInvariant(tampered, lookup)).toThrow(
              RequestInvariantError,
            )
            expect(() =>
              assertRequestInvariant({ ...request, system: 'other' }, lookup),
            ).toThrow('folded request header')
            expect(() =>
              assertRequestInvariant({ ...request, sessionId: 'gone' }, lookup),
            ).toThrow('live session id')
          })
          for (const check of checks) check()
          return replyChunks({ text: 'ok' })
        },
      ],
    })
    const agent = harness.agent()
    agent.followup(userText('hi'))
    await agent.whenIdle()
    expect(checks).toHaveLength(1)
  })

  it('ignores auxiliary calls that carry a purpose', () => {
    expect(() =>
      assertRequestInvariant(
        {
          provider: 'p',
          model: 'm',
          messages: [],
          sessionId: 'x',
          purpose: 'session-title',
        },
        () => undefined,
      ),
    ).not.toThrow()
  })
})
