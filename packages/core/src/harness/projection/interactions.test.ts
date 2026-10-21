import { describe, expect, it } from 'vitest'
import { questionInteraction } from './interactions'

describe('question interactions', () => {
  const asked = {
    id: 'q1',
    questions: [{ id: 'a', header: 'codex', question: '用哪个分支？' }],
  }

  it('7 · an external subagent’s question names its task, so its own page can answer it (AGT-10)', () => {
    const interaction = questionInteraction(
      {
        ...asked,
        external: {
          delegationId: 'dlg-1',
          runId: 'dgr-1',
          generation: 1,
          requestId: 'req-1',
          backend: 'codex',
        },
      } as never,
      1000,
    )
    expect(interaction.meta).toMatchObject({
      interaction_type: 'question',
      question_id: 'q1',
      external_delegation_id: 'dlg-1',
      external_run_id: 'dgr-1',
    })
  })

  it('a question of the agent itself carries no task', () => {
    const interaction = questionInteraction(asked as never, 1000)
    expect(interaction.meta).toEqual({
      interaction_type: 'question',
      question_id: 'q1',
    })
  })
})
