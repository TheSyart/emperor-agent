import type { SchedulerJob, SchedulerMisfirePolicy } from '../../types'

const READONLY_TIME_FIELDS = [
  'createdAtMs',
  'updatedAtMs',
  'nextRunAtMs',
  'lastRunAtMs',
] as const

export function canEditSchedulerJob(job: SchedulerJob | null): boolean {
  if (!job) return false
  if (job.protected) return false
  if (job.payload?.kind === 'system_event') return false
  return true
}

export function readonlySchedulerTimeFields(): string[] {
  return [...READONLY_TIME_FIELDS]
}

const MISFIRE_OPTIONS: Array<{
  value: SchedulerMisfirePolicy
  label: string
}> = [
  { value: 'skip', label: '跳过（默认）' },
  { value: 'latest', label: '只运行最近一次' },
  { value: 'catch-up-one', label: '补跑最早一次' },
]

export function schedulerMisfirePolicyOptions() {
  return MISFIRE_OPTIONS.map((option) => ({ ...option }))
}

export function schedulerMisfirePolicyLabel(value: unknown): string {
  return (
    MISFIRE_OPTIONS.find((option) => option.value === value)?.label ??
    MISFIRE_OPTIONS[0]!.label
  )
}

export function schedulerRunStatusLabel(status?: string | null): string {
  if (status === 'ok') return '成功'
  if (status === 'error') return '失败'
  if (status === 'skipped') return '已跳过'
  if (status === 'cancelled') return '已取消'
  if (status === 'interrupted') return '已中断'
  if (status === 'running') return '运行中'
  return status || '-'
}
