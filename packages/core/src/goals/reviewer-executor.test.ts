import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ModelRouter, ProviderSnapshot } from '../model/router'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { makePlanRecord, PlanStatus, PlanStepStatus } from '../plans/models'
import { PlanStore } from '../plans/store'
import { buildDispatchRunnerFactory } from '../subagents/dispatch-runner'
import { SubagentRegistry } from '../subagents/registry'
import { TaskManager } from '../tasks/manager'
import { TaskStatus } from '../tasks/models'
import { Tool, ToolResultObj } from '../tools/base'
import { toolParamsSchema, S } from '../tools/schema'
import { ToolRegistry } from '../tools/registry'
import { RunnerGoalRecordingService } from '../agent/runner-goal-recording'
import { GoalEvidenceLedger, GoalObservationRecorder } from './evidence'
import { GoalReviewerExecutor } from './reviewer-executor'
import { GoalReviewerLedger } from './reviewer'
import { GoalStore } from './store'
import {
  GoalContractValidator,
  assertGoalTransition,
  newGoalRecord,
} from './validation'

const TEMPLATES = join(__dirname, '..', '..', '..', '..', 'templates')
const T0 = '2026-07-16T01:00:00.000Z'
const T1 = '2026-07-16T01:01:00.000Z'
const T2 = '2026-07-16T01:02:00.000Z'
const T3 = '2026-07-16T01:03:00.000Z'

describe('GoalReviewerExecutor', () => {
  it('runs the real routed AgentRunner and creates task-owned evidence, transcript, terminal Task, and receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-reviewer-executor-'))
    const goalStore = new GoalStore(root)
    const created = await goalStore.create(
      newGoalRecord({
        id: 'goal_reviewer_executor',
        outcome: 'Verify the completed implementation independently.',
        scope: {
          sessionId: 'session_reviewer_executor',
          mode: 'build',
          projectId: 'project_reviewer',
          workspaceRoot: root,
        },
        now: T0,
      }),
    )
    const locked = await goalStore.append(created.id, {
      type: 'goal_updated',
      expectedLastEventSeq: created.lastEventSeq,
      record: GoalContractValidator.lock(
        created,
        {
          inScope: ['reviewer execution'],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'User confirms expected behavior.',
              required: false,
              verification: {
                kind: 'manual',
                requirement: 'User confirmation',
              },
            },
            {
              id: 'AC-2',
              description: 'Independent reviewer validates the implementation.',
              required: true,
              verification: {
                kind: 'reviewer',
                requirement: 'Independent review',
              },
            },
          ],
          escalationConditions: [],
        },
        T1,
      ),
    })
    const planStore = new PlanStore(root)
    const plan = planStore.save(
      makePlanRecord({
        id: 'plan_reviewer_executor',
        title: 'Verify Core changes',
        summary: 'Run the required Core checks.',
        status: PlanStatus.COMPLETED,
        createdAt: 1,
        updatedAt: 3,
        approvedAt: 2,
        completedAt: 3,
        sessionId: locked.scope.sessionId,
        goalId: locked.id,
        sourceInteractionId: 'plan_interaction_reviewer',
        steps: [reviewerStep()],
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
    await goalStore.append(executing.id, {
      type: 'goal_updated',
      expectedLastEventSeq: executing.lastEventSeq,
      record: assertGoalTransition(executing, {
        ...executing,
        runtime: { ...executing.runtime, phase: 'verifying' },
        updatedAt: T3,
      }),
    })

    const taskManager = new TaskManager(root)
    const observations = new GoalObservationRecorder(goalStore)
    const ledgerRef: { current: GoalReviewerLedger | null } = { current: null }
    const evidence = new GoalEvidenceLedger(goalStore, {
      factResolvers: {
        resolveIndependentReviewer: (goalId, source) => {
          const current = ledgerRef.current
          if (!current) throw new Error('reviewer ledger is not initialized')
          return (
            current as unknown as {
              resolveIndependentReviewerFact(
                goalId: string,
                source: unknown,
              ): Promise<unknown>
            }
          ).resolveIndependentReviewerFact(goalId, source) as never
        },
      },
    })
    const baseRecording = new RunnerGoalRecordingService(observations, evidence)
    const ledger = new GoalReviewerLedger({
      goalStore,
      planStore,
      taskManager,
      evidenceLedger: evidence,
      resolveRiskFact: (context) => ({
        ...context,
        kind: 'core_goal_reviewer_risk',
        issuedBy: 'core',
        version: 'risk:executor:1',
        readonlyProven: true,
        changedFiles: [],
        capabilitySignals: [],
      }),
    })
    ledgerRef.current = ledger
    const registry = new ToolRegistry(root)
    registry.register(new PassingCommandTool())
    const modelRouter = fakeReviewerRouter()
    const executor = new GoalReviewerExecutor({
      ledger,
      goalStore,
      taskManager,
      evidenceLedger: evidence,
      baseGoalRecording: baseRecording,
      parentRegistry: registry,
      subagentRegistry: new SubagentRegistry(TEMPLATES),
      runnerFactory: buildDispatchRunnerFactory({ modelRouter }),
    })

    const result = await executor.execute({
      goalId: locked.id,
      planId: plan.id,
      planEventSeq: plan.eventSeq,
      workspaceRoot: root,
      sessionId: locked.scope.sessionId,
    })

    const task = taskManager.store.inspect(result.dispatch.task.id).record!
    expect(task).toMatchObject({
      status: TaskStatus.COMPLETED,
      turn_id: result.dispatch.receipt.turnId,
      metadata: {
        agent_id: result.dispatch.receipt.agentId,
        turn_id: result.dispatch.receipt.turnId,
      },
    })
    expect(result.dispatch.receipt.agentId).toMatch(/^reviewer_agent_/)
    const recorded = await evidence.listEvidence(locked.id)
    expect(recorded).toEqual([
      expect.objectContaining({
        criterionId: 'AC-2',
        recorder: 'reviewer',
        independent: true,
        verdict: 'pass',
        sourceObservationIds: [],
        sourceReceiptIds: [expect.any(String)],
      }),
    ])
    const observation = (
      await goalStore.readObservations<{
        id: string
        taskId: string
        agentId: string
        turnId: string
      }>(locked.id)
    ).records.at(-1)!
    expect(observation).toMatchObject({
      taskId: task.id,
      agentId: result.dispatch.receipt.agentId,
      turnId: result.dispatch.receipt.turnId,
    })
    expect(result.receipt.commandEvidenceIds).toEqual([])
    expect(result.receipt).toMatchObject({
      agentId: result.dispatch.receipt.agentId,
      commandObservationIds: [observation.id],
    })
    expect(result.receipt.verdict).toBe('pass')
    await expect(evidence.listReceipts(locked.id)).resolves.toEqual([
      expect.objectContaining({
        kind: 'independent_reviewer',
        verdict: 'pass',
        source: expect.objectContaining({
          reviewerReceiptId: result.receipt.id,
          taskId: task.id,
          agentId: result.dispatch.receipt.agentId,
          criterionId: 'AC-2',
        }),
      }),
    ])
    expect(
      taskManager
        .readSidechain(task.id)
        .messages.map((message) => message.role),
    ).toEqual(['user', 'assistant'])
  })

  it.each(['missing_spec', 'sidechain_read'] as const)(
    'terminalizes a dispatched reviewer Task when %s fails before runner execution',
    async (failure) => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-reviewer-early-fail-'))
      const taskManager = new TaskManager(root)
      const task = reviewerTask(taskManager)
      if (failure === 'sidechain_read')
        taskManager.readSidechain = () => {
          throw new Error('sidechain unavailable')
        }
      const executor = new GoalReviewerExecutor({
        ledger: {
          async dispatchGoalReviewer() {
            return {
              task,
              receipt: {
                agentId: 'reviewer_agent_early_failure',
                turnId: 'reviewer_turn_early_failure',
              },
            }
          },
        } as never,
        goalStore: {} as never,
        taskManager,
        evidenceLedger: {} as never,
        baseGoalRecording: {} as never,
        parentRegistry: new ToolRegistry(root),
        subagentRegistry: {
          get: () =>
            failure === 'missing_spec'
              ? null
              : { toolNames: [], instructions: '', description: '' },
        } as never,
        runnerFactory: () => {
          throw new Error('runner must not be constructed')
        },
      })

      await expect(
        executor.execute({
          goalId: 'goal_early_failure',
          planId: 'plan_early_failure',
          planEventSeq: 1,
          workspaceRoot: root,
          sessionId: 'session_early_failure',
        }),
      ).rejects.toThrow()

      expect(taskManager.store.inspect(task.id).record?.status).toBe(
        TaskStatus.FAILED,
      )
    },
  )

  it('does not leave a completed reviewer Task when receipt persistence fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-reviewer-receipt-fail-'))
    const taskManager = new TaskManager(root)
    const task = reviewerTask(taskManager)
    taskManager.completeGoalReviewerTask(task.id, { summary: 'checked' })
    const executor = new GoalReviewerExecutor({
      ledger: {} as never,
      goalStore: {} as never,
      taskManager,
      evidenceLedger: {} as never,
      baseGoalRecording: {} as never,
      parentRegistry: new ToolRegistry(root),
      subagentRegistry: {} as never,
      runnerFactory: () => {
        throw new Error('runner must not be constructed')
      },
    })

    ;(
      executor as unknown as {
        terminalizeFailedDispatch(taskId: string, error: string): void
      }
    ).terminalizeFailedDispatch(task.id, 'receipt append failed')

    expect(taskManager.store.inspect(task.id).record).toMatchObject({
      status: TaskStatus.FAILED,
      progress: { receipt_persisted: false },
    })
  })

  it('removes an archived completed reviewer Task when receipt persistence fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-reviewer-archived-fail-'))
    const taskManager = new TaskManager(root)
    const task = reviewerTask(taskManager)
    taskManager.completeGoalReviewerTask(task.id, { summary: 'checked' })
    const index = JSON.parse(readFileSync(taskManager.store.indexFile, 'utf8'))
    const payload = index[task.id]
    delete index[task.id]
    writeFileSync(taskManager.store.indexFile, JSON.stringify(index), 'utf8')
    mkdirSync(taskManager.store.archiveDir, { recursive: true })
    writeFileSync(
      join(taskManager.store.archiveDir, '2026-07.json'),
      JSON.stringify({ [task.id]: payload }),
      'utf8',
    )
    const executor = failedReceiptExecutor(root, taskManager)

    terminalizeFailedDispatch(executor, task.id)

    expect(
      taskManager.store.inspectIncludingArchive(task.id).record,
    ).toMatchObject({
      status: TaskStatus.FAILED,
      progress: { receipt_persisted: false },
    })
  })
})

function failedReceiptExecutor(root: string, taskManager: TaskManager) {
  return new GoalReviewerExecutor({
    ledger: {} as never,
    goalStore: {} as never,
    taskManager,
    evidenceLedger: {} as never,
    baseGoalRecording: {} as never,
    parentRegistry: new ToolRegistry(root),
    subagentRegistry: {} as never,
    runnerFactory: () => {
      throw new Error('runner must not be constructed')
    },
  })
}

function terminalizeFailedDispatch(
  executor: GoalReviewerExecutor,
  taskId: string,
): void {
  ;(
    executor as unknown as {
      terminalizeFailedDispatch(taskId: string, error: string): void
    }
  ).terminalizeFailedDispatch(taskId, 'receipt append failed')
}

function reviewerTask(taskManager: TaskManager) {
  return taskManager.startGoalReviewerTask({
    kind: 'subagent',
    title: 'Early failure reviewer',
    sessionId: 'session_early_failure',
    turnId: 'reviewer_turn_early_failure',
    metadata: {
      schema_version: 'emperor.goal.reviewer-dispatch.v1',
      issued_by: 'core',
      agent_type: 'verification_reviewer',
      agent_id: 'reviewer_agent_early_failure',
      turn_id: 'reviewer_turn_early_failure',
      goal_id: 'goal_early_failure',
      plan_id: 'plan_early_failure',
      plan_event_seq: 1,
      approval_generation: 1,
    },
  })
}

class PassingCommandTool extends Tool {
  override readonly name = 'run_command'
  override readonly description = 'Run a verification command.'
  override readonly parameters = toolParamsSchema({ command: S('command') })
  override readonly evidencePolicy = 'eligible' as const

  override isReadOnly(args: Record<string, unknown>): boolean {
    return String(args.command ?? '') === 'npm test'
  }

  execute(): ToolResultObj {
    return new ToolResultObj({
      modelContent: 'tests passed',
      displaySummary: 'tests passed',
      metadata: { exitCode: 0 },
    })
  }
}

class ReviewerProvider extends LLMProvider {
  private calls = 0

  constructor() {
    super({ defaultModel: 'reviewer-test' })
  }

  async chat(_args: ChatArgs): Promise<LLMResponse> {
    this.calls += 1
    if (this.calls === 1)
      return {
        content: null,
        reasoningContent: null,
        thinkingBlocks: [],
        toolCalls: [
          {
            id: 'review_call_1',
            name: 'run_command',
            arguments: { command: 'npm test' },
          },
        ],
        finishReason: 'tool_calls',
        usage: { input: 10, output: 5 },
      }
    return {
      content: [
        'Independent checks passed.',
        '```verdict',
        JSON.stringify({
          passed: true,
          summary: 'All required checks passed.',
          commands: ['npm test'],
          command_evidence: [],
        }),
        '```',
      ].join('\n'),
      reasoningContent: null,
      thinkingBlocks: [],
      toolCalls: [],
      finishReason: 'stop',
      usage: { input: 10, output: 5 },
    }
  }
}

function fakeReviewerRouter(): ModelRouter {
  const snapshot: ProviderSnapshot = {
    provider: new ReviewerProvider(),
    providerName: 'fake',
    providerLabel: 'Fake',
    model: 'reviewer-test',
    apiBase: null,
    generation: { maxTokens: 2_000, temperature: 0, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: false,
    entryName: 'reviewer-test',
    entryLabel: 'Reviewer test',
    routeReason: 'subagent',
  }
  return {
    route: () => ({
      snapshot,
      useCase: 'subagent',
      reason: 'reviewer test',
      estimatedTokens: null,
    }),
  } as unknown as ModelRouter
}

function reviewerStep() {
  return {
    id: 'step_1',
    title: 'Run tests',
    status: PlanStepStatus.DONE,
    dependsOn: [],
    description: '',
    files: ['packages/core/src/goals/reviewer-executor.ts'],
    commands: ['npm test'],
    acceptance: ['tests pass'],
    discoveryRefs: [],
    verification: [],
    evidence: [],
    risk: 'low',
    riskNote: '',
    rollback: '',
  }
}
