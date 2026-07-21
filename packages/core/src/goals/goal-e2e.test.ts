import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizedGoalCompletionGate } from '../agent/goal-completion-gate-internal'
import { CoreApi } from '../api/core-api'
import {
  GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
  GOAL_PERMISSION_BLOCKER_QUESTION_ID,
} from '../control/goal-blocker'
import {
  GOAL_MANUAL_EVIDENCE_PASS_LABEL,
  GOAL_MANUAL_EVIDENCE_QUESTION_ID,
} from '../control/goal-manual-evidence'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { makePlanRecord, PlanStatus, PlanStepStatus } from '../plans/models'
import { PlanStore } from '../plans/store'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { TaskManager } from '../tasks/manager'
import { ToolResultObj } from '../tools/base'
import { ToolRegistry } from '../tools/registry'
import { GoalBlockerFactStore } from './blocker-facts'
import {
  GoalEvidenceLedger,
  GoalObservationRecorder,
  type GoalEvidence,
} from './evidence'
import { GoalGateFactStore } from './gate-facts'
import { GoalPlanBridge } from './plan-bridge'
import { GoalRecoveryService } from './recovery'
import { GoalReviewerLedger } from './reviewer'
import { GoalStore } from './store'
import { CompleteGoalTool, GoalToolHost, RecordGoalEvidenceTool } from './tools'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')
const T0 = '2026-07-15T08:00:00.000Z'
const T1 = '2026-07-15T08:01:00.000Z'
const T2 = '2026-07-15T08:02:00.000Z'
const T3 = '2026-07-15T08:03:00.000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('Goal mode deterministic E2E', () => {
  it('runs Contract -> Plan awaiting -> CoreApi approval -> Goal coordinator resume through the real model loop', async () => {
    const root = temp('goal-e2e-plan-control-')
    const events: Record<string, unknown>[] = []
    const provider = new GoalPlanProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, 'state'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      initializeMcp: false,
      eventSink: (event) => {
        events.push(event)
      },
    })
    const session = api.sessions.create({
      title: 'Goal Plan control',
      mode: 'build',
      project_path: root,
    })
    api.sessions.activate(String(session.id))

    const started = await api.goals.start({
      outcome: 'Approve and resume a durable Goal Plan.',
      sessionId: String(session.id),
    })
    await settleGoal(api, started.goal.id)
    const pending = api.loop.controlManager.store.load().pending
    expect(pending).toMatchObject({ kind: 'plan', status: 'waiting' })
    expect(pending?.meta).toMatchObject({
      goal_id: started.goal.id,
      goal_session_id: String(session.id),
    })
    expect(await api.loop.goalStore.get(started.goal.id)).toMatchObject({
      status: 'active',
      runtime: {
        phase: 'awaiting_user',
        pendingInteractionId: pending?.id,
        currentPlanId: null,
      },
    })

    await api.control.approvePlan(String(pending?.id), { uiHidden: true })
    await settleGoal(api, started.goal.id)
    const resumed = await api.loop.goalStore.get(started.goal.id)
    expect(resumed).toMatchObject({
      status: 'active',
      runtime: {
        phase: 'paused',
        currentPlanId: String(pending?.meta.plan_id),
        pendingInteractionId: null,
        pauseReason: 'no_new_evidence',
      },
    })
    expect(provider.calls).toBeGreaterThanOrEqual(5)
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'goal_created',
        'goal_runtime_update',
        'goal_paused',
      ]),
    )
    expect(
      events
        .filter((event) => String(event.event).startsWith('goal_'))
        .every((event) => event.session_id === String(session.id)),
    ).toBe(true)
    await api.goals.resume(started.goal.id)
    await settleGoal(api, started.goal.id)
    expect(events.map((event) => event.event)).toContain('goal_resumed')
    await api.close()
  }, 15_000)

  it('keeps background Goal control and runtime ownership on session A when the user switches to session B', async () => {
    const root = temp('goal-e2e-session-switch-')
    const provider = new SwitchableGoalPlanProvider()
    const api = await createApi(root, join(root, 'state'), provider)
    const sessionA = api.sessions.create({
      title: 'Goal owner',
      mode: 'build',
      project_path: root,
    })
    const sessionB = api.sessions.create({ title: 'Foreground chat' })
    api.sessions.activate(String(sessionA.id))
    const started = await api.goals.start({
      outcome: 'Keep background ownership stable.',
      sessionId: String(sessionA.id),
    })
    await within(provider.entered, 2_000, 'provider did not enter')
    api.sessions.activate(String(sessionB.id))
    provider.release()
    await within(
      settleGoal(api, started.goal.id),
      3_000,
      'Goal did not reach Plan awaiting state',
    )

    const pending = api.loop.controlManager.store.load().pending
    expect(api.loop.activeSessionId).toBe(String(sessionB.id))
    expect(
      api.loop.sessionStore.get(String(sessionA.id))?.control_pending,
    ).toMatchObject({ interaction_id: pending?.id })
    expect(
      api.loop.sessionStore.get(String(sessionB.id))?.control_pending ?? null,
    ).toBeNull()
    expect(await api.loop.goalStore.get(started.goal.id)).toMatchObject({
      scope: { sessionId: String(sessionA.id) },
      runtime: {
        phase: 'awaiting_user',
        pendingInteractionId: pending?.id,
      },
    })

    await within(
      api.control.approvePlan(String(pending?.id), { uiHidden: true }),
      3_000,
      'Plan approval did not return',
    )
    await within(
      settleGoal(api, started.goal.id),
      3_000,
      'resumed Goal did not settle',
    )
    expect(api.loop.activeSessionId).toBe(String(sessionB.id))
    await api.close()
  }, 15_000)

  it('automatically reaches manual verification and independent reviewer through production Control and runner paths', async () => {
    const root = temp('goal-e2e-verification-orchestration-')
    const events: Record<string, unknown>[] = []
    const provider = new GoalReviewerAwareProvider()
    const api = await CoreApi.create({
      root,
      stateRoot: join(root, 'state'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      initializeMcp: false,
      eventSink: (event) => {
        events.push(event)
      },
    })
    const session = api.sessions.create({
      title: 'Goal verification orchestration',
      mode: 'build',
      project_path: root,
    })
    api.sessions.activate(String(session.id))
    const created = await api.loop.goalStore.create(
      newGoalRecord({
        id: 'goal_e2e_verification_orchestration',
        outcome: 'Reach every trusted verification issuer.',
        scope: api.loop.goalScopeForSession(session as never),
        now: T0,
      }),
    )
    const locked = await api.loop.goalStore.append(created.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['manual and reviewer production orchestration'],
          outOfScope: [],
          constraints: ['Keep execution inside the owner workspace.'],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'The user explicitly confirms the visible result.',
              required: true,
              verification: {
                kind: 'manual',
                requirement: 'Explicit user confirmation',
              },
            },
            {
              id: 'AC-2',
              description: 'An independent reviewer runs a real command.',
              required: true,
              verification: {
                kind: 'reviewer',
                requirement: 'Independent command-backed review',
              },
            },
          ],
          escalationConditions: [],
        },
        T1,
      ),
      expectedLastEventSeq: created.lastEventSeq,
    })
    api.loop.controlManager.setActiveGoalPlanContext(locked)
    api.loop.controlManager.setRuntimeScope(locked.scope)
    api.loop.controlManager.setMode('smart_auto')
    api.loop.controlManager.setMode('plan')
    const planInteraction = api.loop.controlManager.createPlan({
      title: 'Verification orchestration Plan',
      summary: 'Exercise manual and reviewer issuers.',
      planMarkdown: '# Plan\n\n- Prepare the verification state.\n- Verify it.',
      riskLevel: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Prepare verification state',
          description: 'The implementation is ready for verification.',
          commands: ['pwd'],
          acceptance: ['Verification can run.'],
        },
      ],
    })
    api.loop.controlManager.approve(planInteraction.id)
    const approvedPlan = api.loop.controlManager.planStore.get(
      String(planInteraction.meta.plan_id),
    )!
    const completedAt = approvedPlan.updatedAt + 1
    const plan = api.loop.controlManager.planStore.save({
      ...approvedPlan,
      status: PlanStatus.COMPLETED,
      updatedAt: completedAt,
      completedAt,
      steps: approvedPlan.steps.map((step) => ({
        ...step,
        status: PlanStepStatus.DONE,
      })),
    })
    expect(
      api.loop.controlManager.recordPlanVerificationResult({
        planId: plan.id,
        stepId: 'step_1',
        result: {
          requirement_id: 'cmd_1',
          tool_call_id: 'plan_verification_pwd',
          command: 'pwd',
          passed: true,
          exit_code: 0,
          summary: 'The bounded Plan verification command passed.',
        },
      }),
    ).not.toBeNull()
    const executing = await api.loop.goalStore.append(locked.id, {
      type: 'goal_updated',
      expectedLastEventSeq: locked.lastEventSeq,
      record: assertGoalTransition(locked, {
        ...locked,
        runtime: {
          ...locked.runtime,
          phase: 'executing',
          currentPlanId: plan.id,
        },
        updatedAt: T2,
      }),
    })

    await api.loop.goalCoordinator.start(executing.id)
    await within(
      settleGoal(api, executing.id),
      5_000,
      'manual verification interaction was not reached',
    )
    const manual = api.loop.controlManager.store.load().pending
    expect(manual?.meta.goal_manual_evidence_request).toMatchObject({
      goal_id: executing.id,
      criterion_id: 'AC-1',
    })

    await api.control.answerInteraction(String(manual?.id), {
      [GOAL_MANUAL_EVIDENCE_QUESTION_ID]: {
        choice: GOAL_MANUAL_EVIDENCE_PASS_LABEL,
      },
    })
    await within(
      settleGoal(api, executing.id),
      8_000,
      'reviewer-backed Goal cycle did not settle',
    )

    const evidence = await api.loop.goalEvidenceLedger.listEvidence(
      executing.id,
    )
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterionId: 'AC-1',
          verdict: 'pass',
          recorder: 'user',
        }),
        expect.objectContaining({
          criterionId: 'AC-2',
          verdict: 'pass',
          recorder: 'reviewer',
          independent: true,
        }),
      ]),
    )
    expect(provider.reviewerCommands).toBe(1)
    const finalGateEvent = events
      .filter((event) => event.event === 'goal_gate_evaluated')
      .at(-1)
    expect(finalGateEvent).toMatchObject({
      passed: true,
      reason_codes: [],
    })
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'goal_evidence_recorded',
        'goal_gate_evaluated',
        'goal_completed',
      ]),
    )
    const replay = api.runtime.replay({
      sessionId: String(session.id),
      afterSeq: 0,
      compact: false,
    })
    expect(replay.events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'goal_evidence_recorded',
        'goal_gate_evaluated',
        'goal_completed',
      ]),
    )
    expect(
      replay.events
        .filter((event) => String(event.event).startsWith('goal_'))
        .every((event) => event.session_id === String(session.id)),
    ).toBe(true)
    const summary = await api.goals.get(executing.id)
    expect(summary.acceptance.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'AC-1', verdict: 'pass' }),
        expect.objectContaining({ id: 'AC-2', verdict: 'pass' }),
      ]),
    )
    expect(summary.status).toBe('completed')
    await api.close()
  }, 20_000)

  it('repairs failed command evidence, preserves the failure, and completes through real stores and Gate', async () => {
    const f = await completionFixture('goal_e2e_repair')
    const failed = await f.recordEvidence('fail', 'tests failed', 1)
    await f.refreshFacts()

    const rejected = await f.gate.evaluate(f.goal.id)
    expect(rejected.pass).toBe(false)
    expect(rejected.reasons.map((reason) => reason.code)).toContain(
      'criterion_latest_failed',
    )

    const passed = await f.recordEvidence(
      'pass',
      'tests passed after repair',
      0,
    )
    await f.refreshFacts()
    const completed = await f.gate.complete(f.goal.id)

    expect(completed.goal).toMatchObject({
      status: 'completed',
      runtime: { phase: 'terminal' },
    })
    expect(completed.receipt.evidenceIds).toEqual([passed.id])
    expect(await f.evidenceLedger.listEvidence(f.goal.id)).toEqual([
      expect.objectContaining({ id: failed.id, verdict: 'fail' }),
      expect.objectContaining({ id: passed.id, verdict: 'pass' }),
    ])
    expect(
      (await f.goalStore.readEventsReadonly(f.goal.id)).at(-1),
    ).toMatchObject({
      type: 'goal_completed',
    })
  }, 10_000)

  it('rejects forged authority, cross-Goal and summary-only evidence, and final-text terminal writes', async () => {
    const f = await completionFixture('goal_e2e_security')
    const host = new GoalToolHost({
      goalStore: f.goalStore,
      evidenceLedger: f.evidenceLedger,
      completionGate: f.gate,
      blockGoal: async () => {
        throw new Error('not used')
      },
    })
    const registry = new ToolRegistry()
    registry.register(new RecordGoalEvidenceTool(host))
    registry.register(new CompleteGoalTool(host))

    expect(() =>
      registry.prepareCall('complete_goal', {
        goalId: f.goal.id,
        outcome: 'forged',
        status: 'completed',
      }),
    ).toThrow(/unknown field goalId/)
    expect(() =>
      registry.prepareCall('record_goal_evidence', {
        criterion_id: 'AC-1',
        verdict: 'pass',
        check: 'forged',
        summary: 'forged',
        source_observation_ids: [],
        source_receipt_ids: [],
        path: '/private/forged',
        hash: 'a'.repeat(64),
        toolName: 'run_command',
      }),
    ).toThrow(/unknown field path/)

    const foreign = await f.goalStore.create(
      newGoalRecord({
        id: 'goal_e2e_foreign',
        outcome: 'Remain isolated from another Goal.',
        scope: {
          sessionId: 'session_e2e_foreign',
          mode: 'chat',
          projectId: null,
          workspaceRoot: f.root,
        },
        contract: {
          acceptanceCriteria: [criterion()],
          inScope: ['security'],
        },
        now: T0,
      }),
    )
    const foreignLocked = await f.goalStore.append(foreign.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(foreign, contract(), T1),
      expectedLastEventSeq: foreign.lastEventSeq,
    })
    const observation = await f.recordObservation('tests passed', 0)
    await expect(
      f.evidenceLedger.record(foreignLocked.id, {
        criterionId: 'AC-1',
        verdict: 'pass',
        check: 'cross-goal source',
        summary: 'must reject',
        sourceObservationIds: [observation.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_source_cross_goal' })

    const summaryOnly = await f.observationRecorder.recordToolResult({
      expectedGoalId: f.goal.id,
      sessionId: f.goal.scope.sessionId,
      turnId: 'turn_subagent_summary',
      toolCallId: 'call_subagent_summary',
      toolName: 'dispatch_subagent',
      evidencePolicy: 'forbidden',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'subagent says everything passed',
        displaySummary: 'untrusted summary',
      }),
    })
    await expect(
      f.evidenceLedger.record(f.goal.id, {
        criterionId: 'AC-1',
        verdict: 'pass',
        check: 'summary only',
        summary: 'must reject',
        sourceObservationIds: [summaryOnly!.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_source_ineligible' })

    const forgedTerminal = assertGoalTransition(f.goal, {
      ...f.goal,
      status: 'completed',
      runtime: { ...f.goal.runtime, phase: 'terminal' },
      terminalAt: T3,
      updatedAt: T3,
    })
    await expect(
      f.goalStore.append(f.goal.id, {
        type: 'goal_completed' as never,
        record: forgedTerminal,
        data: { source: 'final_text_or_stop_hook' },
      }),
    ).rejects.toMatchObject({ code: 'goal_terminal_write_forbidden' })
    expect((await f.goalStore.inspect(f.goal.id)).record?.status).toBe('active')
  })

  it('maps stop, restart, cancel, block and policy guard to distinct durable outcomes', async () => {
    const root = temp('goal-e2e-lifecycle-')
    const stateRoot = join(root, 'state')
    const lifecycleEvents: Record<string, unknown>[] = []
    const provider = new BlockingProvider()
    const api = await createApi(root, stateRoot, provider, (event) =>
      lifecycleEvents.push(event),
    )
    const session = api.sessions.create({
      title: 'Goal lifecycle',
      mode: 'build',
      project_path: root,
    })
    api.sessions.activate(String(session.id))
    const started = await api.goals.start({
      outcome: 'Pause safely before restart.',
      sessionId: String(session.id),
    })
    await provider.entered

    const stopped = await api.chat.stopRuntime({ kind: 'goal' })
    expect(stopped.active).toEqual([])
    await settleGoal(api, started.goal.id)
    expect(await api.loop.goalStore.get(started.goal.id)).toMatchObject({
      status: 'draft',
      runtime: { phase: 'paused', pauseReason: 'user_stop' },
    })
    await api.close()

    const restarted = await createApi(
      root,
      stateRoot,
      new StaticProvider(),
      (event) => lifecycleEvents.push(event),
    )
    expect(await restarted.loop.goalStore.get(started.goal.id)).toMatchObject({
      runtime: { phase: 'paused', currentRunId: null },
    })
    expect(restarted.loop.activeTasks.list()).toEqual([])
    restarted.sessions.activate(started.goal.sessionId)
    const cancelled = await restarted.goals.cancel(
      started.goal.id,
      'user confirmed',
    )
    expect(cancelled.goal).toMatchObject({
      status: 'cancelled',
      phase: 'terminal',
    })

    const policySession = restarted.sessions.create({ title: 'Policy Goal' })
    restarted.sessions.activate(String(policySession.id))
    const policyDraft = await restarted.loop.goalStore.create(
      newGoalRecord({
        id: 'goal_e2e_policy',
        outcome: 'Stop at the explicit cycle guard.',
        scope: restarted.loop.goalScopeForSession(policySession as never),
        guardPolicy: { maxCycles: 1 },
        now: T0,
      }),
    )
    const policy = await restarted.loop.goalStore.append(policyDraft.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(policyDraft, contract(), T1),
      expectedLastEventSeq: policyDraft.lastEventSeq,
    })
    await restarted.loop.goalCoordinator.start(policy.id)
    await settleGoal(restarted, policy.id)
    expect(await restarted.loop.goalStore.get(policy.id)).toMatchObject({
      status: 'stopped_by_policy',
      runtime: { phase: 'terminal', pauseReason: 'max_cycles' },
    })

    const blockedSession = restarted.sessions.create({ title: 'Blocked Goal' })
    restarted.sessions.activate(String(blockedSession.id))
    const created = await restarted.loop.goalStore.create(
      newGoalRecord({
        id: 'goal_e2e_blocked',
        outcome: 'Wait for an external dependency.',
        scope: restarted.loop.goalScopeForSession(blockedSession as never),
        now: T0,
      }),
    )
    const locked = await restarted.loop.goalStore.append(created.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(created, contract(), T1),
      expectedLastEventSeq: created.lastEventSeq,
    })
    const pendingBlock = await restarted.loop.goalToolHost.block(
      { root, arguments: {}, sessionId: String(blockedSession.id) },
      {
        reason: 'Release permission is unavailable.',
        requiredPermission: 'release:publish',
      },
    )
    const awaiting = assertGoalTransition(locked, {
      ...locked,
      runtime: {
        ...locked.runtime,
        phase: 'awaiting_user',
        pendingInteractionId: pendingBlock.interactionId,
      },
      updatedAt: T2,
    })
    await restarted.loop.goalStore.append(locked.id, {
      type: 'goal_updated',
      record: awaiting,
      expectedLastEventSeq: locked.lastEventSeq,
    })
    await restarted.control.answerInteraction(pendingBlock.interactionId, {
      [GOAL_PERMISSION_BLOCKER_QUESTION_ID]: {
        choice: GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
      },
    })
    expect(await restarted.loop.goalStore.get(locked.id)).toMatchObject({
      status: 'blocked',
      runtime: { phase: 'terminal' },
    })
    expect(lifecycleEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'goal_cancelled',
        'goal_policy_stopped',
        'goal_blocked',
      ]),
    )
    await restarted.close()
  }, 15_000)

  it('fails closed after event corruption without rewriting pre-Goal session, Plan or runtime bytes', async () => {
    const root = temp('goal-e2e-compat-')
    const sessionDir = join(root, 'sessions', 'legacy-session')
    const runtimeDir = join(sessionDir, 'runtime')
    const historyPath = join(sessionDir, 'history.jsonl')
    const checkpointPath = join(sessionDir, '_checkpoint.json')
    const runtimePath = join(runtimeDir, 'events.jsonl')
    const planStore = new PlanStore(root)
    const plan = planStore.save(
      makePlanRecord({
        id: 'legacy-plan',
        title: 'Legacy non-Goal Plan',
        summary: 'A pre-Goal Plan fixture.',
        status: PlanStatus.WAITING_APPROVAL,
        createdAt: 1,
        updatedAt: 1,
        sessionId: 'legacy-session',
        steps: [],
      }),
    )
    await import('node:fs/promises').then(async ({ mkdir, writeFile }) => {
      await mkdir(runtimeDir, { recursive: true })
      await writeFile(historyPath, '{"role":"user","content":"legacy"}\n')
      await writeFile(checkpointPath, '{"queryState":null}\n')
      await writeFile(runtimePath, '{"event":"ready","seq":1}\n')
    })
    const before = [
      historyPath,
      checkpointPath,
      runtimePath,
      planStore.indexFile,
    ].map((path) => readFileSync(path))

    const store = new GoalStore(root)
    const created = await store.create(
      newGoalRecord({
        id: 'goal_e2e_corrupt',
        outcome: 'Recover without touching legacy state.',
        scope: {
          sessionId: 'goal-session',
          mode: 'build',
          projectId: 'project-goal',
          workspaceRoot: root,
        },
        now: T0,
      }),
    )
    const active = await store.append(created.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(created, contract(), T1),
      expectedLastEventSeq: created.lastEventSeq,
    })
    const executing = assertGoalTransition(active, {
      ...active,
      runtime: { ...active.runtime, phase: 'executing' },
      updatedAt: T2,
    })
    await store.append(active.id, {
      type: 'goal_updated',
      record: executing,
      expectedLastEventSeq: active.lastEventSeq,
    })
    appendFileSync(
      join(root, 'goals', active.id, 'events.jsonl'),
      '{bad-event\n',
    )

    const restarted = new GoalStore(root)
    const recovery = await new GoalRecoveryService(restarted, {
      validateScope: () => ({ valid: true }),
      now: () => T3,
    }).recoverOnStartup()

    expect(recovery.issues).toContainEqual(
      expect.objectContaining({
        goalId: active.id,
        code: 'event_corrupt',
        recovered: false,
      }),
    )
    expect(await restarted.get(active.id)).toMatchObject({
      runtime: { phase: 'paused', pauseReason: 'recovery_required' },
    })
    expect(planStore.get(plan.id)).toMatchObject({
      id: plan.id,
      status: PlanStatus.WAITING_APPROVAL,
      sessionId: 'legacy-session',
      goalId: null,
    })
    expect(
      [historyPath, checkpointPath, runtimePath, planStore.indexFile].map(
        (path) => readFileSync(path),
      ),
    ).toEqual(before)
  })
})

async function completionFixture(goalId: string) {
  const root = temp('goal-e2e-gate-')
  const goalStore = new GoalStore(root)
  const created = await goalStore.create(
    newGoalRecord({
      id: goalId,
      outcome: 'Finish only after deterministic evidence passes.',
      scope: {
        sessionId: `session_${goalId}`,
        mode: 'build',
        projectId: `project_${goalId}`,
        workspaceRoot: root,
      },
      now: T0,
    }),
  )
  const locked = await goalStore.append(created.id, {
    type: 'goal_updated',
    record: GoalContractValidator.lock(created, contract(), T1),
    expectedLastEventSeq: created.lastEventSeq,
  })
  const planStore = new PlanStore(root)
  const plan = planStore.save(
    makePlanRecord({
      id: `plan_${goalId}`,
      title: 'Execute and verify the Goal',
      summary: 'Run the exact deterministic command.',
      status: PlanStatus.COMPLETED,
      createdAt: 1,
      updatedAt: 3,
      approvedAt: 2,
      completedAt: 3,
      sessionId: locked.scope.sessionId,
      goalId: locked.id,
      sourceInteractionId: `interaction_${goalId}`,
      steps: [
        {
          id: 'step_1',
          title: 'Verify',
          status: PlanStepStatus.DONE,
          dependsOn: [],
          description: '',
          files: [],
          commands: ['npm test'],
          acceptance: ['tests pass'],
          discoveryRefs: [],
          verification: [],
          evidence: [],
          risk: 'low',
          riskNote: '',
          rollback: '',
        },
      ],
      metadata: {
        approval_generation: 1,
        scope: {
          session_id: locked.scope.sessionId,
          mode: locked.scope.mode,
          project_id: locked.scope.projectId,
          workspace_root: locked.scope.workspaceRoot,
          project_fingerprint: locked.scope.projectFingerprint,
        },
      },
    }),
  )
  const executing = await goalStore.append(locked.id, {
    type: 'goal_updated',
    expectedLastEventSeq: locked.lastEventSeq,
    record: assertGoalTransition(locked, {
      ...locked,
      runtime: {
        ...locked.runtime,
        phase: 'executing',
        currentPlanId: plan.id,
      },
      updatedAt: T2,
    }),
  })
  let goal = await goalStore.append(executing.id, {
    type: 'goal_updated',
    expectedLastEventSeq: executing.lastEventSeq,
    record: assertGoalTransition(executing, {
      ...executing,
      runtime: { ...executing.runtime, phase: 'verifying' },
      updatedAt: T3,
    }),
  })
  const observationRecorder = new GoalObservationRecorder(goalStore)
  const evidenceLedger = new GoalEvidenceLedger(goalStore)
  const riskFact = (context: {
    goalId: string
    planId: string
    planEventSeq: number
  }) => ({
    ...context,
    kind: 'core_goal_reviewer_risk' as const,
    issuedBy: 'core' as const,
    version: 'risk:e2e-readonly:1',
    readonlyProven: true,
    changedFiles: [],
    capabilitySignals: [],
  })
  const taskManager = new TaskManager(root)
  const reviewerLedger = new GoalReviewerLedger({
    goalStore,
    planStore,
    taskManager,
    evidenceLedger,
    resolveRiskFact: riskFact,
  })
  const planBridge = new GoalPlanBridge({
    goalStore,
    planStore,
    taskManager,
    resolveStepVerification: (context) => ({
      ...context,
      kind: 'core_plan_step_verification',
      issuedBy: 'core',
      verdict: 'pass',
      receiptId: `verification_${context.requirementId}`,
    }),
    resolveReviewer: (context) =>
      reviewerLedger.resolvePlanReviewerFact(context.goalId, context),
    resolveReviewerRiskFact: riskFact,
  })
  const factStore = new GoalGateFactStore(root, { now: () => T3 })
  const gate = createAuthorizedGoalCompletionGate({
    goalStore,
    planBridge,
    evidenceLedger,
    reviewerLedger,
    factStore,
    blockerFactStore: new GoalBlockerFactStore(root),
    now: () => T3,
  })
  const recordObservation = async (summary: string, exitCode: number) => {
    const observation = await observationRecorder.recordToolResult({
      expectedGoalId: goal.id,
      sessionId: goal.scope.sessionId,
      turnId: `turn_${exitCode}_${Date.now()}`,
      toolCallId: `call_${exitCode}_${Date.now()}`,
      toolName: 'run_command',
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result: new ToolResultObj({
        modelContent: summary,
        displaySummary: summary,
        metadata: { exitCode },
        isError: exitCode !== 0,
      }),
    })
    return observation!
  }
  const recordEvidence = async (
    verdict: 'pass' | 'fail',
    summary: string,
    exitCode: number,
  ): Promise<GoalEvidence> => {
    const observation = await recordObservation(summary, exitCode)
    const evidence = await evidenceLedger.record(goal.id, {
      criterionId: 'AC-1',
      verdict,
      check: 'npm test',
      summary,
      sourceObservationIds: [observation.id],
      sourceReceiptIds: [],
    })
    goal = (await goalStore.get(goal.id))!
    return evidence
  }
  const refreshFacts = async () => {
    goal = (await goalStore.get(goal.id))!
    factStore.recordBundle(goal, {
      runtime: { pendingInteractionId: null, directlyAnswerable: false },
      scope: { matches: true },
      storage: { healthy: true },
      hardConstraints: { satisfied: true },
      cost: { estimatedCostUsd: 0 },
    })
  }
  return {
    root,
    goalStore,
    get goal() {
      return goal
    },
    evidenceLedger,
    observationRecorder,
    gate,
    recordObservation,
    recordEvidence,
    refreshFacts,
  }
}

function criterion() {
  return {
    id: 'AC-1',
    description: 'The exact test command passes.',
    required: true,
    verification: { kind: 'command' as const, requirement: 'npm test' },
  }
}

function contract() {
  return {
    inScope: ['deterministic Goal verification'],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [criterion()],
    escalationConditions: [],
  }
}

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function createApi(
  root: string,
  stateRoot: string,
  provider: LLMProvider,
  eventSink?: (event: Record<string, unknown>) => void,
) {
  return await CoreApi.create({
    root,
    stateRoot,
    templatesDir: TEMPLATES_DIR,
    modelRouter: fakeRouter(provider),
    initializeMcp: false,
    eventSink,
  })
}

async function settleGoal(api: CoreApi, goalId: string): Promise<void> {
  const handle = api.loop.goalCoordinator.active(goalId)
  if (handle) await handle.promise
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class StaticProvider extends LLMProvider {
  constructor() {
    super({ defaultModel: 'goal-e2e-static' })
  }

  async chat(): Promise<LLMResponse> {
    return response('No new evidence in this deterministic cycle.')
  }
}

class BlockingProvider extends LLMProvider {
  private releaseEntered!: () => void
  readonly entered = new Promise<void>((resolve) => {
    this.releaseEntered = resolve
  })

  constructor() {
    super({ defaultModel: 'goal-e2e-blocking' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.releaseEntered()
    await new Promise<void>((resolve) => {
      if (args.signal?.aborted) return resolve()
      args.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    return response('Stopped safely.')
  }
}

class GoalPlanProvider extends LLMProvider {
  calls = 0

  constructor() {
    super({ defaultModel: 'goal-e2e-plan' })
  }

  async chat(): Promise<LLMResponse> {
    this.calls += 1
    if (this.calls === 1) {
      return toolResponse('define_contract', 'define_goal_contract', {
        in_scope: ['Goal Plan approval'],
        out_of_scope: [],
        constraints: ['Preserve the owner session scope'],
        acceptance_criteria: [
          {
            id: 'AC-1',
            description: 'The approved Plan remains bound to the Goal.',
            required: true,
            verification: {
              kind: 'command',
              requirement: 'npm test',
            },
          },
        ],
        escalation_conditions: [],
      })
    }
    if (this.calls === 2) {
      return toolResponse('propose_plan', 'propose_plan', {
        title: 'Durable Goal Plan',
        summary: 'Approve the Goal-bound Plan.',
        plan_markdown: '# Plan\n\n- Run the focused verification.',
        risk_level: 'low',
        assumptions: [],
        steps: [
          {
            id: 'step_1',
            title: 'Run focused verification',
            description: 'Run the exact verification command.',
            files: [],
            commands: ['npm test'],
            acceptance: ['The command passes.'],
            risk: 'low',
            risk_note: '',
            rollback: '',
          },
        ],
      })
    }
    return response('Goal execution resumed under the coordinator.')
  }
}

class SwitchableGoalPlanProvider extends GoalPlanProvider {
  private releaseFirst!: () => void
  private markEntered!: () => void
  readonly entered = new Promise<void>((resolve) => {
    this.markEntered = resolve
  })
  private first = true

  release(): void {
    this.releaseFirst()
  }

  override async chat(): Promise<LLMResponse> {
    if (this.first) {
      this.first = false
      this.markEntered()
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve
      })
    }
    return await super.chat()
  }
}

class GoalReviewerAwareProvider extends LLMProvider {
  reviewerCommands = 0
  private reviewerFinals = 0

  constructor() {
    super({ defaultModel: 'goal-e2e-reviewer-aware' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    const toolNames = (
      (args.tools as Array<Record<string, unknown>>) ?? []
    ).map((tool) => String(tool.name ?? ''))
    const reviewer =
      toolNames.includes('run_command') && !toolNames.includes('complete_goal')
    if (
      !reviewer &&
      JSON.stringify(args.messages).includes('当前 Goal Gate 已通过')
    )
      return toolResponse('complete_goal', 'complete_goal', {})
    if (!reviewer) return response('Continue the Goal verification lifecycle.')
    if (this.reviewerCommands === 0) {
      this.reviewerCommands += 1
      return toolResponse('reviewer_pwd', 'run_command', { command: 'pwd' })
    }
    this.reviewerFinals += 1
    return response(
      [
        'Independent checks passed.',
        '```verdict',
        JSON.stringify({
          passed: true,
          summary: 'The independent command completed successfully.',
          commands: ['pwd'],
          command_evidence: [{ command: 'pwd', exit_code: 0 }],
        }),
        '```',
      ].join('\n'),
    )
  }
}

function toolResponse(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LLMResponse {
  return {
    ...response(''),
    toolCalls: [{ id, name, arguments: args }],
    finishReason: 'tool_calls',
  }
}

function response(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input: 1, output: 1 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

function fakeRouter(provider: LLMProvider): {
  route: (useCase: string) => ModelRoute
  payload: () => Record<string, unknown>
} {
  return {
    route: (useCase: string) => ({
      snapshot: snapshot(provider),
      fallback: null,
      useCase,
      reason: `${useCase}:goal-e2e`,
      estimatedTokens: null,
    }),
    payload: () => ({ mainModel: 'goal-e2e', secondaryModel: 'goal-e2e' }),
  }
}

function snapshot(provider: LLMProvider): ProviderSnapshot {
  return {
    provider,
    providerName: 'fake',
    providerLabel: 'Deterministic fake',
    model: 'goal-e2e',
    apiBase: null,
    generation: { maxTokens: 2_000, temperature: 0, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: false,
    entryName: 'goal-e2e',
    entryLabel: 'Goal E2E',
    modelRole: 'main',
    routeReason: 'deterministic_fake',
  }
}
