// Value boundaries and records (ported from dsh-workflow-worker-thread
// `meta.spec.ts` / `realm.spec.ts`, dsh-tools json-schema coverage, and the
// dsh-workflow / dsh-tool-workflow invariant specs as fold assertions).
import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { Session } from '../../session-log/session'
import { SessionLogStore } from '../../session-log/store'
import { jsonSchema } from '../tools/json-schema'
import { WorkflowError, isFatalWorkflowError } from './errors'
import { validateMeta } from './meta'
import { realm } from './realm'
import {
  WorkflowRunFold,
  WorkflowRunRegistry,
  workflowTaskView,
} from './records'
import type { WorkflowRun } from './types'

describe('validateMeta', () => {
  it('accepts a minimal meta and returns a normalized copy', () => {
    const input = { name: 'n', description: 'd' }
    const meta = validateMeta(input)
    expect(meta).toEqual(input)
    expect(meta).not.toBe(input)
  })

  it('accepts the full shape and rebuilds phases entry by entry', () => {
    const phases = [{ title: 't', detail: 'x', provider: 'p', model: 'm' }]
    const meta = validateMeta({
      name: 'n',
      description: 'd',
      whenToUse: 'w',
      phases,
    })
    expect(meta.phases).toEqual(phases)
    expect(meta.phases).not.toBe(phases)
  })

  it('names every violation in one META_INVALID throw', () => {
    let caught: unknown
    try {
      validateMeta({
        name: '',
        description: 3,
        extra: 1,
        phases: [{ title: '' }, 3],
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkflowError)
    expect((caught as WorkflowError).code).toBe('META_INVALID')
    const message = (caught as Error).message
    for (const fragment of [
      'meta.extra is not a recognized field',
      'meta.name must be a non-empty string',
      'meta.description must be a non-empty string',
      'meta.phases[0].title must be a non-empty string',
      'meta.phases[1] must be an object',
    ])
      expect(message).toContain(fragment)
    expect(() => validateMeta(null)).toThrow(
      'invalid meta: meta must be an object',
    )
  })

  it('WorkflowError carries code + fatal (default true)', () => {
    const fatal = new WorkflowError('x', 'AGENT_CAP')
    expect(fatal.fatal).toBe(true)
    expect(isFatalWorkflowError(fatal)).toBe(true)
    expect(
      isFatalWorkflowError(
        new WorkflowError('x', 'AGENT_CAP', { fatal: false }),
      ),
    ).toBe(false)
    expect(isFatalWorkflowError(new Error('x'))).toBe(false)
  })
})

describe('materializeFromRealm', () => {
  const inRealm = (source: string): unknown =>
    vm.runInContext(`(${source})`, vm.createContext({}))

  it('copies realm objects/arrays/scalars into host plain data', () => {
    const value = realm.materializeFromRealm(
      inRealm('{ a: [1, "x", true, null], b: { c: 2 } }'),
    )
    expect(value).toEqual({ a: [1, 'x', true, null], b: { c: 2 } })
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  })

  it('accepts undefined only at the root', () => {
    expect(realm.materializeFromRealm(undefined)).toBeUndefined()
    expect(() => realm.materializeFromRealm({ a: undefined })).toThrow(
      'value.a: undefined is not JSON data',
    )
  })

  it('a "__proto__" key becomes an own data property, never a prototype mutation', () => {
    const value = realm.materializeFromRealm(
      inRealm('JSON.parse(\'{"__proto__": {"polluted": true}}\')'),
    ) as Record<string, unknown>
    expect(Object.getOwnPropertyNames(value)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects functions, symbols, bigints, non-finite numbers, exotic prototypes, cycles, sparse arrays', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const cases: Array<[unknown, string]> = [
      [{ f: () => 1 }, 'value.f: functions are not plain JSON data'],
      [{ s: Symbol('x') }, 'value.s: symbols are not plain JSON data'],
      [{ [Symbol('k')]: 1 }, 'symbol-keyed properties'],
      [{ b: 1n }, 'value.b: bigints are not JSON data'],
      [{ n: Number.NaN }, 'non-finite numbers'],
      [{ d: new Date() }, 'exotic prototype'],
      [{ m: new Map() }, 'exotic prototype'],
      [cycle, 'circular references'],
      [new Array<number>(3), 'sparse arrays'],
      [Object.assign([1], { extra: 2 }), 'non-index properties'],
    ]
    for (const [value, message] of cases)
      expect(() => realm.materializeFromRealm(value)).toThrow(message)
  })

  it('accepts a DAG, null-prototype data, and a throwing getter surfaces rendered', () => {
    const shared = { x: 1 }
    expect(realm.materializeFromRealm({ a: shared, b: shared })).toEqual({
      a: { x: 1 },
      b: { x: 1 },
    })
    const bare = Object.create(null) as Record<string, unknown>
    bare.k = 1
    expect(realm.materializeFromRealm(bare)).toEqual({ k: 1 })
    const throwing = {
      get boom(): never {
        throw new Error('getter broke')
      },
    }
    expect(() => realm.materializeFromRealm(throwing)).toThrow(
      /reading the value threw: .*getter broke/s,
    )
  })

  it('renderThrown is total and prefers the stack', () => {
    const error = new Error('m')
    expect(realm.renderThrown(error)).toBe(error.stack)
    expect(realm.renderThrown({ message: 'only message' })).toBe('only message')
    expect(realm.renderThrown(42)).toBe('42')
    const hostile = {
      get stack(): never {
        throw new Error('no')
      },
    }
    expect(realm.renderThrown(hostile)).toBe('[unrenderable thrown value]')
  })
})

describe('json-schema subset', () => {
  it('accepts the subset and rejects unsupported or misplaced keywords', () => {
    expect(() =>
      jsonSchema.assertObjectJsonSchema({
        type: 'object',
        description: 'x',
        properties: {
          s: { type: 'string', enum: ['a', 'b'] },
          n: { type: 'integer', const: 1 },
          list: { type: 'array', items: { type: 'number' } },
          either: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          any: {},
        },
        required: ['s'],
        additionalProperties: false,
      }),
    ).not.toThrow()
    const cases: Array<[unknown, string]> = [
      [{ type: 'string' }, 'object-rooted'],
      [
        { type: 'object', pattern: 'x' },
        'schema.pattern is not a supported keyword',
      ],
      [{ type: ['object', 'null'] }, 'type arrays are not supported'],
      [{ type: 'object', required: ['missing'] }, 'required names "missing"'],
      [
        { type: 'object', items: {} },
        'schema.items is not supported on type "object"',
      ],
      [
        { type: 'object', properties: { e: { type: 'string', enum: [1] } } },
        'enum must be a non-empty array of string',
      ],
      [
        { type: 'object', properties: { o: { oneOf: [{ type: 'string' }] } } },
        'at least two schemas',
      ],
    ]
    for (const [schema, message] of cases)
      expect(() => jsonSchema.assertObjectJsonSchema(schema)).toThrow(message)
  })

  it('validates values with path-qualified violations', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        ok: { type: 'boolean' as const },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
        kind: { type: 'string' as const, enum: ['a', 'b'] },
        pick: {
          oneOf: [{ type: 'string' as const }, { type: 'integer' as const }],
        },
      },
      required: ['ok'],
      additionalProperties: false,
    }
    expect(
      jsonSchema.validateJsonSchemaValue(schema, {
        ok: true,
        tags: ['x'],
        kind: 'a',
        pick: 1,
      }),
    ).toEqual([])
    expect(
      jsonSchema.validateJsonSchemaValue(schema, {
        tags: [1],
        kind: 'z',
        pick: 1.5,
        extra: 1,
      }),
    ).toEqual([
      'missing required property "value.ok"',
      '"value.tags[0]" must be a string',
      '"value.kind" must be one of ["a","b"]',
      '"value.pick" must match exactly one oneOf branch (matched 0)',
      '"value.extra" is not a declared property (additionalProperties: false)',
    ])
  })
})

describe('workflow run records', () => {
  function session(id = 's'): Session {
    const store = new SessionLogStore({
      root: '/tmp/emperor-wf-records',
      persist: false,
    })
    return store.create({ id, cwd: '/workspace' })
  }

  function fakeRun(id: string): WorkflowRun & { cancels: string[] } {
    const cancels: string[] = []
    return {
      id,
      meta: { name: 'flow', description: 'desc' },
      result: new Promise(() => {}),
      cancel: (reason?: string) => {
        cancels.push(reason ?? '')
      },
      dispose: async () => {},
      cancels,
    }
  }

  it('records a legal continuous trace and folds it (members paired, narration kept)', () => {
    const log = session()
    const registry = new WorkflowRunRegistry()
    const run = fakeRun('r1')
    registry.begin(run, {
      owner: { id: 'owner', session: log },
      tool: 'workflow',
      callId: 'c1',
    })
    const info = { id: 'r1', meta: run.meta }
    registry.observer.phase?.(info, 'p1')
    registry.observer.agentStart?.(info, {
      seq: 1,
      label: 'a',
      phase: 'p1',
      childId: 'sub-1',
    })
    registry.observer.log?.(info, 'working')
    registry.observer.agentEnd?.(info, {
      seq: 1,
      label: 'a',
      phase: 'p1',
      childId: 'sub-1',
      outcome: 'completed',
    })
    // Events for an unknown run are not recorded.
    registry.observer.log?.({ id: 'other', meta: run.meta }, 'ignored')
    expect(registry.isLive('r1')).toBe(true)
    expect(registry.cancel('r1')).toBe(true)
    expect(run.cancels).toEqual(['cancelled by the user'])
    registry.finish('r1', {
      stopReason: 'completed',
      agentsStarted: 1,
      result: 'done',
    })
    expect(registry.isLive('r1')).toBe(false)
    expect(registry.cancel('r1')).toBe(false)
    const [record] = WorkflowRunFold.fold(log.events)
    expect(record).toMatchObject({
      runId: 'r1',
      name: 'flow',
      description: 'desc',
      tool: 'workflow',
      callId: 'c1',
      status: 'completed',
      agentsStarted: 1,
      currentPhase: 'p1',
      result: 'done',
      agents: [
        {
          seq: 1,
          label: 'a',
          phase: 'p1',
          childId: 'sub-1',
          outcome: 'completed',
        },
      ],
    })
    expect(record!.narration.map((entry) => [entry.kind, entry.text])).toEqual([
      ['phase', 'p1'],
      ['log', 'working'],
    ])
    // A running record whose run is no longer live reads as interrupted.
    registry.begin(fakeRun('r2'), {
      owner: { id: 'owner', session: log },
      tool: 'ralph',
    })
    const running = WorkflowRunFold.fold(log.events).find(
      (entry) => entry.runId === 'r2',
    )!
    expect(workflowTaskView(running, 's', { live: false }).status).toBe(
      'interrupted',
    )
    expect(workflowTaskView(running, 's', { live: true })).toMatchObject({
      id: 'r2',
      kind: 'workflow',
      status: 'running',
      workflow_tool: 'ralph',
      rounds: 0,
    })
  })

  it('the fold ignores updates after run-end, unknown runs, and duplicate starts', () => {
    const log = session()
    log.append('tool-workflow/run-start', { runId: 'r', name: 'n' })
    log.append('tool-workflow/run-start', { runId: 'r', name: 'dup' })
    log.append('tool-workflow/agent-end', {
      runId: 'r',
      seq: 9,
      outcome: 'failed',
    })
    log.append('tool-workflow/run-end', {
      runId: 'r',
      stopReason: 'cancelled',
      error: 'stop',
    })
    log.append('tool-workflow/log', { runId: 'r', message: 'late' })
    log.append('tool-workflow/log', { runId: 'ghost', message: 'x' })
    const records = WorkflowRunFold.fold(log.events)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      name: 'n',
      status: 'cancelled',
      error: 'stop',
      narration: [],
    })
  })

  it('a failed append disables recording for that run without throwing', () => {
    const registry = new WorkflowRunRegistry()
    const broken = {
      append: () => {
        throw new Error('disk full')
      },
    } as unknown as Session
    const run = fakeRun('r')
    expect(() =>
      registry.begin(run, {
        owner: { id: 'o', session: broken },
        tool: 'workflow',
      }),
    ).not.toThrow()
    expect(() =>
      registry.observer.log?.({ id: 'r', meta: run.meta }, 'x'),
    ).not.toThrow()
    expect(() =>
      registry.finish('r', { stopReason: 'completed', agentsStarted: 0 }),
    ).not.toThrow()
  })
})
