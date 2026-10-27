import { describe, expect, it } from 'vitest'
import {
  draftHandoff,
  handDraftTo,
  takeDraftHandoff,
  takeHandoff,
} from './draftHandoff'

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

describe('a message handed over to be sent (GRP-05)', () => {
  it('is marked to send, and taken once with that mark', () => {
    handDraftTo('chat-1', '@审稿人 看看', { send: true })
    expect(draftHandoff.value).toEqual({
      sessionId: 'chat-1',
      text: '@审稿人 看看',
      send: true,
    })
    expect(takeHandoff('chat-2')).toBeNull()
    expect(takeHandoff('chat-1')).toEqual({ text: '@审稿人 看看', send: true })
    expect(takeHandoff('chat-1')).toBeNull()
    handDraftTo('chat-1', 'only fill it')
    expect(takeHandoff('chat-1')).toEqual({ text: 'only fill it', send: false })
  })
})
