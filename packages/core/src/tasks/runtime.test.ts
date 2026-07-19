import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskManager } from './manager'
import { TaskKind, TaskStatus } from './models'
import { TaskOutputStore, TaskRuntimeRegistry } from './runtime'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function start(manager: TaskManager, taskId: string) {
  return manager.startTask({
    taskId,
    kind: TaskKind.SUBAGENT,
    title: taskId,
    source: 'dispatch_subagent',
  })
}

describe('TaskRuntimeRegistry', () => {
  it('cancels a live execution and rejects a late completion by revision/CAS', async () => {
    const manager = new TaskManager(tmp('emperor-task-runtime-cancel-'))
    const registry = new TaskRuntimeRegistry(manager)
    const task = start(manager, 'task_cancel')
    const work = deferred<string>()
    const observedSignal: { value: AbortSignal | null } = { value: null }

    const handle = registry.launch({
      task,
      execute: async ({ signal }) => {
        observedSignal.value = signal
        return await work.promise
      },
    })

    await handle.cancel('user stopped task')
    expect(observedSignal.value?.aborted).toBe(true)
    await expect(handle.wait()).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      reason: 'user stopped task',
    })

    work.resolve('late success')
    await handle.settled
    expect(manager.store.get(task.id)).toMatchObject({
      status: TaskStatus.CANCELLED,
      progress: { reason: 'user stopped task' },
    })
    expect(handle.lateResultRejected).toBe(true)
    await expect(handle.readOutput()).resolves.toMatchObject({ content: '' })
  })

  it('cascades a parent abort but leaves detached background work running', async () => {
    const manager = new TaskManager(tmp('emperor-task-runtime-parent-'))
    const registry = new TaskRuntimeRegistry(manager)
    const parent = new AbortController()
    const foregroundWork = deferred<string>()
    const backgroundWork = deferred<string>()
    const foreground = registry.launch({
      task: start(manager, 'task_foreground'),
      parentSignal: parent.signal,
      execute: () => foregroundWork.promise,
    })
    const background = registry.launch({
      task: start(manager, 'task_background'),
      parentSignal: parent.signal,
      detached: true,
      execute: () => backgroundWork.promise,
    })

    parent.abort('parent closed')
    await expect(foreground.wait()).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
    })
    expect(manager.store.get('task_foreground')?.status).toBe(
      TaskStatus.CANCELLED,
    )
    expect(manager.store.get('task_background')?.status).toBe(
      TaskStatus.RUNNING,
    )

    backgroundWork.resolve('background complete')
    await expect(background.wait()).resolves.toMatchObject({
      status: TaskStatus.COMPLETED,
      value: 'background complete',
    })
    foregroundWork.resolve('ignored')
    await Promise.all([foreground.settled, background.settled])
  })

  it('releases a cancelled terminal handle even when ignored work never settles', async () => {
    const manager = new TaskManager(tmp('emperor-task-runtime-ignored-'))
    const registry = new TaskRuntimeRegistry(manager)
    const handle = registry.launch({
      task: start(manager, 'task_ignored'),
      execute: async () => await new Promise<string>(() => {}),
    })

    await handle.cancel('stop ignored work')
    await handle.wait()
    await Promise.resolve()

    expect(registry.list()).toEqual([])
    await expect(registry.shutdown('shutdown')).resolves.toBeUndefined()
  })

  it('propagates the same signal through model/tool/process/MCP-like phases', async () => {
    const phases = ['model', 'tool', 'process', 'mcp'] as const
    for (const phase of phases) {
      const manager = new TaskManager(tmp(`emperor-task-runtime-${phase}-`))
      const registry = new TaskRuntimeRegistry(manager)
      const task = start(manager, `task_${phase}`)
      let seen = false
      const handle = registry.launch({
        task,
        execute: ({ signal }) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                seen = true
                reject(new Error(`${phase} aborted`))
              },
              { once: true },
            )
          }),
      })

      await handle.cancel(`cancel ${phase}`)
      await handle.settled
      expect(seen, phase).toBe(true)
      expect(manager.store.get(task.id)?.status, phase).toBe(
        TaskStatus.CANCELLED,
      )
    }
  })

  it('reconciles disk running records to interrupted after restart', () => {
    const root = tmp('emperor-task-runtime-reconcile-')
    const firstManager = new TaskManager(root)
    start(firstManager, 'task_orphan')
    const secondManager = new TaskManager(root)
    const registry = new TaskRuntimeRegistry(secondManager, {
      reconcileOnStart: true,
    })

    expect(registry.reconciledTaskIds).toEqual(['task_orphan'])
    expect(secondManager.store.get('task_orphan')).toMatchObject({
      status: TaskStatus.INTERRUPTED,
      progress: { code: 'task_interrupted_by_restart' },
    })
  })

  it('reconciles a Scheduler Task that crashed before runtime_managed binding', () => {
    const root = tmp('emperor-task-runtime-scheduler-reconcile-')
    const firstManager = new TaskManager(root)
    const task = firstManager.startTask({
      taskId: `scheduler_run_${'a'.repeat(32)}`,
      kind: TaskKind.SCHEDULER_RUN,
      title: 'scheduler crash gap',
      source: 'scheduler',
    })
    expect(task.metadata.runtime_managed).toBeUndefined()

    const secondManager = new TaskManager(root)
    const registry = new TaskRuntimeRegistry(secondManager, {
      reconcileOnStart: true,
    })

    expect(registry.reconciledTaskIds).toEqual([task.id])
    expect(secondManager.store.get(task.id)?.status).toBe(
      TaskStatus.INTERRUPTED,
    )
  })

  it('cancels and drains every owned handle during lifecycle shutdown', async () => {
    const root = tmp('emperor-task-runtime-shutdown-')
    const manager = new TaskManager(root)
    const registry = new TaskRuntimeRegistry(manager)
    const task = start(manager, 'task_shutdown')
    let aborted = false
    registry.launch({
      task,
      execute: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('shutdown observed'))
            },
            { once: true },
          )
        }),
    })

    await registry.shutdown('application shutdown')

    expect(aborted).toBe(true)
    expect(registry.list()).toEqual([])
    expect(manager.store.get(task.id)).toMatchObject({
      status: TaskStatus.CANCELLED,
      progress: { reason: 'application shutdown' },
    })
  })
})

describe('TaskOutputStore', () => {
  it('reads output by cursor and reports typed quota truncation', () => {
    const root = tmp('emperor-task-output-')
    const output = new TaskOutputStore(root, 'task_output', {
      maxBytes: 8,
      readChunkBytes: 4,
    })

    expect(output.append('abcdef')).toMatchObject({
      acceptedBytes: 6,
      truncated: false,
    })
    expect(output.append('ghijkl')).toMatchObject({
      acceptedBytes: 2,
      droppedBytes: 4,
      truncated: true,
      code: 'task_output_truncated',
    })
    expect(readFileSync(output.path, 'utf8')).toBe('abcdefgh')

    const first = output.read()
    expect(first).toMatchObject({
      content: 'abcd',
      nextCursor: '4',
      eof: false,
      truncated: true,
      truncation: {
        code: 'task_output_truncated',
        limitBytes: 8,
        droppedBytes: 4,
      },
    })
    const second = output.read(first.nextCursor)
    expect(second).toMatchObject({
      content: 'efgh',
      nextCursor: '8',
      eof: true,
      truncated: true,
    })
  })

  it('rejects task output symlinks instead of following them', () => {
    const root = tmp('emperor-task-output-symlink-')
    const outside = tmp('emperor-task-output-outside-')
    mkdirSync(join(root, 'tasks', 'task_link'), { recursive: true })
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'secret', 'utf8')
    symlinkSync(secret, join(root, 'tasks', 'task_link', 'output.log'))
    const output = new TaskOutputStore(root, 'task_link')

    expect(() => output.read()).toThrow(/symlink|outside task directory/i)
    expect(() => output.append('escape')).toThrow(
      /symlink|outside task directory/i,
    )
    expect(readFileSync(secret, 'utf8')).toBe('secret')
  })
})
