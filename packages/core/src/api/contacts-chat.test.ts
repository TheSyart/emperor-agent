// GRP-05 in Core: a single chat with a contact — opened again when there is
// one (only `surface: 'contact'` counts: a trial or a group member's session
// of the same contact never does), made when there is none, kept across a
// restart — and the profile's four numbers (`contacts.stats`).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi, waitFor, type ApiFixture } from './test-helpers'
import { CodexExecutorAdapter } from '../harness/delegation/adapters/codex'
import type { DelegationServiceOptions } from '../harness/delegation/service'
import { fakeCodexProcesses } from '../harness/delegation/testing'
import type { ScriptedReply } from '../harness/testing'

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
  vi.restoreAllMocks()
})

/**
 * Codex on, allowed and signed in, its every process the fake app-server
 * (testing.ts): nothing runs the real codex or reads ~/.codex.
 */
async function withFakeCodex(fixture: ApiFixture): Promise<void> {
  const { api, root } = fixture
  const config = api.executorConfig.read()
  if (!config.profiles.every((profile) => profile.enabled)) {
    for (const profile of config.profiles) profile.enabled = true
    await api.executors.configure(
      { expectedRevision: config.revision, config },
      { sessionId: null },
    )
  }
  for (const profile of config.profiles)
    api.host.delegationConsent.store?.grant(profile.id)
  vi.spyOn(api.executorRegistry, 'requireAvailable').mockImplementation(
    async (profile) => ({
      status: 'available',
      checkedAt: Date.now(),
      authVerified: true,
      capabilities: api.executorRegistry.capabilities(profile.backend),
    }),
  )
  const options = (
    api.delegationRuntime as unknown as { options: DelegationServiceOptions }
  ).options
  options.checkAuth = undefined
  options.runtime = async (_profile, id) => {
    const runtimeRoot = join(root, 'codex-runtimes', id),
      tempRoot = join(runtimeRoot, 'tmp')
    mkdirSync(tempRoot, { recursive: true })
    return {
      runtimeRoot,
      tempRoot,
      environment: { PATH: process.env.PATH ?? '' },
      billing: 'subscription' as const,
    }
  }
  options.adapters.set(
    'codex',
    new CodexExecutorAdapter({
      processes: fakeCodexProcesses({ reply: '收到' }),
    }),
  )
}

async function open(
  replies: ScriptedReply[] = [],
  stateRoot?: string,
): Promise<ApiFixture> {
  const fixture = await makeApi({
    replies,
    ...(stateRoot ? { stateRoot } : {}),
  })
  fixtures.push(fixture)
  return fixture
}

/** The run of one queued chat message, once it has settled. */
async function settled(api: CoreApi, delegationId: string, messageId: string) {
  const runOf = () =>
    Object.values(
      api.delegationRuntime
        .list()
        .find((state) => state.record?.id === delegationId)?.runs ?? {},
    ).find((run) => run.messageId === messageId)
  await waitFor(() => runOf() !== undefined)
  return api.delegationRuntime.wait(delegationId, runOf()!.id)
}

async function reviewer(api: CoreApi, name = '审稿人'): Promise<string> {
  const created = await invokeCoreOperation(api, 'contacts.create', [
    {
      name,
      intro: '代码与方案评审',
      role: {
        mission: '审查每一处改动。',
        deliverable: '问题清单。',
        playbook: '1. 读改动\n2. 列问题',
        boundaries: '不改代码。',
        knowledge: [],
      },
    },
  ])
  return created.id
}

describe('a single chat with a contact (GRP-05)', () => {
  it('makes one the first time (card test: 新建单聊)', async () => {
    const { api } = await open()
    const rev = await reviewer(api)
    const chat = await invokeCoreOperation(api, 'contacts.openChat', [
      { id: rev },
    ])
    expect(chat).toMatchObject({
      surface: 'contact',
      contact_id: rev,
      mode: 'chat',
      project_path: null,
      title: '审稿人 · 单聊',
    })
    const listed = await invokeCoreOperation(api, 'sessions.list', [])
    expect(listed.map((session) => session.id)).toContain(chat.id)
  })

  it('opens the most recent one again, never a trial or a group member’s session (card test: 单聊复用最近会话)', async () => {
    const { api } = await open([{ text: '看过了' }])
    const rev = await reviewer(api)
    const other = await reviewer(api, '译者')
    const first = await invokeCoreOperation(api, 'contacts.openChat', [
      { id: rev },
    ])
    // Sessions of the same contact that are not its single chats.
    const store = api.host.kept.sessionStore
    store.create('试用', { surface: 'trial', contactId: rev })
    store.create('审稿人 · 登录页', {
      surface: 'group_member',
      contactId: rev,
      groupId: 'grp-x',
    })
    await invokeCoreOperation(api, 'contacts.openChat', [{ id: other }])
    expect(
      (await invokeCoreOperation(api, 'contacts.openChat', [{ id: rev }])).id,
    ).toBe(first.id)

    // A fresh one on request; then the most recently used one wins.
    const second = await invokeCoreOperation(api, 'contacts.openChat', [
      { id: rev, fresh: true },
    ])
    expect(second.id).not.toBe(first.id)
    expect(second.contact_id).toBe(rev)
    await api.chat.submit({ content: '看看这个改动', sessionId: first.id })
    expect(
      (await invokeCoreOperation(api, 'contacts.openChat', [{ id: rev }])).id,
    ).toBe(first.id)
  })

  it('goes on after a restart (card test: 重启后继续单聊)', async () => {
    const before = await open([{ text: '第一轮的意见' }])
    const rev = await reviewer(before.api)
    const chat = await invokeCoreOperation(before.api, 'contacts.openChat', [
      { id: rev },
    ])
    await before.api.chat.submit({ content: '第一轮', sessionId: chat.id })
    await before.api.close()
    fixtures.splice(fixtures.indexOf(before), 1)

    const after = await open([{ text: '第二轮的意见' }], before.stateRoot)
    const again = await invokeCoreOperation(after.api, 'contacts.openChat', [
      { id: rev },
    ])
    expect(again.id).toBe(chat.id)
    expect(again.contact_id).toBe(rev)
    await after.api.chat.submit({ content: '第二轮', sessionId: again.id })
    const request = after.adapter.requests.at(-1)!
    // Still the contact, with the first round in its context.
    expect(request.system).toContain('审查每一处改动。')
    expect(JSON.stringify(request.messages)).toContain('第一轮的意见')
  })

  it('lets sessions.create take a contact (card: sessions.create 接受 contactId)', async () => {
    const { api } = await open()
    const rev = await reviewer(api)
    const created = await invokeCoreOperation(api, 'sessions.create', [
      { contactId: rev },
    ])
    expect(created).toMatchObject({
      surface: 'contact',
      contact_id: rev,
      title: '审稿人 · 单聊',
    })
    await expect(
      invokeCoreOperation(api, 'sessions.create', [
        { contactId: 'ct-nobody0000001' },
      ]),
    ).rejects.toMatchObject({ code: 'contact_not_found' })
  })

  it('opens a chat with Claude Code or Codex that never runs a local turn (GRP-11)', async () => {
    const { api } = await open()
    for (const id of ['ct-claude-code', 'ct-codex']) {
      const chat = await invokeCoreOperation(api, 'contacts.openChat', [{ id }])
      expect(chat).toMatchObject({ surface: 'contact', contact_id: id })
      expect(
        await invokeCoreOperation(api, 'contacts.chatDelegation', [
          { sessionId: String(chat.id) },
        ]),
      ).toEqual({ delegationId: null })
      // Its messages go to the executor, never to a local agent.
      await expect(
        api.chat.submit({ content: 'hi', sessionId: String(chat.id) }),
      ).rejects.toMatchObject({ code: 'contact_chat_external' })
    }
  })

  it('sends a message only in a chat with Claude Code or Codex, in words when it cannot (GRP-11)', async () => {
    const { api } = await open()
    const rev = await reviewer(api)
    const local = await invokeCoreOperation(api, 'contacts.openChat', [
      { id: rev },
    ])
    await expect(
      invokeCoreOperation(api, 'contacts.chatSend', [
        { sessionId: String(local.id), text: 'hi', clientMessageId: 'cm-1' },
      ]),
    ).rejects.toMatchObject({ code: 'contact_chat_unavailable' })
    // Codex is off in a fresh config: the refusal says where to turn it on.
    const codex = await invokeCoreOperation(api, 'contacts.openChat', [
      { id: 'ct-codex' },
    ])
    await expect(
      invokeCoreOperation(api, 'contacts.chatSend', [
        { sessionId: String(codex.id), text: 'hi', clientMessageId: 'cm-1' },
      ]),
    ).rejects.toMatchObject({
      code: 'contact_chat_failed',
      message: expect.stringMatching(/设置 › 子智能体/),
    })
  })

  it('goes on with Claude Code or Codex after a restart, from the chat and from its conversation (GRP-19)', async () => {
    const before = await open()
    await withFakeCodex(before)
    const chat = await invokeCoreOperation(before.api, 'contacts.openChat', [
      { id: 'ct-codex' },
    ])
    const sessionId = String(chat.id)
    const first = await invokeCoreOperation(before.api, 'contacts.chatSend', [
      { sessionId, text: '第一条', clientMessageId: 'cm-1' },
    ])
    expect(
      await before.api.delegationRuntime.wait(first.delegationId, first.runId!),
    ).toMatchObject({ phase: 'completed' })
    await before.api.close()
    fixtures.splice(fixtures.indexOf(before), 1)

    // Nothing made the chat's root agent again: the next message must.
    const after = await open([], before.stateRoot)
    await withFakeCodex(after)
    expect(
      await invokeCoreOperation(after.api, 'contacts.chatDelegation', [
        { sessionId },
      ]),
    ).toEqual({ delegationId: first.delegationId })
    const second = await invokeCoreOperation(after.api, 'contacts.chatSend', [
      { sessionId, text: '第二条', clientMessageId: 'cm-2' },
    ])
    expect(second.delegationId).toBe(first.delegationId)
    // Queued, then run as its own task.
    expect(
      await settled(after.api, first.delegationId, 'dgm-cm-2'),
    ).toMatchObject({ phase: 'completed' })

    // The conversation page's own box (delegations.send) after a restart.
    await after.api.close()
    fixtures.splice(fixtures.indexOf(after), 1)
    const third = await open([], before.stateRoot)
    await withFakeCodex(third)
    await expect(
      invokeCoreOperation(third.api, 'delegations.send', [
        {
          id: first.delegationId,
          sessionId,
          messageId: 'dgm-page-3',
          text: '第三条',
          delivery: 'queue',
        },
      ]),
    ).resolves.toMatchObject({ messageId: 'dgm-page-3' })
  })

  it('spends each message’s own cost cap, never one for the whole chat (GRP-19)', async () => {
    const fixture = await open()
    const { api } = fixture
    await withFakeCodex(fixture)
    api.host.kept.modelConfig = {
      ...api.host.kept.modelConfig,
      policy: {
        ...api.host.kept.modelConfig.policy,
        cost: { maxUsdPerAgentTurn: 0.01 },
      },
    } as typeof api.host.kept.modelConfig
    const chat = await invokeCoreOperation(api, 'contacts.openChat', [
      { id: 'ct-codex' },
    ])
    const sessionId = String(chat.id)
    const first = await invokeCoreOperation(api, 'contacts.chatSend', [
      { sessionId, text: '第一条', clientMessageId: 'cm-1' },
    ])
    await api.delegationRuntime.wait(first.delegationId, first.runId!)
    // An API-billed answer that cost more than the cap.
    const owner = api.delegationRuntime
      .list()
      .find((state) => state.record?.id === first.delegationId)!.record!.owner
    api.host.chargeDelegation(owner, 1)
    expect(api.host.delegationTaskSpent(owner)).toBe(true)

    // The next message is a task of its own: it runs.
    await invokeCoreOperation(api, 'contacts.chatSend', [
      { sessionId, text: '第二条', clientMessageId: 'cm-2' },
    ])
    expect(await settled(api, first.delegationId, 'dgm-cm-2')).toMatchObject({
      phase: 'completed',
    })
    // So is one sent from its conversation page.
    api.host.chargeDelegation(owner, 1)
    await invokeCoreOperation(api, 'delegations.send', [
      {
        id: first.delegationId,
        sessionId,
        messageId: 'dgm-page-3',
        text: '第三条',
        delivery: 'queue',
      },
    ])
    expect(await settled(api, first.delegationId, 'dgm-page-3')).toMatchObject({
      phase: 'completed',
    })
  })

  it('takes only a message id a delegation can keep (GRP-19)', async () => {
    const { api } = await open()
    const codex = await invokeCoreOperation(api, 'contacts.openChat', [
      { id: 'ct-codex' },
    ])
    for (const clientMessageId of ['a/b', 'x'.repeat(200), 'cm 1'])
      await expect(
        invokeCoreOperation(api, 'contacts.chatSend', [
          { sessionId: String(codex.id), text: 'hi', clientMessageId },
        ]),
      ).rejects.toMatchObject({ code: 'invalid_core_arguments' })
  })

  it('has no single chat with a contact that is gone', async () => {
    const { api } = await open()
    await expect(
      invokeCoreOperation(api, 'contacts.openChat', [
        { id: 'ct-nobody0000001' },
      ]),
    ).rejects.toMatchObject({ code: 'contact_not_found' })
  })
})

describe('the profile’s four numbers (card test: 档案四个数字)', () => {
  it('counts the groups, the speeches, the ratings and the version', async () => {
    const { api } = await open([
      { text: '单聊里的回答' },
      { text: '群里的发言' },
    ])
    const rev = await reviewer(api)
    const empty = await invokeCoreOperation(api, 'contacts.stats', [
      { id: rev },
    ])
    expect(empty).toEqual({
      groups: 0,
      speeches: 0,
      ratings: { up: 0, down: 0 },
      version: 1,
    })

    // One reply in its single chat, rated twice.
    const chat = await invokeCoreOperation(api, 'contacts.openChat', [
      { id: rev },
    ])
    await api.chat.submit({ content: '看看', sessionId: chat.id })
    for (const rating of ['up', 'down'] as const)
      await invokeCoreOperation(api, 'contacts.feedback', [
        { contactId: rev, messageRef: { sessionId: chat.id }, rating },
      ])
    // Two groups with it (one speech), one without it.
    const group = await invokeCoreOperation(api, 'groups.create', [
      { title: '登录页', members: [rev] },
    ])
    await invokeCoreOperation(api, 'groups.create', [
      { title: '发布说明', members: [rev] },
    ])
    await invokeCoreOperation(api, 'groups.create', [
      { title: '别的群', members: ['ct-emperor'] },
    ])
    await invokeCoreOperation(api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看方案', ask: [rev] },
    ])
    await api.groups.settled(group.id)
    await invokeCoreOperation(api, 'contacts.update', [
      { id: rev, patch: { intro: '只看安全问题' } },
    ])

    expect(
      await invokeCoreOperation(api, 'contacts.stats', [{ id: rev }]),
    ).toEqual({
      groups: 2,
      speeches: 2,
      ratings: { up: 1, down: 1 },
      version: 2,
    })
    await expect(
      invokeCoreOperation(api, 'contacts.stats', [{ id: 'ct-nobody0000001' }]),
    ).rejects.toMatchObject({ code: 'contact_not_found' })
  })
})
