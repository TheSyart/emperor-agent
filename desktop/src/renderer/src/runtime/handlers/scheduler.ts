import type { BootstrapPayload, WsEvent } from '../../types'

export function applySchedulerEventToBootstrap(boot: BootstrapPayload, data: WsEvent) {
  if (!('job' in data) || !data.job) return
  boot.scheduler ||= {
    status: { running: false, jobs: 0, enabled: 0, nextRunAtMs: null, lastError: null },
    jobs: [],
  }
  const jobs = boot.scheduler.jobs || []
  const index = jobs.findIndex((job) => job.id === data.job!.id)
  if (data.event === 'scheduler_job_update' && data.action === 'deleted') {
    if (index >= 0) jobs.splice(index, 1)
  } else if (index >= 0) {
    jobs[index] = data.job
  } else {
    jobs.push(data.job)
  }
  boot.scheduler.jobs = jobs
    .slice()
    .sort((a, b) => Number(a.state?.nextRunAtMs || Infinity) - Number(b.state?.nextRunAtMs || Infinity))
  boot.scheduler.status.jobs = boot.scheduler.jobs.length
  boot.scheduler.status.enabled = boot.scheduler.jobs.filter((job) => job.enabled).length
  boot.scheduler.status.nextRunAtMs = boot.scheduler.jobs
    .filter((job) => job.enabled && job.state?.nextRunAtMs)
    .map((job) => Number(job.state.nextRunAtMs))
    .sort((a, b) => a - b)[0] || null
  boot.scheduler.status.lastError = boot.scheduler.jobs.find((job) => job.state?.lastStatus === 'error')?.state.lastError || null
}
