// CG-03 in the production Core runtime: real background member turns, host
// artifact submission, independent stop commands and restart recovery.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replyChunks } from '../harness/testing'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp, waitFor, type ApiFixture } from './test-helpers'

const fixtures: ApiFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

async function open(options: Parameters<typeof makeApi>[0] = {}) {
  const fixture = await makeApi(options)
  fixtures.push(fixture)
  return fixture
}

async function member(fixture: ApiFixture, name: string): Promise<string> {
  return (
    await invokeCoreOperation(fixture.api, 'contacts.create', [
      {
        name,
        intro: `${name}的独立工作`,
        capabilities: { tools: { preset: 'writer' } },
      },
    ])
  ).id
}

async function groupWith(
  fixture: ApiFixture,
  members: string[],
): Promise<{
  id: string
  members: Array<{ id: string; memberSessionId: string | null }>
}> {
  return invokeCoreOperation(fixture.api, 'groups.create', [
    { title: '后台工作', members },
  ])
}

async function sendWork(
  fixture: ApiFixture,
  groupId: string,
  to: string,
  title = '生成公开报告',
) {
  return invokeCoreOperation(fixture.api, 'groups.send', [
    {
      id: groupId,
      way: 'task',
      text: title,
      to,
      task: {
        title,
        deliverable: '一份可复核的公开报告',
        access: 'group_files',
        acceptance: ['报告已发布', '检查有依据'],
        writeScopes: [`members/${to}`],
      },
    },
  ])
}

describe('production group work runtime (CG-03)', () => {
  it('runs a real member turn and publishes its candidate through the host tool', async () => {
    const fixture = await open({
      replies: [
        {
          tools: [
            {
              name: 'write',
              args: {
                file_path: 'report.md',
                content: '# 报告\n\n真实后台成果。\n',
              },
            },
          ],
        },
        {
          tools: [
            {
              name: 'group_task_submit',
              args: {
                sourcePath: 'report.md',
                checks: [{ evidenceRef: 'write:report.md', passed: true }],
              },
            },
          ],
        },
      ],
    })
    const rev = await member(fixture, '执行者')
    const group = await groupWith(fixture, [rev])
    const sent = await sendWork(fixture, group.id, rev)
    await fixture.api.groups.settled(group.id)
    const task = fixture.api.groupService
      .state(group.id)
      .tasks.get(sent.message.task!.taskId)!
    expect(task.state).toBe('done')
    expect(task.activeRunId).toBeUndefined()
    expect(task.artifacts).toHaveLength(1)
    expect(task.checks).toEqual([
      {
        artifactRevision: task.artifacts![0]!.revision,
        evidenceRef: 'write:report.md',
        passed: true,
      },
    ])
    const chain = fixture.api.groupService
      .history(group.id)
      .messages.filter((message) => message.task?.taskId === task.taskId)
    expect(chain.map((message) => message.kind)).toEqual([
      'task',
      'say',
      'say',
      'result',
    ])
    expect(chain[1]).toMatchObject({
      from: 'ct-emperor',
      text: '已把「生成公开报告」交给执行者。',
    })
    expect(chain[2]).toMatchObject({
      from: rev,
      text: '收到，我来做「生成公开报告」。',
      task: { taskId: task.taskId, attempt: 1 },
    })
    expect(chain[3]).toMatchObject({
      from: rev,
      task: { taskId: task.taskId, attempt: 1, state: 'done' },
    })
    expect(chain[3]!.text).toContain('1 项检查通过')
    expect(fixture.api.groupService.get(group.id).turn?.spend.tokens).toBe(30)
    const artifact = fixture.api.groupService
      .workspace(group.id)
      .artifacts.find((item) => item.taskId === task.taskId)!
    expect(artifact).toBeDefined()
    expect(
      readFileSync(
        join(fixture.api.paths.stateRoot, 'groups', group.id, artifact.path),
        'utf8',
      ),
    ).toContain('真实后台成果')
    const workRequest = fixture.adapter.requests.find((request) =>
      request.messages.some((message) =>
        JSON.stringify(message).includes('生成公开报告'),
      ),
    )!
    expect(workRequest.tools?.map((tool) => tool.name)).toContain(
      'group_task_submit',
    )
  })

  it("publishes a readonly local member's final report through the host", async () => {
    const fixture = await open({
      replies: [{ text: '# 合肥行程核实\n\n场地与交通均已核实。\n' }],
    })
    const researcher = (
      await invokeCoreOperation(fixture.api, 'contacts.create', [
        {
          name: '只读研究员',
          intro: '检索资料并交付报告',
          capabilities: {
            tools: { preset: 'research' },
            permission: 'read_only',
          },
        },
      ])
    ).id
    const group = await groupWith(fixture, [researcher])
    const sent = await invokeCoreOperation(fixture.api, 'groups.send', [
      {
        id: group.id,
        way: 'task',
        text: '核实生日行程',
        to: researcher,
        task: {
          title: '核实生日行程',
          deliverable: '一份公开核实报告',
          access: 'readonly',
          acceptance: ['报告内容完整'],
        },
      },
    ])
    await fixture.api.groups.settled(group.id)
    const task = fixture.api.groupService
      .state(group.id)
      .tasks.get(sent.message.task!.taskId)!
    expect(task.state).toBe('done')
    expect(task.artifacts).toHaveLength(1)
    const artifact = fixture.api.groupService
      .workspace(group.id)
      .artifacts.find((item) => item.taskId === task.taskId)!
    expect(
      readFileSync(
        join(fixture.api.paths.stateRoot, 'groups', group.id, artifact.path),
        'utf8',
      ),
    ).toContain('场地与交通均已核实')
    const request = fixture.adapter.requests.find((candidate) =>
      candidate.messages.some((message) =>
        JSON.stringify(message).includes('核实生日行程'),
      ),
    )!
    expect(JSON.stringify(request.messages)).toContain('直接回复完整成果')
    expect(JSON.stringify(request.messages)).not.toContain(
      '使用 group_task_submit',
    )
  })

  it('refuses a real file-writing task before running a readonly member', async () => {
    const fixture = await open({ replies: [{ text: '不应执行' }] })
    const researcher = (
      await invokeCoreOperation(fixture.api, 'contacts.create', [
        {
          name: '只读研究员',
          intro: '只读研究',
          capabilities: {
            tools: { preset: 'research' },
            permission: 'read_only',
          },
        },
      ])
    ).id
    const group = await groupWith(fixture, [researcher])
    const sent = await sendWork(fixture, group.id, researcher, '写入报告文件')
    await fixture.api.groups.settled(group.id)
    expect(
      fixture.api.groupService
        .state(group.id)
        .tasks.get(sent.message.task!.taskId)!,
    ).toMatchObject({
      state: 'failed',
      problem: { kind: 'adapter', reason: 'readonly' },
    })
    expect(
      fixture.adapter.requests.some((request) =>
        request.messages.some((message) =>
          JSON.stringify(message).includes('写入报告文件'),
        ),
      ),
    ).toBe(false)
    expect(
      fixture.api.groupService.history(group.id).messages.at(-1),
    ).toMatchObject({
      from: 'ct-emperor',
      kind: 'say',
      task: { taskId: sent.message.task!.taskId, state: 'failed' },
    })
    expect(
      fixture.api.groupService.history(group.id).messages.at(-1)!.text,
    ).toContain('只有只读权限，已在执行前停止')
  })

  it('finishes a short speech during a long task and stops the two queues separately', async () => {
    const fixture = await open({
      replies: [{ hang: true }, { text: '短回答已完成' }],
    })
    const rev = await member(fixture, '执行者')
    const res = await member(fixture, '回答者')
    const group = await groupWith(fixture, [rev, res])
    const sent = await sendWork(fixture, group.id, rev, '长任务')
    await waitFor(() => fixture.adapter.requests.length === 1)
    expect(
      await invokeCoreOperation(fixture.api, 'groups.stop', [{ id: group.id }]),
    ).toEqual({ stopped: false })
    expect(
      fixture.api.groupService
        .state(group.id)
        .tasks.get(sent.message.task!.taskId)!.state,
    ).toBe('running')

    await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@回答者 现在回答' },
    ])
    await fixture.api.groupScheduler.settled(group.id)
    expect(
      fixture.api.groupService.state(group.id).messages.at(-1),
    ).toMatchObject({
      from: res,
      text: '短回答已完成',
    })
    expect(
      fixture.api.groupService
        .state(group.id)
        .messages.filter(
          (message) => message.from === res && message.text.startsWith('收到'),
        ),
    ).toHaveLength(0)
    expect(
      fixture.api.groupService
        .state(group.id)
        .tasks.get(sent.message.task!.taskId)!.state,
    ).toBe('running')

    expect(
      await invokeCoreOperation(fixture.api, 'groups.stopWork', [
        { id: group.id },
      ]),
    ).toEqual({ requested: 1 })
    await fixture.api.groups.settled(group.id)
    expect(
      fixture.api.groupService
        .state(group.id)
        .tasks.get(sent.message.task!.taskId)!.state,
    ).toBe('cancelled')
  })

  it('records usage already spent by a failed background task', async () => {
    const fixture = await open({
      replies: [
        {
          tools: [
            {
              name: 'write',
              args: { file_path: 'failed.md', content: '已产生用量' },
            },
          ],
        },
        [
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
          {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'quota exhausted', code: 'QUOTA' },
            },
          },
        ],
      ],
    })
    const rev = await member(fixture, '执行者')
    const group = await groupWith(fixture, [rev])
    const sent = await sendWork(fixture, group.id, rev, '会失败的任务')
    await fixture.api.groups.settled(group.id)
    expect(
      fixture.api.groupService
        .state(group.id)
        .tasks.get(sent.message.task!.taskId)!.state,
    ).toBe('failed')
    expect(fixture.api.groupService.get(group.id).turn?.spend.tokens).toBe(15)
  })

  it('keeps late background spend on its original turn after a newer turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((done) => (release = done))
    const fixture = await open({
      replies: [
        async () => {
          await gate
          return replyChunks({
            tools: [
              {
                name: 'write',
                args: { file_path: 'late.md', content: '迟到成果' },
              },
            ],
          })
        },
        { text: '新回合的回答' },
      ],
    })
    const rev = await member(fixture, '执行者')
    const res = await member(fixture, '回答者')
    const group = await groupWith(fixture, [rev, res])
    const sent = await sendWork(fixture, group.id, rev, '迟到任务')
    const originalTurnId = sent.message.turnId
    await waitFor(() => fixture.adapter.requests.length === 1)

    const newer = await invokeCoreOperation(fixture.api, 'groups.send', [
      { id: group.id, way: 'mention', text: '@回答者 先回答新回合' },
    ])
    await fixture.api.groupScheduler.settled(group.id)
    expect(fixture.api.groupService.get(group.id).turn).toMatchObject({
      turnId: newer.message.turnId,
      spend: { tokens: 15 },
    })

    fixture.adapter.push({
      tools: [
        {
          name: 'group_task_submit',
          args: {
            sourcePath: 'late.md',
            checks: [{ evidenceRef: 'write:late.md', passed: true }],
          },
        },
      ],
    })
    release()
    await fixture.api.groups.settled(group.id)

    const originalEvents = (
      fixture.api.host.sessionLog(group.id)?.events ?? []
    ).filter(
      (event) =>
        event.type === 'group/turn' && event.data.turnId === originalTurnId,
    )
    expect(originalEvents.at(-1)?.data).toMatchObject({
      spend: { tokens: 30 },
    })
    expect(fixture.api.groupService.get(group.id).turn).toMatchObject({
      turnId: newer.message.turnId,
      spend: { tokens: 15 },
    })
    expect(
      fixture.events.filter(
        (event) =>
          event.event === 'group_turn_changed' &&
          event.turn_id === originalTurnId &&
          (event.spend as { tokens?: number } | undefined)?.tokens === 30,
      ),
    ).toHaveLength(0)
  })

  it('marks a persisted active task unknown after restart without running it again', async () => {
    const root = tmp('emperor-group-work-restart-')
    const stateRoot = join(root, 'home')
    const first = await open({ stateRoot })
    const rev = await member(first, '执行者')
    const group = await groupWith(first, [rev])
    first.api.groupService.append(group.id, 'group/task', {
      taskId: 'gt-before-restart',
      to: rev,
      title: '重启前任务',
      deliverable: '报告',
      access: 'readonly',
      acceptance: ['可复核'],
      state: 'running',
      attempt: 1,
      leaseEpoch: 1,
      activeRunId: 'gwr-before-restart',
    })
    await first.api.close()
    fixtures.splice(fixtures.indexOf(first), 1)

    const again = await open({ stateRoot })
    const task = again.api.groupService
      .state(group.id)
      .tasks.get('gt-before-restart')!
    expect(task).toMatchObject({
      state: 'failed',
      problem: { kind: 'unknown', reason: 'app_restart' },
    })
    expect(task.activeRunId).toBeUndefined()
    expect(again.adapter.requests).toHaveLength(0)
  })
})
