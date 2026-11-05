// CG-03: extended GroupTask work runs beside, never inside, the speaking
// queue. Claims, candidates and recovery facts stay in the same group log.
import { describe, expect, it } from 'vitest'
import { GroupScheduler } from './scheduler'
import { memoryGroups } from './test-fixture'
import type { GroupTask } from './types'
import {
  GroupWorkScheduler,
  type GroupWorkRequest,
  type GroupWorkResult,
} from './work-scheduler'

interface Pending {
  request: GroupWorkRequest
  resolve(result: GroupWorkResult): void
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const candidate = (id: string): GroupWorkResult => ({
  outcome: 'completed',
  submission: {
    artifact: { ref: `artifact://${id}`, revision: `${id}-rev` },
    checks: [
      {
        artifactRevision: `${id}-rev`,
        evidenceRef: `check:${id}`,
        passed: true,
      },
    ],
  },
})

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function setup(
  options: {
    globalLimit?: number
    capabilities?: (task: GroupTask) => {
      maxParallel: number
      write: boolean
      stop: boolean
      collect: boolean
    }
    probe?: () => 'unknown' | 'completed' | 'aborted' | 'failed'
  } = {},
) {
  const fixture = memoryGroups()
  const group = fixture.service.create({
    title: '后台协作',
    members: ['ct-arch', 'ct-rev', 'ct-res'],
  })
  const runs: Pending[] = []
  const probes: string[] = []
  let sequence = 0
  const work = new GroupWorkScheduler({
    groups: fixture.service,
    globalLimit: options.globalLimit ?? 4,
    capabilities: (_groupId, task) =>
      options.capabilities?.(task) ?? {
        maxParallel: 2,
        write: true,
        stop: true,
        collect: true,
      },
    run: (request) => {
      const pending = deferred<GroupWorkResult>()
      runs.push({ request, resolve: pending.resolve })
      return pending.promise
    },
    probe: (_groupId, task) => {
      probes.push(task.activeRunId!)
      return options.probe?.() ?? 'unknown'
    },
    newId: () => `gwr-${++sequence}`,
  })
  const add = (
    title: string,
    extra: Partial<{
      to: string
      dependsOn: string[]
      access: GroupTask['access']
      groupId: string
    }> = {},
  ) =>
    fixture.service.send(extra.groupId ?? group.id, {
      way: 'task',
      to: extra.to ?? 'ct-arch',
      text: title,
      task: {
        title,
        deliverable: `${title}成果`,
        access: extra.access ?? 'readonly',
        acceptance: ['成果可复核'],
        ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
      },
    }).message.task!
  const current = (taskId: string, groupId = group.id) =>
    fixture.service.state(groupId).tasks.get(taskId)!
  return { ...fixture, group, work, runs, probes, add, current }
}

describe('GroupWorkScheduler (CG-03)', () => {
  it('runs two compatible ready tasks in parallel and submits candidates', async () => {
    const { group, work, runs, add, current } = setup()
    const first = add('并行一')
    const second = add('并行二', { to: 'ct-rev' })
    work.kick(group.id)
    expect(runs).toHaveLength(2)
    expect(current(first.taskId).state).toBe('running')
    expect(current(second.taskId).state).toBe('running')
    runs[0]!.resolve(candidate('first'))
    await flush()
    expect(current(first.taskId)).toMatchObject({
      state: 'done',
      artifacts: [{ ref: 'artifact://first', revision: 'first-rev' }],
    })
    expect(current(second.taskId).state).toBe('running')
  })

  it('lets a short speech finish while a long work run stays active', async () => {
    const { service, group, work, runs, add } = setup()
    add('长任务')
    work.kick(group.id)
    expect(runs).toHaveLength(1)
    const speaking = new GroupScheduler({
      groups: service,
      speak: async () => ({
        text: '短回答',
        outcome: 'completed',
        spend: { usd: 0, tokens: 0 },
      }),
      poll: async () => ({ raise: false, score: 0, reason: '' }),
      review: async () => ({ verdict: 'approve' }),
      digest: async () => '',
    })
    const sent = service.send(group.id, {
      way: 'mention',
      text: '@研究员 请简短回答',
    })
    await speaking.start(group.id, sent.message, sent.plan)
    expect(service.state(group.id).messages.at(-1)).toMatchObject({
      from: 'ct-res',
      text: '短回答',
    })
    expect(work.live(group.id).active).toBe(1)
  })

  it('degrades an adapter without write or collection support to serial readonly work', () => {
    const { group, work, runs, add, current } = setup({
      capabilities: () => ({
        maxParallel: 2,
        write: false,
        stop: false,
        collect: false,
      }),
    })
    const write = add('需要写入', { access: 'group_files' })
    add('只读一')
    const second = add('只读二', { to: 'ct-rev' })
    work.kick(group.id)
    expect(current(write.taskId)).toMatchObject({
      state: 'failed',
      problem: { kind: 'adapter', reason: 'readonly' },
    })
    expect(runs).toHaveLength(1)
    expect(work.live(group.id)).toMatchObject({ active: 1, maxParallel: 1 })
    expect(current(second.taskId).state).toBe('queued')
  })

  it('does not start a dependent task before its dependency is accepted', () => {
    const { service, group, work, runs, add } = setup()
    const first = add('前置')
    const second = add('后续', { dependsOn: [first.taskId] })
    work.kick(group.id)
    expect(runs.map((run) => run.request.task.taskId)).toEqual([first.taskId])
    service.append(group.id, 'group/task', {
      ...service.state(group.id).tasks.get(first.taskId)!,
      state: 'done',
      activeRunId: undefined,
    })
    work.kick(group.id)
    expect(runs.at(-1)?.request.task.taskId).toBe(second.taskId)
  })

  it('queues another group when the global worker limit is full', async () => {
    const { service, group, work, runs, add, current } = setup({
      globalLimit: 1,
    })
    const other = service.create({ title: '另一群', members: ['ct-rev'] })
    add('占住全局位置')
    const second = add('等待全局位置', {
      groupId: other.id,
      to: 'ct-rev',
    })
    work.kick(group.id)
    work.kick(other.id)
    expect(runs).toHaveLength(1)
    expect(current(second.taskId, other.id).state).toBe('queued')
    runs[0]!.resolve(candidate('global'))
    await flush()
    expect(runs).toHaveLength(2)
    expect(runs[1]!.request.groupId).toBe(other.id)
  })

  it('keeps the claim until stop is confirmed by the runner', async () => {
    const fixture = setup()
    const { group, add, current } = fixture
    const task = add('可停止任务')
    let confirmStop!: (result: GroupWorkResult) => void
    const controlled = new GroupWorkScheduler({
      groups: fixture.service,
      capabilities: () => ({
        maxParallel: 2,
        write: true,
        stop: true,
        collect: true,
      }),
      run: (request) =>
        new Promise<GroupWorkResult>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              confirmStop = resolve
            },
            { once: true },
          )
        }),
      probe: () => 'unknown',
    })
    controlled.kick(group.id)
    expect(controlled.stop(group.id)).toEqual({ requested: 1 })
    expect(current(task.taskId).state).toBe('running')
    expect(controlled.live(group.id).active).toBe(1)
    confirmStop({ outcome: 'aborted' })
    await flush()
    expect(current(task.taskId).state).toBe('cancelled')
    expect(controlled.live(group.id).active).toBe(0)
  })

  it('cancels queued work instead of starting it after a stop is confirmed', async () => {
    const { group, work, runs, add, current } = setup({
      capabilities: () => ({
        maxParallel: 1,
        write: true,
        stop: true,
        collect: true,
      }),
    })
    const running = add('正在执行')
    const queued = add('排队等待', { to: 'ct-rev' })
    work.kick(group.id)
    expect(runs).toHaveLength(1)
    expect(work.stop(group.id)).toEqual({ requested: 1 })
    runs[0]!.resolve({ outcome: 'aborted' })
    await flush()
    expect(runs).toHaveLength(1)
    expect(current(running.taskId).state).toBe('cancelled')
    expect(current(queued.taskId).state).toBe('cancelled')
    expect(work.live(group.id).active).toBe(0)
  })

  it('probes a restarted run, marks an unknown outcome and never reruns it', () => {
    const { service, group, work, runs, probes, add, current } = setup()
    const task = add('重启前任务')
    service.claimTask(group.id, {
      taskId: task.taskId,
      owner: task.to,
      contractRevision: 1,
      runId: 'run-before-restart',
    })
    expect(work.recover()).toBe(1)
    expect(probes).toEqual(['run-before-restart'])
    expect(runs).toHaveLength(0)
    expect(current(task.taskId)).toMatchObject({
      state: 'failed',
      problem: { kind: 'unknown', reason: 'app_restart' },
    })
    expect(current(task.taskId).activeRunId).toBeUndefined()
  })

  it('resumes queued work on recovery without rerunning an old active attempt', () => {
    const { service, group, work, runs, add, current } = setup()
    const active = add('旧活动任务')
    const queued = add('重启前排队', { to: 'ct-rev' })
    service.claimTask(group.id, {
      taskId: active.taskId,
      owner: active.to,
      contractRevision: 1,
      runId: 'old-active',
    })
    expect(work.recover()).toBe(1)
    expect(current(active.taskId).state).toBe('failed')
    expect(runs.map((run) => run.request.task.taskId)).toEqual([queued.taskId])
    expect(runs[0]!.request.task.attempt).toBe(1)
  })

  it('marks a malformed adapter candidate failed instead of abandoning a running task', async () => {
    const { group, work, runs, add, current } = setup()
    const task = add('非法候选')
    work.kick(group.id)
    runs[0]!.resolve({
      outcome: 'completed',
      submission: { artifact: { ref: '', revision: '' } },
    })
    await flush()
    expect(current(task.taskId)).toMatchObject({
      state: 'failed',
      problem: { kind: 'failed' },
    })
    expect(work.live(group.id).active).toBe(0)
  })

  it('rejects a late result after transfer and a newer attempt', async () => {
    const { service, group, work, runs, add, current } = setup()
    const task = add('迟到结果')
    work.kick(group.id)
    const old = runs[0]!
    service.transferTask(group.id, {
      taskId: task.taskId,
      to: 'ct-rev',
      contractRevision: 1,
    })
    work.kick(group.id)
    expect(runs).toHaveLength(2)
    expect(runs[1]!.request.task.attempt).toBe(2)
    old.resolve(candidate('late'))
    await flush()
    expect(current(task.taskId).artifacts).toBeUndefined()
    expect(current(task.taskId).activeRunId).toBe(runs[1]!.request.runId)
    runs[1]!.resolve(candidate('current'))
    await flush()
    expect(current(task.taskId).artifacts).toEqual([
      { ref: 'artifact://current', revision: 'current-rev' },
    ])
  })

  it('records a failed run without discarding earlier artifacts', async () => {
    const { service, group, work, runs, add, current } = setup()
    const task = add('保留失败现场')
    service.append(group.id, 'group/task', {
      ...task,
      artifacts: [{ ref: 'artifact://earlier', revision: 'earlier-rev' }],
    })
    work.kick(group.id)
    runs[0]!.resolve({ outcome: 'failed', detail: 'executor failed' })
    await flush()
    expect(current(task.taskId)).toMatchObject({
      state: 'failed',
      artifacts: [{ ref: 'artifact://earlier', revision: 'earlier-rev' }],
      problem: { kind: 'failed', reason: 'executor failed' },
    })
  })

  it('reports concurrent work spend against the turn that assigned both tasks', async () => {
    const { service, group } = setup()
    const source = service.send(group.id, {
      way: 'broadcast',
      text: '同一轮交办两项工作',
    })
    const speaking = new GroupScheduler({
      groups: service,
      speak: async () => ({
        text: '',
        outcome: 'completed',
        spend: { usd: 0, tokens: 0 },
      }),
      poll: async () => ({ raise: false, score: 0, reason: '' }),
      review: async () => ({ verdict: 'approve' }),
      digest: async () => '',
    })
    await speaking.start(group.id, source.message, [])
    const work = new GroupWorkScheduler({
      groups: service,
      capabilities: () => ({
        maxParallel: 2,
        write: true,
        stop: true,
        collect: true,
      }),
      run: async (request) => ({
        outcome: 'failed',
        detail: 'stop after usage',
        spend: {
          usd: 0,
          tokens: request.task.to === 'ct-arch' ? 15 : 30,
        },
      }),
      recordSpend: (groupId, turnId, spend) =>
        speaking.addWorkSpend(groupId, turnId, spend),
      probe: () => 'unknown',
    })
    for (const [taskId, to] of [
      ['gt-spend-a', 'ct-arch'],
      ['gt-spend-b', 'ct-rev'],
    ] as const) {
      const task: GroupTask = {
        taskId,
        to,
        title: taskId,
        deliverable: '成果',
        access: 'readonly',
        acceptance: ['已检查'],
        state: 'queued',
      }
      service.registerTask(group.id, task)
      service.append(group.id, 'group/message', {
        ...source.message,
        id: `gm-${taskId}`,
        kind: 'task',
        text: task.title,
        ask: [to],
        task,
      })
    }
    work.kick(group.id)
    await work.settled(group.id)
    expect(service.state(group.id).turn).toMatchObject({
      turnId: source.message.turnId,
      spend: { usd: 0, tokens: 45 },
    })
  })

  it('keeps independent answers blind and revealed together while work runs', async () => {
    const { service, group, work, add } = setup()
    add('后台长任务')
    work.kick(group.id)
    const replies: Array<{
      resolve(value: {
        text: string
        outcome: 'completed'
        spend: { usd: number; tokens: number }
      }): void
      member: string
    }> = []
    const speaking = new GroupScheduler({
      groups: service,
      speak: (request) =>
        new Promise((resolve) => {
          replies.push({ resolve, member: request.member })
        }),
      poll: async () => ({ raise: false, score: 0, reason: '' }),
      review: async () => ({ verdict: 'approve' }),
      digest: async () => '',
    })
    const sent = service.send(group.id, {
      way: 'independent',
      text: '@架构师 @审稿人 分别判断',
    })
    const done = speaking.start(group.id, sent.message, sent.plan)
    await flush()
    expect(replies).toHaveLength(2)
    replies[0]!.resolve({
      text: '第一份',
      outcome: 'completed',
      spend: { usd: 0, tokens: 0 },
    })
    await flush()
    expect(
      service.state(group.id).messages.filter((m) => m.text === '第一份'),
    ).toHaveLength(0)
    replies[1]!.resolve({
      text: '第二份',
      outcome: 'completed',
      spend: { usd: 0, tokens: 0 },
    })
    await done
    expect(
      service
        .state(group.id)
        .messages.filter((m) => ['第一份', '第二份'].includes(m.text)),
    ).toHaveLength(2)
    expect(work.live(group.id).active).toBe(1)
  })
})
