/**
 * Model-facing job controls (ported from dsh-tool-jobs): `job_output`,
 * `job_list`, `job_kill`, plus the order-106 prompt section.
 */

import { z } from 'zod'
import type { ToolDefinition } from '../tools/definition'
import { defineTool } from '../tools/definition'
import type { SystemPromptAssembler } from '../prompt/assembler'
import { statusLine, type JobRegistry, type JobSnapshot } from './registry'

export const DEFAULT_JOB_WAIT_TIMEOUT_MS = 30_000
export const MAX_JOB_WAIT_TIMEOUT_MS = 600_000

export const JOBS_PROMPT_SECTION =
  "Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering."

export function installJobsPromptSection(
  prompt: SystemPromptAssembler,
): () => void {
  return prompt.section({
    name: 'tool:jobs',
    order: 106,
    text: JOBS_PROMPT_SECTION,
  })
}

/** UI-facing job fields (no ownership bookkeeping). */
function publicJob(snapshot: JobSnapshot): {
  id: string
  kind: string
  label: string
  status: string
  detail?: string
  exitCode?: number
  startedAt: number
  finishedAt?: number
} {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...(snapshot.detail === undefined ? {} : { detail: snapshot.detail }),
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
    startedAt: snapshot.startedAt,
    ...(snapshot.finishedAt === undefined
      ? {}
      : { finishedAt: snapshot.finishedAt }),
  }
}

export interface JobToolOptions {
  waitTimeoutMs?: number
  maxWaitTimeoutMs?: number
}

export function createJobTools(
  registry: JobRegistry,
  options: JobToolOptions = {},
): ToolDefinition[] {
  const waitDefault = options.waitTimeoutMs ?? DEFAULT_JOB_WAIT_TIMEOUT_MS
  const waitCap = options.maxWaitTimeoutMs ?? MAX_JOB_WAIT_TIMEOUT_MS
  if (waitDefault > waitCap)
    throw new Error(
      `jobs: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`,
    )

  const jobOutput = defineTool({
    name: 'job_output',
    description:
      'Read a background job. Stream jobs return only output since the previous read; ' +
      'final-output jobs return their result after settlement. Every response ends with ' +
      '`[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap.',
    input: z.object({
      job_id: z
        .string()
        .min(1)
        .describe(
          'Job id returned by the tool that started the background work.',
        ),
      wait: z
        .boolean()
        .optional()
        .describe(
          'Block until the job reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the job alive.',
        ),
      timeout_ms: z
        .number()
        .positive()
        .optional()
        .describe(
          `Max wait in milliseconds (only meaningful with wait: true). Defaults to ${waitDefault}; capped at ${waitCap}.`,
        ),
    }),
    isConcurrencySafe: (args) => args.wait !== true,
    async execute(args, context) {
      if (args.wait === true) {
        await registry.wait(
          args.job_id,
          Math.min(args.timeout_ms ?? waitDefault, waitCap),
          context.agent,
          context.signal,
        )
      }
      const read = registry.read(args.job_id, context.agent)
      const body = read.text.length > 0 ? read.text : '(no new output)'
      const separator = body.endsWith('\n') ? '' : '\n'
      return {
        content: `${body}${separator}${statusLine(read.snapshot)}`,
        meta: { job: publicJob(read.snapshot) },
      }
    },
  })

  const jobList = defineTool({
    name: 'job_list',
    description:
      'List your background jobs (running and finished) with their ids, kinds, and statuses.',
    input: z.object({}),
    isConcurrencySafe: () => true,
    execute(_args, context) {
      const jobs = registry.list(context.agent).map(publicJob)
      return Promise.resolve({
        content:
          jobs.length === 0
            ? '(no background jobs)'
            : jobs
                .map(
                  (job) =>
                    `${job.id} [${job.kind}] ${job.status} — ${job.label}`,
                )
                .join('\n'),
        meta: { jobs },
      })
    },
  })

  const jobKill = defineTool({
    name: 'job_kill',
    description:
      'Request cancellation of a running background job by job id. Returns immediately; the job settles as killed once its work actually stops.',
    input: z.object({
      job_id: z
        .string()
        .min(1)
        .describe(
          'Job id returned by the tool that started the background work.',
        ),
      reason: z
        .string()
        .optional()
        .describe(
          'Optional short reason, recorded in the log and forwarded to the job.',
        ),
    }),
    execute(args, context) {
      const outcome = registry.kill(args.job_id, context.agent, args.reason)
      const job = registry.get(args.job_id, context.agent)
      return Promise.resolve({
        content:
          outcome === 'already-finished'
            ? `job ${job.id} had already finished ${statusLine(job)}`
            : `requested cancellation of job ${job.id}`,
        meta: {
          outcome:
            outcome === 'already-finished'
              ? 'already-finished'
              : 'cancellation-requested',
          job: publicJob(job),
        },
      })
    },
  })

  return [jobOutput, jobList, jobKill] as ToolDefinition[]
}
