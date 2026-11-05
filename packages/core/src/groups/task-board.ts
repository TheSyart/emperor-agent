/**
 * CG-02's pure GroupTask transitions. GroupService supplies the one log-backed
 * map and appends each returned snapshot synchronously, so a second claimant
 * always sees the first claimant's attempt. There is no task file beside it.
 */
import type {
  ContactId,
  GroupTask,
  GroupTaskArtifact,
  GroupTaskCheck,
  GroupTaskProblem,
} from './types'

export function contractRevision(task: GroupTask): number {
  return task.contractRevision ?? 1
}

/** Extended contracts wait for CG-03's worker; simple foreground tasks do not. */
export function usesWorkQueue(task: GroupTask): boolean {
  return Boolean(
    task.acceptance?.length ||
    task.dependsOn?.length ||
    task.writeScopes?.length ||
    task.artifacts?.length ||
    task.checks?.length,
  )
}

export function taskReady(
  tasks: ReadonlyMap<string, GroupTask>,
  task: GroupTask,
): boolean {
  return (
    task.state === 'queued' &&
    task.activeRunId === undefined &&
    (task.dependsOn ?? []).every((id) => tasks.get(id)?.state === 'done')
  )
}

export function assertAcyclic(tasks: ReadonlyMap<string, GroupTask>): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('任务存在循环依赖')
    if (visited.has(id)) return
    visiting.add(id)
    const task = tasks.get(id)
    for (const dependency of task?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of tasks.keys()) visit(id)
}

export function claim(
  task: GroupTask,
  input: { owner: ContactId; contractRevision: number; runId: string },
  ready: boolean,
): GroupTask {
  if (task.to !== input.owner) throw new Error('只有任务负责人可以接单')
  if (contractRevision(task) !== input.contractRevision)
    throw new Error('任务版本过期，不能按旧版本启动')
  if (!ready) throw new Error('任务当前不能接单：依赖未完成或已有执行实例')
  if (!input.runId.trim()) throw new Error('接单需要 runId')
  const next: GroupTask = {
    ...task,
    state: 'running',
    attempt: (task.attempt ?? 0) + 1,
    leaseEpoch: (task.leaseEpoch ?? 0) + 1,
    activeRunId: input.runId,
  }
  delete next.problem
  return next
}

export function submit(
  task: GroupTask,
  input: {
    owner: ContactId
    attempt: number
    leaseEpoch: number
    artifact: GroupTaskArtifact
    checks?: GroupTaskCheck[]
  },
): GroupTask {
  if (task.to !== input.owner)
    throw new Error('任务负责人或执行权已变更，旧结果不能提交')
  if (
    task.state !== 'running' ||
    task.attempt !== input.attempt ||
    task.leaseEpoch !== input.leaseEpoch
  )
    throw new Error('执行权已过期，旧结果不能提交')
  if (!input.artifact.ref.trim() || !input.artifact.revision.trim())
    throw new Error('提交成果需要 ref 和 revision')
  if (
    !input.checks?.length ||
    input.checks.some(
      (check) =>
        !check.passed ||
        check.artifactRevision !== input.artifact.revision ||
        !check.evidenceRef.trim(),
    )
  )
    throw new Error('检查依据必须全部通过并对应同一成果版本')
  const next: GroupTask = {
    ...task,
    // D54: a verified publication finishes autonomously; no user acceptance.
    state: 'done',
    checks: input.checks.map((check) => ({ ...check })),
    artifacts: [
      ...(task.artifacts ?? []).filter(
        (artifact) =>
          artifact.ref !== input.artifact.ref ||
          artifact.revision !== input.artifact.revision,
      ),
      { ...input.artifact },
    ],
  }
  delete next.activeRunId
  delete next.problem
  return next
}

export function accept(
  task: GroupTask,
  input: { artifactRevision: string; checks: GroupTaskCheck[] },
): GroupTask {
  if (task.state !== 'submitted') throw new Error('只有待确认成果可以完成')
  if (!task.artifacts?.some((a) => a.revision === input.artifactRevision))
    throw new Error('成果版本不匹配，不能接受')
  if (
    !input.checks.length ||
    input.checks.some(
      (check) =>
        !check.passed ||
        check.artifactRevision !== input.artifactRevision ||
        !check.evidenceRef.trim(),
    )
  )
    throw new Error('检查依据必须全部通过并对应同一成果版本')
  return { ...task, state: 'done', checks: input.checks.map((c) => ({ ...c })) }
}

export function transfer(
  task: GroupTask,
  input: { to: ContactId; contractRevision: number },
): GroupTask {
  if (contractRevision(task) !== input.contractRevision)
    throw new Error('任务版本过期，不能按旧版本移交')
  if (['submitted', 'done', 'cancelled'].includes(task.state))
    throw new Error('待确认或已结束的任务不能移交')
  if (task.to === input.to) throw new Error('任务已经由这位成员负责')
  const next: GroupTask = {
    ...task,
    to: input.to,
    state: 'queued',
    contractRevision: contractRevision(task) + 1,
    leaseEpoch: (task.leaseEpoch ?? 0) + 1,
  }
  delete next.activeRunId
  delete next.hold
  delete next.problem
  return next
}

/** Finish only the attempt that still owns the task; artifacts are retained. */
export function fail(
  task: GroupTask,
  input: { runId?: string; kind: GroupTaskProblem['kind']; reason: string },
): GroupTask {
  if (input.runId !== undefined) {
    if (task.state !== 'running' || task.activeRunId !== input.runId)
      throw new Error('执行权已过期，旧运行不能修改任务')
  } else if (task.state !== 'queued') {
    throw new Error('只有排队任务可以在启动前标记失败')
  }
  const next: GroupTask = {
    ...task,
    state: 'failed',
    problem: {
      kind: input.kind,
      reason: input.reason.trim() || '运行失败',
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    },
  }
  delete next.activeRunId
  return next
}

/** Cancellation becomes fact only after the active runner confirms it. */
export function cancel(task: GroupTask, runId: string): GroupTask {
  if (task.state !== 'running' || task.activeRunId !== runId)
    throw new Error('执行权已过期，旧运行不能取消任务')
  const next: GroupTask = { ...task, state: 'cancelled' }
  delete next.activeRunId
  delete next.problem
  return next
}

/** A queued task needs no runner confirmation: no attempt has started. */
export function cancelQueued(task: GroupTask): GroupTask {
  if (task.state !== 'queued') throw new Error('只有排队任务可以直接取消')
  const next: GroupTask = { ...task, state: 'cancelled' }
  delete next.activeRunId
  delete next.problem
  return next
}
