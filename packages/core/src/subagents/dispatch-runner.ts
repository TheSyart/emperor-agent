import { buildRoutedRunner } from '../agent/runner-factory'
import type {
  AgentRunnerHookHost,
  CompactorLike,
  ControlManagerRunnerHost,
  FileCheckpointCaptureHost,
  MemoryStoreLike,
  TodoStoreLike,
  TokenTrackerLike,
} from '../agent/runner'
import type { ModelRouter } from '../model/router'
import type { WorkspaceMutationHost } from '../workspace/mutation-coordinator'
import type { ToolRegistry } from '../tools/registry'
import type {
  DispatchRunner,
  DispatchRunnerFactoryArgs,
} from '../tools/dispatch'
import {
  bindRunnerGoalRecordingContext,
  type RunnerGoalRecordingHost,
} from '../agent/runner-goal-recording'

export interface RoutedDispatchRunnerFactoryOptions {
  modelRouter: Pick<ModelRouter, 'route'>
  tokenTracker?: TokenTrackerLike | null
  memoryStore?: MemoryStoreLike | null
  compactor?: CompactorLike | null
  todoStore?: TodoStoreLike | null
  controlManager?: ControlManagerRunnerHost | null
  maxTokensCap?: number | null
  tokenBudget?: number | null
  maxContext?: number | null
  hooks?:
    ((args: DispatchRunnerFactoryArgs) => AgentRunnerHookHost | null) | null
  goalObservationRecorder?: RunnerGoalRecordingHost | null
  fileCheckpoints?: FileCheckpointCaptureHost | null
  workspaceMutations?: WorkspaceMutationHost | null
}

export function buildDispatchRunnerFactory(
  opts: RoutedDispatchRunnerFactoryOptions,
): (args: DispatchRunnerFactoryArgs) => DispatchRunner {
  return (args) => buildDispatchRunner(args, opts)
}

export function buildDispatchRunner(
  args: DispatchRunnerFactoryArgs,
  opts: RoutedDispatchRunnerFactoryOptions,
): DispatchRunner {
  const goalObservationRecorder =
    args.goalObservationRecorder ?? opts.goalObservationRecorder ?? null
  const route = opts.modelRouter.route('subagent', args.spec.name, args.task)
  assertAgentModelPolicy(args, route.snapshot)
  const systemPrompt =
    args.contextMode === 'fork' && args.parentSystemPrompt?.trim()
      ? [
          args.parentSystemPrompt.trim(),
          '# Specialized Subagent Role',
          args.spec.systemPrompt,
        ].join('\n\n')
      : args.spec.systemPrompt
  const runner = buildRoutedRunner({
    route,
    registry: args.subRegistry as ToolRegistry,
    systemPrompt,
    tokenTracker: opts.tokenTracker ?? null,
    usageType: `subagent:${args.spec.name}`,
    maxTokensCap: opts.maxTokensCap ?? null,
    tokenBudget: opts.tokenBudget ?? null,
    memoryStore: opts.memoryStore ?? null,
    compactor: opts.compactor ?? null,
    todoStore: opts.todoStore ?? null,
    controlManager: opts.controlManager ?? null,
    maxContext: opts.maxContext ?? route.snapshot.contextWindowTokens ?? null,
    maxTurns: args.spec.maxTurns,
    workspaceRoot: args.workspaceRoot ?? null,
    sessionId: args.sessionId,
    taskId: args.taskId ?? null,
    subagentDepth: 1,
    hooks: opts.hooks?.(args) ?? null,
    goalObservationRecorder:
      goalObservationRecorder && args.taskId && args.agentId && args.turnId
        ? bindRunnerGoalRecordingContext(goalObservationRecorder, {
            expectedGoalId: args.expectedGoalId,
            taskId: args.taskId,
            agentId: args.agentId,
            turnId: args.turnId,
          })
        : null,
    fileCheckpoints: opts.fileCheckpoints ?? null,
    workspaceMutations: opts.workspaceMutations ?? null,
  })
  return {
    step: (history, stepOpts) =>
      runner.stepAsync(history, {
        turnId: args.turnId ?? null,
        signal: stepOpts?.signal ?? null,
        executionEnvironment: args.executionEnvironment ?? null,
      }),
  }
}

function assertAgentModelPolicy(
  args: DispatchRunnerFactoryArgs,
  snapshot: { modelEntryId?: string; entryName: string },
): void {
  const allowed = args.spec.definition.model.allowedProfiles
  if (allowed.length === 0) return
  const active = new Set(
    [snapshot.modelEntryId, snapshot.entryName]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )
  if (allowed.some((profile) => active.has(profile))) return
  throw new Error(
    'AgentDefinition model policy denied active profile; select an allowed model profile or tighten the definition source.',
  )
}
