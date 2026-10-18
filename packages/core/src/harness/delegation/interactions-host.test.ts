import { expect, it } from 'vitest'
import { makeApi } from '../../api/test-helpers'
import { fixtureDelegationRecord } from './testing'
it('answers both external backends through CoreApi control on an idle parent and cancels on close', async () => {
  const { api, events } = await makeApi()
  try {
    const root = String(
        api.sessions.create({ title: 'external questions' }).id,
      ),
      owner = {
        ...fixtureDelegationRecord().owner,
        rootSessionId: root,
        parentAgentId: root,
      }
    const question = {
      owner,
      delegationId: 'dlg-a',
      runId: 'dgr-a',
      generation: 1,
      requestId: 'req',
      backend: 'claude-code',
      questions: [{ id: 'color', title: 'Which?', options: ['blue', 'red'] }],
    }
    const a = api.host.delegationInteractions.ask(
      question,
      new AbortController().signal,
    )
    const b = api.host.delegationInteractions.ask(
      { ...question, delegationId: 'dlg-b', runId: 'dgr-b', backend: 'codex' },
      new AbortController().signal,
    )
    const cards = api.host.pending.forSession(root)
    expect(cards).toHaveLength(2)
    expect(events.filter((e) => e.event === 'ask_request')).toHaveLength(2)
    await api.control.answerInteraction(cards[0]!, {
      color: { choice: 'blue' },
    })
    expect(await a).toMatchObject({ answers: { color: 'blue' } })
    await api.control.answerInteraction(cards[1]!, {
      color: { freeform: 'green' },
    })
    expect(await b).toMatchObject({ answers: { color: 'green' } })
    const pending = api.host.delegationInteractions.ask(
      { ...question, generation: 2 },
      new AbortController().signal,
    )
    const stale = api.host.pending.forSession(root)[0]!
    api.host.stop(root)
    expect(await pending).toEqual({ outcome: 'cancelled' })
    await expect(
      api.control.answerInteraction(stale, { color: 'blue' }),
    ).rejects.toThrow('not pending')
    const closing = api.host.delegationInteractions.ask(
      { ...question, generation: 3 },
      new AbortController().signal,
    )
    await api.close()
    expect(await closing).toEqual({ outcome: 'cancelled' })
  } finally {
    await api.close()
  }
})
