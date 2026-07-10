import { describe, expect, it } from 'vitest'
import { createExpansionStore, messageScrollSignature, shouldFollowBottom, shouldVirtualize } from './messageListModel'
import type { AssistantMessage, ChatMessage } from '../../types'

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
    const messages: AssistantMessage[] = [
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

describe('shouldVirtualize (Wave6)', () => {
  it('keeps plain rendering under the threshold and virtualizes above it', () => {
    expect(shouldVirtualize(0)).toBe(false)
    expect(shouldVirtualize(119)).toBe(false)
    expect(shouldVirtualize(120)).toBe(true)
    expect(shouldVirtualize(1000)).toBe(true)
  })
})

describe('createExpansionStore (Wave6)', () => {
  it('remembers open state across virtual unmount/remount and bumps a version for re-measure', () => {
    const store = createExpansionStore()
    expect(store.isOpen('block-1', true)).toBe(true)
    expect(store.isOpen('block-2', false)).toBe(false)

    const v0 = store.version.value
    store.setOpen('block-2', true)
    expect(store.isOpen('block-2', false)).toBe(true)
    expect(store.version.value).toBeGreaterThan(v0)

    store.setOpen('block-1', false)
    expect(store.isOpen('block-1', true)).toBe(false)
  })
})
