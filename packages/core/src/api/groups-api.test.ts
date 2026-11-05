// GRP-06: the groups operations on the Core registry — a group and its
// member sessions are created on disk, what the user sends is logged with
// its speaking plan, the log survives a restart, and every change is
// announced as `groups_changed`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_EVENT_NAMES } from '../harness/projection/wire-names'
import { coreOperationKeys, invokeCoreOperation } from './operations'
import { makeApi, tmp, waitFor, type ApiFixture } from './test-helpers'

const GROUP_OPERATIONS = [
  'groups.acceptTask',
  'groups.addMember',
  'groups.claimTask',
  'groups.confirmTask',
  'groups.create',
  'groups.defaults',
  'groups.delete',
  'groups.files.list',
  'groups.get',
  'groups.history',
  'groups.list',
  'groups.publishArtifact',
  'groups.removeMember',
  'groups.send',
  'groups.setDefaults',
  'groups.stop',
  'groups.stopWork',
  'groups.submitTask',
  'groups.tasks',
  'groups.transferTask',
  'groups.update',
  'groups.workspace',
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
      moderator: null,
      settings: expect.objectContaining({ coordination: 'builtin' }),
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
    const memberSessions = sessions.filter((s) => s.surface === 'group_member')
    // Listing is recency-ordered; second-precision creation ties have no order.
    expect(memberSessions).toHaveLength(2)
    expect(memberSessions.map((s) => [s.contact_id, s.group_id])).toEqual(
      expect.arrayContaining([
        ['ct-emperor', group.id],
        [rev, group.id],
      ]),
    )

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
    expect(history.messages.map((m) => m.text)).toEqual([
      '@审稿人 先看看',
      '已请审稿人回答。',
    ])
    expect(
      fixture.events
        .filter((e) => e.event === 'groups_changed')
        .map((e) => e.reason),
    ).toEqual(['created', 'message', 'message'])
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
    expect(listed.map((g) => [g.title, g.memberCount])).toEqual([['评审', 2]])
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
    const architect = (
      await invokeCoreOperation(fixture.api, 'contacts.create', [
        { name: '架构师', intro: '系统设计' },
      ])
    ).id
    const added = await invokeCoreOperation(fixture.api, 'groups.addMember', [
      { id: group.id, contactId: architect },
    ])
    expect(added.members.map((m) => m.id)).toEqual([
      'ct-emperor',
      rev,
      architect,
    ])
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
    expect(removed.members.map((m) => m.id)).toEqual(['ct-emperor', architect])
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

  it('CG-01: creates real member roots and publishes artifacts through Core', async () => {
    const fixture = await open()
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '讨论群', members: ['ct-emperor', rev] },
    ])
    const workspace = await invokeCoreOperation(
      fixture.api,
      'groups.workspace',
      [{ id: group.id }],
    )
    const own = join(workspace.root, 'members', rev)
    writeFileSync(join(own, 'result.md'), '# 结果\n')
    const member = group.members.find((item: { id: string }) => item.id === rev)
    const agent = fixture.api['host'].agentFor(member!.memberSessionId!)
    expect(agent.session.cwd).toBe(own)
    const policy = fixture.api['host'].sandbox.resolve({
      session: agent.session,
    })
    expect(policy.readOnlyRoots).toContain(workspace.shared)
    expect(policy.deniedRoots).toContain(
      join(workspace.root, 'members', 'ct-emperor'),
    )
    const artifact = await invokeCoreOperation(
      fixture.api,
      'groups.publishArtifact',
      [{ id: group.id, contactId: rev, sourcePath: join(own, 'result.md') }],
    )
    expect(artifact.artifactRef).toContain(`artifact://${group.id}/art-`)
    const { files } = await invokeCoreOperation(
      fixture.api,
      'groups.files.list',
      [{ id: group.id }],
    )
    expect(files).toContainEqual(
      expect.objectContaining({
        name: 'result.md',
        artifactRef: artifact.artifactRef,
      }),
    )
    await invokeCoreOperation(fixture.api, 'groups.removeMember', [
      { id: group.id, contactId: rev },
    ])
    const removed = fixture.api.groupService.memberWorkspace(group.id, rev)
    expect(removed.readOnlyRoots).toContain(own)
  })

  it("rejects a task that declares another member's private write scope", async () => {
    const fixture = await makeApi({ replies: [{ hang: true }] })
    fixtures.push(fixture)
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '目录边界', members: ['ct-emperor', rev] },
    ])
    await expect(
      invokeCoreOperation(fixture.api, 'groups.send', [
        {
          id: group.id,
          way: 'task',
          text: '越界写入',
          to: rev,
          task: {
            title: '越界写入',
            deliverable: '不应执行',
            access: 'group_files',
            writeScopes: ['members/ct-emperor/report.md'],
          },
        },
      ]),
    ).rejects.toMatchObject({ code: 'group_invalid' })
    expect(fixture.api.groupService.state(group.id).tasks.size).toBe(0)
  })

  it('CG-02/CG-03: exposes one idempotent, automatically claimed task board', async () => {
    const fixture = await makeApi({ replies: [{ hang: true }, { hang: true }] })
    fixtures.push(fixture)
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '任务契约', members: ['ct-emperor', rev] },
    ])
    const sent = await invokeCoreOperation(fixture.api, 'groups.send', [
      {
        id: group.id,
        way: 'task',
        text: '准备报告',
        to: rev,
        task: {
          title: '准备报告',
          deliverable: '可复核报告',
          access: 'readonly',
          idempotencyKey: 'api-task-1',
          acceptance: ['证据通过'],
          dependsOn: [],
          writeScopes: ['members/' + rev],
        },
      },
    ])
    const taskId = sent.message.task!.taskId
    const replay = await invokeCoreOperation(fixture.api, 'groups.send', [
      {
        id: group.id,
        way: 'task',
        text: '准备报告',
        to: rev,
        task: {
          title: '准备报告',
          deliverable: '可复核报告',
          access: 'readonly',
          idempotencyKey: 'api-task-1',
        },
      },
    ])
    expect(replay.message.id).toBe(sent.message.id)
    expect(replay.plan).toEqual([])
    const moved = await invokeCoreOperation(
      fixture.api,
      'groups.transferTask',
      [{ id: group.id, taskId, to: 'ct-emperor', contractRevision: 1 }],
    )
    await waitFor(() => {
      const task = fixture.api.groupService.state(group.id).tasks.get(taskId)
      return task?.to === 'ct-emperor' && task.state === 'running'
    })
    const claimed = fixture.api.groupService.state(group.id).tasks.get(taskId)!
    // The work scheduler owns the new attempt; a competing API claim is atomic.
    await expect(
      invokeCoreOperation(fixture.api, 'groups.claimTask', [
        {
          id: group.id,
          taskId,
          owner: 'ct-emperor',
          contractRevision: moved.contractRevision,
          runId: 'api-run-1',
        },
      ]),
    ).rejects.toThrow(/不能接单/)
    const completed = await invokeCoreOperation(
      fixture.api,
      'groups.submitTask',
      [
        {
          id: group.id,
          taskId,
          owner: 'ct-emperor',
          attempt: claimed.attempt,
          leaseEpoch: claimed.leaseEpoch,
          artifact: { ref: 'artifact://report', revision: 'report-1' },
          checks: [
            {
              artifactRevision: 'report-1',
              evidenceRef: 'api-check-1',
              passed: true,
            },
          ],
        },
      ],
    )
    expect(completed.state).toBe('done')
    const board = await invokeCoreOperation(fixture.api, 'groups.tasks', [
      { id: group.id },
    ])
    expect(board).toHaveLength(1)
    expect(board[0]).toMatchObject({ taskId, state: 'done', ready: false })
    const history = await invokeCoreOperation(fixture.api, 'groups.history', [
      { id: group.id },
    ])
    const chain = history.messages.filter(
      (message: { task?: { taskId: string } }) =>
        message.task?.taskId === taskId,
    )
    expect(chain.map((message: { kind: string }) => message.kind)).toEqual([
      'task',
      'say',
      'say',
      'say',
      'result',
    ])
    const acknowledgements = fixture.api.groupService
      .state(group.id)
      .messages.filter(
        (message) =>
          message.kind === 'say' &&
          message.text.startsWith('收到，我来做') &&
          message.task?.taskId === taskId,
      )
    expect(acknowledgements.map((message) => message.task?.attempt)).toEqual([
      1, 2,
    ])
    expect(new Set(acknowledgements.map((message) => message.id)).size).toBe(2)
  })

  it('answers group_not_found for a session that is not a group', async () => {
    const fixture = await open()
    const chat = fixture.api.sessions.create({ title: 'Chat' })
    await expect(
      invokeCoreOperation(fixture.api, 'groups.get', [{ id: String(chat.id) }]),
    ).rejects.toMatchObject({ code: 'group_not_found' })
  })

  it('refuses to confirm a task that is not waiting for the user (GRP-09)', async () => {
    const fixture = await open()
    const rev = await reviewer(fixture)
    const group = await invokeCoreOperation(fixture.api, 'groups.create', [
      { title: '评审', members: [rev] },
    ])
    await expect(
      invokeCoreOperation(fixture.api, 'groups.confirmTask', [
        { id: group.id, taskId: 'gt_nope', approve: true },
      ]),
    ).rejects.toMatchObject({ code: 'group_invalid' })
  })
})
