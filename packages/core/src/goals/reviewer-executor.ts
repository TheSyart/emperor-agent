import type { ExecutionEnvironment } from '../environment/snapshot'
import { parseReviewerVerdict } from '../plans/reviewer'
import type {
  RunnerGoalRecordingHost,
  RunnerPlanVerificationReceiptInput,
} from '../agent/runner-goal-recording'
import type { SubagentRegistry } from '../subagents/registry'
import { TaskStatus } from '../tasks/models'
import type { TaskManager } from '../tasks/manager'
import type {
  DispatchRunnerFactoryArgs,
  DispatchRunner,
} from '../tools/dispatch'
import { ToolRegistry } from '../tools/registry'
import { AgentToolPolicyFactory } from '../tools/agent-policy'
import type {
  RecordToolResultInput,
  GoalEvidence,
  GoalEvidenceLedger,
  GoalObservation,
} from './evidence'
import { computeGoalToolInputSha256 } from './evidence'
import type {
  DispatchGoalReviewerInput,
  GoalReviewerDispatch,
  GoalReviewerLedger,
  GoalReviewerReceipt,
} from './reviewer'
import { GoalReviewerError } from './reviewer'
import type { GoalStore } from './store'

export interface ExecuteGoalReviewerInput extends DispatchGoalReviewerInput {
  readonly workspaceRoot: string
  readonly sessionId: string
  readonly executionEnvironment?: ExecutionEnvironment | null
}

export interface GoalReviewerExecutionResult {
  readonly dispatch: GoalReviewerDispatch
  readonly receipt: GoalReviewerReceipt
  readonly final: string
}

/**
 * Executes the Core-created reviewer identity through the regular routed
 * AgentRunner. Tool observations are stamped by Core context, immediately
 * converted into reviewer-owned Goal evidence, and only then referenced by
 * the canonical final verdict and reviewer receipt.
 */
export class GoalReviewerExecutor {
  private readonly recording: ReviewerEvidenceRecordingHost

  constructor(
    private readonly options: {
      readonly ledger: GoalReviewerLedger
      readonly goalStore: GoalStore
      readonly taskManager: TaskManager
      readonly evidenceLedger: GoalEvidenceLedger
      readonly baseGoalRecording: RunnerGoalRecordingHost
      readonly parentRegistry: ToolRegistry
      readonly subagentRegistry: SubagentRegistry
      readonly runnerFactory: (
        args: DispatchRunnerFactoryArgs,
      ) => DispatchRunner
    },
  ) {
    this.recording = new ReviewerEvidenceRecordingHost(
      options.baseGoalRecording,
      options.goalStore,
      options.evidenceLedger,
    )
  }

  async execute(
    input: ExecuteGoalReviewerInput,
  ): Promise<GoalReviewerExecutionResult> {
    const dispatch = await this.options.ledger.dispatchGoalReviewer(input)
    try {
      const spec = this.options.subagentRegistry.get('verification_reviewer')
      if (!spec)
        throw new GoalReviewerError(
          'goal_reviewer_agent_unavailable',
          'Verification reviewer subagent is unavailable.',
        )
      const registry = new AgentToolPolicyFactory(
        this.options.parentRegistry,
      ).create(spec, 'goal_reviewer').registry
      const history = this.options.taskManager.readSidechain(dispatch.task.id, {
        limit: 10_000,
      }).messages
      const runner = this.options.runnerFactory({
        spec,
        subRegistry: registry,
        task: String(history.at(-1)?.content ?? ''),
        workspaceRoot: input.workspaceRoot,
        agentId: dispatch.receipt.agentId,
        taskId: dispatch.task.id,
        turnId: dispatch.receipt.turnId,
        sessionId: input.sessionId,
        executionEnvironment: input.executionEnvironment ?? null,
        goalObservationRecorder: this.recording,
        expectedGoalId: input.goalId,
        enforceCompletionContract: false,
      })
      const modelFinal = await runner.step(history)
      const evidence = this.recording.evidenceForTask(dispatch.task.id)
      const commandObservations = this.recording.commandObservationsForTask(
        dispatch.task.id,
      )
      if (commandObservations.length === 0)
        throw new GoalReviewerError(
          'goal_reviewer_evidence_required',
          'Reviewer did not execute a task-owned validation command.',
        )
      const parsed = parseReviewerVerdict(modelFinal)
      const passed =
        parsed?.passed === true &&
        commandObservations.every((item) => !item.isError) &&
        evidence.every((item) => item.verdict === 'pass')
      const final = canonicalReviewerFinal(modelFinal, {
        passed,
        summary:
          parsed?.summary.trim() ||
          (passed
            ? 'Independent reviewer checks passed.'
            : 'Independent reviewer checks failed or were incomplete.'),
        commands: parsed?.commands ?? [],
        evidenceIds: evidence.map((item) => item.id),
        observationIds: commandObservations.map((item) => item.id),
      })
      this.options.taskManager.appendSidechain(dispatch.task.id, {
        role: 'assistant',
        content: final,
        turn_id: dispatch.receipt.turnId,
        agent_id: dispatch.receipt.agentId,
      })
      this.options.taskManager.completeGoalReviewerTask(dispatch.task.id, {
        summary: parsed?.summary ?? 'Independent Goal review completed.',
      })
      const receipt = await this.options.ledger.recordReviewerReceipt({
        goalId: dispatch.receipt.goalId,
        planId: dispatch.receipt.planId,
        planEventSeq: dispatch.receipt.planEventSeq,
        taskId: dispatch.task.id,
      })
      const goal = (await this.options.goalStore.inspect(receipt.goalId)).record
      if (!goal)
        throw new GoalReviewerError(
          'goal_reviewer_goal_inactive',
          'Reviewer Goal is unavailable after receipt persistence.',
        )
      for (const criterion of goal.contract.acceptanceCriteria) {
        if (criterion.verification.kind !== 'reviewer') continue
        const source = this.options.ledger.independentReviewerSource(
          receipt,
          criterion.id,
        )
        const sourceReceipt =
          await this.options.evidenceLedger.issueIndependentReviewerReceipt(
            goal.id,
            source,
          )
        await this.options.evidenceLedger.record(
          goal.id,
          {
            criterionId: criterion.id,
            verdict: receipt.verdict,
            check: criterion.verification.requirement,
            summary: receipt.summary,
            sourceObservationIds: [],
            sourceReceiptIds: [sourceReceipt.id],
          },
          { recorder: 'reviewer', independent: true },
        )
      }
      return { dispatch, receipt, final }
    } catch (cause) {
      this.terminalizeFailedDispatch(
        dispatch.task.id,
        cause instanceof Error ? cause.message : String(cause),
      )
      throw cause
    }
  }

  private terminalizeFailedDispatch(taskId: string, error: string): void {
    try {
      const task =
        this.options.taskManager.store.inspectIncludingArchive(taskId).record
      if (!task) return
      if (task.status === TaskStatus.COMPLETED) {
        // Preserve a failed provenance tombstone so task-bound observations
        // remain attributable, while ensuring no receipt-less COMPLETED Task
        // can ever be trusted by a later Gate evaluation.
        const failed =
          this.options.taskManager.failCompletedGoalReviewerTaskIncludingArchive(
            taskId,
            { error },
          )
        if (!failed || failed.status !== TaskStatus.FAILED)
          this.options.taskManager.deleteGoalReviewerTaskIncludingArchive(
            taskId,
          )
        return
      }
      if (task.status !== TaskStatus.RUNNING) return
      const failed = this.options.taskManager.failGoalReviewerTask(taskId, {
        error,
      })
      if (!failed || failed.status !== TaskStatus.FAILED)
        this.options.taskManager.deleteGoalReviewerTaskIncludingArchive(taskId)
    } catch {
      try {
        this.options.taskManager.deleteGoalReviewerTaskIncludingArchive(taskId)
      } catch {
        // The original reviewer failure remains authoritative. A later Task
        // store recovery will fail closed on the damaged record.
      }
    }
  }
}

class ReviewerEvidenceRecordingHost implements RunnerGoalRecordingHost {
  private readonly byTask = new Map<string, GoalEvidence[]>()
  private readonly commandObservations = new Map<string, GoalObservation[]>()

  constructor(
    private readonly base: RunnerGoalRecordingHost,
    private readonly goalStore: GoalStore,
    private readonly evidenceLedger: GoalEvidenceLedger,
  ) {}

  captureExpectedGoalId(sessionId: string): Promise<string | null> {
    return this.base.captureExpectedGoalId?.(sessionId) ?? Promise.resolve(null)
  }

  async recordToolResult(input: RecordToolResultInput) {
    const observation = await this.base.recordToolResult(input)
    if (!observation?.eligible || !observation.taskId || !observation.agentId)
      return observation
    if (observation.toolName === 'run_command') {
      const current = this.commandObservations.get(observation.taskId) ?? []
      current.push(observation)
      this.commandObservations.set(observation.taskId, current)
    }
    const goal = (await this.goalStore.inspect(observation.goalId)).record
    if (!goal) return observation
    const criteria = goal.contract.acceptanceCriteria.filter((criterion) => {
      if (criterion.verification.kind === 'command')
        return (
          observation.toolName === 'run_command' &&
          observation.toolInput.inputSha256 ===
            computeGoalToolInputSha256('run_command', {
              command: criterion.verification.requirement,
            }).inputSha256
        )
      return (
        criterion.verification.kind === 'artifact' &&
        observation.artifactRefs.length > 0
      )
    })
    for (const criterion of criteria) {
      const evidence = await this.evidenceLedger.record(
        goal.id,
        {
          criterionId: criterion.id,
          verdict: observation.isError ? 'fail' : 'pass',
          check: criterion.verification.requirement,
          summary: observation.displaySummary,
          sourceObservationIds: [observation.id],
          sourceReceiptIds: [],
        },
        { recorder: 'reviewer', independent: true },
      )
      const current = this.byTask.get(observation.taskId) ?? []
      current.push(evidence)
      this.byTask.set(observation.taskId, current)
    }
    return observation
  }

  recordPlanVerificationReceipt(input: RunnerPlanVerificationReceiptInput) {
    return (
      this.base.recordPlanVerificationReceipt?.(input) ?? Promise.resolve(null)
    )
  }

  evidenceForTask(taskId: string): readonly GoalEvidence[] {
    return [...(this.byTask.get(taskId) ?? [])]
  }

  commandObservationsForTask(taskId: string): readonly GoalObservation[] {
    return [...(this.commandObservations.get(taskId) ?? [])]
  }
}

function canonicalReviewerFinal(
  modelFinal: string,
  input: {
    readonly passed: boolean
    readonly summary: string
    readonly commands: readonly string[]
    readonly evidenceIds: readonly string[]
    readonly observationIds: readonly string[]
  },
): string {
  return [
    String(modelFinal ?? '').trim(),
    '```verdict',
    JSON.stringify({
      passed: input.passed,
      summary: input.summary.slice(0, 1_000),
      commands: [...input.commands],
      command_evidence: input.evidenceIds.map((evidenceId) => ({
        evidence_id: evidenceId,
      })),
      command_observations: input.observationIds.map((observationId) => ({
        observation_id: observationId,
      })),
    }),
    '```',
  ]
    .filter(Boolean)
    .join('\n')
}
