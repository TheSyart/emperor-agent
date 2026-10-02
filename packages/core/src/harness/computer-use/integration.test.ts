// Computer Use through the real stack: CoreApi → HarnessHost → ToolRegistry
// (hooks, gate, guards) → GUI tools → kernel, with a scripted model and the
// fake host port. Covers continuous AI control (no card for ordinary
// actions), the per-action card for a high-impact click, plan mode, and the
// removed up-front control tools.
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../../llm/types'
import {
  eventOf,
  makeApi,
  pendingInteractionId,
  waitFor,
  type ApiFixture,
} from '../../api/test-helpers'
import { replyChunks, type ScriptedReply } from '../testing'
import { FakeComputerUsePort } from './testing/fake-port'

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function setup(replies: ScriptedReply[]) {
  const fixture = await makeApi({
    replies,
    extra: {
      computerUsePort: new FakeComputerUsePort(),
      computerUseSettings: () => ({ enabled: true }),
    },
  })
  fixtures.push(fixture)
  const id = String(fixture.api.sessions.create({ title: 'GUI' }).id)
  return { ...fixture, id }
}

/** Text of the last tool result the model saw. */
function lastResultText(request: GenerateOptions): string {
  const message = request.messages.at(-1)
  const blocks = (message?.content ?? []) as Array<{
    type: string
    content?: Array<{ type: string; text?: string }>
    text?: string
  }>
  const result = blocks.find((block) => block.type === 'tool-result')
  return (
    result?.content?.find((block) => block.type === 'text')?.text ??
    blocks.find((block) => block.type === 'text')?.text ??
    ''
  )
}

/** The last tool result the model saw, parsed from its first text block. */
function lastToolResult(request: GenerateOptions): Record<string, unknown> {
  const text = lastResultText(request)
  return JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>
}

/** Every text block of the last tool result the model saw. */
function lastResultTexts(request: GenerateOptions): string {
  const message = request.messages.at(-1)
  const blocks = (message?.content ?? []) as Array<{
    type: string
    content?: Array<{ type: string; text?: string }>
  }>
  const result = blocks.find((block) => block.type === 'tool-result')
  return (result?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

/** The ref of a named element in the last observation. */
function refIn(request: GenerateOptions, name: string): string {
  const envelope = lastResultTexts(request)
  const decoded = envelope.includes('content_begin')
    ? (JSON.parse(
        envelope.split('content_begin\n')[1]!.split('\ncontent_end')[0]!,
      ) as string)
    : envelope
  const line = decoded.split('\n').find((row) => row.includes(`"${name}"`))
  if (line === undefined) throw new Error(`no element "${name}"`)
  return line.split(' ')[0]!
}

const openCheckout: ScriptedReply = {
  tools: [
    { name: 'browser_open', args: { url: 'https://fixture.test/checkout' } },
  ],
}
const observe: ScriptedReply = { tools: [{ name: 'browser_observe' }] }
const clickPay: ScriptedReply = (request) =>
  replyChunks({
    tools: [
      { name: 'browser_click', args: { ref: refIn(request, 'Pay now') } },
    ],
  })

describe('computer use end to end (scripted model, fake port)', () => {
  it('runs ordinary actions without asking while computer use is on', async () => {
    let seen: Record<string, unknown> | undefined
    const { api, events, id } = await setup([
      openCheckout,
      (request) => {
        seen = lastToolResult(request)
        return replyChunks({ text: 'opened' })
      },
    ])
    await api.chat.submit({ content: 'go', sessionId: id })
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(seen).toMatchObject({ status: 'ok', tool: 'browser_open' })
    const log = api.host.sessionLog(id)!.events.map((event) => event.type)
    expect(log).toContain('ui/auto-approved')
  })

  it('asks for a high-impact action one action at a time', async () => {
    let seen: Record<string, unknown> | undefined
    const { api, events, id } = await setup([
      openCheckout,
      observe,
      clickPay,
      (request) => {
        seen = lastToolResult(request)
        return replyChunks({ text: 'paid' })
      },
    ])
    const submitted = api.chat.submit({ content: 'pay', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const interactionId = pendingInteractionId(events, 'ask_request')
    expect(interactionId).toMatch(/^grant_/)
    const pending = api.control.get(id).pending as {
      meta: { interaction_type: string; grant: { high_impact?: boolean } }
      questions: Array<{ options: Array<{ id: string }> }>
    }
    expect(pending.meta).toMatchObject({
      interaction_type: 'computer_use_grant',
      grant: { high_impact: true },
    })
    // Only this one action can be allowed; no task / session / timed scope.
    expect(pending.questions[0]!.options.map((option) => option.id)).toEqual([
      'once',
      'deny',
    ])
    await api.control.answerInteraction(interactionId, {
      grant: { option_id: 'once' },
    })
    expect((await submitted).content).toBe('paid')
    expect(seen).toMatchObject({ status: 'ok', tool: 'browser_click' })
    const log = api.host.sessionLog(id)!.events.map((event) => event.type)
    expect(log).toContain('ui/grant-requested')
    expect(log).toContain('ui/grant-decided')
  })

  it('refuses GUI requests while plan mode is on', async () => {
    let seen: Record<string, unknown> | undefined
    const { api, events, id } = await setup([
      openCheckout,
      (request) => {
        const message = JSON.stringify(request.messages.at(-1)?.content)
        seen = { denied: message.includes('PLAN_MODE_ACTION_DENIED') }
        return replyChunks({ text: 'planning' })
      },
    ])
    api.control.setMode('plan', id)
    await api.chat.submit({ content: 'go', sessionId: id })
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(seen).toEqual({ denied: true })
  })

  it('tells the model the up-front control tools were removed', async () => {
    let seen: string | undefined
    const { api, events, id } = await setup([
      {
        tools: [
          {
            name: 'ui_request_control',
            args: { origins: ['https://example.com'], actions: ['observe'] },
          },
        ],
      },
      (request) => {
        seen = lastResultText(request)
        return replyChunks({ text: 'noted' })
      },
    ])
    await api.chat.submit({ content: 'go', sessionId: id })
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(seen).toContain('tool "ui_request_control" was removed')
    expect(api.host.tools.names()).not.toContain('ui_request_control')
    expect(api.host.tools.names()).not.toContain('ui_delegate_grant')
  })
})
