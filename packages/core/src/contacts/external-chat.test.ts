// GRP-11: a single chat with Claude Code or Codex is a delegation the user
// started, rooted at the chat session: read-only, continued message after
// message, each message its own task, with the contact's job card appended.
import { describe, expect, it, vi } from 'vitest'
import type {
  DelegationOwner,
  DelegationRecord,
  DelegationStart,
} from '../harness/delegation/types'
import { DelegationError } from '../harness/delegation/types'
import { ExternalChat } from './external-chat'
import type { Contact } from './types'

function contact(patch: Partial<Contact> = {}): Contact {
  return {
    id: 'ct-codex',
    kind: 'external',
    backend: 'codex',
    name: 'Codex',
    intro: '外部',
    domains: [],
    avatar: { kind: 'logo', backend: 'codex' },
    role: {
      mission: '',
      deliverable: '',
      playbook: '',
      boundaries: '',
      knowledge: [],
    },
    capabilities: {
      model: 'inherit',
      tools: { preset: 'engineer' },
      permission: 'inherit',
    },
    groupHabit: { speak: 'mentioned', length: 'brief' },
    memory: { enabled: false },
    version: 1,
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

function setup(who: Contact | null = contact()) {
  const records = new Map<string, DelegationRecord>()
  let n = 0
  const delegations = {
    start: vi.fn(async (owner: DelegationOwner, spec: DelegationStart) => {
      const id = `dlg-${++n}`
      const record = {
        id,
        owner,
        backend: spec.backend,
        startSpec: spec,
        availability: 'active',
        currentRunId: `dgr-${n}`,
      } as unknown as DelegationRecord
      records.set(id, record)
      return record
    }),
    send: vi.fn(async (_id: string, _input: Record<string, unknown>) => ({
      messageId: 'm',
      state: 'queued' as const,
    })),
    list: () => [...records.values()].map((record) => ({ record })),
  }
  const chat = new ExternalChat({
    delegations: delegations as never,
    parentAgentId: (sessionId) => `agent-${sessionId}`,
    beginTask: vi.fn(),
    session: (id) =>
      id === 's-chat'
        ? { id, surface: 'contact', contact_id: 'ct-codex' }
        : id === 's-plain'
          ? { id }
          : null,
    contact: () => who,
  })
  return { chat, delegations, records }
}

describe('ExternalChat', () => {
  it('starts a read-only delegation rooted at the chat with the first message', async () => {
    const { chat, delegations } = setup()
    expect(chat.delegationOf('s-chat')).toBeNull()
    const sent = await chat.send('s-chat', '看看这个仓库的结构', 'cm-1')
    expect(sent).toMatchObject({ delegationId: 'dlg-1', runId: 'dgr-1' })
    const [owner, spec] = delegations.start.mock.calls[0]!
    expect(owner).toMatchObject({
      rootSessionId: 's-chat',
      parentAgentId: 'agent-s-chat',
      source: 'contact',
      depth: 1,
      taskScopeId: 'contact-chat:s-chat:cm-1',
    })
    expect(spec).toMatchObject({
      backend: 'codex',
      prompt: '看看这个仓库的结构',
      workspace: 'shared-readonly',
      base: 'committed',
    })
    expect(spec.instructions).toBeUndefined()
    expect(chat.delegationOf('s-chat')).toBe('dlg-1')
  })

  it('continues the same delegation, each message its own task', async () => {
    const { chat, delegations } = setup()
    await chat.send('s-chat', '第一句', 'cm-1')
    const next = await chat.send('s-chat', '第二句', 'cm-2')
    expect(delegations.start).toHaveBeenCalledTimes(1)
    expect(delegations.send.mock.calls[0]![1]).toMatchObject({
      text: '第二句',
      delivery: 'queue',
      taskScopeId: 'contact-chat:s-chat:cm-2',
    })
    expect(next.delegationId).toBe('dlg-1')
  })

  it('appends the job card of an external contact that wears one', async () => {
    const { chat, delegations } = setup(
      contact({
        name: 'Codex · 代码审稿人',
        builtin: false,
        role: {
          mission: '审查改动里的正确性问题',
          deliverable: '问题清单',
          playbook: '1. 读改动\n2. 列问题',
          boundaries: '不改代码',
          knowledge: [],
        },
      }),
    )
    await chat.send('s-chat', '审一下', 'cm-1')
    expect(delegations.start.mock.calls[0]![1].instructions).toContain(
      '审查改动里的正确性问题',
    )
  })

  it('refuses a session that is not a chat with Claude Code or Codex', async () => {
    const { chat } = setup()
    await expect(chat.send('s-plain', 'hi', 'cm-1')).rejects.toMatchObject({
      code: 'contact_chat_unavailable',
    })
    await expect(chat.send('s-nope', 'hi', 'cm-1')).rejects.toMatchObject({
      code: 'invalid_session',
    })
    const local = setup(contact({ kind: 'local', backend: undefined }))
    await expect(local.chat.send('s-chat', 'hi', 'cm-1')).rejects.toMatchObject(
      { code: 'contact_chat_unavailable' },
    )
  })

  it('reads a sign-in failure as one line with where to fix it', async () => {
    const { chat, delegations } = setup()
    delegations.start.mockRejectedValueOnce(
      new DelegationError('AUTH_REQUIRED', 'codex is not signed in'),
    )
    await expect(chat.send('s-chat', 'hi', 'cm-1')).rejects.toMatchObject({
      code: 'contact_chat_failed',
      message: expect.stringMatching(/登录/),
    })
  })

  it('refuses an empty message', async () => {
    const { chat } = setup()
    await expect(chat.send('s-chat', '  ', 'cm-1')).rejects.toMatchObject({
      code: 'contact_chat_failed',
    })
  })

  it('reads a chat whose contact was deleted, never continues it', async () => {
    const { chat, delegations } = setup(null)
    await expect(chat.send('s-chat', 'hi', 'cm-1')).rejects.toMatchObject({
      code: 'contact_deleted',
    })
    expect(delegations.start).not.toHaveBeenCalled()
  })

  it('starts a new delegation once the old one is closed', async () => {
    const { chat, delegations, records } = setup()
    await chat.send('s-chat', '第一句', 'cm-1')
    ;(records.get('dlg-1') as { availability: string }).availability = 'closed'
    await chat.send('s-chat', '重新开始', 'cm-2')
    expect(delegations.start).toHaveBeenCalledTimes(2)
  })

  // GRP-19: what the user reads when a message does not go out is Chinese
  // and says what to do — never a code, the executor's English, or the
  // group's 「@ 它」.
  it.each([
    ['PARENT_NOT_FOUND', 'delegation parent is not active'],
    ['NEEDS_RECOVERY', 'conversation is closed or requires recovery'],
    ['STOPPING', 'wait for current cancellation proof'],
    ['QUEUE_LIMIT', 'queued message limit reached'],
    ['BUDGET_LIMIT', 'the root task has spent its cost cap'],
    ['JOURNAL_CORRUPT', 'descriptor missing'],
    ['RESTART_PAUSED', 'review the preserved queue'],
    ['DELIVERY_UNKNOWN', 'message acceptance is unknown'],
    ['BRIEF_LIMIT', 'message is empty or exceeds 32 KiB'],
    ['AUTH_REQUIRED', 'codex is not signed in'],
    ['RUN_LIMIT', 'too many runs'],
    ['SOMETHING_NEW', 'an English detail'],
  ])('says %s in words, without codes or English', async (code, detail) => {
    const { chat, delegations } = setup()
    await chat.send('s-chat', '第一句', 'cm-1')
    delegations.send.mockRejectedValueOnce(new DelegationError(code, detail))
    const error = await chat.send('s-chat', '第二句', 'cm-2').catch((e) => e)
    expect(error).toMatchObject({ code: 'contact_chat_failed' })
    const words = String(error.message).replace(/Codex|Emperor/g, '')
    expect(words).not.toMatch(/[A-Z]{2,}_[A-Z]|[A-Za-z]{3,}|@/)
    expect(words).toMatch(/[\u4e00-\u9fff]/)
  })

  it('says a failure that is not the executor’s in words too', async () => {
    const { chat, delegations } = setup()
    delegations.start.mockRejectedValueOnce(new Error('socket hang up'))
    const error = await chat.send('s-chat', 'hi', 'cm-1').catch((e) => e)
    expect(error.message).not.toMatch(/socket/)
  })

  it('refuses a message longer than a delegation takes, before it goes', async () => {
    const { chat, delegations } = setup()
    const error = await chat
      .send('s-chat', '长'.repeat(11_000), 'cm-1')
      .catch((e) => e)
    expect(error).toMatchObject({
      code: 'contact_chat_failed',
      message: expect.stringMatching(/太长/),
    })
    expect(delegations.start).not.toHaveBeenCalled()
  })

  it('opens one delegation when two first messages arrive together', async () => {
    const { chat, delegations } = setup()
    // As the real start, the record exists only after a few awaits.
    const start = delegations.start.getMockImplementation()!
    delegations.start.mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return start(...args)
    })
    const sent = await Promise.all([
      chat.send('s-chat', '第一句', 'cm-1'),
      chat.send('s-chat', '第二句', 'cm-2'),
    ])
    expect(delegations.start).toHaveBeenCalledTimes(1)
    expect(delegations.send).toHaveBeenCalledTimes(1)
    expect(sent[1]!.delegationId).toBe(sent[0]!.delegationId)
  })

  it('follows the newest open delegation of the chat', async () => {
    const { chat, records } = setup()
    for (const [id, createdAt, availability] of [
      ['dlg-old', 1, 'idle'],
      ['dlg-new', 3, 'idle'],
      ['dlg-closed', 5, 'closed'],
    ] as const)
      records.set(id, {
        id,
        createdAt,
        availability,
        owner: { rootSessionId: 's-chat', source: 'contact' },
      } as unknown as DelegationRecord)
    expect(chat.delegationOf('s-chat')).toBe('dlg-new')
  })
})
