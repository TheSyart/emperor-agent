import { describe, expect, it } from 'vitest'
import { draftHandoff, handDraftTo, takeDraftHandoff } from './draftHandoff'

describe('draft handoff', () => {
  it('gives the draft to its own session once', () => {
    handDraftTo('s1', 'Greet the team')
    expect(draftHandoff.value).toEqual({
      sessionId: 's1',
      text: 'Greet the team',
    })
    expect(takeDraftHandoff('s2')).toBeNull()
    expect(takeDraftHandoff('s1')).toBe('Greet the team')
    expect(takeDraftHandoff('s1')).toBeNull()
    handDraftTo('s1', '')
    expect(draftHandoff.value).toBeNull()
  })
})
