import { describe, expect, it } from 'vitest'
import type { RuntimeEventEnvelope } from '../types'
import {
  createExpansionStore,
  messageScrollSignature,
  shouldVirtualize,
} from '../components/chat/messageListModel'
import { projectChatEvents } from './chatProjection'

describe('renderer long-session pressure contract', () => {
  it('projects and expands more than 1,000 streamed messages within the desktop budget', () => {
    const startedAt = performance.now()
    const events: RuntimeEventEnvelope[] = []
    let seq = 0
    for (let index = 0; index < 1_001; index += 1) {
      const turnId = `turn-${index}`
      events.push(
        {
          event: 'user_message',
          seq: ++seq,
          session_id: 's1',
          turn_id: turnId,
          client_message_id: `user-${index}`,
          content: `request ${index}`,
        },
        {
          event: 'message_delta',
          seq: ++seq,
          session_id: 's1',
          turn_id: turnId,
          delta: `response ${index}`,
        },
        {
          event: 'assistant_done',
          seq: ++seq,
          session_id: 's1',
          turn_id: turnId,
          content: `response ${index}`,
        },
      )
    }

    const projection = projectChatEvents(events, { sessionId: 's1' })
    const expansion = createExpansionStore()
    for (const message of projection.messages) {
      const key = `message:${message.id}`
      expansion.setOpen(key, true)
      expect(expansion.isOpen(key, false)).toBe(true)
    }
    const durationMs = performance.now() - startedAt

    expect(projection.messages).toHaveLength(2_002)
    expect(shouldVirtualize(projection.messages.length)).toBe(true)
    expect(messageScrollSignature(projection.messages)).toContain('2002')
    expect(expansion.version.value).toBe(2_002)
    expect(durationMs).toBeLessThan(2_000)
  })
})
