import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EmperorError } from '../errors'
import {
  DEFAULT_GOAL_GUARD_POLICY,
  goalSummary,
  isGoalTerminal,
  newGoalRecord,
  parseGoalRecord,
  type GoalAcceptanceCriterion,
  type GoalRecord,
} from './index'

const CREATED_AT = '2026-07-15T10:00:00.000Z'

function workspace(): string {
  return join(process.cwd(), '.goal-test-workspaces', 'models')
}

function criterion(
  id = 'AC-1',
  kind: GoalAcceptanceCriterion['verification']['kind'] = 'command',
): GoalAcceptanceCriterion {
  return {
    id,
    description: `Verify ${id}`,
    required: true,
    verification: { kind, requirement: `check ${id}` },
  }
}

function expectGoalCode(run: () => unknown, code: string): void {
  try {
    run()
    throw new Error('expected Goal operation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(EmperorError)
    expect((error as EmperorError).code).toBe(code)
  }
}

function expectDeepFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  for (const nested of Object.values(value)) expectDeepFrozen(nested)
}

describe('Goal models', () => {
  it('creates a draft Goal with normalized Outcome, scope and safe defaults', () => {
    const root = workspace()
    const goal = newGoalRecord({
      id: 'goal_minimal',
      outcome: '  ship the Goal domain  ',
      scope: {
        sessionId: 'session-1',
        mode: 'build',
        projectId: 'project-1',
        workspaceRoot: root,
      },
      contract: { acceptanceCriteria: [criterion()] },
      now: CREATED_AT,
    })

    expect(goal).toMatchObject({
      schemaVersion: 'emperor.goal.v1',
      id: 'goal_minimal',
      status: 'draft',
      scope: {
        sessionId: 'session-1',
        mode: 'build',
        projectId: 'project-1',
        workspaceRoot: root,
      },
      contract: {
        outcome: 'ship the Goal domain',
        acceptanceCriteria: [criterion()],
        lockedAt: null,
        revision: 1,
      },
      runtime: {
        phase: 'contract',
        cyclesUsed: 0,
        consecutiveNoEvidenceCycles: 0,
        currentRunId: null,
        currentPlanId: null,
        pendingInteractionId: null,
        lastEvidenceAt: null,
        pauseReason: null,
      },
      guardPolicy: DEFAULT_GOAL_GUARD_POLICY,
      latestEvidenceByCriterion: {},
      supersedesGoalId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      terminalAt: null,
      lastEventSeq: 0,
    })
    expect(goal.scope.projectFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns a deeply frozen snapshot from the factory', () => {
    const goal = newGoalRecord({
      id: 'goal_frozen_factory',
      outcome: 'freeze the initial snapshot',
      scope: {
        sessionId: 'session-frozen-factory',
        mode: 'build',
        projectId: 'project-frozen-factory',
        workspaceRoot: workspace(),
      },
      contract: { acceptanceCriteria: [criterion()] },
      now: CREATED_AT,
    })
    const mutable = goal as unknown as {
      status: string
      scope: { workspaceRoot: string }
    }

    expectDeepFrozen(goal)
    expect(() => {
      mutable.status = 'active'
    }).toThrow(TypeError)
    expect(() => {
      mutable.scope.workspaceRoot = '/private/tampered'
    }).toThrow(TypeError)
    expect(goal.status).toBe('draft')
  })

  it('exposes Goal snapshots as deeply readonly at compile time', () => {
    const goal = newGoalRecord({
      id: 'goal_readonly_types',
      outcome: 'keep public types readonly',
      scope: {
        sessionId: 'session-readonly-types',
        mode: 'chat',
        projectId: null,
        workspaceRoot: workspace(),
      },
      contract: { acceptanceCriteria: [criterion()] },
      now: CREATED_AT,
    })

    const assertDeepReadonly = (snapshot: GoalRecord): void => {
      // @ts-expect-error GoalRecord fields are readonly.
      snapshot.status = 'active'
      // @ts-expect-error Nested GoalScope fields are readonly.
      snapshot.scope.workspaceRoot = '/private/tampered'
      // @ts-expect-error Contract arrays are readonly.
      snapshot.contract.constraints.push('tampered')
      // @ts-expect-error Nested verification fields are readonly.
      snapshot.contract.acceptanceCriteria[0]!.verification.requirement =
        'changed'
    }
    expect(assertDeepReadonly).toBeTypeOf('function')
    expect(goal.status).toBe('draft')
  })

  it('accepts Outcome lengths 1 and 4000 and rejects whitespace or 4001', () => {
    const root = workspace()
    const make = (outcome: string) =>
      newGoalRecord({
        id: 'goal_boundary',
        outcome,
        scope: {
          sessionId: 'session-boundary',
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: CREATED_AT,
      })

    expect(make('x').contract.outcome).toBe('x')
    expect(make('x'.repeat(4000)).contract.outcome).toHaveLength(4000)
    expectGoalCode(() => make('   '), 'goal_outcome_invalid')
    expectGoalCode(() => make('x'.repeat(4001)), 'goal_outcome_invalid')
  })

  it('binds every Goal to a canonical workspace and hashes project ID with it', () => {
    const root = workspace()
    const build = (projectId: string) =>
      newGoalRecord({
        id: `goal_${projectId}`,
        outcome: 'bind scope',
        scope: {
          sessionId: 'session-scope',
          mode: 'build',
          projectId,
          workspaceRoot: root,
        },
        now: CREATED_AT,
      })

    const first = build('project-a')
    expect(build('project-a').scope.projectFingerprint).toBe(
      first.scope.projectFingerprint,
    )
    expect(build('project-b').scope.projectFingerprint).not.toBe(
      first.scope.projectFingerprint,
    )

    const chat = newGoalRecord({
      id: 'goal_chat',
      outcome: 'chat scope',
      scope: {
        sessionId: 'session-chat',
        mode: 'chat',
        projectId: null,
        workspaceRoot: root,
      },
      now: CREATED_AT,
    })
    expect(chat.scope.workspaceRoot).toBe(root)
    expect(chat.scope.projectFingerprint).toMatch(/^[a-f0-9]{64}$/)

    const otherChat = newGoalRecord({
      id: 'goal_chat_other_workspace',
      outcome: 'chat scope',
      scope: {
        sessionId: 'session-chat-other-workspace',
        mode: 'chat',
        projectId: null,
        workspaceRoot: `${root}-other`,
      },
      now: CREATED_AT,
    })
    expect(otherChat.scope.projectFingerprint).not.toBe(
      chat.scope.projectFingerprint,
    )
  })

  it('rejects chat workspace drift against its saved binding fingerprint', () => {
    const goal = newGoalRecord({
      id: 'goal_chat_drift',
      outcome: 'detect chat workspace drift',
      scope: {
        sessionId: 'session-chat-drift',
        mode: 'chat',
        projectId: null,
        workspaceRoot: workspace(),
      },
      now: CREATED_AT,
    })
    const raw = structuredClone(goal) as unknown as Record<string, unknown>
    ;(raw.scope as Record<string, unknown>).workspaceRoot =
      `${workspace()}-moved`

    expectGoalCode(() => parseGoalRecord(raw), 'goal_scope_mismatch')
  })

  it('rejects an invalid runtime scope mode with a typed error', () => {
    expectGoalCode(
      () =>
        newGoalRecord({
          id: 'goal_invalid_mode',
          outcome: 'reject invalid mode',
          scope: {
            sessionId: 'session-invalid-mode',
            mode: 'agent' as 'chat',
            projectId: null,
            workspaceRoot: workspace(),
          },
          now: CREATED_AT,
        }),
      'goal_scope_invalid',
    )
  })

  it('rejects a relative workspace root instead of resolving it implicitly', () => {
    expectGoalCode(
      () =>
        newGoalRecord({
          id: 'goal_relative_workspace',
          outcome: 'keep workspace binding pure',
          scope: {
            sessionId: 'session-relative-workspace',
            mode: 'chat',
            projectId: null,
            workspaceRoot: 'relative/workspace',
          },
          now: CREATED_AT,
        }),
      'goal_scope_invalid',
    )
  })

  it('preserves significant trailing spaces through factory and parser binding', () => {
    const workspaceWithTrailingSpace = `${workspace()} `
    const created = newGoalRecord({
      id: 'goal_workspace_trailing_space',
      outcome: 'preserve significant path characters',
      scope: {
        sessionId: 'session-workspace-trailing-space',
        mode: 'chat',
        projectId: null,
        workspaceRoot: workspaceWithTrailingSpace,
      },
      now: CREATED_AT,
    })
    const parsed = parseGoalRecord(structuredClone(created))
    const withoutTrailingSpace = newGoalRecord({
      id: 'goal_workspace_without_trailing_space',
      outcome: 'distinguish workspace bindings',
      scope: {
        sessionId: 'session-workspace-without-trailing-space',
        mode: 'chat',
        projectId: null,
        workspaceRoot: workspace(),
      },
      now: CREATED_AT,
    })

    expect(created.scope.workspaceRoot).toBe(workspaceWithTrailingSpace)
    expect(parsed.scope.workspaceRoot).toBe(workspaceWithTrailingSpace)
    expect(created.scope.projectFingerprint).not.toBe(
      withoutTrailingSpace.scope.projectFingerprint,
    )
  })

  it('parses v1 records with safe defaults for omitted optional fields', () => {
    const raw = structuredClone(
      newGoalRecord({
        id: 'goal_legacy',
        outcome: 'load a v1 record',
        scope: {
          sessionId: 'session-legacy',
          mode: 'chat',
          projectId: null,
          workspaceRoot: workspace(),
        },
        now: CREATED_AT,
      }),
    ) as unknown as Record<string, unknown>
    delete raw.guardPolicy
    delete raw.latestEvidenceByCriterion
    delete raw.supersedesGoalId
    delete raw.terminalAt
    delete raw.lastEventSeq
    const runtime = raw.runtime as Record<string, unknown>
    delete runtime.currentRunId
    delete runtime.currentPlanId
    delete runtime.pendingInteractionId
    delete runtime.lastEvidenceAt
    delete runtime.pauseReason
    const contract = raw.contract as Record<string, unknown>
    delete contract.inScope
    delete contract.outOfScope
    delete contract.constraints
    delete contract.escalationConditions
    delete (raw.scope as Record<string, unknown>).projectFingerprint

    const parsed = parseGoalRecord(raw)

    expect(parsed.guardPolicy).toEqual(DEFAULT_GOAL_GUARD_POLICY)
    expect(parsed.latestEvidenceByCriterion).toEqual({})
    expect(parsed.supersedesGoalId).toBeNull()
    expect(parsed.terminalAt).toBeNull()
    expect(parsed.lastEventSeq).toBe(0)
    expect(parsed.contract.inScope).toEqual([])
    expect(parsed.contract.outOfScope).toEqual([])
    expect(parsed.contract.constraints).toEqual([])
    expect(parsed.contract.escalationConditions).toEqual([])
    expect(parsed.runtime).toMatchObject({
      currentRunId: null,
      currentPlanId: null,
      pendingInteractionId: null,
      lastEvidenceAt: null,
      pauseReason: null,
    })
    expect(parsed.scope.projectFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(parsed).not.toBe(raw)
    expectDeepFrozen(parsed)
  })

  it('rejects a locked active v1 record with a missing workspace fingerprint', () => {
    const raw = structuredClone(
      newGoalRecord({
        id: 'goal_locked_missing_fingerprint',
        outcome: 'never lose a locked workspace binding',
        scope: {
          sessionId: 'session-locked-missing-fingerprint',
          mode: 'chat',
          projectId: null,
          workspaceRoot: workspace(),
        },
        contract: { acceptanceCriteria: [criterion()] },
        now: CREATED_AT,
      }),
    ) as unknown as Record<string, unknown>
    raw.status = 'active'
    ;(raw.runtime as Record<string, unknown>).phase = 'planning'
    ;(raw.contract as Record<string, unknown>).lockedAt =
      '2026-07-15T10:05:00.000Z'
    delete (raw.scope as Record<string, unknown>).projectFingerprint

    expectGoalCode(() => parseGoalRecord(raw), 'goal_scope_mismatch')
  })

  it('rejects unknown schema versions with a typed safe error', () => {
    const secretRoot = '/Users/private-owner/secret-workspace'
    expectGoalCode(
      () =>
        parseGoalRecord({
          schemaVersion: 'emperor.goal.v2',
          scope: { workspaceRoot: secretRoot },
        }),
      'goal_schema_version_unsupported',
    )

    try {
      parseGoalRecord({
        schemaVersion: 'emperor.goal.v1',
        scope: { workspaceRoot: secretRoot },
      })
      throw new Error('expected parse to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(EmperorError)
      const safe = (error as EmperorError).toSafe()
      expect(safe.code).toBe('goal_record_invalid')
      expect(JSON.stringify(safe)).not.toContain(secretRoot)
    }
  })

  it('summarizes evidence verdicts without exposing private scope', () => {
    const goal = newGoalRecord({
      id: 'goal_summary',
      outcome: 'summarize the Goal',
      scope: {
        sessionId: 'session-summary',
        mode: 'chat',
        projectId: null,
        workspaceRoot: workspace(),
      },
      contract: {
        acceptanceCriteria: [
          criterion('AC-1'),
          criterion('AC-2'),
          criterion('AC-3'),
        ],
      },
      now: CREATED_AT,
    })
    const record: GoalRecord = {
      ...goal,
      runtime: {
        ...goal.runtime,
        currentPlanId: 'plan-current',
        cyclesUsed: 7,
      },
      latestEvidenceByCriterion: {
        'AC-1': 'evidence-pass',
        'AC-2': 'evidence-fail',
      },
    }

    const summary = goalSummary(record, {
      'evidence-pass': 'pass',
      'evidence-fail': 'fail',
    })

    expect(summary).toEqual({
      id: 'goal_summary',
      status: 'draft',
      phase: 'contract',
      outcome: 'summarize the Goal',
      sessionId: 'session-summary',
      currentPlanId: 'plan-current',
      cyclesUsed: 7,
      createdAt: CREATED_AT,
      lastEventSeq: 0,
      acceptance: {
        passed: 1,
        failed: 1,
        missing: 1,
        total: 3,
        criteria: [
          {
            id: 'AC-1',
            description: 'Verify AC-1',
            required: true,
            verificationKind: 'command',
            verdict: 'pass',
            evidenceSummary: null,
          },
          {
            id: 'AC-2',
            description: 'Verify AC-2',
            required: true,
            verificationKind: 'command',
            verdict: 'fail',
            evidenceSummary: null,
          },
          {
            id: 'AC-3',
            description: 'Verify AC-3',
            required: true,
            verificationKind: 'command',
            verdict: 'missing',
            evidenceSummary: null,
          },
        ],
      },
      updatedAt: CREATED_AT,
    })
    expect(summary).not.toHaveProperty('scope')
    expect(summary).not.toHaveProperty('workspaceRoot')
  })

  it('recognizes every terminal status and no non-terminal status', () => {
    expect(isGoalTerminal('completed')).toBe(true)
    expect(isGoalTerminal('blocked')).toBe(true)
    expect(isGoalTerminal('cancelled')).toBe(true)
    expect(isGoalTerminal('stopped_by_policy')).toBe(true)
    expect(isGoalTerminal('draft')).toBe(false)
    expect(isGoalTerminal('active')).toBe(false)
  })
})
