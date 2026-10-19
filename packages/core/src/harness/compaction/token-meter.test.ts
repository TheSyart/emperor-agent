// Token meter (KRN-05): per-session calibration against provider usage
// (DSH-25) and route-priced images (DSH-13).
import { describe, expect, it } from 'vitest'
import { createUserMessage, userText } from '../../llm/message'
import type { GenerateOptions, ImageAttachmentRef } from '../../llm/types'
import { createTestHarness, replyChunks } from '../testing'
import { TokenMeter } from './token-meter'

const PASSAGE =
  '上下文接近上限时，代理会先截短较早的工具结果，再把较早的对话压缩成一份摘要，保留最近的内容。'

function chinese(length: number): string {
  let text = ''
  while (text.length < length) text += PASSAGE
  return text.slice(0, length)
}

/** A provider tokenizer unlike the heuristic: CJK ≈ 0.6 token, the rest 1/3. */
function providerCount(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[一-鿿]/u.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk * 0.6 + other / 3)
}

function requestText(request: {
  system?: string
  tools?: unknown
  messages: GenerateOptions['messages']
}): string {
  return [
    request.system ?? '',
    request.tools === undefined ? '' : JSON.stringify(request.tools),
    ...request.messages.flatMap((message) =>
      message.content.map((block) => (block.type === 'text' ? block.text : '')),
    ),
  ].join('')
}

/** Replies `text` and reports what the provider tokenizer counted. */
function providerReply(text: string) {
  return (request: GenerateOptions) =>
    replyChunks({
      text,
      usage: {
        inputTokens: providerCount(requestText(request)),
        outputTokens: providerCount(text),
      },
    })
}

describe('TokenMeter calibration', () => {
  it('lands within 10% of the provider count once calibrated (KRN-05 #6)', async () => {
    const h = createTestHarness()
    const agent = h.agent()
    for (let round = 0; round < 3; round += 1) {
      h.adapter.push(providerReply(chinese(600)))
      agent.followup(userText(chinese(600)))
      await agent.whenIdle()
    }
    const meter = new TokenMeter()
    const header = agent.session.requestHeader()!
    // A changed header has no usage anchor: the whole request is estimated.
    const changed = {
      ...header,
      system: `${header.system ?? ''}\n${chinese(300)}`,
    }
    const measurement = meter.measure(agent.session, changed)
    expect(measurement.baseline.kind).toBe('estimated')
    const truth = providerCount(
      requestText({
        system: changed.system,
        tools: changed.tools,
        messages: agent.session.deriveMessages(),
      }),
    )
    expect(measurement.calibration).toBeGreaterThan(0.5)
    expect(measurement.calibration).toBeLessThan(0.7)
    expect(Math.abs(measurement.totalTokens - truth) / truth).toBeLessThan(0.1)
  })

  it('ignores usage that cannot belong to the request', async () => {
    const h = createTestHarness({
      replies: [
        { text: chinese(800), usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    })
    const agent = h.agent()
    agent.followup(userText(chinese(800)))
    await agent.whenIdle()
    const measurement = new TokenMeter().measure(agent.session)
    expect(measurement.calibration).toBe(1)
    expect(measurement.baseline.kind).toBe('estimated')
    // Two 800-character Chinese messages at ~1 token per character.
    expect(measurement.totalTokens).toBeGreaterThan(1500)
  })
})

describe('TokenMeter images', () => {
  it('prices an image by the route instead of its JSON length (DSH-13)', async () => {
    const h = createTestHarness({ replies: [{ text: 'seen' }] })
    const agent = h.agent()
    const attachment: ImageAttachmentRef = {
      attachmentId: 'att_2026-10_0000000a',
      mediaType: 'image/png',
      bytes: 200_000,
      width: 1024,
      height: 1024,
    }
    agent.followup(
      createUserMessage({
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', attachment },
        ],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
    const nodeOf = (meter: TokenMeter) =>
      meter
        .measure(agent.session)
        .nodes.find(
          (node) => agent.session.events[node.seq]?.type === 'user/message',
        )!.tokens
    const deepseek = nodeOf(new TokenMeter({ imagePricing: () => 'deepseek' }))
    const anthropic = nodeOf(
      new TokenMeter({ imagePricing: () => 'anthropic' }),
    )
    expect(deepseek).toBeGreaterThanOrEqual(1024)
    expect(deepseek).toBeLessThan(1100)
    expect(anthropic).toBeGreaterThanOrEqual(1334)
  })
})
