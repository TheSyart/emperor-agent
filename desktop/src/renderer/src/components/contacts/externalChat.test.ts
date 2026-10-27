/**
 * GRP-11: where a single chat with Claude Code or Codex opens — its own
 * page before the first message, its delegation's page after — and its
 * messages, which go to `contacts.chatSend`, never to a local turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => vi.fn())
vi.mock('../../api/http', () => ({ core }))

const {
  contactChatLocation,
  externalChatLocation,
  externalChatPlaceholder,
  sendExternalChat,
} = await import('./externalChat')

beforeEach(() => {
  core.mockReset()
})

describe('contactChatLocation', () => {
  it('opens a local contact’s chat page without asking Core', async () => {
    expect(await contactChatLocation({ kind: 'local' }, 's-1')).toEqual({
      name: 'chat',
      params: { sessionId: 's-1' },
    })
    expect(core).not.toHaveBeenCalled()
  })

  it('opens Claude Code’s chat page before its first message', async () => {
    core.mockResolvedValue({ delegationId: null })
    expect(await contactChatLocation({ kind: 'external' }, 's-1')).toEqual({
      name: 'chat',
      params: { sessionId: 's-1' },
    })
    expect(core).toHaveBeenCalledWith('contacts.chatDelegation', {
      sessionId: 's-1',
    })
  })

  it('opens the delegation’s page once the chat has one', async () => {
    core.mockResolvedValue({ delegationId: 'dlg-1' })
    expect(await contactChatLocation({ kind: 'external' }, 's-1')).toEqual(
      externalChatLocation('s-1', 'dlg-1'),
    )
  })
})

describe('sendExternalChat', () => {
  it('sends the message with its own id and lands on the delegation’s page', async () => {
    core.mockResolvedValue({ delegationId: 'dlg-1', runId: 'dgr-1' })
    expect(await sendExternalChat('s-1', '看看结构')).toEqual({
      name: 'external-agent',
      params: { sessionId: 's-1', delegationId: 'dlg-1' },
    })
    const [op, input] = core.mock.calls[0]!
    expect(op).toBe('contacts.chatSend')
    expect(input).toMatchObject({ sessionId: 's-1', text: '看看结构' })
    expect(input.clientMessageId).toMatch(/^cm-[0-9a-f-]{36}$/)
  })

  it('gives each message a new id', async () => {
    core.mockResolvedValue({ delegationId: 'dlg-1', runId: null })
    await sendExternalChat('s-1', 'a')
    await sendExternalChat('s-1', 'b')
    const ids = core.mock.calls.map(([, input]) => input.clientMessageId)
    expect(new Set(ids).size).toBe(2)
  })

  it('passes a refusal on, in Core’s words', async () => {
    core.mockRejectedValue(
      Object.assign(new Error('Codex 还没有登录'), {
        code: 'contact_chat_failed',
      }),
    )
    await expect(sendExternalChat('s-1', 'hi')).rejects.toMatchObject({
      code: 'contact_chat_failed',
      message: 'Codex 还没有登录',
    })
  })
})

it('names who the first message goes to', () => {
  expect(externalChatPlaceholder('Claude Code')).toBe('给 Claude Code 发消息')
})
