// Computer Use through the real stack: CoreApi → HarnessHost → ToolRegistry
// (hooks, gate, guards) → ui_* tools → kernel, with a scripted model and the
// fake host port. Covers the grant card round trip, D1 auto-approval, plan
// mode, the emergency stop while a card is pending, and fail-closed stop.
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

async function setup(
  replies: ScriptedReply[],
  mode: 'unrestricted' | 'scoped' = 'unrestricted',
) {
  const fixture = await makeApi({
    replies,
    extra: {
      computerUsePort: new FakeComputerUsePort(),
      computerUseSettings: () => ({ enabled: true, authorizationMode: mode }),
    },
  })
  fixtures.push(fixture)
  const id = String(fixture.api.sessions.create({ title: 'GUI' }).id)
  return { ...fixture, id }
}

/** The last tool result the model saw, parsed from its first text block. */
function lastToolResult(request: GenerateOptions): Record<string, unknown> {
  const message = request.messages.at(-1)
  const blocks = (message?.content ?? []) as Array<{
    type: string
    content?: Array<{ type: string; text?: string }>
    text?: string
  }>
  const result = blocks.find((block) => block.type === 'tool-result')
  const text =
    result?.content?.find((block) => block.type === 'text')?.text ??
    blocks.find((block) => block.type === 'text')?.text ??
    ''
  const json = text.slice(text.indexOf('{'))
  return JSON.parse(json) as Record<string, unknown>
}

const requestControl = {
  tools: [
    {
      name: 'ui_request_control',
      args: {
        origins: ['https://example.com'],
        actions: ['observe', 'interact'],
        reason: 'fill the signup form',
      },
    },
  ],
}

describe('computer use end to end (scripted model, fake port)', () => {
  it('shows a grant card in restricted presets and returns the chosen scope', async () => {
    let seen: Record<string, unknown> | undefined
    const { api, events, id } = await setup(
      [
        requestControl,
        (request) => {
          seen = lastToolResult(request)
          return replyChunks({ text: 'granted' })
        },
      ],
      'scoped',
    )
    const submitted = api.chat.submit({ content: 'go', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const interactionId = pendingInteractionId(events, 'ask_request')
    expect(interactionId).toMatch(/^grant_/)
    expect(api.control.get(id).pending).toMatchObject({
      id: interactionId,
      meta: { interaction_type: 'computer_use_grant' },
    })
    await api.control.answerInteraction(interactionId, {
      grant: { option_id: 'session' },
    })
    expect((await submitted).content).toBe('granted')
    expect(seen).toMatchObject({
      status: 'ok',
      tool: 'ui_request_control',
      granted: 'session',
      origins: ['https://example.com'],
    })
    expect(api.computerUse.listGrants()).toEqual([
      expect.objectContaining({ scope: 'session', ownerSessionId: id }),
    ])
    const log = api.host.sessionLog(id)!.events.map((event) => event.type)
    expect(log).toContain('ui/grant-requested')
    expect(log).toContain('ui/grant-decided')
  })

  it('auto-approves with persistent GUI access under workspace Shell mode', async () => {
    let seen: Record<string, unknown> | undefined
    const { api, events, id } = await setup([
      requestControl,
      (request) => {
        seen = lastToolResult(request)
        return replyChunks({ text: 'ok' })
      },
    ])
    await api.chat.submit({ content: 'go', sessionId: id })
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(seen).toMatchObject({ granted: 'auto' })
  })

  it('refuses GUI requests while plan mode is on', async () => {
    let seen: Record<string, unknown> | undefined
    const { api, events, id } = await setup([
      requestControl,
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

  it('the emergency stop dismisses a pending card and is not blocked by it', async () => {
    let seen: string | undefined
    const { api, events, id } = await setup(
      [
        requestControl,
        (request) => {
          seen = JSON.stringify(request.messages.at(-1)?.content)
          return replyChunks({ text: 'stopped' })
        },
      ],
      'scoped',
    )
    const submitted = api.chat.submit({ content: 'go', sessionId: id })
    await waitFor(() => eventOf(events, 'ask_request') !== undefined)
    const status = await api.computerUse.stop()
    expect(status.stopped).toBe(true)
    expect((await submitted).content).toBe('stopped')
    expect(seen).toContain('PERMISSION_DENIED')
    expect(api.control.get(id).pending).toBeNull()
    expect(eventOf(events, 'interaction_cancelled')).toBeDefined()
    expect(api.computerUse.listGrants()).toEqual([])
    await api.computerUse.resume()
  })

  it('stays stopped across a refusal: a stopped kernel refuses new requests', async () => {
    let seen: string | undefined
    const { api, events, id } = await setup([
      requestControl,
      (request) => {
        seen = JSON.stringify(request.messages.at(-1)?.content)
        return replyChunks({ text: 'refused' })
      },
    ])
    await api.computerUse.stop()
    await api.chat.submit({ content: 'go', sessionId: id })
    expect(eventOf(events, 'ask_request')).toBeUndefined()
    expect(seen).toContain('emergency-stop')
  })
})
