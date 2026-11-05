/**
 * CG-03's background work queue. It shares GroupService's log-backed task
 * board with the speaking queue, but owns separate workers and abort signals.
 * A completed turn is not a completed task: only an exact-lease candidate
 * a fully checked submission moves work to `done`.
 */
import { contractRevision, taskReady, usesWorkQueue } from './task-board'
import { resolve } from 'node:path'
import type { Agent } from '../harness/agent/agent'
import type { GroupService } from './service'
import type {
  ContactId,
  GroupTask,
  GroupTaskArtifact,
  GroupTaskCheck,
} from './types'

export const GROUP_WORK_PER_GROUP_LIMIT = 2
export const GROUP_WORK_GLOBAL_LIMIT = 4

export interface GroupWorkCapabilities {
  maxParallel: number
  write: boolean
  stop: boolean
  collect: boolean
}

export interface GroupWorkRequest {
  groupId: string
  task: GroupTask
  runId: string
  memberSessionId: string
  signal: AbortSignal
}

export interface GroupWorkResult {
  outcome: 'completed' | 'failed' | 'aborted'
  detail?: string
  /** Actual model usage, including a failed or aborted attempt. */
  spend?: { usd: number; tokens: number }
  /** A trusted adapter result, still checked against the current lease. */
  submission?: {
    artifact: GroupTaskArtifact
    checks?: GroupTaskCheck[]
  }
}

export type GroupWorkProbe = 'unknown' | 'completed' | 'aborted' | 'failed'

export interface GroupWorkSchedulerDeps {
  groups: GroupService
  capabilities(groupId: string, task: GroupTask): GroupWorkCapabilities
  run(request: GroupWorkRequest): Promise<GroupWorkResult>
  recordSpend?(
    groupId: string,
    turnId: string,
    spend: { usd: number; tokens: number },
  ): void
  /** Inspect the old adapter/session record; never starts another attempt. */
  probe(groupId: string, task: GroupTask): GroupWorkProbe
  perGroupLimit?: number
  globalLimit?: number
  newId?(prefix: string): string
}

interface ActiveWork {
  groupId: string
  task: GroupTask
  runId: string
  memberSessionId: string
  turnId: string | null
  controller: AbortController
  capabilities: GroupWorkCapabilities
  done: Promise<void>
}

function randomId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export class GroupWorkScheduler {
  private readonly active = new Map<string, ActiveWork>()
  private readonly stopping = new Set<string>()
  private readonly perGroupLimit: number
  private readonly globalLimit: number
  private readonly newId: (prefix: string) => string

  constructor(private readonly deps: GroupWorkSchedulerDeps) {
    this.perGroupLimit = Math.max(
      1,
      deps.perGroupLimit ?? GROUP_WORK_PER_GROUP_LIMIT,
    )
    this.globalLimit = Math.max(1, deps.globalLimit ?? GROUP_WORK_GLOBAL_LIMIT)
    this.newId = deps.newId ?? randomId
  }

  /** The submission tool exists only for this session's current work attempt. */
  isWorking(agent: Agent | undefined): boolean {
    return Boolean(agent && this.currentForSession(agent.session.id))
  }

  /** Host-publish a file, then submit its exact immutable revision. */
  submit(
    agent: Agent | undefined,
    input: {
      sourcePath: string
      checks?: Array<{ evidenceRef: string; passed: boolean }>
    },
  ): GroupTask {
    const run = agent ? this.currentForSession(agent.session.id) : undefined
    if (!run) throw new Error('只有当前后台任务的负责人可以提交成果')
    const root = this.deps.groups.memberWorkspace(
      run.groupId,
      run.task.to,
    ).workspaceRoot
    const artifact = this.deps.groups.publishArtifact(run.groupId, {
      contactId: run.task.to,
      sourcePath: resolve(root, input.sourcePath),
      taskId: run.task.taskId,
    })
    const revision = artifact.artifactId
    return this.deps.groups.submitTask(run.groupId, {
      taskId: run.task.taskId,
      owner: run.task.to,
      attempt: run.task.attempt!,
      leaseEpoch: run.task.leaseEpoch!,
      artifact: { ref: artifact.artifactRef, revision },
      ...(input.checks === undefined
        ? {}
        : {
            checks: input.checks.map((check) => ({
              ...check,
              artifactRevision: revision,
            })),
          }),
    })
  }

  private currentForSession(sessionId: string): ActiveWork | undefined {
    return [...this.active.values()].find((run) => {
      if (run.memberSessionId !== sessionId || run.controller.signal.aborted)
        return false
      const current = this.deps.groups
        .state(run.groupId)
        .tasks.get(run.task.taskId)
      return current?.state === 'running' && current.activeRunId === run.runId
    })
  }

  live(groupId: string): {
    active: number
    queued: number
    maxParallel: number
  } {
    const tasks = this.deps.groups.tasks(groupId)
    const ready = tasks.filter((task) => usesWorkQueue(task) && task.ready)
    const running = [...this.active.values()].filter(
      (run) => run.groupId === groupId,
    )
    const limits = [...running, ...ready].map((run) => {
      const capabilities =
        'capabilities' in run
          ? run.capabilities
          : this.deps.capabilities(groupId, run)
      return this.parallelLimit(capabilities)
    })
    return {
      active: running.length,
      queued: ready.length,
      maxParallel: limits.length ? Math.min(...limits) : this.perGroupLimit,
    }
  }

  /** Fill free slots synchronously; adapter promises settle independently. */
  kick(groupId: string): void {
    if (this.stopping.has(groupId)) return
    // A transfer revokes the old lease at once and asks its runner to stop.
    for (const run of this.active.values()) {
      if (run.groupId !== groupId) continue
      const current = this.deps.groups.state(groupId).tasks.get(run.task.taskId)
      if (current?.activeRunId !== run.runId) run.controller.abort()
    }
    const state = this.deps.groups.state(groupId)
    for (const view of this.deps.groups.tasks(groupId)) {
      if (this.active.size >= this.globalLimit) return
      if (!usesWorkQueue(view) || !view.ready) continue
      const task = state.tasks.get(view.taskId)
      if (!task || !taskReady(state.tasks, task)) continue
      const runningHere = [...this.active.values()].filter(
        (run) => run.groupId === groupId,
      ).length
      const capabilities = this.deps.capabilities(groupId, task)
      if (runningHere >= this.parallelLimit(capabilities)) continue
      if (task.access !== 'readonly' && !capabilities.write) {
        this.deps.groups.failTask(groupId, {
          taskId: task.taskId,
          kind: 'adapter',
          reason: 'readonly',
        })
        continue
      }
      this.start(groupId, task, capabilities)
    }
  }

  /** Stop background work only; speaking has its own GroupScheduler.stop. */
  stop(groupId: string): { requested: number } {
    let requested = 0
    for (const run of this.active.values()) {
      if (run.groupId !== groupId || !run.capabilities.stop) continue
      run.controller.abort()
      requested += 1
    }
    if (requested > 0) this.stopping.add(groupId)
    // No attempt owns a queued task, so cancelling it needs no confirmation.
    // Otherwise a finishing run would immediately fill its slot again.
    for (const task of this.deps.groups.tasks(groupId))
      if (usesWorkQueue(task) && task.state === 'queued')
        this.deps.groups.cancelQueuedTask(groupId, task.taskId)
    return { requested }
  }

  async settled(groupId?: string): Promise<void> {
    for (;;) {
      const runs = [...this.active.values()].filter(
        (run) => groupId === undefined || run.groupId === groupId,
      )
      if (!runs.length) return
      await Promise.allSettled(runs.map((run) => run.done))
    }
  }

  async shutdown(): Promise<void> {
    for (const run of this.active.values()) run.controller.abort()
    await this.settled()
  }

  /**
   * A restart never starts an attempt. Probe the old session/delegation and
   * leave an explicit failure/cancellation whose stale results cannot land.
   */
  recover(): number {
    let recovered = 0
    for (const group of this.deps.groups.list()) {
      for (const task of this.deps.groups.state(group.id).tasks.values()) {
        if (
          !usesWorkQueue(task) ||
          task.state !== 'running' ||
          !task.activeRunId
        )
          continue
        let probe: GroupWorkProbe = 'unknown'
        try {
          probe = this.deps.probe(group.id, task)
        } catch {
          // An unavailable adapter is an unknown outcome, never a retry.
        }
        if (probe === 'aborted')
          this.deps.groups.cancelTask(group.id, task.taskId, task.activeRunId)
        else
          this.deps.groups.failTask(group.id, {
            taskId: task.taskId,
            runId: task.activeRunId,
            kind: probe === 'failed' ? 'failed' : 'unknown',
            reason: probe === 'unknown' ? 'app_restart' : 'missing_submission',
          })
        recovered += 1
      }
    }
    // Queued work never had an attempt, so it is safe to schedule after a
    // restart. Only a recovered active attempt is barred from rerunning.
    for (const group of this.deps.groups.list()) this.kick(group.id)
    return recovered
  }

  private parallelLimit(capabilities: GroupWorkCapabilities): number {
    return capabilities.write && capabilities.stop && capabilities.collect
      ? Math.max(
          1,
          Math.min(this.perGroupLimit, Math.floor(capabilities.maxParallel)),
        )
      : 1
  }

  private start(
    groupId: string,
    task: GroupTask,
    capabilities: GroupWorkCapabilities,
  ): void {
    const memberSessionId = this.deps.groups
      .state(groupId)
      .memberSessions.get(task.to)
    if (
      !memberSessionId ||
      !this.deps.groups.state(groupId).members.includes(task.to)
    ) {
      this.deps.groups.failTask(groupId, {
        taskId: task.taskId,
        kind: 'adapter',
        reason: 'owner_unavailable',
      })
      return
    }
    const runId = this.newId('gwr-')
    const claimed = this.deps.groups.claimTask(groupId, {
      taskId: task.taskId,
      owner: task.to,
      contractRevision: contractRevision(task),
      runId,
    })
    const run: ActiveWork = {
      groupId,
      task: claimed,
      runId,
      memberSessionId,
      turnId:
        this.deps.groups
          .state(groupId)
          .messages.find((message) => message.task?.taskId === task.taskId)
          ?.turnId ?? null,
      controller: new AbortController(),
      capabilities,
      done: Promise.resolve(),
    }
    this.active.set(runId, run)
    run.done = this.execute(run).finally(() => {
      this.active.delete(runId)
      if (![...this.active.values()].some((r) => r.groupId === groupId))
        this.stopping.delete(groupId)
      // A global slot may belong to a task queued in another group.
      for (const group of this.deps.groups.list()) this.kick(group.id)
    })
  }

  private async execute(run: ActiveWork): Promise<void> {
    let result: GroupWorkResult
    try {
      result = await this.deps.run({
        groupId: run.groupId,
        task: run.task,
        runId: run.runId,
        memberSessionId: run.memberSessionId,
        signal: run.controller.signal,
      })
    } catch (error) {
      result = {
        outcome: run.controller.signal.aborted ? 'aborted' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    if (
      run.turnId &&
      result.spend &&
      (result.spend.usd > 0 || result.spend.tokens > 0)
    )
      this.deps.recordSpend?.(run.groupId, run.turnId, result.spend)
    const current = this.deps.groups
      .state(run.groupId)
      .tasks.get(run.task.taskId)
    const owns =
      current?.state === 'running' &&
      current.activeRunId === run.runId &&
      current.attempt === run.task.attempt &&
      current.leaseEpoch === run.task.leaseEpoch
    if (!owns) return
    if (result.outcome === 'aborted') {
      this.deps.groups.cancelTask(run.groupId, run.task.taskId, run.runId)
      return
    }
    if (result.outcome === 'failed') {
      this.deps.groups.failTask(run.groupId, {
        taskId: run.task.taskId,
        runId: run.runId,
        kind: 'failed',
        reason: result.detail ?? '运行失败',
      })
      return
    }
    if (!result.submission) {
      this.deps.groups.failTask(run.groupId, {
        taskId: run.task.taskId,
        runId: run.runId,
        kind: 'failed',
        reason: 'missing_submission',
      })
      return
    }
    try {
      this.deps.groups.submitTask(run.groupId, {
        taskId: run.task.taskId,
        owner: run.task.to as ContactId,
        attempt: run.task.attempt!,
        leaseEpoch: run.task.leaseEpoch!,
        artifact: result.submission.artifact,
        ...(result.submission.checks
          ? { checks: result.submission.checks }
          : {}),
      })
    } catch (error) {
      this.deps.groups.failTask(run.groupId, {
        taskId: run.task.taskId,
        runId: run.runId,
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
