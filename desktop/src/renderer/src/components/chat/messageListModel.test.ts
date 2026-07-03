import { describe, expect, it } from 'vitest'
import { messageScrollSignature, shouldFollowBottom } from './messageListModel'
import type { ChatMessage } from '../../types'

describe('messageScrollSignature', () => {
  it('tracks only the last visible message changes needed for bottom pinning', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'old' },
      { id: 'a1', role: 'assistant', content: 'hello', streaming: true, segments: [] },
    ]

    const first = messageScrollSignature(messages)
    messages[0]!.content = 'old but edited elsewhere'
    expect(messageScrollSignature(messages)).toBe(first)

    messages[1]!.content = 'hello world'
    expect(messageScrollSignature(messages)).not.toBe(first)
  })

  it('tracks assistant segment count without deep-watching every segment field', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: '', streaming: true, segments: [] },
    ]
    const before = messageScrollSignature(messages)
    messages[0]!.segments.push({ type: 'thought', id: 't1', label: 'x', status: 'done', startedAt: 1, endedAt: 2 })
    expect(messageScrollSignature(messages)).not.toBe(before)
  })
})

describe('shouldFollowBottom (Wave4.1)', () => {
  it('keeps following while within the threshold of the bottom', () => {
    expect(shouldFollowBottom({ scrollTop: 920, scrollHeight: 1500, clientHeight: 500 })).toBe(true)
    expect(shouldFollowBottom({ scrollTop: 1000, scrollHeight: 1500, clientHeight: 500 })).toBe(true)
  })

  it('unlocks when the user scrolls up past the threshold', () => {
    expect(shouldFollowBottom({ scrollTop: 300, scrollHeight: 1500, clientHeight: 500 })).toBe(false)
  })
})
