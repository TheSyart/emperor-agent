// GRP-08 in Core: what the group page needs beyond GRP-06/07 — 设置 › 群聊's
// defaults (collaboration and the loop guard, in settings.json) that a new
// group starts from while an old one keeps its own; the turn on screen
// while a member speaks; and a member's question waiting in its own
// session, answered through control like any other, the speech going on.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreOperationKeys, invokeCoreOperation } from './operations'
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

async function reviewer(fixture: ApiFixture): Promise<string> {
  return (
    await invokeCoreOperation(fixture.api, 'contacts.create', [
      { name: '审稿人', intro: '代码与方案评审' },
    ])
  ).id
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

describe('设置 › 群聊 (GRP-08, D14)', () => {
  it('registers groups.defaults and groups.setDefaults', () => {
    expect(coreOperationKeys()).toEqual(
      expect.arrayContaining(['groups.defaults', 'groups.setDefaults']),
    )
  })

  it('is autonomous with the loop guard on until the user changes it', async () => {
    const fixture = await open()
    expect(
      await invokeCoreOperation(fixture.api, 'groups.defaults', []),
    ).toEqual({ collaboration: 'autonomous', loopGuard: true })
  })

  it('starts a new group from the defaults, keeps an old one as it was, and survives a restart', async () => {
    const root = tmp('emperor-groups-defaults-')
    const stateRoot = join(root, 'home')
    const first = await open({ stateRoot })
    const rev = await reviewer(first)
    const old = await invokeCoreOperation(first.api, 'groups.create', [
      { title: '旧群', members: [rev] },
    ])
    expect(
      await invokeCoreOperation(first.api, 'groups.setDefaults', [
        { collaboration: 'moderated', loopGuard: false },
      ]),
    ).toEqual({ collaboration: 'moderated', loopGuard: false })
    const settingsFile = JSON.parse(
      readFileSync(join(stateRoot, 'settings.json'), 'utf8'),
    ) as { groups?: unknown }
    expect(settingsFile.groups).toEqual({
      collaboration: 'moderated',
      loopGuard: false,
    })
    const fresh = await invokeCoreOperation(first.api, 'groups.create', [
      { title: '新群', members: [rev] },
    ])
    expect(fresh.settings).toMatchObject({
      collaboration: 'moderated',
      loopGuard: false,
    })
    expect(
      (await invokeCoreOperation(first.api, 'groups.get', [{ id: old.id }]))
        .settings,
    ).toMatchObject({ collaboration: 'autonomous', loopGuard: true })
    await first.api.close()
    fixtures.splice(fixtures.indexOf(first), 1)

    const again = await open({ stateRoot })
    expect(await invokeCoreOperation(again.api, 'groups.defaults', [])).toEqual(
      { collaboration: 'moderated', loopGuard: false },
    )
    // A change of one leaves the other.
    expect(
      await invokeCoreOperation(again.api, 'groups.setDefaults', [
        { loopGuard: true },
      ]),
    ).toEqual({ collaboration: 'moderated', loopGuard: true })
  })

  it('refuses an unknown collaboration', async () => {
    const fixture = await open()
    await expect(
      invokeCoreOperation(fixture.api, 'groups.setDefaults', [
        { collaboration: 'chaos' } as never,
      ]),
    ).rejects.toThrow()
  })
})

describe('the group page’s live view (GRP-08)', () => {
  it('groups.get shows who speaks while a member speaks, then the turn’s end', async () => {
    const fixture = await open({ replies: [{ hang: true }] })
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '登录页', members: [rev] },
    ])
    const sent = await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    await until(() => fixture.adapter.requests.length > 0)
    const live = await invokeCoreOperation(fixture.api, 'groups.get', [
      { id: group.id },
    ])
    expect(live.turn).toMatchObject({
      turnId: sent.message.turnId,
      state: 'speaking',
      speakers: [rev],
      queued: [],
      startedAt: sent.message.at,
    })
    await invokeCoreOperation(fixture.api, 'groups.stop', [{ id: group.id }])
    await fixture.api.groups.settled(group.id)
    const after = await invokeCoreOperation(fixture.api, 'groups.get', [
      { id: group.id },
    ])
    expect(after.turn).toMatchObject({
      state: 'stopped',
      reason: 'user',
      speakers: [],
    })
  })

  it('a member’s question waits in its own session; the answer lets the speech go on (D29)', async () => {
    const fixture = await open({
      replies: [
        {
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
        },
        { text: '好，先看登录。' },
      ],
    })
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '登录页', members: [rev] },
    ])
    const memberSessionId = group.members[0]!.memberSessionId!
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    await until(() => fixture.events.some((e) => e.event === 'ask_request'))
    const asked = fixture.events.find((e) => e.event === 'ask_request')!
    expect(asked.session_id).toBe(memberSessionId)
    const control = await invokeCoreOperation(fixture.api, 'control.get', [
      memberSessionId,
    ])
    const pending = control.pending as {
      id: string
      questions: Array<{ id: string; options: Array<{ label: string }> }>
    }
    expect(pending.questions[0]!.options.map((o) => o.label)).toEqual([
      '登录',
      '注册',
    ])
    await invokeCoreOperation(fixture.api, 'control.answerInteraction', [
      pending.id,
      { scope: { choice: '登录', freeform: '' } },
    ])
    await fixture.api.groups.settled(group.id)
    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    // GRP-12: the answer stays in the group log, for the user only.
    expect(history.messages.map((m) => [m.from, m.text])).toEqual([
      ['user', '@审稿人 看看'],
      ['system', '你回答了 审稿人 的提问：登录'],
      [rev, '好，先看登录。'],
    ])
  })
})
