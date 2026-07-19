import { Cron } from 'croner'
import {
  computeNextRunMs,
  SchedulerMisfirePolicy,
  SchedulerSchedule,
  validateSchedule,
} from './models'

const MAX_MISSED_COUNT = 10_000
const MAX_DATE_MS = 8_640_000_000_000_000

export interface SchedulerOccurrenceWindow {
  firstMissedMs: number
  latestMissedMs: number
  nextFutureMs: number | null
  missedCount: number
  countCapped: boolean
}

export type SchedulerStartupDecision =
  | { kind: 'none'; nextRunAtMs: number | null }
  | {
      kind: 'skip' | 'queue'
      scheduledForMs: number
      window: SchedulerOccurrenceWindow
    }

export function occurrenceWindow(
  schedule: SchedulerSchedule,
  firstDueMs: number,
  currentMs: number,
): SchedulerOccurrenceWindow {
  validateSchedule(schedule)
  const firstMissedMs = schedulerTime(firstDueMs, 'first due time')
  const now = schedulerTime(currentMs, 'current time')
  if (firstMissedMs > now)
    throw new Error('first due time must not be later than current time')

  if (schedule.kind === 'at') {
    return {
      firstMissedMs,
      latestMissedMs: firstMissedMs,
      nextFutureMs: null,
      missedCount: 1,
      countCapped: false,
    }
  }

  if (schedule.kind === 'every') {
    const interval = schedule.every_ms!
    const exactCount = Math.floor((now - firstMissedMs) / interval) + 1
    const countCapped = exactCount > MAX_MISSED_COUNT
    const latestMissedMs =
      firstMissedMs + Math.max(0, exactCount - 1) * interval
    const nextFutureMs = latestMissedMs + interval
    return {
      firstMissedMs,
      latestMissedMs,
      nextFutureMs:
        Number.isSafeInteger(nextFutureMs) && nextFutureMs <= MAX_DATE_MS
          ? nextFutureMs
          : null,
      missedCount: Math.min(exactCount, MAX_MISSED_COUNT),
      countCapped,
    }
  }

  const cron = new Cron(schedule.expr!, {
    paused: true,
    timezone: schedule.tz ?? undefined,
  })
  let cursor = new Date(Math.max(0, firstMissedMs - 1))
  let counted = 0
  let latestCountedMs = firstMissedMs
  while (counted <= MAX_MISSED_COUNT) {
    const occurrence = cron.nextRun(cursor)
    if (!occurrence || occurrence.getTime() > now) break
    counted += 1
    latestCountedMs = occurrence.getTime()
    cursor = occurrence
  }
  const countCapped = counted > MAX_MISSED_COUNT
  const currentSecondMs = Math.floor(now / 1_000) * 1_000
  const currentSecond = new Date(currentSecondMs)
  const latest = cron.match(currentSecond)
    ? currentSecond
    : cron.previousRuns(1, new Date(now))[0]
  const latestMissedMs =
    latest && latest.getTime() >= firstMissedMs
      ? latest.getTime()
      : latestCountedMs
  const nextFutureMs = cron.nextRun(new Date(now))?.getTime() ?? null
  return {
    firstMissedMs,
    latestMissedMs,
    nextFutureMs,
    missedCount: Math.max(1, Math.min(counted, MAX_MISSED_COUNT)),
    countCapped,
  }
}

export function resolveStartupMisfire(
  schedule: SchedulerSchedule,
  policy: SchedulerMisfirePolicy,
  nextRunAtMs: number | null,
  currentMs: number,
): SchedulerStartupDecision {
  validateSchedule(schedule)
  const now = schedulerTime(currentMs, 'current time')
  if (nextRunAtMs === null)
    return { kind: 'none', nextRunAtMs: computeNextRunMs(schedule, now) }
  const due = schedulerTime(nextRunAtMs, 'next run time')
  if (due >= now) return { kind: 'none', nextRunAtMs: due }

  const window = occurrenceWindow(schedule, due, now)
  if (policy === SchedulerMisfirePolicy.SKIP)
    return { kind: 'skip', scheduledForMs: due, window }
  if (policy === SchedulerMisfirePolicy.LATEST)
    return {
      kind: 'queue',
      scheduledForMs: window.latestMissedMs,
      window,
    }
  if (policy === SchedulerMisfirePolicy.CATCH_UP_ONE)
    return { kind: 'queue', scheduledForMs: due, window }
  throw new Error(`unsupported scheduler misfire policy: ${String(policy)}`)
}

function schedulerTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS)
    throw new Error(`${label} is invalid`)
  return value
}
