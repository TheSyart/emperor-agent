export type PromptPrefetchStatus = 'ready' | 'timeout' | 'error' | 'aborted'

export interface PromptPrefetchTask<T = unknown> {
  name: string
  run: (signal: AbortSignal) => Promise<T> | T
  timeoutMs?: number
  required?: boolean
}

export interface PromptPrefetchTaskReport {
  name: string
  required: boolean
  status: PromptPrefetchStatus
  durationMs: number
  errorCode?: string
}

export interface PromptPrefetchReport {
  version: 1
  deadlineMs: number
  durationMs: number
  tasks: PromptPrefetchTaskReport[]
}

export interface PromptPrefetchResult {
  values: Record<string, unknown>
  report: PromptPrefetchReport
}

interface TaskOutcome {
  value?: unknown
  error?: unknown
  report: PromptPrefetchTaskReport
}

export class PromptPrefetchError extends Error {
  readonly code = 'prompt_prefetch_required_failed'
  readonly taskName: string
  readonly report: PromptPrefetchReport

  constructor(taskName: string, report: PromptPrefetchReport) {
    super(`Required prompt prefetch failed: ${taskName}`)
    this.name = 'PromptPrefetchError'
    this.taskName = taskName
    this.report = report
  }
}

/**
 * Launches independent prompt inputs together and keeps slow optional sources
 * outside the model-request critical path. Reports never contain fetched values
 * or raw error messages.
 */
export class PromptPrefetchCoordinator {
  async run(
    tasks: PromptPrefetchTask[],
    opts?: { signal?: AbortSignal | null; deadlineMs?: number },
  ): Promise<PromptPrefetchResult> {
    const startedAt = Date.now()
    const deadlineMs = positiveMs(opts?.deadlineMs, 2_000)
    const deadlineAt = startedAt + deadlineMs
    const outcomes = await Promise.all(
      tasks.map((task) =>
        runTask(task, {
          parentSignal: opts?.signal ?? null,
          deadlineAt,
        }),
      ),
    )
    const report: PromptPrefetchReport = {
      version: 1,
      deadlineMs,
      durationMs: Math.max(0, Date.now() - startedAt),
      tasks: outcomes.map((outcome) => outcome.report),
    }
    const failedRequired = outcomes.find(
      (outcome) => outcome.report.required && outcome.report.status !== 'ready',
    )
    if (failedRequired?.error && hasStableErrorCode(failedRequired.error))
      throw failedRequired.error
    if (failedRequired)
      throw new PromptPrefetchError(failedRequired.report.name, report)

    const values: Record<string, unknown> = {}
    outcomes.forEach((outcome) => {
      if (outcome.report.status === 'ready')
        values[outcome.report.name] = outcome.value
    })
    return { values, report }
  }
}

function runTask(
  task: PromptPrefetchTask,
  opts: { parentSignal: AbortSignal | null; deadlineAt: number },
): Promise<TaskOutcome> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const remainingMs = Math.max(1, opts.deadlineAt - startedAt)
  const timeoutMs = Math.min(
    remainingMs,
    positiveMs(task.timeoutMs, remainingMs),
  )

  return new Promise<TaskOutcome>((resolve) => {
    let settled = false
    const finish = (
      status: PromptPrefetchStatus,
      value?: unknown,
      errorCode?: string,
      error?: unknown,
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      opts.parentSignal?.removeEventListener('abort', abortFromParent)
      resolve({
        value,
        error,
        report: {
          name: String(task.name),
          required: task.required === true,
          status,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(errorCode ? { errorCode } : {}),
        },
      })
    }
    const abortFromParent = (): void => {
      controller.abort(opts.parentSignal?.reason)
      finish('aborted', undefined, 'prefetch_aborted')
    }
    const timeout = setTimeout(() => {
      controller.abort(new Error('prompt prefetch deadline exceeded'))
      finish('timeout', undefined, 'prefetch_timeout')
    }, timeoutMs)

    if (opts.parentSignal?.aborted) {
      abortFromParent()
      return
    }
    opts.parentSignal?.addEventListener('abort', abortFromParent, {
      once: true,
    })
    Promise.resolve()
      .then(() => task.run(controller.signal))
      .then(
        (value) => finish('ready', value),
        (error) => finish('error', undefined, 'prefetch_task_failed', error),
      )
  })
}

function hasStableErrorCode(error: unknown): error is Error & { code: string } {
  return Boolean(
    error &&
    typeof error === 'object' &&
    typeof (error as Record<string, unknown>).code === 'string',
  )
}

function positiveMs(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
