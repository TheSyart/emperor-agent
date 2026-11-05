// GRP-12 in Core: when the user answers a member who asked during its
// speech — a quick reply, their own words, 不回答, an approval's yes or no —
// through control.* like any other answer, Core keeps one line for the user
// in the group log (「你回答了 架构师 的提问：…」). groups.history returns
// it; no member is ever given it; it survives a restart.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScriptedReply } from '../harness/testing'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp, type ApiFixture } from './test-helpers'

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function open(options: Parameters<typeof makeApi>[0] = {}) {
  const fixture = await makeApi(options)
  fixtures.push(fixture)
  return fixture
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

const ASK: ScriptedReply = {
  tools: [
    {
      id: 'q1',
      name: 'ask_user_question',
      args: {
        questions: [
          {
            id: 'scope',
            question: '先看哪一部分？',
            options: [{ label: '登录' }, { label: '注册' }],
          },
        ],
      },
    },
  ],
}

const ESCALATE: ScriptedReply = {
  tools: [
    {
      id: 'b1',
      name: 'bash',
      args: {
        command: 'echo escalated',
        description: 'print a word',
        sandbox_permissions: 'danger-full-access',
        justification: 'needs to write outside',
      },
    },
  ],
}

/** With bash (the engineer's tools), so a member can ask for an approval. */
async function contact(fixture: ApiFixture, name: string): Promise<string> {
  return (
    await invokeCoreOperation(fixture.api, 'contacts.create', [
      {
        name,
        intro: `${name}的职责`,
        capabilities: { tools: { preset: 'engineer' } },
      },
    ])
  ).id
}

/** A group of the reviewer (and the architect, when asked for). */
async function room(fixture: ApiFixture, withArchitect = false) {
  const rev = await contact(fixture, '审稿人')
  const arch = withArchitect ? await contact(fixture, '架构师') : null
  const group = await invokeCoreOperation(fixture.api, 'groups.create', [
    { title: '登录页', members: arch ? [rev, arch] : [rev] },
  ])
  const sessionOf = (id: string) =>
    group.members.find((m) => m.id === id)!.memberSessionId!
  return { rev, arch, group, sessionOf }
}

/** The interaction waiting in a member's session. */
async function waiting(fixture: ApiFixture, sessionId: string) {
  await until(() =>
    fixture.events.some(
      (e) => e.event === 'ask_request' && e.session_id === sessionId,
    ),
  )
  const control = await invokeCoreOperation(fixture.api, 'control.get', [
    sessionId,
  ])
  return control.pending as { id: string }
}

/** Read-only, so the escalation asks for approval. */
async function readOnly(fixture: ApiFixture, sessionId: string) {
  await invokeCoreOperation(fixture.api, 'control.setPermissionMode', [
    'read-only',
    sessionId,
  ])
}

async function history(fixture: ApiFixture, groupId: string) {
  return (
    await invokeCoreOperation(fixture.api, 'groups.history', [{ id: groupId }])
  ).messages
}

describe('the user’s answers in the group log (GRP-12)', () => {
  it('anchors a pending question to the speech published immediately before it', async () => {
    const fixture = await open({
      replies: [
        { text: '我先确认范围。', tools: ASK.tools },
        { text: '好，先看登录。' },
      ],
    })
    const { rev, group, sessionOf } = await room(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    const pending = await waiting(fixture, sessionOf(rev))
    const before = await history(fixture, group.id)
    expect(before.map((message) => [message.from, message.text])).toEqual([
      ['user', '@审稿人 看看'],
      ['ct-emperor', '已请审稿人回答。'],
      [rev, '我先确认范围。'],
    ])
    expect(before[2]).toMatchObject({
      kind: 'say',
      interactionId: pending.id,
    })
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '登录', freeform: '' } },
    ])
    await fixture.api.groups.settled(group.id)
    const after = await history(fixture, group.id)
    expect(after.map((message) => [message.from, message.text])).toEqual([
      ['user', '@审稿人 看看'],
      ['ct-emperor', '已请审稿人回答。'],
      [rev, '我先确认范围。'],
      ['system', '你回答了 审稿人 的提问：登录'],
      [rev, '好，先看登录。'],
    ])
  })

  it('built-in clarify waits as Emperor’s real controlled question', async () => {
    const fixture = await open({
      replies: [
        { text: '{"raise":false,"score":0,"reason":""}' },
        { text: '{"kind":"clarify","text":"先看哪一部分？"}' },
        { text: '我先确认范围。', tools: ASK.tools },
        { text: '明白，先看登录。' },
      ],
    })
    const { group, sessionOf } = await room(fixture)
    await invokeCoreOperation(fixture.api, 'groups.update', [
      { id: group.id, patch: { settings: { summarizeAtEnd: false } } },
    ])
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'broadcast', text: '看看这个页面' },
    ])
    const pending = await waiting(fixture, sessionOf('ct-emperor'))
    const before = await history(fixture, group.id)
    expect(before.map((message) => [message.from, message.text])).toEqual([
      ['user', '看看这个页面'],
      ['ct-emperor', '我先确认范围。'],
    ])
    expect(before[1]).toMatchObject({ interactionId: pending.id })
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '登录', freeform: '' } },
    ])
    await fixture.api.groups.settled(group.id)
    expect(
      (await history(fixture, group.id)).map((message) => [
        message.from,
        message.text,
      ]),
    ).toEqual([
      ['user', '看看这个页面'],
      ['ct-emperor', '我先确认范围。'],
      ['system', '你回答了 Emperor 的提问：登录'],
      ['ct-emperor', '明白，先看登录。'],
    ])
  })

  it('a quick reply leaves 「你回答了 …」 between the question and the speech it let go on', async () => {
    const fixture = await open({ replies: [ASK, { text: '好，先看登录。' }] })
    const { rev, group, sessionOf } = await room(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    const pending = await waiting(fixture, sessionOf(rev))
    const changed = fixture.events.length
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '登录', freeform: '' } },
    ])
    expect(
      fixture.events
        .slice(changed)
        .some((e) => e.event === 'groups_changed' && e.group_id === group.id),
    ).toBe(true)
    await fixture.api.groups.settled(group.id)
    const messages = await history(fixture, group.id)
    expect(messages.map((m) => [m.from, m.text])).toEqual([
      ['user', '@审稿人 看看'],
      ['ct-emperor', '已请审稿人回答。'],
      ['system', '你回答了 审稿人 的提问：登录'],
      [rev, '好，先看登录。'],
    ])
    expect(messages[2]).toMatchObject({
      kind: 'system',
      private: true,
      note: {
        contactId: rev,
        outcome: 'answered',
        subject: 'question',
        asked: '先看哪一部分？',
        reply: '登录',
      },
    })
  })

  it('keeps the user’s own words', async () => {
    const fixture = await open({ replies: [ASK, { text: '收到。' }] })
    const { rev, group, sessionOf } = await room(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    const pending = await waiting(fixture, sessionOf(rev))
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '', freeform: '两个都看，先登录' } },
    ])
    await fixture.api.groups.settled(group.id)
    expect((await history(fixture, group.id))[2]!.text).toBe(
      '你回答了 审稿人 的提问：两个都看，先登录',
    )
  })

  it('不回答 leaves 「你没有回答 …」 and the speech goes on', async () => {
    const fixture = await open({ replies: [ASK, { text: '那我先看登录。' }] })
    const { rev, group, sessionOf } = await room(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    const pending = await waiting(fixture, sessionOf(rev))
    await invokeCoreOperation(fixture.api, 'control.cancelInteraction', [
      pending.id,
    ])
    await fixture.api.groups.settled(group.id)
    expect(
      (await history(fixture, group.id)).map((m) => [m.from, m.text]),
    ).toEqual([
      ['user', '@审稿人 看看'],
      ['ct-emperor', '已请审稿人回答。'],
      ['system', '你没有回答 审稿人 的提问：先看哪一部分？'],
      [rev, '那我先看登录。'],
    ])
  })

  it('an approval allowed leaves 「你批准了 …」', async () => {
    const fixture = await open({ replies: [ESCALATE, { text: '跑完了。' }] })
    const { rev, group, sessionOf } = await room(fixture)
    await readOnly(fixture, sessionOf(rev))
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 跑一下' },
    ])
    const pending = await waiting(fixture, sessionOf(rev))
    expect(pending.id).toMatch(/^approval_/)
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { permission: { option_id: 'allow_once', choice: '允许本次' } },
    ])
    await fixture.api.groups.settled(group.id)
    const note = (await history(fixture, group.id)).find(
      (m) => m.from === 'system',
    )!
    expect(note.text).toBe('你批准了 审稿人 的请求：echo escalated')
    expect(note.note).toMatchObject({
      outcome: 'approved',
      subject: 'approval',
    })
  })

  it('an approval denied leaves 「你拒绝了 …」', async () => {
    const fixture = await open({ replies: [ESCALATE, { text: '那就不跑。' }] })
    const { rev, group, sessionOf } = await room(fixture)
    await readOnly(fixture, sessionOf(rev))
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 跑一下' },
    ])
    const pending = await waiting(fixture, sessionOf(rev))
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { permission: { option_id: 'deny', choice: '拒绝' } },
    ])
    await fixture.api.groups.settled(group.id)
    expect(
      (await history(fixture, group.id)).find((m) => m.from === 'system')!.text,
    ).toBe('你拒绝了 审稿人 的请求：echo escalated')
  })

  it('records a question asked while answering a private message', async () => {
    const fixture = await open({
      replies: [ASK, { text: '私下说：先看登录。' }],
    })
    const { rev, group, sessionOf } = await room(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'private', to: rev, text: '悄悄问你一句' },
    ])
    const pending = await waiting(fixture, sessionOf(rev))
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '注册', freeform: '' } },
    ])
    await fixture.api.groups.settled(group.id)
    const messages = await history(fixture, group.id)
    expect(messages.map((m) => [m.from, m.text])).toEqual([
      ['user', '悄悄问你一句'],
      ['ct-emperor', '已请审稿人回答。'],
      ['system', '你回答了 审稿人 的提问：注册'],
      [rev, '私下说：先看登录。'],
    ])
    expect(messages[2]!.turnId).toBe(messages[0]!.turnId)
  })

  it('no member is ever given it: the next speeches read without it', async () => {
    const fixture = await open({
      replies: [
        ASK,
        { text: '好，先看登录。' },
        { text: '登录页的表单可以拆开。' },
        { text: '同意，拆成两步。' },
      ],
    })
    const { rev, arch, group, sessionOf } = await room(fixture, true)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    const pending = await waiting(fixture, sessionOf(rev))
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '登录', freeform: '' } },
    ])
    await fixture.api.groups.settled(group.id)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: `@架构师 @审稿人 接着说` },
    ])
    await fixture.api.groups.settled(group.id)
    const spoken = (await history(fixture, group.id)).filter(
      (m) => m.from === arch || m.from === rev,
    )
    expect(spoken.map((m) => m.text)).toEqual([
      '好，先看登录。',
      '登录页的表单可以拆开。',
      '同意，拆成两步。',
    ])
    expect(fixture.adapter.requests.length).toBeGreaterThanOrEqual(4)
    for (const request of fixture.adapter.requests)
      expect(JSON.stringify(request.messages)).not.toContain('你回答了')
  })

  it('is still there after a restart', async () => {
    const root = tmp('emperor-groups-answers-')
    const stateRoot = join(root, 'home')
    const first = await open({ stateRoot, replies: [ASK, { text: '好。' }] })
    const { rev, group, sessionOf } = await room(first)
    await invokeCoreOperation(first.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    const pending = await waiting(first, sessionOf(rev))
    await invokeCoreOperation(first.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '登录', freeform: '' } },
    ])
    await first.api.groups.settled(group.id)
    await first.api.close()
    fixtures.splice(fixtures.indexOf(first), 1)

    const again = await open({ stateRoot })
    expect((await history(again, group.id)).map((m) => m.text)).toEqual([
      '@审稿人 看看',
      '已请审稿人回答。',
      '你回答了 审稿人 的提问：登录',
      '好。',
    ])
  })

  it('stopping drops a waiting question but keeps the acceptance', async () => {
    const fixture = await open({ replies: [ASK] })
    const { rev, group, sessionOf } = await room(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    await waiting(fixture, sessionOf(rev))
    await invokeCoreOperation(fixture.api, 'groups.stop', [{ id: group.id }])
    await fixture.api.groups.settled(group.id)
    expect((await history(fixture, group.id)).map((m) => m.from)).toEqual([
      'user',
      'ct-emperor',
    ])
  })

  it('a question outside any group is answered as before, with no group line', async () => {
    const fixture = await open({ replies: [ASK, { text: '好。' }] })
    const { group } = await room(fixture)
    const sessionId = String(fixture.api.sessions.create({ title: 'Chat' }).id)
    const submitted = fixture.api.chat.submit({ content: '看看', sessionId })
    const pending = await waiting(fixture, sessionId)
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '登录', freeform: '' } },
    ])
    await submitted
    expect(await history(fixture, group.id)).toEqual([])
  })
})
