import { describe, expect, it } from 'vitest'
import {
  CoreUnavailableError,
  LifecycleStartupError,
  LifecycleSupervisor,
  type LifecycleService,
} from './lifecycle'

function service(
  id: string,
  log: string[],
  opts: {
    dependsOn?: string[]
    start?: () => void | Promise<void>
    ready?: () => void | Promise<void>
    stop?: (signal: AbortSignal) => void | Promise<void>
  } = {},
): LifecycleService {
  return {
    id,
    required: true,
    dependsOn: opts.dependsOn ?? [],
    async reconcile() {
      log.push(`${id}:reconcile`)
    },
    async start() {
      log.push(`${id}:start`)
      await opts.start?.()
    },
    async ready() {
      log.push(`${id}:ready`)
      await opts.ready?.()
    },
    async stop(_reason, signal) {
      log.push(`${id}:stop`)
      await opts.stop?.(signal)
    },
  }
}

describe('LifecycleSupervisor', () => {
  it('reconciles, starts, and readies dependencies exactly once', async () => {
    const log: string[] = []
    const supervisor = new LifecycleSupervisor([
      service('scheduler', log, { dependsOn: ['sessions'] }),
      service('tasks', log),
      service('sessions', log, { dependsOn: ['tasks'] }),
    ])

    const first = supervisor.start()
    const duplicate = supervisor.start()
    expect(duplicate).toBe(first)
    await Promise.all([first, duplicate])
    await supervisor.start()

    expect(log).toEqual([
      'tasks:reconcile',
      'tasks:start',
      'tasks:ready',
      'sessions:reconcile',
      'sessions:start',
      'sessions:ready',
      'scheduler:reconcile',
      'scheduler:start',
      'scheduler:ready',
    ])
    expect(supervisor.snapshot()).toMatchObject({
      state: 'ready',
      services: [
        { id: 'tasks', state: 'ready' },
        { id: 'sessions', state: 'ready' },
        { id: 'scheduler', state: 'ready' },
      ],
    })
    expect(() => supervisor.assertReady()).not.toThrow()
  })

  it('cleans a partial start in reverse dependency order and stays failed', async () => {
    const log: string[] = []
    const supervisor = new LifecycleSupervisor([
      service('tasks', log),
      service('sessions', log, {
        dependsOn: ['tasks'],
        start: () => {
          throw new Error('session startup failed after partial allocation')
        },
      }),
      service('scheduler', log, { dependsOn: ['sessions'] }),
    ])

    await expect(supervisor.start()).rejects.toMatchObject({
      name: 'LifecycleStartupError',
      serviceId: 'sessions',
      phase: 'start',
    })
    await expect(supervisor.start()).rejects.toBeInstanceOf(
      LifecycleStartupError,
    )

    expect(log).toEqual([
      'tasks:reconcile',
      'tasks:start',
      'tasks:ready',
      'sessions:reconcile',
      'sessions:start',
      'sessions:stop',
      'tasks:stop',
    ])
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      failedServiceId: 'sessions',
      failedPhase: 'start',
    })
  })

  it('stops in reverse dependency order and continues after a deadline', async () => {
    const log: string[] = []
    const supervisor = new LifecycleSupervisor(
      [
        service('tasks', log),
        service('sessions', log, {
          dependsOn: ['tasks'],
          stop: async () => await new Promise<void>(() => {}),
        }),
        service('scheduler', log, { dependsOn: ['sessions'] }),
      ],
      { stopTimeoutMs: 15 },
    )
    await supervisor.start()
    log.length = 0

    const first = supervisor.stop('test shutdown')
    const duplicate = supervisor.stop('duplicate shutdown')
    expect(duplicate).toBe(first)
    await first

    expect(log).toEqual(['scheduler:stop', 'sessions:stop', 'tasks:stop'])
    expect(supervisor.snapshot()).toMatchObject({
      state: 'stopped',
      services: [
        { id: 'tasks', state: 'stopped' },
        { id: 'sessions', state: 'stop_timeout' },
        { id: 'scheduler', state: 'stopped' },
      ],
    })
  })

  it('fails Core operations with a structured unavailable error before ready', () => {
    const supervisor = new LifecycleSupervisor([])

    expect(() => supervisor.assertReady()).toThrow(CoreUnavailableError)
    try {
      supervisor.assertReady()
    } catch (error) {
      expect((error as CoreUnavailableError).toSafe()).toEqual({
        code: 'core_unavailable',
        message: 'Core runtime is not ready (idle).',
        action: 'retry',
      })
    }
  })

  it('rejects missing dependencies and dependency cycles before effects', () => {
    expect(
      () =>
        new LifecycleSupervisor([
          service('scheduler', [], { dependsOn: ['missing'] }),
        ]),
    ).toThrow('unknown lifecycle dependency')
    expect(
      () =>
        new LifecycleSupervisor([
          service('a', [], { dependsOn: ['b'] }),
          service('b', [], { dependsOn: ['a'] }),
        ]),
    ).toThrow('lifecycle dependency cycle')
  })
})
