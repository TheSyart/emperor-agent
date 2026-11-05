// CG-02: one GroupTask fact in the group log. Dependencies, exclusive
// claims, candidate submissions and acceptance never create a second store.
import { describe, expect, it } from 'vitest'
import { foldGroupEvents } from './events'
import type { GroupService } from './service'
import { memoryGroups } from './test-fixture'
import type { GroupTask } from './types'

function setup() {
  const fixture = memoryGroups()
  const view = fixture.service.create({
    title: '可靠分工',
    members: ['ct-arch', 'ct-rev'],
  })
  return { ...fixture, id: view.id }
}

function task(
  service: GroupService,
  id: string,
  title: string,
  extra: Partial<{
    idempotencyKey: string
    acceptance: string[]
    dependsOn: string[]
    writeScopes: string[]
  }> = {},
) {
  return service.send(id, {
    way: 'task',
    text: title,
    to: 'ct-arch',
    task: {
      title,
      deliverable: `${title}的成果`,
      access: 'readonly',
      ...extra,
    },
  })
}

function current(service: GroupService, id: string, taskId: string): GroupTask {
  const value = service.state(id).tasks.get(taskId)
  if (!value) throw new Error(`missing task ${taskId}`)
  return value
}

describe('GroupTask board (CG-02)', () => {
  it('replays a legacy task without adding contract or lease fields', () => {
    const legacy: GroupTask = {
      taskId: 'gt-old',
      to: 'ct-arch',
      title: '旧任务',
      deliverable: '旧成果',
      access: 'readonly',
      state: 'done',
    }
    const state = foldGroupEvents([{ type: 'group/task', data: legacy }])
    expect(state.tasks.get('gt-old')).toEqual(legacy)
  })

  it('lets only one competing claim start an attempt', () => {
    const { service, id } = setup()
    const { message } = task(service, id, '独占执行')
    const taskId = message.task!.taskId
    const claimed = service.claimTask(id, {
      taskId,
      owner: 'ct-arch',
      contractRevision: 1,
      runId: 'run-1',
    })
    expect(claimed).toMatchObject({
      state: 'running',
      attempt: 1,
      leaseEpoch: 1,
      activeRunId: 'run-1',
    })
    expect(() =>
      service.claimTask(id, {
        taskId,
        owner: 'ct-arch',
        contractRevision: 1,
        runId: 'run-2',
      }),
    ).toThrow(/不能接单/)
    expect(current(service, id, taskId).activeRunId).toBe('run-1')
  })

  it('deduplicates delivery by idempotency key without a second message or task', () => {
    const { service, id } = setup()
    const first = task(service, id, '只建一次', {
      idempotencyKey: 'request-7',
    })
    const accepted = service.state(id).messages.map((message) => message.id)
    const second = task(service, id, '只建一次', {
      idempotencyKey: 'request-7',
    })
    expect(second.message.id).toBe(first.message.id)
    expect(second.plan).toEqual([])
    expect(service.state(id).messages.map((message) => message.id)).toEqual(
      accepted,
    )
    expect(
      service.state(id).messages.filter((m) => m.from === 'user' && m.task),
    ).toHaveLength(1)
    expect(service.state(id).tasks).toHaveLength(1)
  })

  it('keeps a dependent task unready until every dependency is accepted', () => {
    const { service, id } = setup()
    const first = task(service, id, '先完成')
    const second = task(service, id, '后执行', {
      dependsOn: [first.message.task!.taskId],
      acceptance: ['结果可复核'],
    })
    const secondId = second.message.task!.taskId
    expect(second.plan).toEqual([])
    expect(service.tasks(id).find((t) => t.taskId === secondId)?.ready).toBe(
      false,
    )
    service.append(id, 'group/task', {
      ...first.message.task!,
      state: 'done',
    })
    expect(service.tasks(id).find((t) => t.taskId === secondId)?.ready).toBe(
      true,
    )
  })

  it('refuses a dependency graph with a cycle', () => {
    const { service, id } = setup()
    const a = task(service, id, 'A').message.task!
    const b = task(service, id, 'B').message.task!
    service.append(id, 'group/task', { ...a, dependsOn: [b.taskId] })
    service.append(id, 'group/task', { ...b, dependsOn: [a.taskId] })
    expect(() => task(service, id, 'C', { dependsOn: [a.taskId] })).toThrow(
      /循环依赖/,
    )
  })

  it('rejects a stale contract revision instead of starting it', () => {
    const { service, id } = setup()
    const { message } = task(service, id, '版本检查')
    const taskId = message.task!.taskId
    service.transferTask(id, {
      taskId,
      to: 'ct-rev',
      contractRevision: 1,
    })
    expect(() =>
      service.claimTask(id, {
        taskId,
        owner: 'ct-rev',
        contractRevision: 1,
        runId: 'stale-run',
      }),
    ).toThrow(/版本过期/)
    expect(current(service, id, taskId).state).toBe('queued')
  })

  it('completes a valid submission autonomously and emits one task-linked delivery', () => {
    const { service, id } = setup()
    const { message } = task(service, id, '提交验收', {
      acceptance: ['测试通过'],
    })
    const taskId = message.task!.taskId
    const claimed = service.claimTask(id, {
      taskId,
      owner: 'ct-arch',
      contractRevision: 1,
      runId: 'run-submit',
    })
    const submitted = service.submitTask(id, {
      taskId,
      owner: 'ct-arch',
      attempt: claimed.attempt!,
      leaseEpoch: claimed.leaseEpoch!,
      artifact: { ref: 'artifact://report', revision: 'rev-1' },
      checks: [
        { artifactRevision: 'rev-1', evidenceRef: 'test-1', passed: true },
      ],
    })
    expect(submitted.state).toBe('done')
    expect(submitted.activeRunId).toBeUndefined()
    const chain = service
      .history(id)
      .messages.filter((entry) => entry.task?.taskId === taskId)
    expect(chain.map((entry) => entry.kind)).toEqual([
      'task',
      'say',
      'say',
      'result',
    ])
    expect(chain[1]).toMatchObject({ from: 'ct-emperor', kind: 'say' })
    expect(chain[2]).toMatchObject({
      from: 'ct-arch',
      text: '收到，我来做「提交验收」。',
      replyTo: message.id,
      task: { attempt: 1 },
    })
    expect(chain[3]).toMatchObject({
      from: 'ct-arch',
      replyTo: message.id,
      task: { attempt: 1, state: 'done' },
    })
    expect(chain[3]!.text).toContain('1 项检查通过')
    expect(chain[3]!.text).not.toContain('tool')
  })

  it('revokes the old owner and lease on transfer', () => {
    const { service, id } = setup()
    const { message } = task(service, id, '移交任务')
    const taskId = message.task!.taskId
    const claimed = service.claimTask(id, {
      taskId,
      owner: 'ct-arch',
      contractRevision: 1,
      runId: 'run-old',
    })
    const moved = service.transferTask(id, {
      taskId,
      to: 'ct-rev',
      contractRevision: 1,
    })
    expect(moved).toMatchObject({
      to: 'ct-rev',
      state: 'queued',
      contractRevision: 2,
    })
    expect(moved.activeRunId).toBeUndefined()
    expect(() =>
      service.submitTask(id, {
        taskId,
        owner: 'ct-arch',
        attempt: claimed.attempt!,
        leaseEpoch: claimed.leaseEpoch!,
        artifact: { ref: 'artifact://late', revision: 'late-1' },
      }),
    ).toThrow(/负责人|执行权/)
    expect(current(service, id, taskId).artifacts).toBeUndefined()
  })

  it('keeps candidate check evidence with the submitted artifact for review', () => {
    const { service, id } = setup()
    const { message } = task(service, id, '候选证据', {
      acceptance: ['检查可复核'],
    })
    const taskId = message.task!.taskId
    const claimed = service.claimTask(id, {
      taskId,
      owner: 'ct-arch',
      contractRevision: 1,
      runId: 'run-evidence',
    })
    const checks = [
      {
        artifactRevision: 'candidate-1',
        evidenceRef: 'test-output-1',
        passed: true,
      },
    ]
    const submitted = service.submitTask(id, {
      taskId,
      owner: 'ct-arch',
      attempt: claimed.attempt!,
      leaseEpoch: claimed.leaseEpoch!,
      artifact: { ref: 'artifact://candidate', revision: 'candidate-1' },
      checks,
    })
    expect(submitted).toMatchObject({ state: 'done', checks })
  })

  it('rejects missing, failed or mismatched checks before autonomous completion', () => {
    const { service, id } = setup()
    const { message } = task(service, id, '证据检查')
    const taskId = message.task!.taskId
    const claimed = service.claimTask(id, {
      taskId,
      owner: 'ct-arch',
      contractRevision: 1,
      runId: 'run-check',
    })
    const input = {
      taskId,
      owner: 'ct-arch',
      attempt: claimed.attempt!,
      leaseEpoch: claimed.leaseEpoch!,
      artifact: { ref: 'artifact://evidence', revision: 'rev-check' },
    }
    expect(() => service.submitTask(id, input)).toThrow(/检查依据/)
    expect(() =>
      service.submitTask(id, {
        ...input,
        checks: [
          {
            artifactRevision: 'rev-check',
            evidenceRef: 'test-1',
            passed: false,
          },
        ],
      }),
    ).toThrow(/检查依据/)
    expect(() =>
      service.submitTask(id, {
        ...input,
        checks: [
          { artifactRevision: 'other', evidenceRef: 'test-1', passed: true },
        ],
      }),
    ).toThrow(/检查依据/)
    expect(current(service, id, taskId).state).toBe('running')
    expect(
      service.history(id).messages.filter((entry) => entry.kind === 'result'),
    ).toHaveLength(0)
  })

  it('projects the same task state onto the board, history and replay', () => {
    const { service, id, logs } = setup()
    const { message } = task(service, id, '唯一事实', {
      acceptance: ['日志一致'],
    })
    const taskId = message.task!.taskId
    const claimed = service.claimTask(id, {
      taskId,
      owner: 'ct-arch',
      contractRevision: 1,
      runId: 'run-projection',
    })
    service.submitTask(id, {
      taskId,
      owner: 'ct-arch',
      attempt: claimed.attempt!,
      leaseEpoch: claimed.leaseEpoch!,
      artifact: { ref: 'artifact://one', revision: 'one-1' },
      checks: [
        {
          artifactRevision: 'one-1',
          evidenceRef: 'projection-1',
          passed: true,
        },
      ],
    })
    const board = service.tasks(id).find((t) => t.taskId === taskId)
    const shown = service.history(id).messages.find((m) => m.id === message.id)
    const replayed = foldGroupEvents(logs.get(id)!).tasks.get(taskId)
    expect(board).toMatchObject({ state: 'done', ready: false })
    expect(shown?.task).toEqual(replayed)
    expect(board).toMatchObject(replayed!)
  })
})
