// GRP-06: the groups operations on the Core registry — a group and its
// member sessions are created on disk, what the user sends is logged with
// its speaking plan, the log survives a restart, and every change is
// announced as `groups_changed`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_EVENT_NAMES } from '../harness/projection/wire-names'
import { coreOperationKeys, invokeCoreOperation } from './operations'
import { makeApi, tmp, type ApiFixture } from './test-helpers'

const GROUP_OPERATIONS = [
  'groups.addMember',
  'groups.create',
  'groups.files.list',
  'groups.get',
  'groups.history',
  'groups.list',
  'groups.removeMember',
  'groups.send',
  'groups.stop',
  'groups.update',
]

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function open(stateRoot?: string) {
  const fixture = await makeApi(stateRoot ? { stateRoot } : {})
  fixtures.push(fixture)
  return fixture
}

async function reviewer(fixture: ApiFixture): Promise<string> {
  const created = await invokeCoreOperation(fixture.api, 'contacts.create', [
    { name: '审稿人', intro: '代码与方案评审' },
  ])
  return created.id
}

describe('groups operations', () => {
  it('registers the groups operations and the groups_changed event', () => {
    expect(
      coreOperationKeys().filter((key) => key.startsWith('groups.')),
    ).toEqual(GROUP_OPERATIONS)
    expect(RUNTIME_EVENT_NAMES).toContain('groups_changed')
  })

  it('creates a group with a session per member and logs what the user sends', async () => {
    const fixture = await open()
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '登录页改版', members: ['ct-emperor', rev] },
    ])
    expect(group).toMatchObject({
      title: '登录页改版',
      moderator: 'ct-emperor',
    })
    const sessions = fixture.api.sessions.list() as Array<{
      id: string
      surface?: string
      contact_id?: string
      group_id?: string
    }>
    expect(sessions.find((s) => s.id === group.id)).toMatchObject({
      surface: 'group',
      group_id: group.id,
    })
    expect(
      sessions
        .filter((s) => s.surface === 'group_member')
        .map((s) => [s.contact_id, s.group_id]),
    ).toEqual([
      ['ct-emperor', group.id],
      [rev, group.id],
    ])

    const sent = await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@审稿人 先看看' },
    ])
    expect(sent.message.ask).toEqual([rev])
    expect(sent.plan).toEqual([
      { kind: 'speak', member: rev, reason: 'asked', source: sent.message.id },
    ])
    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    expect(history.messages.map((m) => m.text)).toEqual(['@审稿人 先看看'])
    expect(
      fixture.events
        .filter((e) => e.event === 'groups_changed')
        .map((e) => e.reason),
    ).toEqual(['created', 'message'])
  })

  it('keeps the group after a restart', async () => {
    const root = tmp('emperor-groups-')
    const stateRoot = join(root, 'home')
    const first = await open(stateRoot)
    const rev = await reviewer(first)
    const group = await invokeCoreOperation(first.api, 'groups.create', [
      { title: '评审', members: [rev] },
    ])
    await invokeCoreOperation(first.api, 'groups.send', [
      { id: group.id, way: 'broadcast', text: '大家好' },
    ])
    await first.api.close()
    fixtures.splice(fixtures.indexOf(first), 1)

    const again = await open(stateRoot)
    const listed = await invokeCoreOperation(again.api, 'groups.list', [])
    expect(listed.map((g) => [g.title, g.memberCount])).toEqual([['评审', 1]])
    const history = await invokeCoreOperation(again.api, 'groups.history', [
      { id: group.id },
    ])
    expect(history.messages.map((m) => m.text)).toEqual(['大家好'])
  })

  it('updates, adds and removes members through the registry', async () => {
    const fixture = await open()
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '评审', members: [rev] },
    ])
    const added = await invokeCoreOperation(fixture.api, 'groups.addMember', [
      { id: group.id, contactId: 'ct-emperor' },
    ])
    expect(added.members.map((m) => m.id)).toEqual([rev, 'ct-emperor'])
    const updated = await invokeCoreOperation(fixture.api, 'groups.update', [
      {
        id: group.id,
        patch: { charter: '两周上线', settings: { quiet: true } },
      },
    ])
    expect(updated).toMatchObject({ charter: '两周上线' })
    expect(updated.settings.quiet).toBe(true)
    const removed = await invokeCoreOperation(
      fixture.api,
      'groups.removeMember',
      [{ id: group.id, contactId: rev }],
    )
    expect(removed.members.map((m) => m.id)).toEqual(['ct-emperor'])
  })

  it('lists the group files, none at first', async () => {
    const fixture = await open()
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '评审', members: [rev] },
    ])
    expect(
      await invokeCoreOperation(fixture.api, 'groups.files.list', [
        { id: group.id },
      ]),
    ).toEqual({ files: [] })
    const dir = join(fixture.api.paths.stateRoot, 'groups', group.id, 'files')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plan.md'), '# 方案\n')
    const { files } = await invokeCoreOperation(
      fixture.api,
      'groups.files.list',
      [{ id: group.id }],
    )
    expect(files).toEqual([
      expect.objectContaining({ name: 'plan.md', size: 9 }),
    ])
  })

  it('answers group_not_found for a session that is not a group', async () => {
    const fixture = await open()
    const chat = fixture.api.sessions.create({ title: 'Chat' })
    await expect(
      invokeCoreOperation(fixture.api, 'groups.get', [{ id: String(chat.id) }]),
    ).rejects.toMatchObject({ code: 'group_not_found' })
  })
})
