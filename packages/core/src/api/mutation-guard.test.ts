import { describe, expect, it } from 'vitest'
import {
  assertCoreMutationAllowed,
  CoreMutationGuardError,
} from './mutation-guard'
import { EmperorError } from '../errors'

describe('mutation guard (MIG-IPC-008)', () => {
  it('allows direct user actions in ask_before_edit mode', () => {
    expect(() =>
      assertCoreMutationAllowed(
        { mode: 'ask_before_edit', pending: null },
        { area: 'scheduler', action: 'run' },
      ),
    ).not.toThrow()
  })

  it('rejects mutations while Ask / Plan is pending', () => {
    expect(() =>
      assertCoreMutationAllowed(
        { mode: 'ask_before_edit', pending: { id: 'ask_1' } },
        { area: 'team', action: 'wake teammate' },
      ),
    ).toThrow(CoreMutationGuardError)
    try {
      assertCoreMutationAllowed(
        { mode: 'ask_before_edit', pending: { id: 'ask_1' } },
        { area: 'team', action: 'wake teammate' },
      )
    } catch (error) {
      expect(error).toMatchObject({ status: 409 })
    }
  })

  it('rejects plan mode mutations', () => {
    try {
      assertCoreMutationAllowed(
        { mode: 'plan', pending: null },
        { area: 'scheduler', action: 'create' },
      )
    } catch (error) {
      expect(error).toMatchObject({ status: 403 })
      expect(String((error as Error).message)).toContain('计划模式')
    }
  })

  it('FIX-13 · 7 · reads plan mode from the v3 control payload', () => {
    // v3: `mode` is the permission preset; plan mode is its own flag.
    const plan = {
      version: 3,
      mode: 'workspace-write',
      preset: 'workspace-write',
      plan: true,
      pending: null,
    }
    expect(() =>
      assertCoreMutationAllowed(plan, {
        area: 'processes',
        action: 'reparent',
      }),
    ).toThrow(expect.objectContaining({ code: 'mutation_blocked_plan' }))
    expect(() =>
      assertCoreMutationAllowed(
        { ...plan, plan: false },
        { area: 'processes', action: 'reparent' },
      ),
    ).not.toThrow()
  })

  it('FIX-10 · 4 · carries a code and Chinese text across IPC', () => {
    for (const [control, code, text] of [
      [{ mode: 'plan', pending: null }, 'mutation_blocked_plan', '计划模式'],
      [
        { mode: 'ask_before_edit', pending: { id: 'ask_1' } },
        'mutation_blocked_pending',
        '等你回复',
      ],
    ] as const) {
      try {
        assertCoreMutationAllowed(control, {
          area: 'processes',
          action: 'reparent',
        })
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(EmperorError)
        expect((error as EmperorError).toSafe()).toMatchObject({
          code,
          message: expect.stringContaining(text),
        })
      }
    }
    expect(new CoreMutationGuardError(403, 'x').toSafe().code).toBe(
      'mutation_forbidden',
    )
    expect(new CoreMutationGuardError(409, 'x').toSafe().code).toBe(
      'mutation_conflict',
    )
  })
})
