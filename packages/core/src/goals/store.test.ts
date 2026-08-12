import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GoalRecord } from './models'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'
import {
  GOAL_EVENT_SCHEMA_VERSION,
  computeGoalEventHash,
  type GoalEventEnvelope,
} from './events'
import { GoalStore, type GoalAppendInput } from './store'
import { createNodePersistenceAdapter } from '../store/persistence'

const T0 = '2026-07-15T10:00:00.000Z'
const T1 = '2026-07-15T10:01:00.000Z'
const T2 = '2026-07-15T10:02:00.000Z'
const T3 = '2026-07-15T10:03:00.000Z'

let stateRoot: string

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'emperor-goal-store-'))
})

describe('GoalStore durable ledger', () => {
  it('creates, appends, reads and lists a hash-chained Goal projection', async () => {
    const store = new GoalStore(stateRoot)
    const created = await store.create(draft('goal_happy', 'session-happy'))
    const planning = await lock(store, created, T1)

    expect(created.lastEventSeq).toBe(1)
    expect(planning.lastEventSeq).toBe(2)
    expect(await store.get(created.id)).toEqual(planning)
    expect(await store.list()).toEqual([planning])
    expect(await store.findActiveBySession('session-happy')).toEqual(planning)

    const goalRoot = join(stateRoot, 'goals', created.id)
    const events = await readEvents(goalRoot)
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, 'goal_created'],
      [2, 'goal_updated'],
    ])
    expect(events[0]).toMatchObject({
      schemaVersion: GOAL_EVENT_SCHEMA_VERSION,
      goalId: created.id,
      prevHash: null,
    })
    expect(events[0]!.hash).toBe(computeGoalEventHash(events[0]!))
    expect(events[1]!.prevHash).toBe(events[0]!.hash)
    expect(events[1]!.hash).toBe(computeGoalEventHash(events[1]!))

    expect(
      JSON.parse(await readFile(join(goalRoot, 'goal.json'), 'utf8')),
    ).toEqual(planning)
    const index = JSON.parse(
      await readFile(join(stateRoot, 'goals', 'index.json'), 'utf8'),
    ) as { goals: Array<Record<string, unknown>> }
    expect(index.goals).toEqual([
      expect.objectContaining({
        id: created.id,
        sessionId: 'session-happy',
        status: 'active',
        phase: 'planning',
        outcomePreview: 'Ship a durable goal',
      }),
    ])
  })

  it('reads the current Goal from the ledger without repairing a stale index', async () => {
    const store = new GoalStore(stateRoot)
    const created = await store.create(
      draft('goal_readonly_current', 'session-readonly-current'),
    )
    const indexPath = join(stateRoot, 'goals', 'index.json')
    await writeFile(indexPath, '{"stale":true}\n', 'utf8')

    await expect(store.listReadonly()).resolves.toEqual([created])
    await expect(
      store.findActiveBySession('session-readonly-current'),
    ).resolves.toEqual(created)
    expect(await readFile(indexPath, 'utf8')).toBe('{"stale":true}\n')
  })

  it('serializes concurrent creates for one session and releases the keyed lock', async () => {
    const store = new GoalStore(stateRoot)
    const results = await Promise.allSettled([
      store.create(draft('goal_first', 'session-shared')),
      store.create(draft('goal_second', 'session-shared')),
    ])

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected?.reason).toMatchObject({ code: 'goal_active_exists' })
    expect(await store.list()).toHaveLength(1)
  })

  it('does not serialize lifecycle writes for different resolved roots', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'emperor-goal-store-other-'))
    const firstReached = deferred<void>()
    const secondReached = deferred<void>()
    const releaseFirst = deferred<void>()
    const releaseSecond = deferred<void>()
    const first = new GoalStore(stateRoot, {
      hooks: {
        async beforeEventAppend() {
          firstReached.resolve()
          await releaseFirst.promise
        },
      },
    })
    const second = new GoalStore(otherRoot, {
      hooks: {
        async beforeEventAppend() {
          secondReached.resolve()
          await releaseSecond.promise
        },
      },
    })

    const firstCreate = first.create(draft('goal_root_a', 'session-root-a'))
    await firstReached.promise
    const secondCreate = second.create(draft('goal_root_b', 'session-root-b'))
    const rootsRanInParallel = await Promise.race([
      secondReached.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ])
    releaseFirst.resolve()
    releaseSecond.resolve()
    await Promise.all([firstCreate, secondCreate])

    expect(rootsRanInParallel).toBe(true)
  })

  it('serializes index rescan and atomic write across different session creates', async () => {
    let signalFirstIndex!: () => void
    let releaseFirstIndex!: () => void
    const firstReachedIndex = new Promise<void>((resolve) => {
      signalFirstIndex = resolve
    })
    const firstMayWrite = new Promise<void>((resolve) => {
      releaseFirstIndex = resolve
    })
    let secondEventSynced = false
    const store = new GoalStore(stateRoot, {
      hooks: {
        afterEventSync(context) {
          if (context.goalId === 'goal_index_second') secondEventSynced = true
        },
        async beforeIndexWrite(context) {
          if (context.goalId !== 'goal_index_first') return
          signalFirstIndex()
          await firstMayWrite
        },
      },
    })

    const first = store.create(draft('goal_index_first', 'session-index-first'))
    await firstReachedIndex
    const second = store.create(
      draft('goal_index_second', 'session-index-second'),
    )
    await Promise.resolve()
    expect(secondEventSynced).toBe(false)
    releaseFirstIndex()
    await Promise.all([first, second])

    const index = JSON.parse(
      await readFile(join(stateRoot, 'goals', 'index.json'), 'utf8'),
    ) as { goals: Array<{ id: string }> }
    expect(index.goals.map((entry) => entry.id).sort()).toEqual([
      'goal_index_first',
      'goal_index_second',
    ])
  })

  it('recovers an event synced before a deterministic snapshot failure', async () => {
    let failSeq2 = true
    const writeOrder: string[] = []
    const failing = new GoalStore(stateRoot, {
      hooks: {
        afterEventSync(context) {
          if (context.seq === 2) writeOrder.push('event_synced')
        },
        beforeSnapshotWrite(context) {
          if (context.seq === 2 && failSeq2) {
            writeOrder.push('snapshot')
            failSeq2 = false
            throw new Error('injected snapshot failure')
          }
        },
        beforeIndexWrite(context) {
          if (context.seq === 2) writeOrder.push('index')
        },
      },
    })
    const created = await failing.create(
      draft('goal_snapshot_failure', 'session-snapshot-failure'),
    )
    const next = GoalContractValidator.lock(created, definition(), T1)

    await expect(
      failing.append(created.id, {
        type: 'goal_updated',
        record: next,
        createdAt: T1,
      }),
    ).rejects.toThrow('injected snapshot failure')
    expect(writeOrder).toEqual(['event_synced', 'snapshot'])

    const onDiskBeforeRecovery = JSON.parse(
      await readFile(join(stateRoot, 'goals', created.id, 'goal.json'), 'utf8'),
    ) as GoalRecord
    expect(onDiskBeforeRecovery.lastEventSeq).toBe(1)
    expect(await readEvents(join(stateRoot, 'goals', created.id))).toHaveLength(
      2,
    )

    const recovered = await new GoalStore(stateRoot).get(created.id)
    expect(recovered).toMatchObject({
      status: 'active',
      runtime: { phase: 'planning' },
      lastEventSeq: 2,
    })
  })

  it('preserves the last good Goal snapshot when durable rename fails', async () => {
    const healthy = new GoalStore(stateRoot)
    const created = await healthy.create(
      draft('goal_snapshot_rename_failure', 'session-snapshot-rename-failure'),
    )
    const snapshotPath = join(stateRoot, 'goals', created.id, 'goal.json')
    const before = await readFile(snapshotPath, 'utf8')
    const failing = new GoalStore(stateRoot, {
      persistenceAdapter: createNodePersistenceAdapter({
        beforeOperation(operation, path) {
          if (operation === 'rename' && path === snapshotPath)
            throw new Error('injected Goal snapshot rename')
        },
      }),
    })
    const next = GoalContractValidator.lock(created, definition(), T1)

    await expect(
      failing.append(created.id, {
        type: 'goal_updated',
        record: next,
        createdAt: T1,
      }),
    ).rejects.toMatchObject({
      code: 'persistence_io',
      operation: 'rename',
    })
    expect(await readFile(snapshotPath, 'utf8')).toBe(before)
    expect(
      (await readdir(join(stateRoot, 'goals', created.id))).filter((name) =>
        name.includes('.tmp-'),
      ),
    ).toEqual([])
    expect(await readEvents(join(stateRoot, 'goals', created.id))).toHaveLength(
      2,
    )
    await expect(new GoalStore(stateRoot).get(created.id)).resolves.toEqual({
      ...next,
      lastEventSeq: 2,
    })
  })

  it('isolates a corrupt index and rebuilds all current and historical Goals', async () => {
    const store = new GoalStore(stateRoot)
    const active = await store.create(draft('goal_active', 'session-active'))
    const historical = await store.create(
      draft('goal_historical', 'session-historical'),
    )
    await cancel(store, historical, T1)
    await writeFile(
      join(stateRoot, 'goals', 'index.json'),
      '{bad index',
      'utf8',
    )

    const restarted = new GoalStore(stateRoot)
    const records = await restarted.list()

    expect(records.map((record) => record.id).sort()).toEqual(
      [active.id, historical.id].sort(),
    )
    expect(
      (await readdir(join(stateRoot, 'goals'))).some((name) =>
        name.startsWith('index.json.corrupt-'),
      ),
    ).toBe(true)
    expect((await restarted.diagnostics()).indexRebuilt).toBe(true)
  })

  it('quarantines a corrupt index before create replaces its projection', async () => {
    const store = new GoalStore(stateRoot)
    await store.create(draft('goal_before_corruption', 'session-before'))
    await writeFile(
      join(stateRoot, 'goals', 'index.json'),
      '{bad index',
      'utf8',
    )

    await store.create(draft('goal_after_corruption', 'session-after'))

    expect(
      (await readdir(join(stateRoot, 'goals'))).some((name) =>
        name.startsWith('index.json.corrupt-'),
      ),
    ).toBe(true)
    expect((await store.diagnostics()).indexRebuilt).toBe(true)
    expect(await store.list()).toHaveLength(2)
  })

  it('deletes a paused Goal by session and atomically removes its index entry', async () => {
    const store = new GoalStore(stateRoot)
    let record = await store.create(draft('goal_delete', 'session-delete'))
    record = await lock(store, record, T1)
    record = await move(store, record, 'executing', T2)
    record = await move(store, record, 'paused', T3, 'user_requested')

    await expect(store.deleteBySession('session-delete')).resolves.toBe(1)
    expect(existsSync(join(stateRoot, 'goals', record.id))).toBe(false)
    expect(await store.list()).toEqual([])
    const index = JSON.parse(
      await readFile(join(stateRoot, 'goals', 'index.json'), 'utf8'),
    ) as { goals: unknown[] }
    expect(index.goals).toEqual([])
  })

  it('refuses to delete a running Goal without changing its directory or index', async () => {
    const store = new GoalStore(stateRoot)
    let record = await store.create(draft('goal_running', 'session-running'))
    record = await lock(store, record, T1)
    record = await move(store, record, 'executing', T2)
    const indexBefore = await readFile(
      join(stateRoot, 'goals', 'index.json'),
      'utf8',
    )

    await expect(
      store.deleteBySession('session-running'),
    ).rejects.toMatchObject({ code: 'goal_running_delete_forbidden' })
    expect(existsSync(join(stateRoot, 'goals', record.id))).toBe(true)
    expect(await readFile(join(stateRoot, 'goals', 'index.json'), 'utf8')).toBe(
      indexBefore,
    )
  })

  it('serializes paused delete against a concurrent resume append', async () => {
    const deleteReached = deferred<void>()
    const releaseDelete = deferred<void>()
    let blockDelete = false
    const store = new GoalStore(stateRoot, {
      hooks: {
        async beforeDeleteRemove() {
          if (!blockDelete) return
          deleteReached.resolve()
          await releaseDelete.promise
        },
      },
    })
    let paused = await store.create(
      draft('goal_delete_resume', 'session-delete-resume'),
    )
    paused = await lock(store, paused, T1)
    paused = await move(store, paused, 'executing', T2)
    paused = await move(store, paused, 'paused', T3, 'user_requested')
    const resumed = assertGoalTransition(paused, {
      ...paused,
      runtime: { ...paused.runtime, phase: 'executing', pauseReason: null },
      updatedAt: '2026-07-15T10:04:00.000Z',
    })

    blockDelete = true
    const deletion = store.deleteBySession('session-delete-resume')
    const reached = await Promise.race([
      deleteReached.promise.then(() => true),
      deletion.then(() => false),
    ])
    if (!reached) releaseDelete.resolve()
    expect(reached).toBe(true)

    let appendSettled = false
    const append = store
      .append(paused.id, {
        type: 'goal_updated',
        record: resumed,
        createdAt: '2026-07-15T10:04:00.000Z',
      })
      .finally(() => {
        appendSettled = true
      })
    await Promise.resolve()
    expect(appendSettled).toBe(false)

    releaseDelete.resolve()
    await expect(deletion).resolves.toBe(1)
    await expect(append).rejects.toMatchObject({ code: 'goal_not_found' })
    expect(existsSync(join(stateRoot, 'goals', paused.id))).toBe(false)
  })

  it('serializes delete against a concurrent observation append', async () => {
    const deleteReached = deferred<void>()
    const releaseDelete = deferred<void>()
    let blockDelete = false
    const store = new GoalStore(stateRoot, {
      hooks: {
        async beforeDeleteRemove() {
          if (!blockDelete) return
          deleteReached.resolve()
          await releaseDelete.promise
        },
      },
    })
    const created = await store.create(
      draft('goal_delete_observation', 'session-delete-observation'),
    )

    blockDelete = true
    const deletion = store.deleteBySession('session-delete-observation')
    const reached = await Promise.race([
      deleteReached.promise.then(() => true),
      deletion.then(() => false),
    ])
    if (!reached) releaseDelete.resolve()
    expect(reached).toBe(true)

    let observationSettled = false
    const observation = store
      .appendObservation(created.id, { id: 'obs_race' })
      .finally(() => {
        observationSettled = true
      })
    await Promise.resolve()
    expect(observationSettled).toBe(false)

    releaseDelete.resolve()
    await expect(deletion).resolves.toBe(1)
    await expect(observation).rejects.toMatchObject({ code: 'goal_not_found' })
    expect(existsSync(join(stateRoot, 'goals', created.id))).toBe(false)
  })

  it('hides a create directory from list until its first event is durable', async () => {
    const eventReached = deferred<void>()
    const releaseEvent = deferred<void>()
    const store = new GoalStore(stateRoot, {
      hooks: {
        async beforeEventAppend(context) {
          if (context.goalId !== 'goal_create_visibility') return
          eventReached.resolve()
          await releaseEvent.promise
        },
      },
    })

    const creation = store.create(
      draft('goal_create_visibility', 'session-create-visibility'),
    )
    const reached = await Promise.race([
      eventReached.promise.then(() => true),
      creation.then(() => false),
    ])
    if (!reached) releaseEvent.resolve()
    expect(reached).toBe(true)

    let listSettled = false
    const listing = store.list().finally(() => {
      listSettled = true
    })
    await Promise.resolve()
    expect(listSettled).toBe(false)

    releaseEvent.resolve()
    const [created, records] = await Promise.all([creation, listing])
    expect(records).toEqual([created])
    expect((await store.diagnostics()).issues).not.toContainEqual(
      expect.objectContaining({
        goalId: created.id,
        code: 'scope_missing',
      }),
    )
  })

  it('keeps observation corruption isolated from the Goal snapshot boundary', async () => {
    const store = new GoalStore(stateRoot)
    const created = await store.create(
      draft('goal_observations', 'session-observations'),
    )
    await store.appendObservation(created.id, { id: 'obs_1', ok: true })
    const observationsPath = join(
      stateRoot,
      'goals',
      created.id,
      'observations.jsonl',
    )
    await appendFile(observationsPath, 'not-json\n', 'utf8')

    const observations = await store.readObservations(created.id)

    expect(observations.records).toEqual([{ id: 'obs_1', ok: true }])
    expect(observations.badLines).toEqual([{ line: 2, raw: 'not-json' }])
    expect(await store.get(created.id)).toEqual(created)
  })

  it('serializes diagnostics loading with a concurrent diagnostics update', async () => {
    const initial = new GoalStore(stateRoot)
    const created = await initial.create(
      draft('goal_diagnostics_rmw', 'session-diagnostics-rmw'),
    )
    await initial.appendObservation(created.id, { id: 'obs_valid' })
    await appendFile(
      join(stateRoot, 'goals', created.id, 'observations.jsonl'),
      'not-json\n',
      'utf8',
    )
    const missingRoot = join(stateRoot, 'goals', 'goal_diagnostics_missing')
    await mkdir(missingRoot, { recursive: true })
    await writeFile(join(missingRoot, 'events.jsonl'), '', 'utf8')
    await initial.list()

    const diagnosticsRead = deferred<void>()
    const releaseDiagnostics = deferred<void>()
    const diagnosticsUpdate = deferred<void>()
    const releaseUpdate = deferred<void>()
    const diagnosticsWrite = deferred<void>()
    const releaseWrite = deferred<void>()
    let writeReached = false
    const restarted = new GoalStore(stateRoot, {
      hooks: {
        async afterDiagnosticsRead() {
          diagnosticsRead.resolve()
          await releaseDiagnostics.promise
        },
        async beforeDiagnosticsUpdate() {
          diagnosticsUpdate.resolve()
          await releaseUpdate.promise
        },
        async beforeDiagnosticsWrite() {
          writeReached = true
          diagnosticsWrite.resolve()
          await releaseWrite.promise
        },
      },
    })
    const snapshot = restarted.diagnostics()
    await diagnosticsRead.promise

    const observations = restarted.readObservations(created.id)
    await diagnosticsUpdate.promise
    releaseUpdate.resolve()
    await new Promise<void>((resolveImmediate) =>
      setImmediate(resolveImmediate),
    )
    const updateWaitedForLoad = !writeReached
    releaseDiagnostics.resolve()
    await snapshot
    await diagnosticsWrite.promise
    releaseWrite.resolve()
    await observations

    expect(updateWaitedForLoad).toBe(true)
    expect(await restarted.diagnostics()).toMatchObject({
      issues: [
        expect.objectContaining({
          goalId: 'goal_diagnostics_missing',
          code: 'scope_missing',
        }),
      ],
      observationCorruptions: [
        expect.objectContaining({ goalId: created.id, badLines: 1 }),
      ],
    })
  })

  it('ignores schema-invalid diagnostics projections and rebuilds valid facts', async () => {
    const initial = new GoalStore(stateRoot)
    const created = await initial.create(
      draft('goal_invalid_diagnostics', 'session-invalid-diagnostics'),
    )
    const base = {
      indexRebuilt: false,
      indexCorruptBackup: null,
    }
    const invalidDocuments = [
      {
        ...base,
        issues: [null],
        observationCorruptions: [],
        deleteFailures: [],
      },
      {
        ...base,
        issues: [
          {
            goalId: created.id,
            code: 'not_a_recovery_issue',
            path: '/tmp/events',
            recovered: false,
          },
        ],
        observationCorruptions: [],
        deleteFailures: [],
      },
      {
        ...base,
        issues: [],
        observationCorruptions: [
          { goalId: created.id, path: '/tmp/observations', badLines: '1' },
        ],
        deleteFailures: [],
      },
      {
        ...base,
        issues: [],
        observationCorruptions: [],
        deleteFailures: [{ sessionId: 42, goalId: created.id }],
      },
    ]

    for (const document of invalidDocuments) {
      await writeFile(initial.diagnosticsPath, JSON.stringify(document), 'utf8')
      const restarted = new GoalStore(stateRoot)
      await expect(restarted.list()).resolves.toEqual([created])
      expect(await restarted.diagnostics()).toMatchObject({
        issues: [],
        observationCorruptions: [],
        deleteFailures: [],
      })
    }

    const missingRoot = join(stateRoot, 'goals', 'goal_rebuilt_diagnostics')
    await mkdir(missingRoot, { recursive: true })
    await writeFile(join(missingRoot, 'events.jsonl'), '', 'utf8')
    await writeFile(
      initial.diagnosticsPath,
      JSON.stringify(invalidDocuments[0]),
      'utf8',
    )
    const rebuilt = new GoalStore(stateRoot)

    await expect(rebuilt.list()).resolves.toEqual([created])
    expect(await rebuilt.diagnostics()).toMatchObject({
      issues: [
        expect.objectContaining({
          goalId: 'goal_rebuilt_diagnostics',
          code: 'scope_missing',
          recovered: false,
        }),
      ],
      observationCorruptions: [],
      deleteFailures: [],
    })
    expect(await new GoalStore(stateRoot).diagnostics()).toMatchObject({
      issues: [
        expect.objectContaining({
          goalId: 'goal_rebuilt_diagnostics',
          code: 'scope_missing',
        }),
      ],
    })
  })

  it('binds recovery event subtypes to recovery pause semantics before fsync', async () => {
    const store = new GoalStore(stateRoot)
    let planning = await store.create(
      draft('goal_event_subtype', 'session-event-subtype'),
    )
    planning = await lock(store, planning, T1)
    const path = join(stateRoot, 'goals', planning.id, 'events.jsonl')
    const executing = assertGoalTransition(planning, {
      ...planning,
      runtime: { ...planning.runtime, phase: 'executing' },
      updatedAt: T2,
    })
    const beforeFakeRecovery = await readFile(path, 'utf8')

    await expect(
      store.append(planning.id, {
        type: 'goal_recovery_paused',
        record: executing,
        createdAt: T2,
      }),
    ).rejects.toMatchObject({ code: 'goal_event_invalid' })
    expect(await readFile(path, 'utf8')).toBe(beforeFakeRecovery)

    const running = await store.append(planning.id, {
      type: 'goal_updated',
      record: executing,
      createdAt: T2,
    })
    const paused = assertGoalTransition(running, {
      ...running,
      runtime: {
        ...running.runtime,
        phase: 'paused',
        pauseReason: 'recovery_required',
      },
      updatedAt: T3,
    })
    const beforeFakeUpdate = await readFile(path, 'utf8')

    await expect(
      store.append(running.id, {
        type: 'goal_updated',
        record: paused,
        createdAt: T3,
      }),
    ).rejects.toMatchObject({ code: 'goal_event_invalid' })
    expect(await readFile(path, 'utf8')).toBe(beforeFakeUpdate)

    const recovered = await store.append(running.id, {
      type: 'goal_recovery_paused',
      record: paused,
      createdAt: T3,
      data: { reason: 'recovery_required' },
    })
    expect(recovered.runtime).toMatchObject({
      phase: 'paused',
      pauseReason: 'recovery_required',
    })
  })

  it('rejects create-only event types before fsync and keeps the ledger appendable', async () => {
    const store = new GoalStore(stateRoot)
    let planning = await store.create(
      draft('goal_reject_created_event', 'session-reject-created-event'),
    )
    planning = await lock(store, planning, T1)
    const executing = assertGoalTransition(planning, {
      ...planning,
      runtime: { ...planning.runtime, phase: 'executing' },
      updatedAt: T2,
    })
    const path = join(stateRoot, 'goals', planning.id, 'events.jsonl')
    const before = await readFile(path, 'utf8')

    await expect(
      store.append(planning.id, {
        type: 'goal_created',
        record: executing,
        createdAt: T2,
      } as unknown as GoalAppendInput),
    ).rejects.toMatchObject({ code: 'goal_event_invalid' })

    expect(await readFile(path, 'utf8')).toBe(before)
    const appended = await store.append(planning.id, {
      type: 'goal_updated',
      record: executing,
      createdAt: T2,
    })
    expect(await new GoalStore(stateRoot).get(planning.id)).toEqual(appended)
  })

  it('rejects non-plain event data before hashing or writing any bytes', async () => {
    const store = new GoalStore(stateRoot)
    let planning = await store.create(
      draft('goal_reject_date_data', 'session-reject-date-data'),
    )
    planning = await lock(store, planning, T1)
    const executing = assertGoalTransition(planning, {
      ...planning,
      runtime: { ...planning.runtime, phase: 'executing' },
      updatedAt: T2,
    })
    const path = join(stateRoot, 'goals', planning.id, 'events.jsonl')
    const before = await readFile(path, 'utf8')

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const value of [
      new Date(T2),
      undefined,
      BigInt(1),
      Number.NaN,
      cyclic,
    ]) {
      await expect(
        store.append(planning.id, {
          type: 'goal_updated',
          record: executing,
          createdAt: T2,
          data: { value } as unknown as GoalAppendInput['data'],
        }),
      ).rejects.toMatchObject({ code: 'goal_json_invalid' })
      expect(await readFile(path, 'utf8')).toBe(before)
    }
    const appended = await store.append(planning.id, {
      type: 'goal_updated',
      record: executing,
      createdAt: T2,
      data: { source: 'test' },
    })
    expect(await new GoalStore(stateRoot).get(planning.id)).toEqual(appended)
  })

  it('rejects undefined observations without creating a corrupt JSONL row', async () => {
    const store = new GoalStore(stateRoot)
    const created = await store.create(
      draft('goal_reject_observation', 'session-reject-observation'),
    )
    const path = join(stateRoot, 'goals', created.id, 'observations.jsonl')
    await store.appendObservation(created.id, { id: 'obs_before' })
    const before = await readFile(path, 'utf8')

    await expect(
      store.appendObservation(created.id, undefined),
    ).rejects.toMatchObject({ code: 'goal_json_invalid' })
    expect(await readFile(path, 'utf8')).toBe(before)

    await store.appendObservation(created.id, { id: 'obs_after' })
    expect(await store.readObservations(created.id)).toEqual({
      records: [{ id: 'obs_before' }, { id: 'obs_after' }],
      badLines: [],
    })
  })

  it('uses only stateRoot/goals and private POSIX modes for Goal data', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'emperor-workspace-'))
    const store = new GoalStore(stateRoot)
    const created = await store.create(
      newGoalRecord({
        id: 'goal_private_paths',
        outcome: 'Keep state private',
        scope: {
          sessionId: 'session-private',
          mode: 'build',
          projectId: 'project-private',
          workspaceRoot,
        },
        now: T0,
      }),
    )
    await store.appendObservation(created.id, { id: 'obs_private' })

    expect(store.goalsRoot).toBe(join(stateRoot, 'goals'))
    expect(existsSync(join(workspaceRoot, 'goals'))).toBe(false)
    if (process.platform !== 'win32') {
      expect((await stat(store.goalsRoot)).mode & 0o777).toBe(0o700)
      expect((await stat(join(store.goalsRoot, created.id))).mode & 0o777).toBe(
        0o700,
      )
      for (const file of [
        join(store.goalsRoot, 'index.json'),
        join(store.goalsRoot, created.id, 'goal.json'),
        join(store.goalsRoot, created.id, 'events.jsonl'),
        join(store.goalsRoot, created.id, 'observations.jsonl'),
      ]) {
        expect((await stat(file)).mode & 0o777).toBe(0o600)
      }
    }
  })
})

function draft(id: string, sessionId: string): GoalRecord {
  return newGoalRecord({
    id,
    outcome: 'Ship a durable goal',
    scope: {
      sessionId,
      mode: 'build',
      projectId: 'project-1',
      workspaceRoot: join(stateRoot, 'workspace'),
    },
    now: T0,
  })
}

function definition() {
  return {
    inScope: ['Goal persistence'],
    outOfScope: [],
    constraints: ['Crash safe'],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'Ledger can recover state',
        required: true,
        verification: { kind: 'command' as const, requirement: 'npm test' },
      },
    ],
    escalationConditions: [],
  }
}

async function lock(
  store: GoalStore,
  current: GoalRecord,
  at: string,
): Promise<GoalRecord> {
  return store.append(current.id, {
    type: 'goal_updated',
    record: GoalContractValidator.lock(current, definition(), at),
    createdAt: at,
  })
}

async function move(
  store: GoalStore,
  current: GoalRecord,
  phase: GoalRecord['runtime']['phase'],
  at: string,
  pauseReason: string | null = null,
): Promise<GoalRecord> {
  const next = assertGoalTransition(current, {
    ...current,
    runtime: { ...current.runtime, phase, pauseReason },
    updatedAt: at,
  })
  return store.append(current.id, {
    type:
      phase === 'paused' && pauseReason === 'recovery_required'
        ? 'goal_recovery_paused'
        : 'goal_updated',
    record: next,
    createdAt: at,
  })
}

async function cancel(
  store: GoalStore,
  current: GoalRecord,
  at: string,
): Promise<GoalRecord> {
  const next = assertGoalTransition(current, {
    ...current,
    status: 'cancelled',
    runtime: { ...current.runtime, phase: 'terminal' },
    terminalAt: at,
    updatedAt: at,
  })
  return store.append(current.id, {
    type: 'goal_updated',
    record: next,
    createdAt: at,
  })
}

async function readEvents(goalRoot: string): Promise<GoalEventEnvelope[]> {
  return (await readFile(join(goalRoot, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as GoalEventEnvelope)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
