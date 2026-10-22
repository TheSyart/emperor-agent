// Image offload is a logged decision (DSH-13): the oldest images over a
// route's request budget are replaced by a placeholder, an `image/offload`
// event records it, and the placeholder stays across a model switch, a
// fallback and a reopened log.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OFFLOADED_IMAGE_TEXT } from '../../llm/content'
import { createUserMessage } from '../../llm/message'
import type { ContentBlock, Message } from '../../llm/types'
import { SessionLogStore } from '../../session-log/store'
import { createTestHarness, testRoute } from '../testing'

function withImage(
  text: string,
  id: string,
): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text', text },
      {
        type: 'image',
        attachment: {
          attachmentId: id,
          mediaType: 'image/png',
          bytes: 600,
          width: 64,
          height: 64,
        },
      },
    ],
    source: { kind: 'user' },
  })
}

function blocksOf(messages: readonly Message[], text: string): ContentBlock[] {
  return messages.find((message) =>
    message.content.some(
      (block) => block.type === 'text' && block.text === text,
    ),
  )!.content
}

describe('image offload', () => {
  it('keeps an offloaded image offloaded after a model switch and a reopen (KRN-05 #9)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-image-offload-'))
    const h = createTestHarness({ root })
    // `narrow` holds one 600-byte image (800 base64 bytes) per request; `wide` holds many.
    h.llm.setRoutes(
      [
        testRoute({ id: 'narrow', vision: true, maxRequestImageBytes: 1_000 }),
        testRoute({ id: 'wide', modelId: 'wide-model', vision: true }),
      ],
      'narrow',
    )
    const agent = h.agent('offload-session')
    h.adapter.push({ text: 'one' }, { text: 'two' }, { text: 'three' })
    agent.followup(withImage('first', 'att_2026-10_00000001'))
    await agent.whenIdle()
    agent.followup(withImage('second', 'att_2026-10_00000002'))
    await agent.whenIdle()

    const offloads = agent.session.events.filter(
      (event) => event.type === 'image/offload',
    )
    expect(offloads).toHaveLength(1)
    const first = agent.session.events.find(
      (event) =>
        event.type === 'user/message' &&
        event.data.content.some(
          (block) => block.type === 'text' && block.text === 'first',
        ),
    )!
    expect(offloads[0]!.data).toEqual({
      seq: first.seq,
      reason: 'request-bytes',
    })
    const second = h.adapter.requests[1]!.messages
    expect(blocksOf(second, 'first')[1]).toEqual({
      type: 'text',
      text: OFFLOADED_IMAGE_TEXT,
    })
    expect(blocksOf(second, 'second')[1]).toMatchObject({ type: 'image' })

    // The wide route could carry both images; the log keeps the first offloaded.
    h.llm.setRoutes(h.llm.listRoutes(), 'wide')
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'third' }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
    const third = h.adapter.requests[2]!
    expect(third.provider).toBe('wide')
    expect(blocksOf(third.messages, 'first')[1]).toEqual({
      type: 'text',
      text: OFFLOADED_IMAGE_TEXT,
    })
    expect(blocksOf(third.messages, 'second')[1]).toMatchObject({
      type: 'image',
    })
    expect(
      agent.session.events.filter((event) => event.type === 'image/offload'),
    ).toHaveLength(1)

    // Replaying the log from disk derives the same request messages.
    h.sessions.flush('offload-session', { sync: true })
    const reopened = new SessionLogStore({ root, persist: true }).tryOpen(
      'offload-session',
    )!
    expect(JSON.stringify(reopened.deriveMessages())).toBe(
      JSON.stringify(agent.session.deriveMessages()),
    )
    expect(blocksOf(reopened.deriveMessages(), 'first')[1]).toEqual({
      type: 'text',
      text: OFFLOADED_IMAGE_TEXT,
    })
  })

  it('never logs the newest image as offloaded, even when it alone is over budget', async () => {
    const h = createTestHarness()
    h.llm.setRoutes(
      [testRoute({ vision: true, maxRequestImageBytes: 500 })],
      'test-route',
    )
    const agent = h.agent()
    h.adapter.push({ text: 'ok' })
    agent.followup(withImage('only', 'att_2026-10_00000003'))
    await agent.whenIdle()
    expect(
      agent.session.events.some((event) => event.type === 'image/offload'),
    ).toBe(false)
    expect(blocksOf(h.adapter.requests[0]!.messages, 'only')[1]).toMatchObject({
      type: 'image',
    })
  })
})
