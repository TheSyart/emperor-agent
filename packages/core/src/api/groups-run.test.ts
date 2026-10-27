// GRP-07 in Core: a member speaks in its own session as a background turn,
// reading its role card, the group charter and what was delivered to it;
// group tools exist there and nowhere else; groups.stop stops the turn; a
// turn left open by a restart is marked stopped.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_EVENT_NAMES } from '../harness/projection/wire-names'
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

async function groupWithReviewer(fixture: ApiFixture) {
  const rev = (
    await invokeCoreOperation(fixture.api, 'contacts.create', [
      {
        name: '审稿人',
        intro: '代码与方案评审',
        role: { mission: '评审登录页的方案和代码' },
      },
    ])
  ).id
  const group = await invokeCoreOperation(fixture.api, 'groups.create', [
    { title: '登录页', members: [rev] },
  ])
  return { rev, group }
}

const toolNames = (request: { tools?: Array<{ name: string }> }) =>
  (request.tools ?? []).map((tool) => tool.name)

describe('group turns in Core', () => {
  it('registers groups.stop and the two group runtime events', () => {
    expect(RUNTIME_EVENT_NAMES).toContain('group_turn_changed')
    expect(RUNTIME_EVENT_NAMES).toContain('group_member_status')
  })

  it('runs a member’s speech in its own session with its role card and the charter', async () => {
    const fixture = await open({ replies: [{ text: '我看过了，先修溢出' }] })
    const { rev, group } = await groupWithReviewer(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看方案' },
    ])
    await fixture.api.groups.settled(group.id)

    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    expect(history.messages.map((m) => [m.from, m.text])).toEqual([
      ['user', '@审稿人 看看方案'],
      [rev, '我看过了，先修溢出'],
    ])
    const request = fixture.adapter.requests[0]!
    expect(request.system).toContain('# 群聊：登录页')
    expect(request.system).toContain('评审登录页的方案和代码')
    expect(toolNames(request)).toEqual(
      expect.arrayContaining(['group_whisper', 'group_assign', 'group_pass']),
    )
    expect(toolNames(request)).not.toContain('group_next')
    const turns = fixture.events.filter((e) => e.event === 'group_turn_changed')
    expect(turns.at(-1)).toMatchObject({
      group_id: group.id,
      state: 'finished',
    })
  })

  it('says a member’s failed speech in Chinese, not the provider’s words (SET-02)', async () => {
    const fixture = await open({
      replies: [
        { error: 'Insufficient Balance (request_id: 7118)', code: 'QUOTA' },
      ],
    })
    const { group } = await groupWithReviewer(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看方案' },
    ])
    await fixture.api.groups.settled(group.id)
    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    const notice = history.messages.find((m) => m.kind === 'system')!
    expect(notice.text).toMatch(
      /审稿人 这次发言失败：模型服务的余额或额度用完了/,
    )
    expect(notice.text).not.toContain('Insufficient')
  })

  it('a member’s group_pass leaves 没有补充 and ends its speech', async () => {
    const fixture = await open({
      replies: [{ tools: [{ name: 'group_pass', args: { reason: '同意' } }] }],
    })
    const { rev, group } = await groupWithReviewer(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 还有补充吗' },
    ])
    await fixture.api.groups.settled(group.id)
    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    expect(history.messages.map((m) => [m.from, m.kind, m.text])).toEqual([
      ['user', 'say', '@审稿人 还有补充吗'],
      [rev, 'pass', '同意'],
    ])
    expect(fixture.adapter.requests).toHaveLength(1)
  })

  it('groups.stop stops the turn and drops the speech', async () => {
    const fixture = await open({ replies: [{ hang: true }] })
    const { group } = await groupWithReviewer(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    for (let i = 0; i < 50 && fixture.adapter.requests.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      await invokeCoreOperation(fixture.api, 'groups.stop', [{ id: group.id }]),
    ).toEqual({ stopped: true })
    await fixture.api.groups.settled(group.id)
    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    expect(history.messages.map((m) => m.from)).toEqual(['user'])
    expect(
      fixture.events.filter((e) => e.event === 'group_turn_changed').at(-1),
    ).toMatchObject({ state: 'stopped', reason: 'user' })
  })

  it('a plain chat never sees the group tools', async () => {
    const fixture = await open({ replies: [{ text: 'hi' }] })
    const sessionId = String(fixture.api.sessions.create({ title: 'Chat' }).id)
    await fixture.api.chat.submit({ content: 'hi', sessionId })
    expect(
      toolNames(fixture.adapter.requests[0]!).filter((n) =>
        n.startsWith('group_'),
      ),
    ).toEqual([])
    expect(fixture.adapter.requests[0]!.system).not.toContain('# 群聊')
  })

  it('marks a turn left open by a restart stopped', async () => {
    const root = tmp('emperor-groups-run-')
    const stateRoot = join(root, 'home')
    const first = await open({ stateRoot })
    const { group } = await groupWithReviewer(first)
    first.api.groupService.append(group.id, 'group/turn', {
      turnId: 't-open',
      state: 'started',
      spend: { usd: 0, tokens: 0 },
    })
    await first.api.close()
    fixtures.splice(fixtures.indexOf(first), 1)
    const again = await open({ stateRoot })
    expect(again.api.groupService.state(group.id).turn).toMatchObject({
      state: 'stopped',
      reason: 'app_restart',
    })
  })
})
