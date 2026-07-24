import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelRoute, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { AgentLoop } from './loop'
import { CancelledTaskError } from '../runtime/active'
import { CompactionCursorStore } from '../memory/compaction-ledger'
import type { MemoryEmbeddingProvider } from '../memory/hybrid-retrieval'
import { EnvironmentProbe } from '../environment/probe'
import { ExecutionEnvironmentService } from '../environment/snapshot'
import { SchedulerPayload, SchedulerSchedule } from '../scheduler/models'
import type { SchedulerAgentTurnPayload } from '../scheduler/executor'
import { SchedulerService } from '../scheduler/service'
import type { GoalObservation } from '../goals/evidence'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from '../goals/validation'
import { GoalPlanBridge } from '../goals/plan-bridge'
import { GoalReviewerPolicy } from '../goals/reviewer'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'
import { PlanStatus, PlanStepStatus, type PlanRecord } from '../plans/models'
import { ToolResultObj } from '../tools/base'
import { GOAL_REVIEWER_WAIVER_APPROVE_LABEL } from '../control/plan-verification'
import {
  GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
  GOAL_PERMISSION_BLOCKER_QUESTION_ID,
  GOAL_PERMISSION_BLOCKER_RETRY_LABEL,
} from '../control/goal-blocker'
import {
  GOAL_MANUAL_EVIDENCE_DECLINE_LABEL,
  GOAL_MANUAL_EVIDENCE_FAIL_LABEL,
  GOAL_MANUAL_EVIDENCE_PASS_LABEL,
  GOAL_MANUAL_EVIDENCE_QUESTION_ID,
} from '../control/goal-manual-evidence'
import { CODE_GRAPH_PARSER_REVISION } from '../code-intelligence/models'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function symlinkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

function skillDocument(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function withEnv(
  name: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

class FakeProvider extends LLMProvider {
  calls: ChatArgs[] = []
  constructor() {
    super({ defaultModel: 'fake-main' })
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length === 1) {
      return response(null, {
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: { path: 'hello.txt' } },
        ],
        finishReason: 'tool_calls',
      })
    }
    return response('读完了。')
  }
}

async function createInterruptedSkip(
  loop: AgentLoop,
  sessionId: string,
  label: string,
): Promise<{ planId: string; approvalGeneration: number }> {
  const session = loop.sessionStore.get(sessionId)
  if (!session) throw new Error(`missing test session: ${sessionId}`)
  const created = await loop.goalStore.create(
    newGoalRecord({
      id: `goal_loop_skip_${label}`,
      outcome: `Recover the durable Plan skip for session ${label}.`,
      scope: {
        sessionId,
        mode: session.mode,
        projectId: session.project_id,
        workspaceRoot: session.project_path ?? loop.root,
      },
      now: '2026-07-16T00:00:00.000Z',
    }),
  )
  const planning = await loop.goalStore.append(created.id, {
    type: 'goal_updated',
    record: GoalContractValidator.lock(
      created,
      {
        inScope: [`durable skip ${label}`],
        outOfScope: [],
        constraints: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: `Session ${label} successor step is active.`,
            required: true,
            verification: { kind: 'command', requirement: 'npm test' },
          },
        ],
        escalationConditions: [],
      },
      '2026-07-16T00:00:01.000Z',
    ),
    expectedLastEventSeq: created.lastEventSeq,
  })
  const manager = loop.controlManager
  manager.setRuntimeScope({
    sessionId,
    mode: planning.scope.mode,
    projectId: planning.scope.projectId,
    workspaceRoot: planning.scope.workspaceRoot,
    projectFingerprint: planning.scope.projectFingerprint,
  })
  manager.setActiveGoalPlanContext(planning)
  manager.setMode('plan')
  const interaction = manager.createPlan({
    title: `Startup skip recovery ${label}`,
    summary: `Create an interrupted durable skip for ${label}.`,
    planMarkdown: '# Plan\n\n- First\n- Second',
    steps: [
      {
        id: 'step_1',
        title: `First ${label}`,
        commands: ['npm test'],
        acceptance: ['first handled'],
      },
      {
        id: 'step_2',
        title: `Second ${label}`,
        commands: ['npm test'],
        acceptance: ['second active'],
        depends_on: ['step_1'],
      },
    ],
  })
  manager.approve(interaction.id)
  const planId = String(interaction.meta.plan_id)
  await loop.goalPlanBridge.bindApprovedPlan({
    goalId: planning.id,
    planId,
  })
  const interrupted = new GoalPlanBridge({
    goalStore: loop.goalStore,
    planStore: manager.planStore,
    taskManager: loop.taskManager,
    resolveStepWaiver: ({ goalId, planId: sourcePlanId, stepId }) => ({
      kind: 'explicit_user_plan_step_waiver',
      issuedBy: 'core',
      approvedBy: 'user',
      receiptId: `waiver_startup_recovery_${label}`,
      goalId,
      planId: sourcePlanId,
      stepId,
    }),
  })
  const originalSave = manager.planStore.save.bind(manager.planStore)
  manager.planStore.save = ((candidate: PlanRecord) => {
    const intent = candidate.metadata.goal_skip_intent as
      Record<string, unknown> | undefined
    if (intent?.stage === 'completed')
      throw new Error(`injected startup settlement interruption ${label}`)
    return originalSave(candidate)
  }) as typeof manager.planStore.save
  await expect(
    interrupted.skipStepWithWaiver({
      goalId: planning.id,
      planId,
      stepId: 'step_1',
    }),
  ).rejects.toThrow(`startup settlement interruption ${label}`)
  manager.planStore.save = originalSave
  return {
    planId,
    approvalGeneration: Number(
      manager.planStore.get(planId)?.metadata.approval_generation,
    ),
  }
}

describe('AgentLoop (MIG-CORE-011)', () => {
  it('keeps code intelligence absent by default and exposes it only for a gated Build scope', async () => {
    const defaultRoot = tmp('emperor-agent-loop-code-default-')
    const defaultLoop = await AgentLoop.create({
      root: defaultRoot,
      stateRoot: join(defaultRoot, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    expect(defaultLoop.registry.has('code_intelligence')).toBe(false)
    expect(defaultLoop.codeIntelligence.diagnostics()).toMatchObject({
      capability: { effectiveMode: 'off', toolAllowed: false },
      graphManagers: 0,
    })
    await defaultLoop.close()

    const root = tmp('emperor-agent-loop-code-enabled-')
    const stateRoot = join(root, '.emperor')
    const projectRoot = join(root, 'project')
    mkdirSync(join(projectRoot, 'src'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'src', 'a.ts'),
      'export const alpha = 1\n',
      'utf8',
    )
    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
      codeIntelligenceMode: 'on',
      codeIntelligenceEvaluationGate: {
        passed: true,
        datasetSha256: 'a'.repeat(64),
        parserRevision: CODE_GRAPH_PARSER_REVISION,
      },
    })
    expect(loop.registry.has('code_intelligence')).toBe(true)

    const chatResult = await loop.registry.executeResult(
      'code_intelligence',
      { operation: 'find_definitions', symbol: 'alpha' },
      { sessionId: loop.activeSessionId, workspaceRoot: root },
    )
    expect(chatResult.isError).toBe(true)
    expect(chatResult.modelContent).toMatch(/Build session/i)

    const project = loop.projectStore.resolve(projectRoot)
    const build = loop.sessionStore.create('Code project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    const first = await loop.registry.executeResult(
      'code_intelligence',
      { operation: 'find_definitions', symbol: 'alpha' },
      {
        sessionId: build.id,
        workspaceRoot: join(root, 'attacker-controlled-context'),
      },
    )
    expect(first.isError).toBe(false)
    expect(JSON.parse(first.modelContent)).toMatchObject({
      strategy: 'graph',
      locations: [{ path: 'src/a.ts', line: 1 }],
    })

    await loop.registry.executeResult(
      'write_file',
      { path: 'src/a.ts', content: 'export const beta = 2\n' },
      { sessionId: build.id, workspaceRoot: projectRoot },
    )
    const second = await loop.registry.executeResult(
      'code_intelligence',
      { operation: 'find_definitions', symbol: 'beta' },
      { sessionId: build.id, workspaceRoot: projectRoot },
    )
    expect(JSON.parse(second.modelContent)).toMatchObject({
      locations: [{ path: 'src/a.ts', line: 1 }],
    })
    expect(loop.codeIntelligence.diagnostics()).toMatchObject({
      graphManagers: 1,
      notifications: 1,
    })
    await loop.endSession(build.id, 'test complete')
    await loop.close()
  })

  it('assembles core subsystems and runs a user turn through a real tool loop', async () => {
    const root = tmp('emperor-agent-loop-')
    writeFileSync(join(root, 'hello.txt'), 'hello from workspace\n', 'utf8')
    const provider = new FakeProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const events: Array<Record<string, unknown>> = []

    const reply = await loop.runUserTurn('读取 hello.txt', {
      turnId: 'turn_1',
      emit: async (event) => {
        events.push(event)
      },
    })

    expect(reply).toBe('读完了。')
    expect(loop.registry.has('read_file')).toBe(true)
    expect(loop.registry.has('web_search')).toBe(true)
    expect(loop.registry.has('dispatch_subagent')).toBe(true)
    expect(loop.registry.has('scheduler')).toBe(true)
    expect(loop.registry.has('spawn_teammate')).toBe(true)
    expect(loop.environmentCatalog.catalog.catalogId).toBe(
      'emperor-environment-tools',
    )
    expect(Object.isFrozen(loop.environmentCatalog.catalog)).toBe(true)
    expect(loop.environmentProbe).toBeInstanceOf(EnvironmentProbe)
    expect(loop.executionEnvironmentService).toBeInstanceOf(
      ExecutionEnvironmentService,
    )
    expect(loop.activeSessionId).toBeTruthy()
    expect(provider.calls).toHaveLength(2)
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain(
      'hello from workspace',
    )
    expect(loop.history.at(-1)).toMatchObject({
      role: 'assistant',
      content: '读完了。',
    })
    expect(
      loop.activeMemoryStore.loadUnarchivedHistory().map((item) => item.role),
    ).toEqual(['user', 'assistant'])
    expect(events.map((event) => event.event)).toContain('tool_call')
    expect(
      existsSync(
        join(
          root,
          '.emperor',
          'sessions',
          loop.activeSessionId!,
          'history.jsonl',
        ),
      ),
    ).toBe(true)
  })

  it('wires active Goal observation recording into the mainline runner', async () => {
    const root = tmp('emperor-agent-loop-goal-recording-')
    writeFileSync(join(root, 'hello.txt'), 'hello from workspace\n', 'utf8')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionId = loop.activeSessionId!
    const created = await loop.goalStore.create(
      newGoalRecord({
        id: 'goal_loop_recording',
        outcome: 'Record a real mainline tool result',
        scope: {
          sessionId,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: '2026-07-15T10:00:00.000Z',
      }),
    )
    const active = GoalContractValidator.lock(
      created,
      {
        inScope: ['mainline runner'],
        outOfScope: [],
        constraints: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'A real file read is observed',
            required: true,
            verification: { kind: 'artifact', requirement: 'Read hello.txt' },
          },
        ],
        escalationConditions: [],
      },
      '2026-07-15T10:01:00.000Z',
    )
    await loop.goalStore.append(created.id, {
      type: 'goal_updated',
      record: active,
      createdAt: active.updatedAt,
    })

    await loop.runUserTurn('读取 hello.txt', { turnId: 'turn_goal_recording' })

    expect(loop.controlManager.activeGoalPlanContext()?.id).toBe(created.id)

    expect(
      (await loop.goalStore.readObservations<GoalObservation>(created.id))
        .records,
    ).toEqual([
      expect.objectContaining({
        goalId: created.id,
        turnId: 'turn_goal_recording',
        toolName: 'read_file',
        evidencePolicy: 'eligible',
        eligible: true,
      }),
    ])
  })

  it('completes a real command plus waived Plan through pure production Goal resolvers', async () => {
    const root = tmp('emperor-agent-loop-goal-terminal-composition-')
    const stateRoot = join(root, '.emperor')
    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionId = loop.activeSessionId!
    const created = await loop.goalStore.create(
      newGoalRecord({
        id: 'goal_loop_terminal_composition',
        outcome: 'Complete through the production AgentLoop Goal Gate.',
        scope: {
          sessionId,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        guardPolicy: { maxEstimatedCostUsd: 1 },
        now: '2020-01-01T08:00:00.000Z',
      }),
    )
    const locked = await loop.goalStore.append(created.id, {
      type: 'goal_updated',
      expectedLastEventSeq: created.lastEventSeq,
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['production completion composition'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'The production verification command passes.',
              required: true,
              verification: { kind: 'command', requirement: 'npm test' },
            },
          ],
          escalationConditions: [],
        },
        '2020-01-01T08:01:00.000Z',
      ),
    })
    loop.controlManager.setRuntimeScope({
      sessionId,
      mode: locked.scope.mode,
      projectId: locked.scope.projectId,
      workspaceRoot: locked.scope.workspaceRoot,
      projectFingerprint: locked.scope.projectFingerprint,
    })
    loop.controlManager.setActiveGoalPlanContext(locked)
    loop.controlManager.setMode('plan')
    const interaction = loop.controlManager.createPlan({
      title: 'Production completion composition',
      summary: 'Verify one command and explicitly waive one step.',
      planMarkdown: '# Plan\n\n- Verify\n- Waive',
      steps: [
        {
          id: 'step_command',
          title: 'Verify command',
          commands: ['npm test'],
          acceptance: ['tests pass'],
        },
        {
          id: 'step_waived',
          title: 'Explicitly waived work',
          commands: [],
          acceptance: ['user waiver is persisted'],
          depends_on: ['step_command'],
        },
      ],
    })
    loop.controlManager.approve(interaction.id)
    const planId = String(interaction.meta.plan_id)
    const { goal: executing } = await loop.goalPlanBridge.bindApprovedPlan({
      goalId: locked.id,
      planId,
    })
    const plan = loop.controlManager.planStore.get(planId)!
    const commandCallId = 'call_loop_terminal_command'
    const completedPlan = loop.controlManager.planStore.save({
      ...plan,
      status: PlanStatus.COMPLETED,
      completedAt: plan.updatedAt + 1,
      steps: plan.steps.map((step) =>
        step.id === 'step_command'
          ? {
              ...step,
              status: PlanStepStatus.DONE,
              evidence: [
                {
                  source: 'core_plan_step_verification',
                  issued_by: 'core',
                  plan_id: plan.id,
                  plan_step_id: step.id,
                  requirement_id: 'cmd_1',
                  command: 'npm test',
                  tool_call_id: commandCallId,
                  passed: true,
                  exit_code: 0,
                },
              ],
            }
          : {
              ...step,
              status: PlanStepStatus.SKIPPED,
              evidence: [
                {
                  source: 'goal_plan_step_waiver',
                  issued_by: 'core',
                  approved_by: 'user',
                  goal_id: executing.id,
                  plan_id: plan.id,
                  plan_step_id: step.id,
                  receipt_id: 'waiver_loop_terminal_step',
                },
              ],
            },
      ),
    })
    const verifying = await loop.goalStore.append(executing.id, {
      type: 'goal_updated',
      expectedLastEventSeq: executing.lastEventSeq,
      record: assertGoalTransition(executing, {
        ...executing,
        runtime: { ...executing.runtime, phase: 'verifying' },
        updatedAt: '2020-01-01T08:02:00.000Z',
      }),
    })
    const observation = await loop.goalObservationRecorder.recordToolResult({
      expectedGoalId: verifying.id,
      sessionId,
      turnId: 'turn_loop_terminal_composition',
      toolCallId: commandCallId,
      toolName: 'run_command',
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result: new ToolResultObj({
        modelContent: 'tests passed',
        displaySummary: 'tests passed',
        metadata: { exitCode: 0 },
      }),
    })
    const planVerification =
      await loop.goalEvidenceLedger.issuePlanVerificationReceipt(verifying.id, {
        planId,
        stepId: 'step_command',
        requirementId: 'cmd_1',
        toolCallId: commandCallId,
        sourceObservationId: observation!.id,
        approvedInputHash: observation!.toolInput.inputSha256,
      })
    await loop.goalEvidenceLedger.record(verifying.id, {
      criterionId: 'AC-1',
      verdict: 'pass',
      check: 'npm test',
      summary: 'tests passed',
      sourceObservationIds: [],
      sourceReceiptIds: [planVerification.id],
    })
    const waiverRisk = await loop.goalReviewerRiskAdapter.resolve({
      goalId: verifying.id,
      planId,
      planEventSeq: completedPlan.eventSeq,
    })
    const reviewerWaiver = loop.controlManager.requestGoalReviewerWaiver({
      goal: verifying,
      planId,
      planEventSeq: completedPlan.eventSeq,
      riskSignals: new GoalReviewerPolicy().requirementFor(
        completedPlan,
        waiverRisk,
      ).riskSignals,
      riskFactVersion: waiverRisk?.version ?? null,
      reason: 'Exercise the production explicit-user waiver composition.',
    })
    loop.controlManager.answer(reviewerWaiver.id, {
      goal_reviewer_waiver: {
        choice: GOAL_REVIEWER_WAIVER_APPROVE_LABEL,
        freeform: '',
      },
    })
    await loop.goalReviewerLedger.recordReviewerWaiver({
      goalId: verifying.id,
      planId,
      planEventSeq: completedPlan.eventSeq,
      interactionId: reviewerWaiver.id,
    })
    const currentGoal = (await loop.goalStore.inspect(verifying.id)).record!
    await loop.refreshGoalGateFacts(currentGoal.id, {
      currentScope: currentGoal.scope,
      hardConstraintsSatisfied: true,
      estimatedCostUsd: 0,
    })
    const mutationLedger = new GoalGateMutationLedger(stateRoot)
    const epochBefore = mutationLedger.inspect().epoch
    const bytesBefore = {
      goal: readFileSync(join(stateRoot, 'goals', currentGoal.id, 'goal.json')),
      plan: readFileSync(loop.controlManager.planStore.indexFile),
      facts: readFileSync(loop.goalGateFactStore.path),
    }
    const productionReceipt = await loop.goalPlanBridge.planCompletionReceipt(
      currentGoal.id,
      currentGoal,
    )
    expect(productionReceipt.completed, JSON.stringify(productionReceipt)).toBe(
      true,
    )
    const repairingGet = vi
      .spyOn(loop.goalStore, 'get')
      .mockRejectedValue(new Error('repairing GoalStore.get is forbidden'))
    const repairingList = vi
      .spyOn(loop.goalStore, 'list')
      .mockRejectedValue(new Error('repairing GoalStore.list is forbidden'))
    await expect(
      loop.goalEvidenceLedger.validatedEvidenceById(
        currentGoal.id,
        currentGoal.latestEvidenceByCriterion['AC-1']!,
      ),
    ).resolves.toMatchObject({ criterionId: 'AC-1', verdict: 'pass' })

    const evaluation = await loop.evaluateGoal(currentGoal.id)

    expect(evaluation.pass, JSON.stringify(evaluation.reasons)).toBe(true)
    expect(repairingGet).not.toHaveBeenCalled()
    expect(repairingList).not.toHaveBeenCalled()
    expect(mutationLedger.inspect().epoch).toBe(epochBefore)
    expect(
      readFileSync(join(stateRoot, 'goals', currentGoal.id, 'goal.json')),
    ).toEqual(bytesBefore.goal)
    expect(readFileSync(loop.controlManager.planStore.indexFile)).toEqual(
      bytesBefore.plan,
    )
    expect(readFileSync(loop.goalGateFactStore.path)).toEqual(bytesBefore.facts)
    repairingGet.mockRestore()
    repairingList.mockRestore()

    const pending = loop.controlManager.createAsk({
      questions: [
        {
          id: 'terminal_scope',
          header: 'Scope',
          question: 'Should terminal completion continue?',
          options: [
            { label: 'Continue', description: 'Resolve the pending action.' },
            { label: 'Pause', description: 'Keep the Goal active.' },
          ],
        },
      ],
      context: 'A concrete pending Control interaction must block terminal.',
    })
    expect(loop.controlManager.store.load().pending?.id).toBe(pending.id)
    expect(
      (await loop.evaluateGoal(currentGoal.id)).reasons.map(
        (reason) => reason.code,
      ),
    ).toContain('pending_interaction')
    expect(loop.controlManager.store.load().pending?.id).toBe(pending.id)
    await expect(loop.completeGoal(currentGoal.id)).rejects.toMatchObject({
      code: 'goal_completion_gate_failed',
    })
    loop.controlManager.answer(pending.id, {
      terminal_scope: { choice: 'Continue', freeform: '' },
    })
    await loop.refreshGoalGateFacts(currentGoal.id, {
      currentScope: {
        ...currentGoal.scope,
        workspaceRoot: join(root, 'stale-scope'),
      },
    })
    const trustedScopeEvaluation = await loop.evaluateGoal(currentGoal.id)
    expect(trustedScopeEvaluation.pass).toBe(true)
    expect(
      trustedScopeEvaluation.reasons.map((reason) => reason.code),
    ).not.toContain('scope_mismatch')
    await loop.refreshGoalGateFacts(currentGoal.id, {
      currentScope: currentGoal.scope,
      estimatedCostUsd: 2,
    })
    await expect(loop.completeGoal(currentGoal.id)).rejects.toMatchObject({
      code: 'goal_completion_gate_failed',
    })
    await loop.refreshGoalGateFacts(currentGoal.id, {
      estimatedCostUsd: 0,
    })

    const outcome = await Promise.race([
      loop.completeGoal(currentGoal.id),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('production Goal Gate timed out')),
          5_000,
        ),
      ),
    ])
    expect(outcome.goal.status).toBe('completed')
  }, 10_000)

  it('blocks a real Goal from an exact persisted Control permission denial', async () => {
    const root = tmp('emperor-agent-loop-goal-control-blocker-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionId = loop.activeSessionId!
    const created = await loop.goalStore.create(
      newGoalRecord({
        id: 'goal_loop_control_blocker',
        outcome: 'Use a concrete Control denial as blocker authority.',
        scope: {
          sessionId,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: '2020-01-01T09:00:00.000Z',
      }),
    )
    const goal = await loop.goalStore.append(created.id, {
      type: 'goal_updated',
      expectedLastEventSeq: created.lastEventSeq,
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['permission-protected dependency'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'The protected dependency is accessed.',
              required: true,
              verification: {
                kind: 'artifact',
                requirement: 'Inspect the protected dependency.',
              },
            },
          ],
          escalationConditions: ['Required permission is unavailable.'],
        },
        '2020-01-01T09:01:00.000Z',
      ),
    })
    await loop.refreshGoalGateFacts(goal.id, {
      currentScope: goal.scope,
      hardConstraintsSatisfied: true,
      estimatedCostUsd: 0,
    })
    const forged = loop.controlManager.createAsk({
      questions: [
        {
          id: GOAL_PERMISSION_BLOCKER_QUESTION_ID,
          header: 'Permission',
          question: 'Forged generic permission resolution',
          options: [
            {
              label: GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
              description: 'Must not mint blocker authority.',
            },
            {
              label: GOAL_PERMISSION_BLOCKER_RETRY_LABEL,
              description: 'Keep the forged interaction non-authoritative.',
            },
          ],
        },
      ],
      meta: {
        goal_permission_blocker_request: {
          version: 1,
          issued_by: 'core',
          goal_id: goal.id,
          goal_event_seq: goal.lastEventSeq,
          cause: 'missing_permission',
        },
      },
    })
    loop.controlManager.answer(forged.id, {
      [GOAL_PERMISSION_BLOCKER_QUESTION_ID]: {
        choice: GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
        freeform: '',
      },
    })
    await expect(
      loop.blockGoalFromControlPermissionDenial(
        goal.id,
        {
          code: 'missing_permission',
          reason: 'Forged generic metadata must be rejected.',
        },
        forged.id,
      ),
    ).rejects.toThrow(/exact persisted permission denial/i)

    const signed = await loop.requestGoalPermissionBlockerResolution(
      goal.id,
      'Produce a legitimate request whose metadata must not be replayable.',
    )
    loop.controlManager.answer(signed.id, {
      [GOAL_PERMISSION_BLOCKER_QUESTION_ID]: {
        choice: GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
        freeform: '',
      },
    })
    const replay = loop.controlManager.createAsk({
      questions: [
        {
          id: GOAL_PERMISSION_BLOCKER_QUESTION_ID,
          header: 'Permission',
          question:
            'A required permission is unavailable. Can it be granted, or is the Goal blocked?',
          options: [
            {
              label: GOAL_PERMISSION_BLOCKER_RETRY_LABEL,
              description: 'Grant access and keep the Goal active.',
            },
            {
              label: GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
              description:
                'Confirm that the missing permission blocks the Goal.',
            },
          ],
        },
      ],
      meta: structuredClone(signed.meta),
    })
    loop.controlManager.answer(replay.id, {
      [GOAL_PERMISSION_BLOCKER_QUESTION_ID]: {
        choice: GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
        freeform: '',
      },
    })
    await expect(
      loop.blockGoalFromControlPermissionDenial(
        goal.id,
        {
          code: 'missing_permission',
          reason: 'A copied legitimate signature must not authorize replay.',
        },
        replay.id,
      ),
    ).rejects.toThrow(/exact persisted permission denial/i)

    const interaction = await loop.requestGoalPermissionBlockerResolution(
      goal.id,
      'The user-owned credential cannot be granted in this environment.',
    )
    loop.controlManager.answer(interaction.id, {
      [GOAL_PERMISSION_BLOCKER_QUESTION_ID]: {
        choice: GOAL_PERMISSION_BLOCKER_DENIED_LABEL,
        freeform: '',
      },
    })

    const blocked = await loop.blockGoalFromControlPermissionDenial(
      goal.id,
      {
        code: 'missing_permission',
        reason: 'The required user-owned credential is unavailable.',
      },
      interaction.id,
    )

    expect(blocked.status).toBe('blocked')
    expect(loop.goalBlockerCauseLedger.inspect(goal)).toMatchObject({
      cause: 'missing_permission',
      receiptId: interaction.id,
    })
  })

  it('records only exact persisted Control manual answers and keeps the latest FAIL→PASS→FAIL', async () => {
    const root = tmp('emperor-agent-loop-goal-manual-evidence-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const created = await loop.goalStore.create(
      newGoalRecord({
        id: 'goal_loop_manual_evidence',
        outcome: 'Bind manual evidence to exact persisted Control answers.',
        scope: {
          sessionId: loop.activeSessionId!,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: '2020-01-01T10:00:00.000Z',
      }),
    )
    const goal = await loop.goalStore.append(created.id, {
      type: 'goal_updated',
      expectedLastEventSeq: created.lastEventSeq,
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['manual verification'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'The user inspects the rendered result.',
              required: true,
              verification: {
                kind: 'manual',
                requirement: 'Inspect the exact rendered result.',
              },
            },
          ],
          escalationConditions: [],
        },
        '2020-01-01T10:01:00.000Z',
      ),
    })
    const record = async (choice: string, verdict: 'pass' | 'fail') => {
      const interaction = await loop.requestGoalManualVerification(
        goal.id,
        'AC-1',
      )
      loop.controlManager.answer(interaction.id, {
        [GOAL_MANUAL_EVIDENCE_QUESTION_ID]: { choice, freeform: '' },
      })
      return await loop.recordGoalManualVerification(goal.id, {
        interactionId: interaction.id,
        criterionId: 'AC-1',
        verdict,
      })
    }

    const signed = await loop.requestGoalManualVerification(goal.id, 'AC-1')
    loop.controlManager.answer(signed.id, {
      [GOAL_MANUAL_EVIDENCE_QUESTION_ID]: {
        choice: GOAL_MANUAL_EVIDENCE_PASS_LABEL,
        freeform: '',
      },
    })
    const replay = loop.controlManager.createAsk({
      questions: signed.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: question.options.map((option) => ({ ...option })),
      })),
      context: signed.context,
      meta: structuredClone(signed.meta),
    })
    loop.controlManager.answer(replay.id, {
      [GOAL_MANUAL_EVIDENCE_QUESTION_ID]: {
        choice: GOAL_MANUAL_EVIDENCE_PASS_LABEL,
        freeform: '',
      },
    })
    await expect(
      loop.goalEvidenceLedger.issueUserManualReceipt(goal.id, {
        interactionId: replay.id,
        criterionId: 'AC-1',
        verdict: 'pass',
      }),
    ).rejects.toThrow(/unavailable or no longer trusted/i)

    const failed = await record(GOAL_MANUAL_EVIDENCE_FAIL_LABEL, 'fail')
    const passed = await record(GOAL_MANUAL_EVIDENCE_PASS_LABEL, 'pass')
    const regressed = await record(GOAL_MANUAL_EVIDENCE_FAIL_LABEL, 'fail')
    expect([failed.verdict, passed.verdict, regressed.verdict]).toEqual([
      'fail',
      'pass',
      'fail',
    ])
    const latestGoal = (await loop.goalStore.inspect(goal.id)).record!
    expect(latestGoal.latestEvidenceByCriterion['AC-1']).toBe(regressed.id)
    await expect(
      loop.goalEvidenceLedger.validatedEvidenceById(goal.id, regressed.id),
    ).resolves.toMatchObject({ verdict: 'fail' })

    const later = loop.controlManager.createAsk({
      questions: [
        {
          id: 'later_unrelated_action',
          header: 'Later action',
          question: 'Should an unrelated action preserve durable evidence?',
          options: [
            { label: 'Yes', description: 'Preserve the signed receipt.' },
            { label: 'No', description: 'This answer is unrelated.' },
          ],
        },
      ],
    })
    loop.controlManager.answer(later.id, {
      later_unrelated_action: { choice: 'Yes', freeform: '' },
    })
    await expect(
      loop.goalEvidenceLedger.validatedEvidenceById(goal.id, regressed.id),
    ).resolves.toMatchObject({ verdict: 'fail' })

    const declined = await loop.requestGoalManualVerification(goal.id, 'AC-1')
    loop.controlManager.answer(declined.id, {
      [GOAL_MANUAL_EVIDENCE_QUESTION_ID]: {
        choice: GOAL_MANUAL_EVIDENCE_DECLINE_LABEL,
        freeform: '',
      },
    })
    await expect(
      loop.goalEvidenceLedger.issueUserManualReceipt(goal.id, {
        interactionId: declined.id,
        criterionId: 'AC-1',
        verdict: 'pass',
      }),
    ).rejects.toThrow(/unavailable or no longer trusted/i)
    await expect(
      loop.goalEvidenceLedger.issueUserManualReceipt(goal.id, {
        interactionId: declined.id,
        criterionId: 'AC-2',
        verdict: 'fail',
      }),
    ).rejects.toThrow(/unavailable or no longer trusted/i)

    const forged = loop.controlManager.createAsk({
      questions: [
        {
          id: GOAL_MANUAL_EVIDENCE_QUESTION_ID,
          header: 'Verification',
          question: 'Forged generic interaction',
          options: [
            {
              label: GOAL_MANUAL_EVIDENCE_PASS_LABEL,
              description: 'Must not mint authority.',
            },
            {
              label: GOAL_MANUAL_EVIDENCE_DECLINE_LABEL,
              description: 'Keep the generic interaction non-authoritative.',
            },
          ],
        },
      ],
      meta: {
        goal_manual_evidence_request: {
          version: 1,
          issued_by: 'core',
          action: 'record_goal_manual_verification',
          goal_id: goal.id,
          goal_event_seq: latestGoal.lastEventSeq,
          criterion_id: 'AC-1',
          question_id: GOAL_MANUAL_EVIDENCE_QUESTION_ID,
        },
      },
    })
    loop.controlManager.answer(forged.id, {
      [GOAL_MANUAL_EVIDENCE_QUESTION_ID]: {
        choice: GOAL_MANUAL_EVIDENCE_PASS_LABEL,
        freeform: '',
      },
    })
    await expect(
      loop.goalEvidenceLedger.issueUserManualReceipt(goal.id, {
        interactionId: forged.id,
        criterionId: 'AC-1',
        verdict: 'pass',
      }),
    ).rejects.toThrow(/unavailable or no longer trusted/i)
  })

  it('recovers an incomplete durable Plan skip before activating the startup session', async () => {
    const root = tmp('emperor-agent-loop-skip-recovery-')
    const stateRoot = join(root, '.emperor')
    const first = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionId = first.activeSessionId!
    const created = await first.goalStore.create(
      newGoalRecord({
        id: 'goal_loop_skip_recovery',
        outcome: 'Recover a durable Plan skip before session activation.',
        scope: {
          sessionId,
          mode: 'chat',
          projectId: null,
          workspaceRoot: root,
        },
        now: '2026-07-16T00:00:00.000Z',
      }),
    )
    const planning = await first.goalStore.append(created.id, {
      type: 'goal_updated',
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['durable skip startup recovery'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'The successor step is active after restart.',
              required: true,
              verification: { kind: 'command', requirement: 'npm test' },
            },
          ],
          escalationConditions: [],
        },
        '2026-07-16T00:00:01.000Z',
      ),
      expectedLastEventSeq: created.lastEventSeq,
    })
    const manager = first.controlManager
    manager.setRuntimeScope({
      sessionId,
      mode: planning.scope.mode,
      projectId: planning.scope.projectId,
      workspaceRoot: planning.scope.workspaceRoot,
      projectFingerprint: planning.scope.projectFingerprint,
    })
    manager.setActiveGoalPlanContext(planning)
    manager.setMode('plan')
    const interaction = manager.createPlan({
      title: 'Startup skip recovery',
      summary: 'Create an interrupted durable skip.',
      planMarkdown: '# Plan\n\n- First\n- Second',
      steps: [
        {
          id: 'step_1',
          title: 'First',
          commands: ['npm test'],
          acceptance: ['first handled'],
        },
        {
          id: 'step_2',
          title: 'Second',
          commands: ['npm test'],
          acceptance: ['second active'],
          depends_on: ['step_1'],
        },
      ],
    })
    manager.approve(interaction.id)
    const planId = String(interaction.meta.plan_id)
    await first.goalPlanBridge.bindApprovedPlan({
      goalId: planning.id,
      planId,
    })
    const interrupted = new GoalPlanBridge({
      goalStore: first.goalStore,
      planStore: manager.planStore,
      taskManager: first.taskManager,
      resolveStepWaiver: ({ goalId, planId: sourcePlanId, stepId }) => ({
        kind: 'explicit_user_plan_step_waiver',
        issuedBy: 'core',
        approvedBy: 'user',
        receiptId: 'waiver_startup_recovery',
        goalId,
        planId: sourcePlanId,
        stepId,
      }),
    })
    const originalSave = manager.planStore.save.bind(manager.planStore)
    manager.planStore.save = ((candidate: PlanRecord) => {
      const intent = candidate.metadata.goal_skip_intent as
        Record<string, unknown> | undefined
      if (intent?.stage === 'completed')
        throw new Error('injected startup settlement interruption')
      return originalSave(candidate)
    }) as typeof manager.planStore.save
    await expect(
      interrupted.skipStepWithWaiver({
        goalId: planning.id,
        planId,
        stepId: 'step_1',
      }),
    ).rejects.toThrow(/startup settlement/)
    manager.planStore.save = originalSave

    const restarted = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })

    expect(restarted.activeSessionId).toBe(sessionId)
    expect(
      (
        restarted.controlManager.planStore.get(planId)?.metadata
          .goal_skip_intent as Record<string, unknown>
      ).stage,
    ).toBe('completed')
    expect(restarted.todoStore.todos).toEqual([])
    const planTasks = restarted.taskManager.store
      .list()
      .filter((task) => task.metadata.plan_id === planId)
    expect(
      planTasks.find((task) => task.metadata.plan_step_id === 'step_1')?.status,
    ).not.toBe('running')
    expect(
      planTasks.filter(
        (task) =>
          task.metadata.plan_step_id === 'step_2' && task.status === 'running',
      ),
    ).toHaveLength(1)
  })

  it('keeps non-current Goal skip recovery free of session WorkItem mirrors', async () => {
    const root = tmp('emperor-agent-loop-skip-recovery-background-')
    const stateRoot = join(root, '.emperor')
    const first = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionA = first.activeSessionId!
    const sessionB = first.sessionStore.create('Background B')
    await createInterruptedSkip(first, sessionB.id, 'background_b')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    first.sessionStore.touch(sessionA, 'Keep A current at restart')
    first.sessionStore.archive(sessionB.id)

    const restarted = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })

    expect(restarted.activeSessionId).toBe(sessionA)
    expect(restarted.todoStore.todos).toEqual([])
    restarted.activateSession(sessionB.id)
    expect(restarted.todoStore.todos).toEqual([])
    restarted.activateSession(sessionA)
    expect(restarted.todoStore.todos).toEqual([])
  })

  it('drops a recovered Todo projection when its session was deleted', async () => {
    const root = tmp('emperor-agent-loop-skip-recovery-deleted-session-')
    const stateRoot = join(root, '.emperor')
    const first = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionA = first.activeSessionId!
    const sessionB = first.sessionStore.create('Deleted B')
    const recoveredB = await createInterruptedSkip(
      first,
      sessionB.id,
      'deleted_b',
    )
    expect(first.sessionStore.delete(sessionB.id)).toBe(true)

    const restarted = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })

    expect(restarted.activeSessionId).toBe(sessionA)
    expect(restarted.todoStore.todos).toEqual([])
    expect(() => restarted.activateSession(sessionB.id)).toThrow(
      /unknown session/,
    )
    expect(
      (
        restarted.controlManager.planStore.get(recoveredB.planId)?.metadata
          .goal_skip_intent as Record<string, unknown>
      ).stage,
    ).toBe('completed')
  })

  it('does not recreate legacy Todo projections for recovered short Plans', async () => {
    const root = tmp('emperor-agent-loop-skip-recovery-multi-session-')
    const stateRoot = join(root, '.emperor')
    const first = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const sessionA = first.activeSessionId!
    await createInterruptedSkip(first, sessionA, 'multi_a')
    const sessionB = first.sessionStore.create('Recovered B')
    await createInterruptedSkip(first, sessionB.id, 'multi_b')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    first.sessionStore.touch(sessionA, 'Keep A current at restart')
    first.sessionStore.archive(sessionB.id)

    const restarted = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })

    expect(restarted.activeSessionId).toBe(sessionA)
    expect(restarted.todoStore.todos).toEqual([])
    restarted.activateSession(sessionB.id)
    expect(restarted.todoStore.todos).toEqual([])

    expect(await restarted.goalPlanBridge.recoverIncompleteSkips()).toEqual({
      count: 0,
    })
    restarted.activateSession(sessionA)
    expect(restarted.todoStore.todos).toEqual([])
    restarted.activateSession(sessionB.id)
    expect(restarted.todoStore.todos).toEqual([])
  })

  it('binds Plan pause to the owning session without projecting short Plans into Todo', async () => {
    const root = tmp('emperor-agent-loop-plan-pause-scope-')
    const stateRoot = join(root, '.emperor')
    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    try {
      const sessionA = loop.activeSessionId!
      const bindingsA = loop.sessionRuntimes.get(sessionA)!.bindings
      const interactionA = loop.controlManager.createPlan({
        title: 'Session A plan',
        summary: 'A',
        planMarkdown: '# A',
        steps: [
          { id: 'step_a', title: 'A', description: 'A', acceptance: ['A'] },
        ],
      })
      loop.controlManager.approve(interactionA.id)
      bindingsA.runner.controlManager?.migrateLegacyPlanTodoMirrors?.()
      const planA = String(interactionA.meta.plan_id)

      const sessionB = loop.sessionStore.create('Session B')
      loop.activateSession(sessionB.id)
      const bindingsB = loop.sessionRuntimes.get(sessionB.id)!.bindings
      const interactionB = loop.controlManager.createPlan({
        title: 'Session B plan',
        summary: 'B',
        planMarkdown: '# B',
        steps: [
          { id: 'step_b', title: 'B', description: 'B', acceptance: ['B'] },
        ],
      })
      loop.controlManager.approve(interactionB.id)
      bindingsB.runner.controlManager?.migrateLegacyPlanTodoMirrors?.()
      const planB = String(interactionB.meta.plan_id)

      bindingsA.runner.controlManager?.pausePlanExecution?.({
        reason: 'no_progress',
        turnId: 'turn_a_pause',
        pausedAt: Date.now() / 1000,
        evaluationCount: 1,
        totalIterations: 20,
        nextActions: ['Continue A'],
      })

      expect(
        loop.controlManager.planStore.get(planA)?.metadata.execution_pause,
      ).toBeTruthy()
      expect(
        loop.controlManager.planStore.get(planB)?.metadata.execution_pause,
      ).toBeUndefined()
      expect(bindingsA.todoStore.todos).toEqual([])
      expect(bindingsB.todoStore.todos).toEqual([])
    } finally {
      await loop.close()
    }
  })

  it('restores a paused short Plan without recreating a Todo projection', async () => {
    const root = tmp('emperor-agent-loop-plan-pause-restart-')
    const stateRoot = join(root, '.emperor')
    const first = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    const interaction = first.controlManager.createPlan({
      title: 'Restart paused plan',
      summary: 'Persist the pause.',
      planMarkdown: '# Restart',
      steps: [
        {
          id: 'step_restart',
          title: 'Restart step',
          description: 'Resume explicitly.',
          acceptance: ['resumed'],
        },
      ],
    })
    first.controlManager.approve(interaction.id)
    first.controlManager.pausePlanExecution({
      reason: 'no_progress',
      turnId: 'turn_restart_pause',
      pausedAt: Date.now() / 1000,
      evaluationCount: 0,
      totalIterations: 12,
      nextActions: ['Resume explicitly'],
    })
    await first.close()

    const restarted = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    try {
      expect(restarted.todoStore.todos).toEqual([])
      expect(
        restarted.controlManager.planStore.get(String(interaction.meta.plan_id))
          ?.metadata.execution_pause,
      ).toMatchObject({ reason: 'no_progress' })
    } finally {
      await restarted.close()
    }
  })

  it('inherits the paused Plan execution identity for an explicit continue turn', async () => {
    const root = tmp('emperor-agent-loop-plan-execution-identity-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
      initializeMcp: false,
    })
    try {
      const interaction = loop.controlManager.createPlan({
        title: 'Continue the same task',
        summary: 'Keep one task-level change ledger.',
        planMarkdown: '# Continue',
        steps: [
          {
            id: 'step_continue',
            title: 'Continue step',
            description: 'Resume explicitly.',
            acceptance: ['resumed'],
          },
        ],
      })
      loop.controlManager.approve(interaction.id)
      loop.controlManager.pausePlanExecution({
        reason: 'no_progress',
        turnId: 'turn_original',
        executionId: 'execution_original',
        pausedAt: Date.now() / 1000,
        evaluationCount: 0,
        totalIterations: 12,
        nextActions: ['Continue'],
      })
      let observedExecutionId: string | null = null
      vi.spyOn(loop.runner, 'stepStream').mockImplementation(async () => {
        observedExecutionId = loop.runner.executionId
        return 'resumed'
      })

      await expect(
        loop.runUserTurn('继续执行', {
          sessionId: loop.activeSessionId,
          turnId: 'turn_resumed',
        }),
      ).resolves.toBe('resumed')

      expect(observedExecutionId).toBe('execution_original')
    } finally {
      await loop.close()
    }
  })

  it('resumes a paused Goal and its bound Plan through one explicit continue message', async () => {
    const root = tmp('emperor-agent-loop-goal-plan-resume-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(
        new QueueProvider([
          response(null, {
            toolCalls: [
              {
                id: 'resume_todo_claim',
                name: 'update_todos',
                arguments: {
                  todos: [
                    {
                      id: 'plan:step_resume',
                      content: 'Resume step',
                      status: 'completed',
                    },
                  ],
                },
              },
            ],
            finishReason: 'tool_calls',
          }),
          response(null, {
            toolCalls: [
              {
                id: 'resume_verification',
                name: 'run_command',
                arguments: { command: 'pwd' },
              },
            ],
            finishReason: 'tool_calls',
          }),
          response(null, {
            toolCalls: [
              {
                id: 'resume_todo_complete',
                name: 'update_todos',
                arguments: {
                  todos: [
                    {
                      id: 'plan:step_resume',
                      content: 'Resume step',
                      status: 'completed',
                    },
                  ],
                },
              },
            ],
            finishReason: 'tool_calls',
          }),
          response('计划已恢复并完成验证。'),
        ]),
      ),
      initializeMcp: false,
    })
    try {
      const sessionId = loop.activeSessionId!
      const session = loop.sessionStore.get(sessionId)!
      const created = await loop.goalStore.create(
        newGoalRecord({
          id: 'goal_loop_continuation_resume',
          outcome: 'Resume the paused Goal and Plan together.',
          scope: {
            sessionId,
            mode: session.mode,
            projectId: session.project_id,
            workspaceRoot: session.project_path ?? loop.root,
          },
          now: '2026-07-21T00:00:00.000Z',
        }),
      )
      const locked = await loop.goalStore.append(created.id, {
        type: 'goal_updated',
        expectedLastEventSeq: created.lastEventSeq,
        record: GoalContractValidator.lock(
          created,
          {
            inScope: ['resume one paused step'],
            outOfScope: [],
            constraints: [],
            acceptanceCriteria: [
              {
                id: 'AC-1',
                description: 'The paused step resumes.',
                required: true,
                verification: { kind: 'command', requirement: 'npm test' },
              },
            ],
            escalationConditions: [],
          },
          '2026-07-21T00:00:01.000Z',
        ),
      })
      loop.controlManager.setRuntimeScope(locked.scope)
      loop.controlManager.setActiveGoalPlanContext(locked)
      loop.controlManager.setMode('full_access')
      loop.controlManager.setMode('plan')
      const interaction = loop.controlManager.createPlan({
        title: 'Resume Goal Plan',
        summary: 'Resume the active step.',
        planMarkdown: '# Plan\n\n- Resume',
        steps: [
          {
            id: 'step_resume',
            title: 'Resume step',
            commands: ['pwd'],
            acceptance: ['step resumed'],
          },
        ],
      })
      loop.controlManager.approve(interaction.id)
      const planId = String(interaction.meta.plan_id)
      await loop.goalPlanBridge.bindApprovedPlan({
        goalId: locked.id,
        planId,
      })
      loop.controlManager.pausePlanExecution({
        reason: 'no_progress',
        turnId: 'turn_before_resume',
        pausedAt: Date.now() / 1000,
        evaluationCount: 1,
        totalIterations: 20,
        nextActions: ['Continue the active step'],
      })
      const resumePlanExecution = vi.spyOn(
        loop.controlManager,
        'resumePlanExecution',
      )
      await loop.goalCoordinator.pause(locked.id, 'continuation_pause')
      let resumedTurnDone!: () => void
      const resumedTurn = new Promise<void>((resolve) => {
        resumedTurnDone = resolve
      })
      let pauseAfterGoalTurn: unknown = null
      loop.goalCoordinator.setTurnSubmitter(async (input) => {
        await loop.runUserTurn(input.content, {
          displayContent: input.displayContent,
          sessionId: input.goal.scope.sessionId,
          restoreActiveSessionAfterTurn: true,
          source: 'goal',
          uiHidden: input.uiHidden,
          useActiveTask: false,
          taskId: input.taskId,
          turnId: input.turnId,
          signal: input.signal,
        })
        pauseAfterGoalTurn =
          loop.controlManager.planStore.get(planId)?.metadata.execution_pause
        resumedTurnDone()
      })

      await expect(
        loop.runUserTurn('继续执行', {
          sessionId,
          turnId: 'turn_explicit_goal_resume',
        }),
      ).resolves.toBe('')
      await resumedTurn
      expect(resumePlanExecution).toHaveBeenCalled()
      expect(
        (
          resumePlanExecution.mock.results[0]?.value as
            { metadata?: Record<string, unknown> } | null | undefined
        )?.metadata?.execution_pause,
      ).toBeUndefined()
      expect(pauseAfterGoalTurn).not.toMatchObject({
        turn_id: 'turn_before_resume',
      })
      expect(loop.goalCoordinator.active(locked.id)).not.toBeNull()
      await loop.goalCoordinator.pause(locked.id, 'test_cleanup')
      const handle = loop.goalCoordinator.active(locked.id)
      if (handle) await handle.promise
      expect(
        loop.controlManager.planStore.get(planId)?.metadata.execution_pause,
      ).not.toMatchObject({ turn_id: 'turn_before_resume' })
    } finally {
      await loop.close()
    }
  })

  it('creates a fresh execution snapshot per turn while keeping each turn fixed', async () => {
    const root = tmp('emperor-agent-loop-environment-')
    const provider = new QueueProvider([response('first'), response('second')])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      initializeMcp: false,
    })
    const create = vi.spyOn(loop.executionEnvironmentService, 'create')
    const previous = process.env.EMPEROR_SNAPSHOT_TEST
    try {
      process.env.EMPEROR_SNAPSHOT_TEST = 'one'
      await loop.runUserTurn('first', { turnId: 'turn_environment_1' })
      process.env.EMPEROR_SNAPSHOT_TEST = 'two'
      await loop.runUserTurn('second', { turnId: 'turn_environment_2' })

      expect(create).toHaveBeenCalledTimes(2)
      const snapshots = await Promise.all(
        create.mock.results.map((result) => result.value),
      )
      expect(snapshots[0]!.revision).not.toBe(snapshots[1]!.revision)
      expect(snapshots[0]!.selectEnv(['EMPEROR_SNAPSHOT_TEST'])).toEqual({
        EMPEROR_SNAPSHOT_TEST: 'one',
      })
      expect(snapshots[1]!.selectEnv(['EMPEROR_SNAPSHOT_TEST'])).toEqual({
        EMPEROR_SNAPSHOT_TEST: 'two',
      })
    } finally {
      if (previous === undefined) delete process.env.EMPEROR_SNAPSHOT_TEST
      else process.env.EMPEROR_SNAPSHOT_TEST = previous
      await loop.close()
    }
  })

  it('prefetches goal, memory/skills projection, execution environment, and MCP concurrently', async () => {
    const root = tmp('emperor-agent-loop-prefetch-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new QueueProvider([response('done')])),
      initializeMcp: false,
    })
    const started: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalEnvironmentCreate =
      loop.executionEnvironmentService.create.bind(
        loop.executionEnvironmentService,
      )
    vi.spyOn(loop.executionEnvironmentService, 'create').mockImplementation(
      async (request) => {
        started.push('execution_environment')
        await gate
        return await originalEnvironmentCreate(request)
      },
    )
    const originalFindGoal = loop.goalStore.findActiveBySession.bind(
      loop.goalStore,
    )
    vi.spyOn(loop.goalStore, 'findActiveBySession').mockImplementation(
      async (sessionId) => {
        started.push('active_goal')
        await gate
        return await originalFindGoal(sessionId)
      },
    )
    const bindings = loop.sessionRuntimes.get(loop.activeSessionId!)!.bindings
    const originalProjection = bindings.contextBuilder.buildProjection.bind(
      bindings.contextBuilder,
    )
    vi.spyOn(bindings.contextBuilder, 'buildProjection').mockImplementation(
      () => {
        started.push('memory_skills_projection')
        return originalProjection()
      },
    )
    vi.spyOn(loop.mcpClient, 'getTools').mockImplementation(() => {
      started.push('mcp_catalog')
      return []
    })
    const emitted: Array<Record<string, unknown>> = []

    try {
      const running = loop.runUserTurn('prefetch', {
        turnId: 'turn_prefetch',
        emit: (event) => {
          emitted.push(event)
        },
      })
      await vi.waitFor(() => {
        expect(started).toEqual(
          expect.arrayContaining([
            'active_goal',
            'execution_environment',
            'memory_skills_projection',
            'mcp_catalog',
          ]),
        )
      })
      release()
      await expect(running).resolves.toBe('done')

      expect(
        emitted.find((event) => event.event === 'context_projection'),
      ).toMatchObject({
        report: {
          prefetch: {
            version: 1,
            tasks: expect.arrayContaining([
              expect.objectContaining({
                name: 'active_goal',
                status: 'ready',
              }),
              expect.objectContaining({
                name: 'execution_environment',
                status: 'ready',
              }),
              expect.objectContaining({
                name: 'memory_skills_projection',
                status: 'ready',
              }),
              expect.objectContaining({
                name: 'mcp_catalog',
                status: 'ready',
              }),
            ]),
          },
        },
      })
    } finally {
      release()
      await loop.close()
    }
  })

  it('runs hybrid memory in eval shadow mode without changing the model prompt', async () => {
    const root = tmp('emperor-agent-loop-hybrid-eval-')
    const provider = new QueueProvider([response('done')])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      initializeMcp: false,
      hybridMemoryMode: 'eval',
    })
    loop.sharedMemory.writeMemory(
      '## Database\n\nDatabase endpoint is db.eval.internal:6543.',
    )

    await loop.runUserTurn('database endpoint', { turnId: 'turn_hybrid_eval' })

    expect(loop.hybridMemory.diagnostics()).toMatchObject({
      capability: {
        effectiveMode: 'eval',
        promptMutationAllowed: false,
      },
      searches: 1,
      promptMutations: 0,
      lastStrategy: 'fts',
    })
    expect(existsSync(loop.hybridMemory.index.indexPath)).toBe(true)
    expect(JSON.stringify(provider.calls[0]!.messages)).not.toContain(
      'Retrieved Long-term Memory',
    )
  })

  it('changes only the dynamic memory projection after provider-bound eval gate passes', async () => {
    const root = tmp('emperor-agent-loop-hybrid-on-')
    const provider = new QueueProvider([response('done')])
    const embeddingProvider: MemoryEmbeddingProvider = {
      id: 'evaluated-loop-fixture',
      dimensions: 2,
      async embed(texts) {
        return texts.map(() => [1, 0])
      },
    }
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      initializeMcp: false,
      hybridMemoryMode: 'on',
      memoryEmbeddingProvider: embeddingProvider,
      hybridMemoryEvaluationGate: {
        passed: true,
        datasetSha256: 'a'.repeat(64),
        embeddingProviderId: embeddingProvider.id,
      },
    })
    loop.sharedMemory.writeMemory(
      '## Database\n\nPostgreSQL endpoint is db.on.internal:6543.',
    )

    await loop.runUserTurn('where is the primary database', {
      turnId: 'turn_hybrid_on',
    })

    const sent = JSON.stringify(provider.calls[0]!.messages)
    expect(sent).toContain('Retrieved Long-term Memory')
    expect(sent).toContain('db.on.internal:6543')
    expect(sent).toContain('source=global')
    expect(loop.hybridMemory.diagnostics()).toMatchObject({
      capability: { effectiveMode: 'on', promptMutationAllowed: true },
      searches: 1,
      promptMutations: 1,
      lastStrategy: 'hybrid',
    })
    expect(
      loop.runner.promptSections.find(
        (section) => section.name === 'long_term_memory',
      ),
    ).toMatchObject({ stability: 'dynamic' })
  })

  it('starts the production scheduler exactly once and stops it with the loop', async () => {
    const root = tmp('emperor-agent-loop-scheduler-lifecycle-')
    const start = vi.spyOn(SchedulerService.prototype, 'start')
    let loop: AgentLoop | null = null
    try {
      loop = await AgentLoop.create({
        root,
        stateRoot: join(root, '.emperor'),
        templatesDir: TEMPLATES_DIR,
        modelRouter: fakeRouter(new QueueProvider([response('unused')])),
        initializeMcp: false,
      })

      expect(start).toHaveBeenCalledTimes(1)
      expect(loop.schedulerService.status().running).toBe(true)
      expect(loop.lifecycleSupervisor.snapshot()).toMatchObject({
        state: 'ready',
        services: [
          { id: 'process-runtime', state: 'ready' },
          { id: 'code-intelligence', state: 'ready' },
          { id: 'task-runtime', state: 'ready' },
          { id: 'subagent-supervisor', state: 'ready' },
          { id: 'session-runtime', state: 'ready' },
          { id: 'mcp', state: 'ready' },
          { id: 'scheduler', state: 'ready' },
        ],
      })

      await loop.schedulerService.start()
      expect(start).toHaveBeenCalledTimes(2)
      expect(loop.schedulerService.status().running).toBe(true)

      await loop.close()
      expect(loop.schedulerService.status().running).toBe(false)
      expect(loop.lifecycleSupervisor.snapshot()).toMatchObject({
        state: 'stopped',
        services: [
          { id: 'process-runtime', state: 'stopped' },
          { id: 'code-intelligence', state: 'stopped' },
          { id: 'task-runtime', state: 'stopped' },
          { id: 'subagent-supervisor', state: 'stopped' },
          { id: 'session-runtime', state: 'stopped' },
          { id: 'mcp', state: 'stopped' },
          { id: 'scheduler', state: 'stopped' },
        ],
      })
    } finally {
      if (loop?.schedulerService.status().running) await loop.close()
      start.mockRestore()
    }
  })

  it('creates a fresh snapshot for a scheduler-triggered agent run', async () => {
    const root = tmp('emperor-agent-loop-scheduler-environment-')
    const provider = new QueueProvider([response('scheduled')])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      initializeMcp: false,
    })
    const create = vi.spyOn(loop.executionEnvironmentService, 'create')
    const job = loop.schedulerService.addJob({
      name: 'snapshot scheduler job',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({
        kind: 'agent_turn',
        message: 'inspect environment',
        deliver: false,
      }),
    })

    await loop.schedulerService.runJob(job.id, { force: true })

    expect(create).toHaveBeenCalledTimes(1)
    const snapshot = await create.mock.results[0]!.value
    expect(snapshot.projectFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(provider.calls[0]!.messages.at(-1)?.content).toContain(
      '[SCHEDULER_TRIGGER]',
    )
    await loop.close()
  })

  it('runs Scheduler turns through TaskRuntime and propagates lifecycle cancellation', async () => {
    const root = tmp('emperor-agent-loop-scheduler-task-runtime-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new QueueProvider([])),
      initializeMcp: false,
    })
    let entered = (): void => undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const submitted: { value: SchedulerAgentTurnPayload | null } = {
      value: null,
    }
    loop.setSchedulerAgentTurnSubmitter(async (payload) => {
      submitted.value = payload
      entered()
      return await new Promise<string>((_resolve, reject) => {
        payload.signal.addEventListener(
          'abort',
          () => reject(payload.signal.reason),
          { once: true },
        )
      })
    })
    const job = loop.schedulerService.addJob({
      name: 'runtime-owned scheduler turn',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({
        kind: 'agent_turn',
        message: 'wait for shutdown',
        deliver: false,
      }),
    })

    const running = loop.schedulerService.runJob(job.id, { force: true })
    await started
    const taskId = submitted.value!.taskId
    expect(loop.taskManager.store.get(taskId)).toMatchObject({
      status: 'running',
      metadata: { runtime_managed: true },
    })
    expect(loop.activeTasks.list()).toEqual([
      expect.objectContaining({
        id: submitted.value!.scheduler.runId,
        kind: 'scheduler',
      }),
    ])

    const closing = loop.close()
    await expect(running).resolves.toBe(true)
    await closing
    expect(submitted.value!.signal.aborted).toBe(true)
    expect(loop.taskManager.store.get(taskId)?.status).toBe('cancelled')
    expect(loop.schedulerService.getJob(job.id)?.state.last_status).toBe(
      'interrupted',
    )
    expect(loop.activeTasks.list()).toEqual([])
  })

  it('applies configured PreToolUse hooks through the real loop runtime', async () => {
    const root = tmp('emperor-agent-loop-hooks-')
    const stateRoot = join(root, '.emperor')
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(join(root, 'hello.txt'), 'secret content\n', 'utf8')
    writeFileSync(
      join(stateRoot, 'hooks_config.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              id: 'deny-read',
              matcher: 'read_file',
              handler: {
                type: 'command',
                command: process.execPath,
                args: [
                  '-e',
                  'process.stdout.write(JSON.stringify({decision:"deny",reason:"blocked read"}))',
                ],
              },
            },
          ],
        },
      }),
    )
    const provider = new FakeProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const events: Array<Record<string, unknown>> = []

    await loop.runUserTurn('读取 hello.txt', {
      turnId: 'turn_hooks',
      emit: async (event) => {
        events.push(event)
      },
    })

    const secondCall = provider.calls[1]!
    const toolMessage = secondCall.messages.find(
      (message) => message.role === 'tool',
    )
    expect(String(toolMessage?.content ?? '')).toContain('blocked read')
    expect(String(toolMessage?.content ?? '')).not.toContain('secret content')
    expect(events.map((event) => event.event)).toContain('hook_run_started')
    expect(
      (await loop.hookService.audit.replayRuns()).records.some(
        (record) => record.groupId === 'deny-read',
      ),
    ).toBe(true)
  })

  it('rejects an unavailable model before recording user history', async () => {
    const root = tmp('emperor-agent-loop-no-model-')
    const provider = new FakeProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: Object.assign(fakeRouter(provider), {
        availability: {
          usable: false,
          code: 'model_configuration_required' as const,
          message: '请先配置模型',
          action: 'open_model_settings' as const,
          provider: 'deepseek',
          entryName: null,
        },
      }),
    })
    const events: Array<Record<string, unknown>> = []

    await expect(
      loop.runUserTurn('hi', {
        turnId: 'turn_no_model',
        emit: async (event) => {
          events.push(event)
        },
      }),
    ).rejects.toMatchObject({
      code: 'model_configuration_required',
      action: 'open_model_settings',
    })

    expect(provider.calls).toHaveLength(0)
    expect(loop.history).toEqual([])
    expect(loop.activeMemoryStore.loadUnarchivedHistory()).toEqual([])
    expect(events.map((event) => event.event)).not.toContain('user_message')
  })

  it('blocks Build before recording history when the active model has no tool calling', async () => {
    const root = tmp('emperor-agent-loop-build-no-tools-')
    const projectRoot = tmp('emperor-agent-loop-build-no-tools-project-')
    const provider = new FakeProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider, false),
    })
    const project = loop.projectStore.resolve(projectRoot)
    const buildSession = loop.sessionStore.create('Build project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(buildSession.id)

    await expect(loop.runUserTurn('修改项目')).rejects.toMatchObject({
      code: 'model_configuration_required',
      action: 'open_model_settings',
    })
    expect(provider.calls).toHaveLength(0)
    expect(loop.history).toEqual([])
    expect(loop.activeMemoryStore.loadUnarchivedHistory()).toEqual([])
  })

  it('blocks Scheduler automation but still permits ordinary Chat without tool calling', async () => {
    const root = tmp('emperor-agent-loop-chat-no-tools-')
    const provider = new QueueProvider([response('chat still works')])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider, false),
    })

    await expect(loop.runUserTurn('普通问答')).resolves.toBe('chat still works')
    await expect(
      loop.runUserTurn('自动执行', {
        source: 'scheduler',
        useActiveTask: false,
      }),
    ).rejects.toMatchObject({
      code: 'model_configuration_required',
      action: 'open_model_settings',
    })
    expect(provider.calls).toHaveLength(1)
  })

  it('restores the foreground session when a targeted Scheduler turn is rejected', async () => {
    const root = tmp('emperor-agent-loop-scheduler-restore-')
    const provider = new QueueProvider([])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider, false),
    })
    const foregroundId = String(loop.activeSessionId)
    const background = loop.sessionStore.create('Background', { mode: 'chat' })

    await expect(
      loop.runUserTurn('自动执行', {
        sessionId: background.id,
        restoreActiveSessionAfterTurn: true,
        source: 'scheduler',
        useActiveTask: false,
      }),
    ).rejects.toMatchObject({ code: 'model_configuration_required' })
    expect(loop.activeSessionId).toBe(foregroundId)
    expect(provider.calls).toHaveLength(0)
  })

  it('runs build session file tools inside the bound project workspace', async () => {
    const root = tmp('emperor-agent-loop-core-root-')
    const projectRoot = tmp('emperor-agent-loop-project-')
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"wrong-core-root"}\n',
      'utf8',
    )
    writeFileSync(join(root, 'core-only.txt'), 'core root file\n', 'utf8')
    writeFileSync(
      join(projectRoot, 'package.json'),
      '{"name":"right-project-root"}\n',
      'utf8',
    )
    writeFileSync(
      join(projectRoot, 'project-only.txt'),
      'project root file\n',
      'utf8',
    )
    const provider = new QueueProvider([
      response(null, {
        toolCalls: [
          { id: 'call_glob', name: 'glob', arguments: { pattern: '*.txt' } },
          {
            id: 'call_read_relative',
            name: 'read_file',
            arguments: { path: 'package.json' },
          },
          {
            id: 'call_read_absolute',
            name: 'read_file',
            arguments: { path: join(projectRoot, 'package.json') },
          },
          {
            id: 'call_pwd',
            name: 'run_command',
            arguments: { command: 'pwd' },
          },
        ],
        finishReason: 'tool_calls',
      }),
      response('读完了。'),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const project = loop.projectStore.resolve(projectRoot)
    const buildSession = loop.sessionStore.create('Build project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(buildSession.id)
    loop.controlManager.setMode('smart_auto')

    await loop.runUserTurn('读取 package.json', {
      turnId: 'turn_1',
      emit: async () => {},
    })

    const toolOutputs = provider.calls[1]!.messages.filter(
      (message) => message.role === 'tool',
    )
      .map((message) => String(message.content ?? ''))
      .join('\n')
    expect(toolOutputs).toContain('right-project-root')
    expect(toolOutputs).toContain('project-only.txt')
    expect(toolOutputs).toContain(basename(projectRoot))
    expect(toolOutputs).not.toContain('wrong-core-root')
    expect(toolOutputs).not.toContain('core-only.txt')
    expect(provider.calls[0]!.messages[0]!.content).toContain(
      `Workspace root: \`${projectRoot}\``,
    )
    const processEnvelope = readFileSync(
      loop.sessionRuntimes.get(buildSession.id)!.bindings.runtimeStore
        .eventsFile,
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === 'process_containment')
    expect(processEnvelope).toMatchObject({
      schemaVersion: 2,
      type: 'process_containment',
      toolCallId: 'call_pwd',
      visibility: 'user',
      idempotencyKey: 'call_pwd:process_containment',
      payload: {
        decision: expect.stringMatching(/^(sandboxed|unsandboxed)$/),
        backend: expect.any(String),
        capability_status: expect.any(String),
        policy_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
  })

  it('captures enabled managed file writes at the real tool boundary and can rewind them', async () => {
    const root = tmp('emperor-agent-loop-file-checkpoint-')
    const projectRoot = tmp('emperor-agent-loop-file-checkpoint-project-')
    writeFileSync(join(projectRoot, 'managed.txt'), 'before checkpoint\n')
    const provider = new QueueProvider([
      response(null, {
        toolCalls: [
          {
            id: 'call_checkpoint_edit',
            name: 'edit_file',
            arguments: {
              path: 'managed.txt',
              old_text: 'before checkpoint',
              new_text: 'after checkpoint',
            },
          },
        ],
        finishReason: 'tool_calls',
      }),
      response('修改完成。'),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
      fileCheckpointsEnabled: true,
      softGitRewindMode: 'eval',
    })
    loop.controlManager.setPermissionMode('smart_auto')
    const project = loop.projectStore.resolve(projectRoot)
    const buildSession = loop.sessionStore.create('Checkpoint build', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(buildSession.id)

    await loop.runUserTurn('修改 managed.txt', {
      turnId: 'turn_checkpoint_edit',
      emit: async () => {},
    })

    expect(readFileSync(join(projectRoot, 'managed.txt'), 'utf8')).toBe(
      'after checkpoint\n',
    )
    const checkpoints = await loop.fileCheckpoints.list(buildSession.id)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      turnId: 'turn_checkpoint_edit',
      toolCallId: 'call_checkpoint_edit',
      toolName: 'edit_file',
      changes: [{ path: 'managed.txt', kind: 'modify' }],
      gitCheckpoint: { status: 'unavailable', reason: 'not_repository' },
    })
    await loop.fileCheckpoints.rewind({
      sessionId: buildSession.id,
      checkpointId: checkpoints[0]!.id,
      workspaceRoot: projectRoot,
    })
    expect(readFileSync(join(projectRoot, 'managed.txt'), 'utf8')).toBe(
      'before checkpoint\n',
    )
  })

  it('keeps an in-flight turn bound to its starting session when active session changes', async () => {
    const root = tmp('emperor-agent-loop-turn-scope-')
    const provider = new DelayedProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const firstSessionId = loop.activeSessionId!
    const second = loop.sessionStore.create('Second chat')
    const emitted: Array<Record<string, unknown>> = []

    const running = loop.runUserTurn('先在第一个会话里回答', {
      turnId: 'turn_scope_1',
      emit: async (event) => {
        emitted.push(event)
      },
    })
    await provider.started
    loop.activateSession(second.id)
    provider.finish(response('只应写回第一个会话。'))

    await expect(running).resolves.toBe('只应写回第一个会话。')

    const firstHistory = readFileSync(
      join(root, '.emperor', 'sessions', firstSessionId, 'history.jsonl'),
      'utf8',
    )
    const secondHistoryPath = join(
      root,
      '.emperor',
      'sessions',
      second.id,
      'history.jsonl',
    )
    const secondHistory = existsSync(secondHistoryPath)
      ? readFileSync(secondHistoryPath, 'utf8')
      : ''
    expect(firstHistory).toContain('只应写回第一个会话。')
    expect(secondHistory).not.toContain('只应写回第一个会话。')
    expect(loop.sessionStore.get(firstSessionId)?.message_count).toBe(2)
    expect(loop.sessionStore.get(second.id)?.message_count).toBe(0)
    expect(emitted.find((event) => event.event === 'turn_scope')).toMatchObject(
      {
        session_id: firstSessionId,
        turn_id: 'turn_scope_1',
        state_root: join(root, '.emperor'),
        session_root: join(root, '.emperor', 'sessions', firstSessionId),
        active_memory_binding: {
          profile: {
            scope: { kind: 'user_profile' },
            readable: true,
            writable: true,
            path: join(root, '.emperor', 'memory', 'profile', 'USER.local.md'),
          },
          longTerm: {
            scope: { kind: 'global' },
            readable: true,
            writable: true,
            path: join(root, '.emperor', 'memory', 'MEMORY.local.md'),
          },
        },
      },
    )
  })

  it('keeps a late Ask bound to the session that started the turn', async () => {
    const root = tmp('emperor-agent-loop-late-ask-scope-')
    const provider = new DelayedProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const firstSessionId = loop.activeSessionId!
    const second = loop.sessionStore.create('Second chat')

    const running = loop.runUserTurn('确认本次修改范围', {
      turnId: 'turn_late_ask_scope',
      emit: async () => {},
    })
    const settled = running.then(
      () => null,
      (error: unknown) => error,
    )
    await provider.started
    loop.activateSession(second.id)
    provider.finish(
      response(null, {
        toolCalls: [
          {
            id: 'call_late_ask',
            name: 'ask_user',
            arguments: {
              questions: [
                {
                  id: 'scope',
                  header: '范围',
                  question: '本次范围怎么定？',
                  options: [
                    { label: '最小', description: '只处理核心路径' },
                    { label: '完整', description: '包含测试和文档' },
                  ],
                },
              ],
            },
          },
        ],
        finishReason: 'tool_calls',
      }),
    )

    expect(await settled).not.toBeNull()
    const pending = loop.controlManager.store.load().pending
    expect(pending?.meta.control_session_id).toBe(firstSessionId)
    expect(
      loop.sessionStore.get(firstSessionId)?.control_pending,
    ).toMatchObject({
      kind: 'ask',
      interaction_id: pending?.id,
    })
    expect(loop.sessionStore.get(second.id)?.control_pending).toBeNull()
  })

  it('restores the previous active session after a background turn targets another session', async () => {
    const root = tmp('emperor-agent-loop-bg-session-')
    const provider = new DelayedProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const firstSessionId = loop.activeSessionId!
    const second = loop.sessionStore.create('Background target')

    const running = loop.runUserTurn('后台会话执行', {
      sessionId: second.id,
      restoreActiveSessionAfterTurn: true,
      turnId: 'turn_background_session',
    })
    await provider.started
    expect(loop.activeSessionId).toBe(second.id)
    provider.finish(response('后台完成。'))

    await expect(running).resolves.toBe('后台完成。')

    expect(loop.activeSessionId).toBe(firstSessionId)
    const secondHistory = readFileSync(
      join(root, '.emperor', 'sessions', second.id, 'history.jsonl'),
      'utf8',
    )
    expect(secondHistory).toContain('后台完成。')
  })

  it('auto-compacts stable completed turns through compactSession when explicitly enabled', async () => {
    const root = tmp('emperor-agent-loop-auto-compact-')
    const provider = new QueueProvider([
      response('新回复。', { usage: { input: 90_000, output: 4 } }),
      response(
        JSON.stringify({
          schemaVersion: 'emperor.compaction-draft.v1',
          episode: {
            operations: [
              {
                op: 'append_section_item',
                section: 'Summary',
                content: '- Auto compacted old completed chat turns.',
                reason: 'token threshold summarized stable history',
                sourceSeqs: [1, 2, 3, 4],
                confidence: 'high',
              },
            ],
          },
          userProfile: {
            operations: [
              {
                op: 'append_section_item',
                section: 'Stable Preferences',
                content:
                  '- Prefers automatic scoped compaction when context is high.',
                reason: 'stable user preference from old turns',
                sourceSeqs: [1],
                confidence: 'high',
              },
            ],
          },
          globalMemory: {
            operations: [
              {
                op: 'append_section_item',
                section: 'Cross-Project Decisions',
                content:
                  '- Auto compaction uses compactSession and keeps session history.',
                reason: 'durable system behavior',
                sourceSeqs: [2],
                confidence: 'high',
              },
            ],
          },
          decisions: [],
          discarded: [],
        }),
      ),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    for (let i = 1; i <= 5; i++) {
      loop.activeMemoryStore.appendHistory('user', `old user ${i}`, {
        extra: { turn_id: `old_${i}` },
      })
      loop.activeMemoryStore.appendHistory('assistant', `old assistant ${i}`, {
        extra: { turn_id: `old_${i}` },
      })
    }

    const emitted: Array<Record<string, unknown>> = []
    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', '1', async () => {
      const reply = await loop.runUserTurn('触发自动压缩', {
        turnId: 'turn_auto_compact',
        emit: (event) => {
          emitted.push(event)
        },
      })
      expect(reply).toBe('新回复。')
    })

    expect(provider.calls).toHaveLength(2)
    expect(
      emitted.filter((event) => event.event === 'record_degraded'),
    ).toEqual([])
    expect(provider.calls[1]!.model).toBe('fake-active')
    expect(loop.sharedMemory.readMemory()).toContain(
      'Auto compaction uses compactSession',
    )
    expect(loop.sharedMemory.readUser()).toContain(
      'automatic scoped compaction',
    )
    expect(loop.sharedMemory.readTodayEpisode()).toContain(
      'Auto compacted old completed chat turns',
    )
    expect(
      loop.activeMemoryStore.loadUnarchivedHistory().map((row) => row.role),
    ).toHaveLength(8)
    expect(loop.history.map((row) => row.role)).toHaveLength(8)
    const cursor = new CompactionCursorStore(loop.paths.stateRoot).readOrInit(
      loop.activeSessionId!,
    )
    expect(cursor.compactedUntilSeq).toBeGreaterThanOrEqual(4)
    expect(cursor.archivedUntilSeq).toBeGreaterThanOrEqual(4)

    await loop.runUserTurn('压缩后的下一轮', { turnId: 'turn_after_compact' })
    const snapshot = JSON.parse(
      readFileSync(
        join(
          loop.sessionStore.sessionDir(loop.activeSessionId!),
          'prompt-snapshots',
          'turn_after_compact.json',
        ),
        'utf8',
      ),
    )
    expect(snapshot.contextPlan.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'session_history',
          reason: 'semantic_compaction_applied',
          fromSeq: 1,
          toSeq: cursor.compactedUntilSeq,
          compactionId: cursor.lastCompactionId,
          targetScopes: expect.arrayContaining(['global', 'user_profile']),
        }),
      ]),
    )
  })

  it('keeps unfinished todos scoped to the session that created them', async () => {
    const root = tmp('emperor-agent-loop-todo-session-scope-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new QueueProvider([response('done')])),
    })
    const firstSessionId = loop.activeSessionId!

    loop.todoStore.update([
      { id: 1, content: '旧会话待办', status: 'in_progress' },
    ])

    const second = loop.sessionStore.create('Second chat')
    loop.activateSession(second.id)
    expect(loop.todoStore.todos).toEqual([])

    loop.todoStore.update([
      { id: 1, content: '第二会话待办', status: 'pending' },
    ])
    loop.activateSession(firstSessionId)
    expect(loop.todoStore.todos).toMatchObject([
      { content: '旧会话待办', status: 'in_progress' },
    ])

    loop.activateSession(second.id)
    expect(loop.todoStore.todos).toMatchObject([
      { content: '第二会话待办', status: 'pending' },
    ])
  })

  it('mirrors waiting ask and plan controls into the active session index', async () => {
    const root = tmp('emperor-agent-loop-control-session-tag-')
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const sessionId = loop.activeSessionId!

    const ask = loop.controlManager.createAsk({
      questions: [
        {
          id: 'scope',
          header: '范围',
          question: '范围怎么定？',
          options: [
            { label: '最小', description: '只做核心' },
            { label: '完整', description: '包含测试' },
          ],
        },
      ],
    })
    expect(loop.sessionStore.get(sessionId)?.control_pending).toMatchObject({
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: ask.id,
    })

    loop.controlManager.answer(ask.id, { scope: { choice: '完整' } })
    expect(loop.sessionStore.get(sessionId)?.control_pending).toBeNull()

    loop.controlManager.setMode('plan')
    const plan = loop.controlManager.createPlan({
      title: '实现计划',
      summary: '等待确认',
      planMarkdown: '# Plan\n\n- Do it',
      assumptions: [],
      riskLevel: 'low',
    })
    expect(loop.sessionStore.get(sessionId)?.control_pending).toMatchObject({
      kind: 'plan',
      label: '计划需要用户确认',
      tone: 'green',
      interaction_id: plan.id,
    })

    loop.controlManager.cancel(plan.id)
    expect(loop.sessionStore.get(sessionId)?.control_pending).toBeNull()
  })

  it('does not execute a project test script before permission approval', async () => {
    const root = tmp('emperor-agent-loop-project-test-approval-')
    const projectRoot = tmp('emperor-agent-loop-project-test-workspace-')
    const marker = join(projectRoot, 'test-marker.txt')
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'permission-fixture',
        private: true,
        scripts: { test: 'node write-test-marker.cjs' },
      }),
      'utf8',
    )
    writeFileSync(
      join(projectRoot, 'write-test-marker.cjs'),
      "require('node:fs').writeFileSync('test-marker.txt', 'executed')\n",
      'utf8',
    )
    const provider = new QueueProvider([
      response(null, {
        toolCalls: [
          {
            id: 'call_project_test',
            name: 'run_command',
            arguments: { command: 'npm test' },
          },
        ],
        finishReason: 'tool_calls',
      }),
      response('测试已执行。'),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const project = loop.projectStore.resolve(projectRoot)
    const buildSession = loop.sessionStore.create('Build project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(buildSession.id)

    const result = await loop
      .runUserTurn('运行项目测试', {
        turnId: 'turn_project_test_approval',
        emit: async () => {},
      })
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(result).not.toBeNull()
    expect(existsSync(marker)).toBe(false)
    expect(loop.controlManager.store.load().pending).toMatchObject({
      kind: 'ask',
      meta: {
        permission: {
          version: 2,
          operation_count: 1,
          operations: [
            {
              tool_name: 'run_command',
              risk: 'high',
              summary: 'npm test',
            },
          ],
        },
      },
    })
  })

  it('gates dispatch_subagent tool calls through the real permission pipeline (audit P0-1)', async () => {
    const root = tmp('emperor-agent-loop-dispatch-guard-')
    const marker = join(root, 'marker.txt')
    writeFileSync(marker, 'x', 'utf8')

    const provider = new QueueProvider([
      // 主 agent: 派遣子代理去改权限
      response(null, {
        toolCalls: [
          {
            id: 'call_1',
            name: 'dispatch_subagent',
            arguments: {
              agent_type: 'general',
              task: `把 ${marker} 权限改成 000`,
            },
          },
        ],
        finishReason: 'tool_calls',
      }),
      // 子代理: 尝试跑一条高危命令 (chmod 命中 isHighRiskCommand)
      response(null, {
        toolCalls: [
          {
            id: 'call_2',
            name: 'run_command',
            arguments: { command: `chmod 000 ${marker}` },
          },
        ],
        finishReason: 'tool_calls',
      }),
      // 子代理: 收到"需要审批"结果后收工回禀
      response('未获批准，无法执行该命令。'),
      // 主 agent: 收到子代理回禀后结束回合
      response('已确认小太监未能执行高危命令。'),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const emitted: Array<Record<string, unknown>> = []

    await loop.runUserTurn('帮我检查一下 marker.txt 这个文件的状态。', {
      turnId: 'turn_1',
      emit: async (event) => {
        emitted.push(event)
      },
    })

    // 高危命令必须没有真的执行 —— 文件权限位应保持未变。
    const mode = statSync(marker).mode & 0o777
    expect(mode).not.toBe(0)
    // 审批流程应该真实触发（而不是被子代理静默绕过）。
    expect(loop.controlManager.payload().pending).toBeTruthy()
    expect(emitted.map((event) => event.event)).toEqual(
      expect.arrayContaining(['task_started', 'task_error']),
    )
    const taskEnvelopes = readFileSync(loop.runtimeStore.eventsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => String(event.type ?? '').startsWith('task_'))
    expect(taskEnvelopes).toHaveLength(2)
    expect(taskEnvelopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaVersion: 2,
          type: 'task_started',
          taskId: expect.stringMatching(/^subagent_/),
          visibility: 'user',
          idempotencyKey: expect.stringContaining(':task_started'),
        }),
        expect.objectContaining({
          schemaVersion: 2,
          type: 'task_error',
          taskId: expect.stringMatching(/^subagent_/),
          visibility: 'user',
          idempotencyKey: expect.stringContaining(':task_error'),
        }),
      ]),
    )
    const storedEvents = readFileSync(loop.runtimeStore.eventsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const toolEnvelopes = storedEvents.filter((event) =>
      String(event.type ?? '').startsWith('tool_'),
    )
    expect(toolEnvelopes.length).toBeGreaterThan(0)
    expect(
      toolEnvelopes.every(
        (event) => event.schemaVersion === 2 && Boolean(event.toolCallId),
      ),
    ).toBe(true)
    const queuedToolIds = toolEnvelopes
      .filter((event) => event.type === 'tool_run_queued')
      .map((event) => String(event.toolCallId))
    for (const toolCallId of queuedToolIds) {
      expect(
        toolEnvelopes.filter(
          (event) =>
            event.toolCallId === toolCallId &&
            [
              'tool_run_completed',
              'tool_run_failed',
              'tool_run_cancelled',
            ].includes(String(event.type)),
        ),
        toolCallId,
      ).toHaveLength(1)
    }
  })

  it('loads local permission rules into the real permission pipeline', async () => {
    const root = tmp('emperor-agent-loop-permission-rules-')
    mkdirSync(join(root, '.emperor'), { recursive: true })
    writeFileSync(
      join(root, '.emperor', 'emperor.local.json'),
      JSON.stringify({
        permissions: {
          rules: [
            {
              id: 'deny-secrets',
              action: 'deny',
              tool: 'write_file',
              pathGlob: 'secrets/**',
              reason: 'secret writes need manual handling',
            },
          ],
        },
      }),
      'utf8',
    )
    const provider = new QueueProvider([
      response(null, {
        toolCalls: [
          {
            id: 'call_1',
            name: 'write_file',
            arguments: { path: 'secrets/key.md', content: 'secret' },
          },
        ],
        finishReason: 'tool_calls',
      }),
      response('没有写入。'),
    ])
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })

    await loop.runUserTurn('写入 secret', {
      turnId: 'turn_rules',
      emit: async () => {},
    })

    const toolOutput = provider.calls[1]!.messages.filter(
      (message) => message.role === 'tool',
    )
      .map((message) => String(message.content ?? ''))
      .join('\n')
    expect(toolOutput).toContain('permission denied')
    expect(toolOutput).toContain('secret writes need manual handling')
    expect(existsSync(join(root, 'secrets', 'key.md'))).toBe(false)
  })

  it('stops a cancelled turn from continuing after the model returns late', async () => {
    const root = tmp('emperor-agent-loop-cancel-turn-')
    const provider = new CancellableProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const emitted: Array<Record<string, unknown>> = []

    const running = loop.runUserTurn('读取 hello.txt 后继续总结', {
      turnId: 'turn_cancel',
      emit: async (event) => {
        emitted.push(event)
      },
    })
    await provider.secondCallStarted

    const cancelled = loop.activeTasks.cancel({ kind: 'turn' })
    expect(cancelled).toHaveLength(1)
    await expect(running).rejects.toBeInstanceOf(CancelledTaskError)

    provider.finishSecond(response('这条迟到回复不应该进入会话。'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(emitted.some((event) => event.event === 'assistant_done')).toBe(
      false,
    )
    expect(
      loop.history.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === '这条迟到回复不应该进入会话。',
      ),
    ).toBe(false)
  })

  it('treats an aborting provider as cancellation after an active-task race', async () => {
    const root = tmp('emperor-agent-loop-provider-abort-')
    const provider = new AbortRejectingProvider()
    const loop = await AgentLoop.create({
      root,
      stateRoot: join(root, '.emperor'),
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(provider),
    })
    const emitted: Array<Record<string, unknown>> = []
    const hookRun = vi.spyOn(loop.hookService, 'run')

    const running = loop.runUserTurn('读取 hello.txt 后继续总结', {
      turnId: 'turn_provider_abort',
      emit: async (event) => {
        emitted.push(event)
      },
    })
    await provider.secondCallStarted

    loop.activeTasks.cancel({ kind: 'turn' })
    await expect(running).rejects.toBeInstanceOf(CancelledTaskError)
    await provider.secondCallAborted
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(emitted.some((event) => event.event === 'error')).toBe(false)
    expect(
      hookRun.mock.calls.some(([eventName]) => eventName === 'StopFailure'),
    ).toBe(false)
  })

  it('resolves skills with project > user-global > builtin precedence, and drops project skills outside build sessions', async () => {
    const root = tmp('emperor-agent-loop-skills-root-')
    const stateRoot = join(root, '.emperor')
    const projectRoot = tmp('emperor-agent-loop-skills-project-')
    const builtinGreet = skillDocument(
      'greet',
      'Greet from built-in.',
      'builtin greet',
    )
    const userGreet = skillDocument(
      'greet',
      'Greet from user state.',
      'user greet',
    )
    const userOnly = skillDocument(
      'user-only',
      'Available only from user state.',
      'user-only skill',
    )
    const projectGreet = skillDocument(
      'greet',
      'Greet from the active project.',
      'project greet',
    )
    mkdirSync(join(root, 'skills', 'greet'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'greet', 'SKILL.md'),
      builtinGreet,
      'utf8',
    )
    mkdirSync(join(stateRoot, 'skills', 'greet'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'greet', 'SKILL.md'),
      userGreet,
      'utf8',
    )
    mkdirSync(join(stateRoot, 'skills', 'user-only'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'user-only', 'SKILL.md'),
      userOnly,
      'utf8',
    )

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(await loop.registry.execute('load_skill', { name: 'greet' })).toBe(
      userGreet,
    )
    expect(
      await loop.registry.execute('load_skill', { name: 'user-only' }),
    ).toBe(userOnly)

    const project = loop.projectStore.resolve(projectRoot)
    mkdirSync(join(projectRoot, '.emperor', 'skills', 'greet'), {
      recursive: true,
    })
    writeFileSync(
      join(projectRoot, '.emperor', 'skills', 'greet', 'SKILL.md'),
      projectGreet,
      'utf8',
    )
    const buildSession = loop.sessionStore.create('Build project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(buildSession.id)

    expect(await loop.registry.execute('load_skill', { name: 'greet' })).toBe(
      projectGreet,
    )
    expect(
      loop
        .effectiveSkillConfigResolutions()
        .find((resolution) => resolution.key.id === 'skills.greet'),
    ).toMatchObject({
      source: { kind: 'project', trust: 'trusted' },
      value: { name: 'greet', source: 'project', readOnly: true },
    })
    expect(
      await loop.registry.execute('load_skill', { name: 'user-only' }),
    ).toBe(userOnly)

    loop.activateSession(
      loop.sessionStore
        .list({ includeArchived: false })
        .find((s) => s.id !== buildSession.id)!.id,
    )

    expect(await loop.registry.execute('load_skill', { name: 'greet' })).toBe(
      userGreet,
    )
    expect(
      loop
        .effectiveSkillConfigResolutions()
        .find((resolution) => resolution.key.id === 'skills.greet'),
    ).toMatchObject({
      source: { kind: 'user', trust: 'trusted' },
      value: { name: 'greet', source: 'user', readOnly: false },
    })
  })

  it('expands {{skill_dir}} to the selected canonical directory without rewriting SKILL.md', async () => {
    const root = tmp('emperor-agent-loop-skill-placeholder-root-')
    const stateRoot = join(root, '.emperor')
    const skillDir = join(stateRoot, 'skills', 'path-aware')
    const skillFile = join(skillDir, 'SKILL.md')
    const source = skillDocument(
      'path-aware',
      'Resolve bundled file paths.',
      'Run {{skill_dir}}/scripts/check.mjs',
    )
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, source, 'utf8')

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(
      await loop.registry.execute('load_skill', { name: 'path-aware' }),
    ).toBe(source.replaceAll('{{skill_dir}}', realpathSync(skillDir)))
    expect(readFileSync(skillFile, 'utf8')).toBe(source)
  })

  it('exposes Core-native create, validate, and package actions through manage_skill', async () => {
    const root = tmp('emperor-agent-loop-manage-skill-root-')
    const stateRoot = join(root, '.emperor')
    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const refreshRuntimeContext = vi.spyOn(loop, 'refreshRuntimeContext')

    const created = JSON.parse(
      await loop.registry.execute('manage_skill', {
        action: 'create',
        name: 'release-audit',
        description: 'Audit release artifacts and integrity evidence.',
        resources: ['references'],
      }),
    ) as Record<string, unknown>
    expect(created).toMatchObject({ name: 'release-audit', valid: true })
    expect(refreshRuntimeContext).toHaveBeenCalledOnce()

    const validated = JSON.parse(
      await loop.registry.execute('manage_skill', {
        action: 'validate',
        name: 'release-audit',
      }),
    ) as Record<string, unknown>
    expect(validated).toMatchObject({ name: 'release-audit', valid: true })

    const packaged = JSON.parse(
      await loop.registry.execute('manage_skill', {
        action: 'package',
        name: 'release-audit',
      }),
    ) as Record<string, unknown>
    expect(packaged).toMatchObject({
      name: 'release-audit',
      path: join(
        realpathSync(stateRoot),
        'skill-packages',
        'release-audit.skill',
      ),
    })
  })

  it('does not load a Skill through a symbolic-link root', async () => {
    const root = tmp('emperor-agent-loop-skill-link-root-')
    const stateRoot = join(root, '.emperor')
    const outside = tmp('emperor-agent-loop-skill-link-outside-')
    mkdirSync(join(stateRoot, 'skills'), { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), 'outside skill\n')
    symlinkDirectory(outside, join(stateRoot, 'skills', 'linked'))

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(await loop.registry.execute('load_skill', { name: 'linked' })).toBe(
      '[ERR] skill "linked" not found',
    )
  })

  it('does not expose a dependency-blocked user Skill to model context or load_skill', async () => {
    const root = tmp('emperor-agent-loop-blocked-skill-root-')
    const stateRoot = join(root, '.state')
    const blocked = join(stateRoot, 'skills', 'blocked-skill')
    mkdirSync(blocked, { recursive: true })
    writeFileSync(
      join(blocked, 'SKILL.md'),
      '---\nname: blocked-skill\ndescription: Blocked dependency.\n---\n\nBLOCKED_CONTENT\n',
    )
    writeFileSync(
      join(blocked, '.emperor-skill-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'blocked',
        source: 'skill_install',
      }),
    )

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(
      await loop.registry.execute('load_skill', { name: 'blocked-skill' }),
    ).toBe('[ERR] skill "blocked-skill" not found')
    expect(loop.skillsLoader.summary()).not.toContain('BLOCKED_CONTENT')
  })

  it('does not load project Skills through a symlinked .emperor ancestor', async () => {
    const root = tmp('emperor-agent-loop-project-skill-link-root-')
    const stateRoot = join(root, '.state')
    const projectRoot = tmp('emperor-agent-loop-project-skill-project-')
    const outside = tmp('emperor-agent-loop-project-skill-outside-')
    const outsideSkill = join(outside, 'skills', 'escaped')
    mkdirSync(outsideSkill, { recursive: true })
    writeFileSync(join(outsideSkill, 'SKILL.md'), 'escaped project skill\n')
    symlinkDirectory(outside, join(projectRoot, '.emperor'))

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })
    const project = loop.projectStore.resolve(projectRoot)
    const session = loop.sessionStore.create('Linked project', {
      mode: 'build',
      project: project as unknown as Record<string, unknown>,
    })
    loop.activateSession(session.id)

    expect(await loop.registry.execute('load_skill', { name: 'escaped' })).toBe(
      '[ERR] skill "escaped" not found',
    )
  })

  it('skips invalid directory Skills and falls back to the next valid source', async () => {
    const root = tmp('emperor-agent-loop-invalid-skill-root-')
    const stateRoot = join(root, '.state')
    const builtin = join(root, 'skills', 'reviewer')
    const user = join(stateRoot, 'skills', 'reviewer')
    mkdirSync(builtin, { recursive: true })
    mkdirSync(user, { recursive: true })
    writeFileSync(
      join(builtin, 'SKILL.md'),
      '---\nname: reviewer\ndescription: Review code safely.\n---\n\nVALID_BUILTIN\n',
    )
    writeFileSync(
      join(user, 'SKILL.md'),
      '---\nname: reviewer\n---\n\nINVALID_USER\n',
    )

    const loop = await AgentLoop.create({
      root,
      stateRoot,
      templatesDir: TEMPLATES_DIR,
      modelRouter: fakeRouter(new FakeProvider()),
    })

    expect(
      await loop.registry.execute('load_skill', { name: 'reviewer' }),
    ).toBe(
      '---\nname: reviewer\ndescription: Review code safely.\n---\n\nVALID_BUILTIN\n',
    )
    expect(loop.skillsLoader.summary()).not.toContain('INVALID_USER')
  })
})

class QueueProvider extends LLMProvider {
  private readonly queue: LLMResponse[]
  calls: ChatArgs[] = []
  constructor(queue: LLMResponse[]) {
    super({ defaultModel: 'fake-main' })
    this.queue = queue
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    return this.queue.length ? this.queue.shift()! : response('done')
  }
}

class CancellableProvider extends LLMProvider {
  calls: ChatArgs[] = []
  private secondStartedResolve: () => void = () => {}
  private secondResolve: (response: LLMResponse) => void = () => {}
  readonly secondCallStarted = new Promise<void>((resolve) => {
    this.secondStartedResolve = resolve
  })

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length === 1) {
      return response(null, {
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: { path: 'hello.txt' } },
        ],
        finishReason: 'tool_calls',
      })
    }
    this.secondStartedResolve()
    return new Promise<LLMResponse>((resolve) => {
      this.secondResolve = resolve
    })
  }

  finishSecond(response: LLMResponse): void {
    this.secondResolve(response)
  }
}

class AbortRejectingProvider extends LLMProvider {
  calls: ChatArgs[] = []
  private secondStartedResolve: () => void = () => {}
  private secondAbortedResolve: () => void = () => {}
  readonly secondCallStarted = new Promise<void>((resolve) => {
    this.secondStartedResolve = resolve
  })
  readonly secondCallAborted = new Promise<void>((resolve) => {
    this.secondAbortedResolve = resolve
  })

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    if (this.calls.length === 1) {
      return response(null, {
        toolCalls: [
          { id: 'call_1', name: 'read_file', arguments: { path: 'hello.txt' } },
        ],
        finishReason: 'tool_calls',
      })
    }
    this.secondStartedResolve()
    return await new Promise<LLMResponse>((_resolve, reject) => {
      args.signal?.addEventListener(
        'abort',
        () => {
          this.secondAbortedResolve()
          reject(new DOMException('The operation was aborted', 'AbortError'))
        },
        { once: true },
      )
    })
  }
}

class DelayedProvider extends LLMProvider {
  private startedResolve: () => void = () => {}
  private responseResolve: (response: LLMResponse) => void = () => {}
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })

  constructor() {
    super({ defaultModel: 'fake-main' })
  }

  async chat(): Promise<LLMResponse> {
    this.startedResolve()
    return new Promise<LLMResponse>((resolve) => {
      this.responseResolve = resolve
    })
  }

  finish(response: LLMResponse): void {
    this.responseResolve(response)
  }
}

function fakeRouter(
  provider: LLMProvider,
  toolCall = true,
): {
  route: (
    useCase: string,
    agentType?: string | null,
    task?: string | null,
  ) => ModelRoute
  payload: () => Record<string, unknown>
} {
  return {
    route: (
      useCase: string,
      _agentType?: string | null,
      _task?: string | null,
    ) => ({
      snapshot: snapshot(provider, toolCall),
      useCase,
      reason: `${useCase}:fake`,
      estimatedTokens: null,
    }),
    payload: () => ({
      activeModel: 'fake-active',
    }),
  }
}

function snapshot(provider: LLMProvider, toolCall = true): ProviderSnapshot {
  return {
    provider,
    providerName: 'fake',
    providerLabel: 'Fake',
    model: 'fake-active',
    apiBase: null,
    generation: { maxTokens: 2000, temperature: 0.1, reasoningEffort: null },
    profile: {
      toolCall,
      vision: true,
      reasoning: false,
      sources: {
        toolCall: 'override',
        vision: 'override',
        reasoning: 'default',
      },
      contextWindowTokens: 100_000,
      maxTokens: 2_000,
      reasoningEfforts: [],
      reasoningAdapter: 'none',
    },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: true,
    modelEntryId: 'active-entry',
    entryName: 'active-entry',
    entryLabel: 'Fake',
    routeReason: 'active_model',
  }
}

function response(
  content: string | null,
  opts: Partial<LLMResponse> = {},
): LLMResponse {
  return {
    content,
    toolCalls: opts.toolCalls ?? [],
    finishReason: opts.finishReason ?? 'stop',
    usage: opts.usage ?? { input: 1, output: 1 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
}
