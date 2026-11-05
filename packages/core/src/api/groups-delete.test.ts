// GRP-16: deleting a group and a contact. A deleted group goes to 最近删除
// the way a conversation does — its own session and every member session
// move to `sessions/.trash`, a running turn is stopped first, and
// `groups_changed` says `deleted`. 最近删除 lists the group alone: restoring
// it brings the group back whole, purging it takes its members and its
// files along. A deleted contact leaves every group it was in; what it said
// stays.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeCoreOperation } from './operations'
import { makeApi, type ApiFixture } from './test-helpers'

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
  const created = await invokeCoreOperation(fixture.api, 'contacts.create', [
    { name: '审稿人', intro: '代码与方案评审' },
  ])
  return created.id
}

async function reviewGroup(fixture: ApiFixture) {
  const rev = await reviewer(fixture)
  const group = await invokeCoreOperation(fixture.api, 'groups.create', [
    { title: '登录页评审', members: ['ct-emperor', rev] },
  ])
  return { rev, group }
}

type Listed = { id: string; surface?: string; group_id?: string }

function sessionsOf(fixture: ApiFixture, groupId: string): Listed[] {
  return (
    fixture.api.sessions.list({ includeArchived: true }) as Listed[]
  ).filter((s) => s.id === groupId || s.group_id === groupId)
}

function trashDir(fixture: ApiFixture): string {
  return join(fixture.stateRoot, 'sessions', '.trash')
}

function trashed(fixture: ApiFixture): string[] {
  const dir = trashDir(fixture)
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

function groupChanges(fixture: ApiFixture) {
  return fixture.events
    .filter((e) => e.event === 'groups_changed')
    .map(({ reason, group_id }) => ({ reason, group_id }))
}

describe('groups.delete (GRP-16)', () => {
  it('moves the group and its member sessions to 最近删除 and says so', async () => {
    const fixture = await open()
    fixture.api.sessions.create({ title: '另一个对话' })
    const { group } = await reviewGroup(fixture)
    const ids = sessionsOf(fixture, group.id).map((s) => s.id)
    expect(ids).toHaveLength(3)

    const result = await invokeCoreOperation(fixture.api, 'groups.delete', [
      { id: group.id },
    ])
    expect(result).toMatchObject({ id: group.id, deleted: true })
    expect(Date.parse(result.restorableUntil)).toBeGreaterThan(Date.now())

    expect(await invokeCoreOperation(fixture.api, 'groups.list', [])).toEqual(
      [],
    )
    expect(sessionsOf(fixture, group.id)).toEqual([])
    expect(trashed(fixture)).toEqual([...ids].sort())
    await expect(
      invokeCoreOperation(fixture.api, 'groups.get', [{ id: group.id }]),
    ).rejects.toMatchObject({ code: 'group_not_found' })
    expect(groupChanges(fixture).at(-1)).toEqual({
      reason: 'deleted',
      group_id: group.id,
    })
    // 最近删除 lists the group alone, as a group.
    expect(
      fixture.api.sessions
        .listDeleted()
        .map((item) => [item.id, item.title, item.surface]),
    ).toEqual([[group.id, '登录页评审', 'group']])
  })

  it('stops a running turn before the group goes', async () => {
    const fixture = await open({ replies: [{ hang: true }] })
    fixture.api.sessions.create({ title: '另一个对话' })
    const { group } = await reviewGroup(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    for (let i = 0; i < 50 && fixture.adapter.requests.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fixture.adapter.requests).toHaveLength(1)

    await invokeCoreOperation(fixture.api, 'groups.delete', [{ id: group.id }])
    await fixture.api.groups.settled(group.id)
    expect(
      fixture.events.filter((e) => e.event === 'group_turn_changed').at(-1),
    ).toMatchObject({ group_id: group.id, state: 'stopped' })
    expect(await invokeCoreOperation(fixture.api, 'groups.list', [])).toEqual(
      [],
    )
    // The stopped turn was written before the log moved to the trash.
    await fixture.api.sessions.restoreDeleted(group.id)
    const back = await invokeCoreOperation(fixture.api, 'groups.get', [
      { id: group.id },
    ])
    expect(back.turn).toMatchObject({ state: 'stopped' })
  })

  it('restores the group whole from 最近删除', async () => {
    const fixture = await open()
    fixture.api.sessions.create({ title: '另一个对话' })
    const { rev, group } = await reviewGroup(fixture)
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'broadcast', text: '大家好' },
    ])
    await fixture.api.groups.settled(group.id)
    const before = sessionsOf(fixture, group.id).map((s) => s.id)
    await invokeCoreOperation(fixture.api, 'groups.delete', [{ id: group.id }])

    const restored = await invokeCoreOperation(
      fixture.api,
      'sessions.restoreDeleted',
      [group.id],
    )
    expect(restored).toMatchObject({ id: group.id, surface: 'group' })
    expect(
      sessionsOf(fixture, group.id)
        .map((s) => s.id)
        .sort(),
    ).toEqual([...before].sort())
    expect(trashed(fixture)).toEqual([])
    expect(fixture.api.sessions.listDeleted()).toEqual([])
    const listed = await invokeCoreOperation(fixture.api, 'groups.list', [])
    expect(listed.map((g) => [g.id, g.memberCount])).toEqual([[group.id, 2]])
    const view = await invokeCoreOperation(fixture.api, 'groups.get', [
      { id: group.id },
    ])
    expect(view.members.map((m) => m.id)).toEqual(['ct-emperor', rev])
    for (const member of view.members)
      expect(before).toContain(member.memberSessionId)
    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    expect(history.messages.map((m) => m.text)).toContain('大家好')
    expect(groupChanges(fixture).at(-1)).toEqual({
      reason: 'restored',
      group_id: group.id,
    })
  })

  it('purging the group takes its member sessions and its files', async () => {
    const fixture = await open()
    fixture.api.sessions.create({ title: '另一个对话' })
    const { group } = await reviewGroup(fixture)
    const files = join(fixture.stateRoot, 'groups', group.id, 'files')
    mkdirSync(files, { recursive: true })
    writeFileSync(join(files, 'plan.md'), '# 方案\n')
    await invokeCoreOperation(fixture.api, 'groups.delete', [{ id: group.id }])
    // Its files stay while it can be restored.
    expect(existsSync(files)).toBe(true)

    await invokeCoreOperation(fixture.api, 'sessions.purgeDeleted', [group.id])
    expect(trashed(fixture)).toEqual([])
    expect(existsSync(join(fixture.stateRoot, 'groups', group.id))).toBe(false)
  })

  it('deletes a group whose sessions are the only ones', async () => {
    const fixture = await open()
    const { group } = await reviewGroup(fixture)
    expect(fixture.api.sessions.list({ includeArchived: true })).toHaveLength(3)
    await invokeCoreOperation(fixture.api, 'groups.delete', [{ id: group.id }])
    expect(fixture.api.sessions.list({ includeArchived: true })).toEqual([])
    expect(trashed(fixture)).toHaveLength(3)
  })

  it('answers group_not_found for an unknown id or a session that is not a group', async () => {
    const fixture = await open()
    const chat = fixture.api.sessions.create({ title: 'Chat' })
    fixture.api.sessions.create({ title: '另一个对话' })
    await expect(
      invokeCoreOperation(fixture.api, 'groups.delete', [{ id: 'grp-nope' }]),
    ).rejects.toMatchObject({ code: 'group_not_found' })
    await expect(
      invokeCoreOperation(fixture.api, 'groups.delete', [
        { id: String(chat.id) },
      ]),
    ).rejects.toMatchObject({ code: 'group_not_found' })
    expect(fixture.api.sessions.list().map((s) => s.id)).toContain(chat.id)
    expect(trashed(fixture)).toEqual([])
  })
})

describe('contacts.delete and the groups (GRP-16)', () => {
  it('a deleted contact leaves its groups; what it said stays', async () => {
    const fixture = await open({ replies: [{ text: '先修溢出' }] })
    const { rev, group } = await reviewGroup(fixture)
    const other = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '只有 Emperor', members: ['ct-emperor'] },
    ])
    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 看看' },
    ])
    await fixture.api.groups.settled(group.id)
    const changesBefore = groupChanges(fixture).length

    await invokeCoreOperation(fixture.api, 'contacts.delete', [{ id: rev }])

    const view = await invokeCoreOperation(fixture.api, 'groups.get', [
      { id: group.id },
    ])
    expect(view.members.map((m) => m.id)).toEqual(['ct-emperor'])
    expect(view.moderator).toBeNull()
    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    expect(history.messages.map((m) => [m.from, m.text])).toEqual([
      ['user', '@审稿人 看看'],
      ['ct-emperor', '已请审稿人回答。'],
      [rev, '先修溢出'],
    ])
    expect(groupChanges(fixture).slice(changesBefore)).toEqual([
      { reason: 'member', group_id: group.id },
    ])
    // Its member session stays (read-only, contact_deleted).
    expect(
      sessionsOf(fixture, group.id).filter(
        (s) => (s as { contact_id?: string }).contact_id === rev,
      ),
    ).toHaveLength(1)
    const untouched = await invokeCoreOperation(fixture.api, 'groups.get', [
      { id: other.id },
    ])
    expect(untouched.members.map((m) => m.id)).toEqual(['ct-emperor'])
  })

  it('a contact still listed after it was deleted shows as missing', async () => {
    const fixture = await open()
    const { rev, group } = await reviewGroup(fixture)
    // A group written before GRP-16 kept a deleted contact as a member:
    // delete the contact behind the groups' back.
    await fixture.api.contactStore.delete(rev)
    const view = await invokeCoreOperation(fixture.api, 'groups.get', [
      { id: group.id },
    ])
    expect(view.members.find((m) => m.id === rev)).toMatchObject({
      missing: true,
    })
  })

  it('refuses to delete a builtin contact and leaves its groups alone', async () => {
    const fixture = await open()
    const { group } = await reviewGroup(fixture)
    await expect(
      invokeCoreOperation(fixture.api, 'contacts.delete', [
        { id: 'ct-emperor' },
      ]),
    ).rejects.toMatchObject({ code: 'contact_builtin' })
    const view = await invokeCoreOperation(fixture.api, 'groups.get', [
      { id: group.id },
    ])
    expect(view.members.map((m) => m.id)).toContain('ct-emperor')
    expect(view.moderator).toBeNull()
  })
})
