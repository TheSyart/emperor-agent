import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HookAggregateDecision, HookEventName } from '../hooks'
import { SubmitHookResultTool } from '../hooks/model-executor'
import { MCPToolAdapter } from '../mcp/adapter'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import {
  AskUserTool,
  ProposePlanTool,
  RequestPlanModeTool,
} from '../control/tools'
import { makeAsk, questionFromDict } from '../control/models'
import { ControlManager } from '../control/manager'
import { PlanStatus } from '../plans/models'
import { SchedulerTool } from '../scheduler/tool'
import { TeamTool } from '../team/tools'
import {
  LoadSkill,
  RunCommand,
  SaveUserProfileTool,
  TodoStore,
  UpdateTodos,
} from '../tools/builtin'
import { DispatchSubagentTool } from '../tools/dispatch'
import { EditFileTool, ReadFileTool, WriteFileTool } from '../tools/filesystem'
import { ManageSkillTool } from '../tools/manage-skill'
import { GlobTool, GrepTool } from '../tools/search'
import { WebFetch } from '../tools/web-fetch'
import { WebSearchTool } from '../tools/web-search'
import { Tool, ToolResultObj } from '../tools/base'
import { ToolRegistry } from '../tools/registry'
import { S, toolParamsSchema } from '../tools/schema'
import type {
  OwnedProcessRequest,
  OwnedProcessResult,
  OwnedProcessRunner,
} from '../environment/process-runner'
import {
  GoalEvidenceLedger,
  GoalObservationRecorder,
  computeGoalObservationOutputSha256,
  computeGoalToolInputSha256,
  type GoalObservation,
} from '../goals/evidence'
import { GoalStore } from '../goals/store'
import { GoalContractValidator, newGoalRecord } from '../goals/validation'
import {
  RunnerGoalRecordingService,
  recordRunnerPlanVerificationReceipt,
  recordRunnerGoalToolResult,
  type RunnerGoalRecordingHost,
} from './runner-goal-recording'
import {
  AgentRunner,
  type AgentRunnerHookHost,
  type ControlManagerRunnerHost,
} from './runner'

type Msg = Record<string, unknown>
const T0 = '2026-07-15T10:00:00.000Z'
const T1 = '2026-07-15T10:01:00.000Z'
const T2 = '2026-07-15T10:02:00.000Z'

function ownedProcessRunnerWith(
  result: Omit<OwnedProcessResult, 'containment'>,
): OwnedProcessRunner {
  return {
    capability: () => ({
      platform: 'darwin',
      backend: 'macos-seatbelt',
      status: 'available',
      filesystem: 'workspace-write',
      network: 'policy-controlled',
      processTree: true,
      reason: 'test fixture',
    }),
    async run(request: OwnedProcessRequest) {
      const containment = {
        decision: 'sandboxed' as const,
        backend: 'macos-seatbelt' as const,
        capabilityStatus: 'available' as const,
        filesystem: 'workspace-write' as const,
        network: 'denied' as const,
        processTree: true,
        policyHash: 'a'.repeat(64),
        reason: 'test fixture',
      }
      await request.onContainment?.(containment)
      return { ...result, containment }
    },
  }
}

describe('AgentRunner Goal final-result recording', () => {
  let stateRoot: string
  let store: GoalStore
  let recorder: GoalObservationRecorder

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'emperor-runner-goal-'))
    store = new GoalStore(stateRoot, { now: () => T2 })
    recorder = new GoalObservationRecorder(store, {
      now: () => T2,
      idFactory: () => 'obs_runner',
    })
  })

  it('records only after execution, PostToolUse transformations, and tool_result emission', async () => {
    await activeGoal('goal_order', 'session-order')
    const order: string[] = []
    const tool = new ProbeTool('mcp_probe', () => order.push('execute'))
    tool.evidencePolicy = 'eligible'
    const captured: Array<
      Parameters<RunnerGoalRecordingHost['recordToolResult']>[0]
    > = []
    const recordingHost: RunnerGoalRecordingHost = {
      async recordToolResult(input) {
        order.push('record')
        captured.push(input)
        return null
      },
    }
    const hooks: AgentRunnerHookHost = {
      run(event) {
        if (event === 'PostToolUse') {
          order.push('post-hook')
          return decision({
            updatedToolOutput: 'hook-replaced-output',
            additionalContext: 'final hook context',
          })
        }
        return decision()
      },
    }
    const emitted: Msg[] = []
    const runner = runnerFor(tool, {
      sessionId: 'session-order',
      hooks,
      goalObservationRecorder: recordingHost,
    })

    await runner.stepAsync([{ role: 'user', content: 'run probe' }], {
      turnId: 'turn-order',
      emit: (event) => {
        emitted.push(event)
        if (event.event === 'tool_result') order.push('tool-result-event')
      },
    })

    expect(order).toEqual([
      'execute',
      'post-hook',
      'tool-result-event',
      'record',
    ])
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      sessionId: 'session-order',
      turnId: 'turn-order',
      toolCallId: 'call-1',
      toolName: 'mcp_probe',
      evidencePolicy: 'eligible',
      executed: true,
    })
    expect(captured[0]!.result.modelContent).toBe(
      'hook-replaced-output\n\n[Hook additional context]\nfinal hook context',
    )
    const toolResultEvent = emitted.find(
      (event) => event.event === 'tool_result',
    )
    expect(toolResultEvent?.output).toBe(captured[0]!.result.modelContent)
  })

  it('does not treat model completion text or a passing Stop hook as Goal terminal authority', async () => {
    const goal = await activeGoal(
      'goal_runner_final_is_turn_only',
      'session-final-only',
    )
    const runner = runnerFor(new ProbeTool('read_probe'), {
      sessionId: goal.scope.sessionId,
      hooks: {
        run() {
          return decision()
        },
      },
    })

    await expect(
      runner.stepAsync([{ role: 'user', content: 'finish the Goal' }], {
        turnId: 'turn-final-only',
      }),
    ).resolves.toBe('done')

    expect(await store.get(goal.id)).toMatchObject({
      status: 'active',
      terminalAt: null,
    })
    expect(
      (await store.readEvents(goal.id)).some(
        (event) => event.type === 'goal_completed',
      ),
    ).toBe(false)
  })

  it('records the Core-prepared input after PreToolUse transforms', async () => {
    await activeGoal('goal_effective_input', 'session-effective-input')
    const tool = new ProbeTool('run_command')
    tool.evidencePolicy = 'eligible'
    const captured: Array<
      Parameters<RunnerGoalRecordingHost['recordToolResult']>[0]
    > = []
    const runner = runnerFor(tool, {
      sessionId: 'session-effective-input',
      toolArguments: { command: 'echo forged' },
      goalObservationRecorder: {
        async recordToolResult(input) {
          captured.push(input)
          return null
        },
      },
      hooks: {
        run(event) {
          return event === 'PreToolUse'
            ? decision({ updatedInput: { command: 'npm test' } })
            : decision()
        },
      },
    })

    await runner.stepAsync([{ role: 'user', content: 'run test' }], {
      turnId: 'turn-effective-input',
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]?.arguments).toEqual({ command: 'npm test' })
  })

  it('does not attribute an in-flight command to a Plan that appeared after execution started', async () => {
    const tool = new BlockingCommandTool()
    let currentPlanId: string | null = null
    const recordedPlanIds: string[] = []
    const manager = planSwitchingHost(
      () => currentPlanId,
      (planId) => recordedPlanIds.push(planId),
    )
    const runner = runnerFor(tool, {
      sessionId: 'session-plan-appeared',
      toolArguments: { command: 'npm test' },
      controlManager: manager,
    })

    const pending = runner.stepAsync([{ role: 'user', content: 'run test' }], {
      turnId: 'turn-plan-appeared',
    })
    await tool.started.promise
    currentPlanId = 'plan-b'
    tool.release.resolve()
    await pending

    expect(recordedPlanIds).toEqual([])
  })

  it('keeps the Plan target captured when execution started if the current Plan changes in flight', async () => {
    const tool = new BlockingCommandTool()
    let currentPlanId: string | null = 'plan-a'
    const recordedPlanIds: string[] = []
    const manager = planSwitchingHost(
      () => currentPlanId,
      (planId) => recordedPlanIds.push(planId),
    )
    const runner = runnerFor(tool, {
      sessionId: 'session-plan-switched',
      toolArguments: { command: 'npm test' },
      controlManager: manager,
    })

    const pending = runner.stepAsync([{ role: 'user', content: 'run test' }], {
      turnId: 'turn-plan-switched',
    })
    await tool.started.promise
    currentPlanId = 'plan-b'
    tool.release.resolve()
    await pending

    expect(recordedPlanIds).toEqual(['plan-a'])
  })

  it('does not resurrect a superseded Plan or consume its remaining permission token when an in-flight command finishes', async () => {
    const tool = new BlockingCommandTool()
    const manager = new ControlManager(stateRoot)
    manager.setRuntimeScope({
      sessionId: 'session-plan-resurrection',
      mode: 'build',
      projectId: 'project-plan-resurrection',
      workspaceRoot: '/workspace',
      projectFingerprint: 'project-plan-resurrection-fingerprint',
    })
    manager.setTodoStore(new TodoStore())
    const planA = approveCommandPlan(manager, 'Plan A', [
      'npm test',
      'npm run lint',
    ])
    const runner = runnerFor(tool, {
      sessionId: 'session-plan-resurrection',
      toolArguments: { command: 'npm test' },
      controlManager: manager,
    })

    const pending = runner.stepAsync(
      [{ role: 'user', content: 'run Plan A test' }],
      { turnId: 'turn-plan-resurrection' },
    )
    await tool.started.promise
    const staleTokens = [
      ...((manager.planStore.get(planA)!.metadata.permission_tokens as Array<
        Record<string, unknown>
      >) ?? []),
    ]
    expect(staleTokens).toHaveLength(1)
    const planB = approveCommandPlan(manager, 'Plan B', ['npm run typecheck'])
    const superseded = manager.planStore.get(planA)!
    expect(() =>
      manager.planStore.save({
        ...superseded,
        metadata: { ...superseded.metadata, permission_tokens: staleTokens },
      }),
    ).toThrow(/revoked/i)
    const planAAfterSupersession = manager.planStore.get(planA)!
    const planAUpdatedAt = planAAfterSupersession.updatedAt
    const planAEvidenceCount = planAAfterSupersession.steps[0]!.evidence.length
    tool.release.resolve()
    await pending

    expect(manager.planStore.get(planA)).toMatchObject({
      status: PlanStatus.CANCELLED,
      updatedAt: planAUpdatedAt,
      metadata: { superseded_by: planB },
    })
    expect(manager.planStore.get(planA)!.steps[0]!.evidence).toHaveLength(
      planAEvidenceCount,
    )
    expect(manager.latestExecutablePlan()?.id).toBe(planB)
    expect(
      manager.consumePlanPermissionToken({
        toolName: 'run_command',
        arguments: { command: 'npm run lint' },
      }),
    ).toBeNull()
    expect(manager.latestExecutablePlan()?.id).toBe(planB)
  })

  it('persists the final PostToolUse result and hashes exactly what the model receives', async () => {
    const goal = await activeGoal('goal_final', 'session-final')
    const tool = new ProbeTool('mcp_final')
    tool.evidencePolicy = 'eligible'
    const runner = runnerFor(tool, {
      sessionId: goal.scope.sessionId,
      goalObservationRecorder: recorder,
      hooks: {
        run(event) {
          return event === 'PostToolUse'
            ? decision({ updatedToolOutput: 'visible final output' })
            : decision()
        },
      },
    })
    const history: Msg[] = [{ role: 'user', content: 'run probe' }]

    await runner.stepAsync(history, { turnId: 'turn-final' })

    const observation = (await store.readObservations<GoalObservation>(goal.id))
      .records[0]!
    const toolMessage = history.find((message) => message.role === 'tool')!
    expect(toolMessage.content).toBe('visible final output')
    expect(observation.outputSha256).toBe(
      computeGoalObservationOutputSha256(
        new ToolResultObj({ modelContent: String(toolMessage.content) }),
      ),
    )
    expect(observation.displaySummary).toBe('visible final output')
  })

  it('records the final PostToolUseFailure error as FAIL-capable observation', async () => {
    const goal = await activeGoal('goal_failure', 'session-failure')
    const tool = new ProbeTool('run_command', undefined, 'Error: tests failed')
    tool.evidencePolicy = 'eligible'
    const runner = runnerFor(tool, {
      sessionId: goal.scope.sessionId,
      goalObservationRecorder: recorder,
      hooks: {
        run(event) {
          return event === 'PostToolUseFailure'
            ? decision({ additionalContext: 'diagnosed by failure hook' })
            : decision()
        },
      },
    })

    await runner.stepAsync([{ role: 'user', content: 'run failing test' }], {
      turnId: 'turn-failure',
    })

    expect(
      (await store.readObservations<GoalObservation>(goal.id)).records,
    ).toEqual([
      expect.objectContaining({
        toolName: 'run_command',
        isError: true,
        displaySummary: 'Error: tests failed',
      }),
    ])
    const observation = (await store.readObservations<GoalObservation>(goal.id))
      .records[0]!
    expect(observation.outputSha256).toBe(
      computeGoalObservationOutputSha256(
        new ToolResultObj({
          modelContent:
            'Error: tests failed\n\n[Hook additional context]\ndiagnosed by failure hook',
          isError: true,
        }),
      ),
    )
  })

  it('converts a thrown executed-tool failure through PostToolUseFailure before recording it', async () => {
    const goal = await activeGoal('goal_throw', 'session-throw')
    const tool = new ThrowingProbeTool('run_command')
    tool.evidencePolicy = 'eligible'
    const hookEvents: HookEventName[] = []
    const runner = runnerFor(tool, {
      sessionId: goal.scope.sessionId,
      goalObservationRecorder: recorder,
      hooks: {
        run(event) {
          hookEvents.push(event)
          return event === 'PostToolUseFailure'
            ? decision({ additionalContext: 'throw inspected' })
            : decision()
        },
      },
    })

    await runner.stepAsync([{ role: 'user', content: 'run throwing tool' }], {
      turnId: 'turn-throw',
    })

    expect(hookEvents).toContain('PostToolUseFailure')
    expect(
      (await store.readObservations<GoalObservation>(goal.id)).records,
    ).toEqual([
      expect.objectContaining({
        isError: true,
        displaySummary: 'Error: tool exploded',
      }),
    ])
  })

  it('does not observe a core permission denial because the tool never executed', async () => {
    const goal = await activeGoal('goal_denied', 'session-denied')
    const tool = new ProbeTool('run_command')
    tool.evidencePolicy = 'eligible'
    const manager = permissionHost({
      allowed: false,
      requiresApproval: false,
      reason: 'workspace denied',
    })
    const runner = runnerFor(tool, {
      sessionId: goal.scope.sessionId,
      goalObservationRecorder: recorder,
      controlManager: manager,
    })

    await runner.stepAsync([{ role: 'user', content: 'run denied tool' }], {
      turnId: 'turn-denied',
    })

    expect(tool.executions).toBe(0)
    expect((await store.readObservations(goal.id)).records).toEqual([])
  })

  it('does not observe a PreToolUse denial because the tool never executed', async () => {
    const goal = await activeGoal('goal_hook_denied', 'session-hook-denied')
    const tool = new ProbeTool('run_command')
    tool.evidencePolicy = 'eligible'
    const runner = runnerFor(tool, {
      sessionId: goal.scope.sessionId,
      goalObservationRecorder: recorder,
      hooks: {
        run(event) {
          return event === 'PreToolUse'
            ? decision({ decision: 'deny', reason: 'blocked by policy hook' })
            : decision()
        },
      },
    })

    await runner.stepAsync([{ role: 'user', content: 'run denied tool' }], {
      turnId: 'turn-hook-denied',
    })

    expect(tool.executions).toBe(0)
    expect((await store.readObservations(goal.id)).records).toEqual([])
  })

  it('keeps the final tool result when Goal observation persistence degrades', async () => {
    await activeGoal('goal_record_degraded', 'session-record-degraded')
    const tool = new ProbeTool('run_command')
    tool.evidencePolicy = 'eligible'
    const runner = runnerFor(tool, {
      sessionId: 'session-record-degraded',
      goalObservationRecorder: {
        async recordToolResult() {
          throw new Error('token=super-secret /private/evidence/path')
        },
      },
    })
    const history: Msg[] = [{ role: 'user', content: 'run ordinary tool' }]
    const emitted: Msg[] = []

    await runner.stepAsync(history, {
      turnId: 'turn-record-degraded',
      emit: (event) => {
        emitted.push(event)
      },
    })

    expect(history.find((message) => message.role === 'tool')).toMatchObject({
      tool_call_id: 'call-1',
      name: 'run_command',
      content: 'executed output',
    })
    const resultIndex = emitted.findIndex(
      (event) => event.event === 'tool_result',
    )
    const degradedIndex = emitted.findIndex(
      (event) => event.event === 'record_degraded',
    )
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(degradedIndex).toBeGreaterThan(resultIndex)
    expect(emitted[degradedIndex]).toEqual({
      event: 'record_degraded',
      kind: 'goal_observation',
      reason:
        'Goal observation could not be persisted; completion evidence was not recorded.',
      taskId: 'turn-record-degraded',
    })
    expect(JSON.stringify(emitted[degradedIndex])).not.toContain('super-secret')
    expect(JSON.stringify(emitted[degradedIndex])).not.toContain('/private')
  })

  it('returns the original result when both recording and degraded-event emission fail', async () => {
    await activeGoal('goal_double_degraded', 'session-double-degraded')
    const tool = new ProbeTool('run_command')
    tool.evidencePolicy = 'eligible'
    const runner = runnerFor(tool, {
      sessionId: 'session-double-degraded',
      goalObservationRecorder: {
        async recordToolResult() {
          throw new Error('recorder unavailable')
        },
      },
    })
    const history: Msg[] = [{ role: 'user', content: 'run tool' }]

    await expect(
      runner.stepAsync(history, {
        turnId: 'turn-double-degraded',
        emit(event) {
          if (event.event === 'record_degraded')
            throw new Error('diagnostic sink unavailable')
        },
      }),
    ).resolves.toBeTypeOf('string')
    expect(history.find((message) => message.role === 'tool')).toMatchObject({
      content: 'executed output',
    })
  })

  it('records a forbidden control-tool observation before pausing the turn', async () => {
    const goal = await activeGoal('goal_control_pause', 'session-control-pause')
    const tool = new AskUserTool({
      createAsk(opts) {
        return makeAsk({
          questions: opts.questions.map(questionFromDict),
          context: opts.context,
          parentCallId: opts.parentCallId,
        })
      },
      createPlan() {
        throw new Error('not expected')
      },
    })
    const runner = runnerFor(tool, {
      sessionId: goal.scope.sessionId,
      toolArguments: {
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            question: 'Choose scope?',
            options: [
              { label: 'Small', description: 'Small scope' },
              { label: 'Full', description: 'Full scope' },
            ],
          },
        ],
      },
      goalObservationRecorder: new RunnerGoalRecordingService(
        recorder,
        new GoalEvidenceLedger(store),
      ),
    })

    await expect(
      runner.stepAsync([{ role: 'user', content: 'ask' }], {
        turnId: 'turn-control-pause',
      }),
    ).rejects.toThrow()
    expect(
      (await store.readObservations<GoalObservation>(goal.id)).records,
    ).toEqual([
      expect.objectContaining({
        toolName: 'ask_user',
        evidencePolicy: 'forbidden',
        eligible: false,
      }),
    ])
  })

  it('keeps ordinary output unchanged when there is no active Goal', async () => {
    const tool = new ProbeTool('run_command')
    tool.evidencePolicy = 'eligible'
    const runner = runnerFor(tool, {
      sessionId: 'session-without-goal',
      goalObservationRecorder: recorder,
    })
    const history: Msg[] = [{ role: 'user', content: 'run ordinary tool' }]
    const emitted: Msg[] = []

    await runner.stepAsync(history, {
      turnId: 'turn-ordinary',
      emit: (event) => {
        emitted.push(event)
      },
    })

    expect(history.find((message) => message.role === 'tool')).toMatchObject({
      tool_call_id: 'call-1',
      name: 'run_command',
      content: 'executed output',
    })
    expect(
      emitted.find((event) => event.event === 'tool_result'),
    ).toMatchObject({
      name: 'run_command',
      output: 'executed output',
    })
    expect(await store.list()).toEqual([])
  })

  it('derives policy from the registered Tool and never trusts caller-supplied evidence fields', async () => {
    const goal = await activeGoal('goal_adapter', 'session-adapter')
    const tool = new ProbeTool('unclassified')
    const registry = new ToolRegistry()
    registry.register(tool)

    const observation = await recordRunnerGoalToolResult(recorder, registry, {
      sessionId: goal.scope.sessionId,
      turnId: 'turn-adapter',
      toolCallId: 'call-adapter',
      toolName: tool.name,
      executed: true,
      result: new ToolResultObj({ modelContent: 'context result' }),
    })

    expect(observation).toMatchObject({
      evidencePolicy: 'context_only',
      eligible: false,
    })
  })

  it('bridges an exact Plan command verification into a trusted receipt', async () => {
    const goal = await activeGoal('goal_plan_receipt', 'session-plan-receipt')
    const planLedger = new GoalEvidenceLedger(store, {
      now: () => T2,
      receiptIdFactory: () => 'receipt_plan_runner',
      factResolvers: {
        resolvePlanVerification(goalId, source) {
          return {
            ...source,
            goalId,
            passed: true,
            summary: 'Tests 12 passed',
          }
        },
      },
    })
    const service = new RunnerGoalRecordingService(recorder, planLedger)
    const observation = await service.recordToolResult({
      sessionId: goal.scope.sessionId,
      turnId: 'turn-plan-receipt',
      toolCallId: 'call-plan-receipt',
      toolName: 'run_command',
      arguments: { command: 'npm test' },
      evidencePolicy: 'eligible',
      executed: true,
      result: new ToolResultObj({ modelContent: 'Tests 12 passed' }),
    })

    const receipt = await recordRunnerPlanVerificationReceipt(
      service,
      observation,
      {
        target: {
          plan_id: 'plan-1',
          step_id: 'step-1',
          requirement_id: 'verification-1',
          command: 'npm test',
          approved_input_hash: computeGoalToolInputSha256('run_command', {
            command: 'npm test',
          }).inputSha256,
        },
        result: { passed: true, summary: 'Tests 12 passed' },
      },
    )

    expect(receipt).toMatchObject({
      goalId: goal.id,
      kind: 'plan_verification',
      source: {
        planId: 'plan-1',
        stepId: 'step-1',
        requirementId: 'verification-1',
        toolCallId: 'call-plan-receipt',
        sourceObservationId: 'obs_runner',
        approvedInputHash: observation!.toolInput.inputSha256,
      },
      summary: 'Tests 12 passed',
      outputSha256: observation!.outputSha256,
    })
    await expect(
      recordRunnerPlanVerificationReceipt(service, observation, {
        target: {
          plan_id: 'plan-1',
          step_id: 'step-1',
          requirement_id: 'verification-1',
          command: 'npm test',
          approved_input_hash: observation!.toolInput.inputSha256,
        },
        result: { passed: false, summary: 'Tests failed' },
      }),
    ).resolves.toBeNull()
    expect(await planLedger.listReceipts(goal.id)).toEqual([receipt])
  })

  it('does not sign a Plan receipt or PASS evidence for a real non-zero command', async () => {
    const goal = await activeGoal('goal_plan_nonzero', 'session-plan-nonzero')
    const registry = new ToolRegistry(stateRoot)
    registry.register(new RunCommand(stateRoot))
    const result = await registry.executeResult('run_command', {
      command: 'false',
    })
    const ledger = new GoalEvidenceLedger(store)
    const service = new RunnerGoalRecordingService(recorder, ledger)
    const observation = await service.recordToolResult({
      expectedGoalId: goal.id,
      sessionId: goal.scope.sessionId,
      turnId: 'turn-plan-nonzero',
      toolCallId: 'call-plan-nonzero',
      toolName: 'run_command',
      arguments: { command: 'false' },
      evidencePolicy: 'eligible',
      executed: true,
      result,
    })

    await expect(
      recordRunnerPlanVerificationReceipt(service, observation, {
        target: {
          plan_id: 'plan-nonzero',
          step_id: 'step-nonzero',
          requirement_id: 'req-nonzero',
          command: 'false',
          approved_input_hash: observation!.toolInput.inputSha256,
        },
        result: { passed: true, summary: 'forged pass' },
      }),
    ).resolves.toBeNull()
    await expect(
      ledger.record(goal.id, {
        criterionId: 'AC-1',
        verdict: 'pass',
        check: 'must not pass',
        summary: 'must not pass',
        sourceObservationIds: [observation!.id],
        sourceReceiptIds: [],
      }),
    ).rejects.toMatchObject({ code: 'goal_evidence_source_failed' })
  })

  async function activeGoal(id: string, sessionId: string) {
    return await createActiveGoal(store, id, sessionId)
  }
})

describe('Tool Goal evidence policy allowlist', () => {
  it('marks conventional eligible-tool error strings as failed observations', async () => {
    const registry = new ToolRegistry('/workspace')
    const tool = new ProbeTool(
      'eligible_probe',
      undefined,
      '[ERR] fetch failed',
    )
    tool.evidencePolicy = 'eligible'
    registry.register(tool)

    await expect(registry.executeResult(tool.name, {})).resolves.toMatchObject({
      isError: true,
    })
  })

  it('classifies a real non-zero run_command from structured process status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-command-nonzero-'))
    const registry = new ToolRegistry(root)
    registry.register(new RunCommand(root))

    await expect(
      registry.executeResult('run_command', {
        command: "printf '2 tests failed' >&2; exit 3",
      }),
    ).resolves.toMatchObject({
      isError: true,
      metadata: { exitCode: 3 },
      modelContent: expect.stringContaining('2 tests failed'),
    })
  })

  it('does not treat legal zero-exit output beginning with Error: as failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-command-prefix-'))
    const registry = new ToolRegistry(root)
    registry.register(new RunCommand(root))

    await expect(
      registry.executeResult('run_command', {
        command: "printf 'Error: legal diagnostic text'",
      }),
    ).resolves.toMatchObject({
      isError: false,
      metadata: { exitCode: 0 },
      modelContent: 'Error: legal diagnostic text',
    })
  })

  it('uses real child-process exit codes for silent false and exit 7 failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-command-exit-'))
    const registry = new ToolRegistry(root)
    registry.register(new RunCommand(root))

    await expect(
      registry.executeResult('run_command', { command: 'false' }),
    ).resolves.toMatchObject({
      isError: true,
      metadata: { exitCode: 1 },
    })
    await expect(
      registry.executeResult('run_command', { command: 'exit 7' }),
    ).resolves.toMatchObject({
      isError: true,
      metadata: { exitCode: 7 },
    })
  })

  it('keeps stderr, signal, and non-numeric operational failures safely failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emperor-command-errors-'))
    const registry = new ToolRegistry(root)
    registry.register(new RunCommand(root))

    await expect(
      registry.executeResult('run_command', {
        command: "printf 'bad stderr' >&2; exit 7",
      }),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining('bad stderr'),
      metadata: { exitCode: 7 },
    })

    const signal = new AbortController()
    const pending = registry.executeResult(
      'run_command',
      { command: 'sleep 5' },
      { signal: signal.signal },
    )
    setTimeout(() => signal.abort(), 10)
    await expect(pending).resolves.toMatchObject({
      isError: true,
      metadata: { exitCode: null },
    })

    const missingShell = new RunCommand(root, {
      ownedRunner: ownedProcessRunnerWith({
        status: 'spawn_error',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        error: 'spawn unavailable',
      }),
    })
    const operationalRegistry = new ToolRegistry(root)
    operationalRegistry.register(missingShell)
    await expect(
      operationalRegistry.executeResult('run_command', { command: 'pwd' }),
    ).resolves.toMatchObject({
      isError: true,
      metadata: { exitCode: null },
    })

    const signalled = new RunCommand(root, {
      ownedRunner: ownedProcessRunnerWith({
        status: 'completed',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        error: 'terminated by signal',
        signal: 'SIGTERM',
      }),
    })
    const signalRegistry = new ToolRegistry(root)
    signalRegistry.register(signalled)
    await expect(
      signalRegistry.executeResult('run_command', { command: 'pwd' }),
    ).resolves.toMatchObject({
      isError: true,
      metadata: { exitCode: null, signal: 'SIGTERM' },
    })
  })

  it('defaults new tools to context_only and explicitly opts execution, file, search, web, and MCP into eligible', () => {
    expect(new ProbeTool('new_tool').evidencePolicy).toBe('context_only')
    const eligible = [
      new RunCommand('/workspace'),
      new ReadFileTool('/workspace'),
      new WriteFileTool('/workspace'),
      new EditFileTool('/workspace'),
      new GlobTool('/workspace'),
      new GrepTool('/workspace'),
      new WebFetch(),
      new WebSearchTool(),
      new MCPToolAdapter({
        serverName: 'test',
        toolName: 'probe',
        description: 'probe',
        parametersSchema: { type: 'object', properties: {} },
        connection: {} as never,
      }),
    ]
    expect(eligible.map((tool) => [tool.name, tool.evidencePolicy])).toEqual(
      eligible.map((tool) => [tool.name, 'eligible']),
    )
  })

  it('explicitly forbids control, todo, skill, scheduler, team, subagent, and profile tools', () => {
    const manager = {} as never
    const todos = new TodoStore()
    const forbidden = [
      new AskUserTool(manager),
      new ProposePlanTool(manager),
      new RequestPlanModeTool(manager),
      new UpdateTodos(todos),
      new LoadSkill(),
      new ManageSkillTool(manager),
      new SchedulerTool(manager),
      new TeamTool(() => null),
      new DispatchSubagentTool({
        parentRegistry: new ToolRegistry(),
        subagentRegistry: manager,
        runnerFactory: manager,
      }),
      new SaveUserProfileTool(manager),
      new SubmitHookResultTool('Stop'),
    ]
    expect(forbidden.map((tool) => [tool.name, tool.evidencePolicy])).toEqual(
      forbidden.map((tool) => [tool.name, 'forbidden']),
    )
  })
})

class SequenceProvider extends LLMProvider {
  readonly seenMessages: ChatArgs['messages'][] = []
  private readonly responses: LLMResponse[]

  constructor(toolName: string, toolArguments: Record<string, unknown> = {}) {
    super({ defaultModel: 'fake' })
    this.responses = [
      response(null, [
        { id: 'call-1', name: toolName, arguments: toolArguments },
      ]),
      response('done'),
    ]
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.seenMessages.push(args.messages.map((message) => ({ ...message })))
    const next = this.responses.shift()
    if (!next) throw new Error('missing response')
    return next
  }
}

class ProbeTool extends Tool {
  override readonly description = 'Goal recording probe'
  override readonly parameters = toolParamsSchema({ command: S('command') })
  executions = 0

  constructor(
    override readonly name: string,
    private readonly onExecute?: () => void,
    private readonly output = 'executed output',
  ) {
    super()
  }

  execute(): string {
    this.executions += 1
    this.onExecute?.()
    return this.output
  }
}

class ThrowingProbeTool extends ProbeTool {
  override execute(): string {
    this.executions += 1
    throw new Error('tool exploded')
  }
}

class BlockingCommandTool extends Tool {
  override readonly name = 'run_command'
  override readonly description = 'Blocking command probe'
  override readonly parameters = toolParamsSchema({ command: S('command') })
  readonly started = deferred<void>()
  readonly release = deferred<void>()

  async execute(): Promise<ToolResultObj> {
    this.started.resolve()
    await this.release.promise
    return new ToolResultObj({
      modelContent: 'Tests passed',
      metadata: { exitCode: 0 },
    })
  }
}

function runnerFor(
  tool: Tool,
  options: {
    sessionId: string
    hooks?: AgentRunnerHookHost | null
    goalObservationRecorder?: RunnerGoalRecordingHost | null
    controlManager?: ControlManagerRunnerHost | null
    toolArguments?: Record<string, unknown>
  },
): AgentRunner {
  const registry = new ToolRegistry('/workspace')
  registry.register(tool)
  return new AgentRunner({
    provider: new SequenceProvider(tool.name, options.toolArguments),
    model: 'fake',
    registry,
    systemPrompt: 'system',
    sessionId: options.sessionId,
    workspaceRoot: '/workspace',
    hooks: options.hooks ?? null,
    controlManager: options.controlManager ?? null,
    goalObservationRecorder: options.goalObservationRecorder ?? null,
  })
}

function response(
  content: string | null,
  toolCalls: LLMResponse['toolCalls'] = [],
): LLMResponse {
  return {
    content,
    toolCalls,
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    usage: {},
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

function decision(
  overrides: Partial<HookAggregateDecision> = {},
): HookAggregateDecision {
  return {
    decision: 'passthrough',
    reason: '',
    results: [],
    additionalContext: '',
    ...overrides,
  }
}

function permissionHost(permission: {
  allowed: boolean
  requiresApproval: boolean
  reason: string
}): ControlManagerRunnerHost {
  return {
    systemPrompt: () => '',
    toolDefinitions: (registry) => registry.getDefinitions(),
    assessPermission: () => permission,
    permissionApprovalResult: () => 'approval required',
    assessClarification: () => ({
      required: false,
      reason: '',
      questions: [],
      categories: [],
    }),
    shouldEnforcePlanFinal: () => false,
    createAsk: () => {
      throw new Error('not expected')
    },
    createPlanFromText: () => {
      throw new Error('not expected')
    },
  }
}

function planSwitchingHost(
  currentPlanId: () => string | null,
  onRecord: (planId: string) => void,
): ControlManagerRunnerHost {
  return {
    ...permissionHost({
      allowed: true,
      requiresApproval: false,
      reason: 'allowed',
    }),
    planVerificationTarget(command) {
      const planId = currentPlanId()
      return planId === null
        ? null
        : {
            plan_id: planId,
            step_id: 'step-1',
            requirement_id: 'verification-1',
            command,
            approved_input_hash: computeGoalToolInputSha256('run_command', {
              command,
            }).inputSha256,
          }
    },
    recordPlanVerificationResult({ planId }) {
      onRecord(planId)
      return null
    },
  }
}

function approveCommandPlan(
  manager: ControlManager,
  title: string,
  commands: string[],
): string {
  manager.setMode('plan')
  new ProposePlanTool(manager).execute({
    title,
    summary: `${title} command verification plan.`,
    plan_markdown: `# ${title}`,
    steps: [
      {
        id: 'step_1',
        title: 'Run verification',
        description: 'Execute the approved verification commands.',
        files: ['packages/core/src/agent/runner.ts'],
        commands,
        acceptance: ['all approved commands complete'],
      },
    ],
    assumptions: [],
    risk_level: 'low',
  })
  const pending = manager.payload().pending as Record<string, unknown>
  manager.approve(String(pending.id))
  return manager.planStore.latest()!.id
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function createActiveGoal(
  store: GoalStore,
  id: string,
  sessionId: string,
) {
  const created = await store.create(
    newGoalRecord({
      id,
      outcome: 'Record final tool results',
      scope: {
        sessionId,
        mode: 'build',
        projectId: 'project-1',
        workspaceRoot: '/workspace',
      },
      now: T0,
    }),
  )
  const active = GoalContractValidator.lock(
    created,
    {
      inScope: ['core'],
      outOfScope: [],
      constraints: [],
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: 'Tool result is real',
          required: true,
          verification: { kind: 'command', requirement: 'Run tests' },
        },
      ],
      escalationConditions: [],
    },
    T1,
  )
  return await store.append(id, {
    type: 'goal_updated',
    record: active,
    createdAt: T1,
  })
}
