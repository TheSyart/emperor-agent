// Presentation helpers shared by the trajectory ledger and inspector
// (ported from the dsh TrajectoryTable formatting functions).
import {
  trajectoryUsageInputTotal,
  type AssistantMetricDetail,
  type TrajectoryCellKind,
  type TrajectoryUsage,
} from '../../trajectory/model'

/** Upper-case record kind label (ledger tag, inspector header). */
export const TRAJECTORY_KIND_LABEL: Record<TrajectoryCellKind, string> = {
  system: 'SYSTEM',
  user: 'USER',
  context: 'CONTEXT',
  compacted: 'COMPACTED',
  message: 'ASSISTANT',
  tool: 'TOOL',
  subtool: 'SUBTOOL',
}

/** `850 ms` below one second, else `1.25 s` / `12.5 s`. */
export function formatDurationMs(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`
}

/** Local `YYYY-MM-DD HH:MM:SS.mmm`, or `Not available`. */
export function formatStartedAt(timestamp: number | null | undefined): string {
  if (
    timestamp === null ||
    timestamp === undefined ||
    !Number.isFinite(timestamp)
  )
    return 'Not available'
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  const three = (value: number) => String(value).padStart(3, '0')
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  return `${day} ${time}`
}

/** Thousands-separated integer. */
export function formatCount(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** `1,234 tok`. */
export function formatTokens(value: number): string {
  return `${formatCount(value)} tok`
}

/** One `dt / dd` row of an inspector definition list. */
export interface InspectorRow {
  readonly label: string
  readonly value: string
  /** Indented sub-bucket row (cache / reasoning split). */
  readonly detail?: boolean
  readonly tone?: 'error'
}

/** Assistant step timing rows (Started is rendered separately). */
export function assistantTimingRows(
  metrics: AssistantMetricDetail,
): readonly InspectorRow[] {
  const total = (): string => {
    if (!metrics.timingRecorded) return 'Not recorded'
    if (metrics.stepStartTime === null) return 'Step start unavailable'
    if (metrics.completedTime === null) return 'Pending'
    return formatDurationMs(
      Math.max(0, metrics.completedTime - metrics.stepStartTime),
    )
  }
  const ttft = (): string => {
    if (!metrics.timingRecorded) return 'Not recorded'
    if (metrics.stepStartTime === null) return 'Step start unavailable'
    if (metrics.firstTokenTime === null) return 'First token unavailable'
    return formatDurationMs(
      Math.max(0, metrics.firstTokenTime - metrics.stepStartTime),
    )
  }
  const generation = (): string => {
    if (!metrics.timingRecorded || metrics.firstTokenTime === null)
      return 'First token unavailable'
    if (metrics.completedTime === null) return 'Pending'
    return formatDurationMs(
      Math.max(0, metrics.completedTime - metrics.firstTokenTime),
    )
  }
  const throughput = (): string => {
    if (!metrics.usageProvided) return 'Usage unavailable'
    if (metrics.outputTokens === null) return 'Output tokens unavailable'
    if (!metrics.timingRecorded || metrics.firstTokenTime === null)
      return 'First token unavailable'
    if (metrics.completedTime === null) return 'Pending'
    const seconds = (metrics.completedTime - metrics.firstTokenTime) / 1_000
    if (seconds <= 0) return 'Duration too short'
    return `${(metrics.outputTokens / seconds).toFixed(1)} tok/s`
  }
  return [
    { label: 'Total duration', value: total() },
    { label: 'TTFT', value: ttft() },
    { label: 'Generation', value: generation() },
    { label: 'Throughput', value: throughput() },
  ]
}

/** Usage rows of one request (or the session-cumulative prefix). */
export function usageRows(
  usage: TrajectoryUsage | undefined,
): readonly InspectorRow[] {
  if (usage === undefined) return []
  const rows: InspectorRow[] = []
  const input = trajectoryUsageInputTotal(usage)
  if (input !== undefined)
    rows.push({ label: 'Input', value: formatTokens(input) })
  if (usage.cacheRead !== undefined)
    rows.push({
      label: 'Cache read',
      value: formatTokens(usage.cacheRead),
      detail: true,
    })
  if (usage.cacheWrite !== undefined)
    rows.push({
      label: 'Cache write',
      value: formatTokens(usage.cacheWrite),
      detail: true,
    })
  if (usage.input !== undefined)
    rows.push({
      label: 'Uncached',
      value: formatTokens(usage.input),
      detail: true,
    })
  if (usage.output !== undefined)
    rows.push({ label: 'Output', value: formatTokens(usage.output) })
  if (usage.reasoning !== undefined)
    rows.push({
      label: 'Reasoning',
      value: formatTokens(usage.reasoning),
      detail: true,
    })
  if (usage.output !== undefined && usage.reasoning !== undefined)
    rows.push({
      label: 'Content',
      value: formatTokens(Math.max(0, usage.output - usage.reasoning)),
      detail: true,
    })
  return rows
}

/** Parse a JSON object/array payload, or undefined. */
export function parseJsonContainer(value: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A call-time tool schema in its model-visible shape. */
export interface ParsedToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: object
}

/** Parse the `schemaDetail` JSON of a tool record. */
export function parseToolSchema(value: string): ParsedToolSchema | undefined {
  const parsed = parseJsonContainer(value)
  if (parsed === undefined || Array.isArray(parsed)) return undefined
  const schema = parsed as Record<string, unknown>
  if (
    typeof schema.name !== 'string' ||
    typeof schema.parameters !== 'object' ||
    schema.parameters === null ||
    Array.isArray(schema.parameters)
  )
    return undefined
  return {
    name: schema.name,
    description:
      typeof schema.description === 'string' ? schema.description : '',
    parameters: schema.parameters,
  }
}
