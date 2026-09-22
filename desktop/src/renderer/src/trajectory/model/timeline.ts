// Operation-sequence and recorded-time projections for the trajectory
// overview (ported from the dsh ui-trajectory timeline), plus the pure
// brush / zoom / pan math of the dsh TrajectoryTimeline component so the Vue
// view only wires pointer events to these functions.
import type { TrajectoryTurnModel } from './layout'
import { formatDurationMillis } from './record'
import type {
  AssistantMetricDetail,
  TrajectoryCellKind,
  TrajectoryCellProps,
} from './record'

/** Horizontal projection used by the trajectory timeline. */
export type TrajectoryTimelineMode = 'sequence' | 'duration' | 'time' | 'actual'

/** Inclusive selection in the active timeline projection's domain. */
export interface TrajectoryTimeRange {
  start: number
  end: number
}

/** One ledger record projected into the active timeline domain. */
export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
  index: number
  isError: boolean
  kind: TrajectoryCellKind
  label: string
  lane: number
}

/** One turn boundary in the active timeline domain. */
export interface TrajectoryTimelineTurnBoundary {
  turn: number
  time: number
}

/** Full-domain model used by the overview. */
export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
  spans: readonly TrajectoryTimelineSpan[]
  turnBoundaries: readonly TrajectoryTimelineTurnBoundary[]
}

/** Lane labels top to bottom: input records, model output, tools. */
export const TRAJECTORY_TIMELINE_LANES = ['Input', 'Model', 'Tools'] as const

/** Pixels a pointer must travel before a press becomes a drag. */
export const TIMELINE_MINIMUM_DRAG_PX = 3
/** Narrowest zoomed viewport in sequence mode (operations). */
export const TIMELINE_MINIMUM_ZOOM_OPERATIONS = 4
/** Narrowest zoomed viewport in timed modes (ms). */
export const TIMELINE_MINIMUM_ZOOM_MS = 20
const EDGE_PAN_ZONE_FRACTION = 0.08
const EDGE_PAN_STEP_FRACTION = 0.025
const MAXIMUM_EDGE_PAN_PX = 32
const WHEEL_ZOOM_RATE = 0.0015

/**
 * Format a timeline duration as an integer-millisecond label.
 * @param milliseconds - Non-negative duration in milliseconds.
 */
export function formatTimelineOffset(milliseconds: number): string {
  return formatDurationMillis(milliseconds)
}

/** Semantic lane of one record kind (0 input, 1 model, 2 tools). */
export function trajectoryTimelineLane(kind: TrajectoryCellKind): number {
  if (kind === 'tool' || kind === 'subtool') return 2
  if (kind === 'message' || kind === 'compacted') return 1
  return 0
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

function cellRange(cell: TrajectoryCellProps): TrajectoryTimeRange | null {
  if (!finite(cell.startedAt)) return null
  const durationMs = finite(cell.timeSeconds)
    ? Math.max(0, cell.timeSeconds * 1_000)
    : 0
  return { start: cell.startedAt, end: cell.startedAt + durationMs }
}

/**
 * Project every visible record into a stable three-lane timeline.
 * @param turns - Unfiltered trajectory layout.
 * @param mode - Independent equal/recorded duration and compressed/complete time projection.
 * @returns Timeline model, or `null` when no record is visible.
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = 'sequence',
): TrajectoryTimelineModel | null {
  if (mode !== 'sequence')
    return deriveTimedTimeline(
      turns,
      mode === 'duration' || mode === 'actual',
      mode === 'duration',
    )
  const spans: TrajectoryTimelineSpan[] = []
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = []

  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) =>
      group.cells.filter((cell) => cell.requestOnly !== true),
    )
    if (cells.length === 0) continue
    if (turn.turn !== null)
      turnBoundaries.push({ turn: turn.turn, time: spans.length })
    spans.push(
      ...cells.map((cell, offset): TrajectoryTimelineSpan => ({
        start: spans.length + offset,
        end: spans.length + offset + 1,
        index: cell.index,
        isError: cell.isError === true,
        kind: cell.kind,
        label: cell.text,
        lane: trajectoryTimelineLane(cell.kind),
      })),
    )
  }

  if (spans.length === 0) return null
  return { start: 0, end: spans.length, spans, turnBoundaries }
}

function deriveTimedTimeline(
  turns: readonly TrajectoryTurnModel[],
  actualDuration: boolean,
  compressIdle: boolean,
): TrajectoryTimelineModel | null {
  const timedTurns = turns.flatMap((turn) => {
    const rawSpans = turn.groups.flatMap((group) =>
      group.cells.flatMap((cell): TrajectoryTimelineSpan[] => {
        if (cell.requestOnly === true) return []
        const range = cellRange(cell)
        return range === null
          ? []
          : [
              {
                ...range,
                index: cell.index,
                isError: cell.isError === true,
                kind: cell.kind,
                label: cell.text,
                lane: trajectoryTimelineLane(cell.kind),
              },
            ]
      }),
    )
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }]
  })
  const rawSpans = timedTurns.flatMap((turn) => turn.rawSpans)
  if (rawSpans.length === 0) return null

  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>()
  let removedIdle = 0
  let coveredUntil: number | null = null
  for (const span of [...rawSpans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (compressIdle && coveredUntil !== null && span.start > coveredUntil)
      removedIdle += span.start - coveredUntil
    removedIdleBySpan.set(span, removedIdle)
    coveredUntil =
      coveredUntil === null ? span.end : Math.max(coveredUntil, span.end)
  }

  const spans: TrajectoryTimelineSpan[] = []
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = []
  for (const turn of timedTurns) {
    const projected = turn.rawSpans.map((span): TrajectoryTimelineSpan => {
      const offset = removedIdleBySpan.get(span) ?? 0
      return {
        ...span,
        start: span.start - offset,
        end: (actualDuration ? span.end : span.start) - offset,
      }
    })
    spans.push(...projected)
    if (turn.turn !== null)
      turnBoundaries.push({
        turn: turn.turn,
        time: Math.min(...projected.map((span) => span.start)),
      })
  }

  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries,
  }
}

/**
 * Identify records active at any point inside an inclusive selected interval.
 * @param turns - Unfiltered trajectory layout.
 * @param range - Selected interval in the active projection.
 * @param mode - Timeline projection.
 * @returns Record indexes inside the focus interval.
 */
export function trajectoryTimelineFocusIndexes(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = 'sequence',
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode)
  return new Set(
    model?.spans
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index),
  )
}

// ── record details / tooltip ──────────────────────────────────────────

/** Recorded timing of one timeline record (for tooltips and TTFT split). */
export interface TrajectoryTimelineRecordDetail {
  decodingMs?: number
  durationMs?: number
  startedAt?: number
  ttftMs?: number
}

function assistantTimingDetail(
  metrics: AssistantMetricDetail | undefined,
): Pick<TrajectoryTimelineRecordDetail, 'ttftMs' | 'decodingMs'> {
  const start = metrics?.stepStartTime
  const first = metrics?.firstTokenTime
  const completed = metrics?.completedTime
  if (
    metrics?.timingRecorded !== true ||
    !finite(start) ||
    !finite(first) ||
    !finite(completed) ||
    first < start ||
    completed < first
  )
    return {}
  return { ttftMs: first - start, decodingMs: completed - first }
}

/** Timing facts of one record. */
export function timelineRecordDetail(
  cell: TrajectoryCellProps,
): TrajectoryTimelineRecordDetail {
  const durationMs = finite(cell.timeSeconds)
    ? Math.max(0, cell.timeSeconds * 1_000)
    : undefined
  const startedAt = finite(cell.startedAt) ? cell.startedAt : undefined
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...assistantTimingDetail(cell.assistantMetrics),
  }
}

/** TTFT share of an assistant span (0..1), or null without both readings. */
export function timelineTtftFraction(
  detail: TrajectoryTimelineRecordDetail | undefined,
): number | null {
  const ttft = detail?.ttftMs
  const decoding = detail?.decodingMs
  if (ttft === undefined || decoding === undefined || ttft + decoding <= 0)
    return null
  return ttft / (ttft + decoding)
}

/** Upper-case role label of a record kind. */
export function timelineKindLabel(kind: TrajectoryCellKind): string {
  switch (kind) {
    case 'system':
      return 'SYSTEM'
    case 'user':
      return 'USER'
    case 'context':
      return 'CONTEXT'
    case 'compacted':
      return 'COMPACTED'
    case 'message':
      return 'ASSISTANT'
    case 'tool':
      return 'TOOL'
    case 'subtool':
      return 'SUBTOOL'
  }
}

function formatRecordedTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

/** Multi-line tooltip text of one timeline span. */
export function timelineTooltipLabel(
  kind: TrajectoryCellKind,
  detail: TrajectoryTimelineRecordDetail | undefined,
): string {
  const heading = timelineKindLabel(kind)
  if (detail === undefined) return heading
  const duration =
    detail.durationMs === undefined
      ? null
      : `Total ${formatTimelineOffset(detail.durationMs)}`
  const range =
    detail.startedAt === undefined
      ? null
      : detail.durationMs === undefined
        ? `Started ${formatRecordedTime(detail.startedAt)}`
        : `${formatRecordedTime(detail.startedAt)} → ${formatRecordedTime(
            detail.startedAt + detail.durationMs,
          )}`
  const segments =
    detail.ttftMs === undefined || detail.decodingMs === undefined
      ? null
      : `TTFT ${formatTimelineOffset(detail.ttftMs)} · Decoding ${formatTimelineOffset(
          detail.decodingMs,
        )}`
  const timing = [duration, segments]
    .filter((value) => value !== null)
    .join(' · ')
  return [heading, range, timing]
    .filter((value) => value !== null && value !== '')
    .join('\n')
}

// ── brush / zoom / pan math ───────────────────────────────────────────

/** Ascending range of two points. */
export function orderedRange(left: number, right: number): TrajectoryTimeRange {
  return left <= right
    ? { start: left, end: right }
    : { start: right, end: left }
}

/** Clamp to [0, 1]. */
export function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** A `width` range centered on `center`, kept inside [minimum, maximum]. */
export function centeredRange(
  center: number,
  width: number,
  minimum: number,
  maximum: number,
): TrajectoryTimeRange {
  const clampedWidth = Math.min(maximum - minimum, Math.max(0, width))
  const start = Math.min(
    Math.max(center - clampedWidth / 2, minimum),
    maximum - clampedWidth,
  )
  return { start, end: start + clampedWidth }
}

/** A domain range as fractions of the visible domain (may exceed [0, 1]). */
export function rangeFraction(
  range: TrajectoryTimeRange,
  start: number,
  duration: number,
  minimum: number,
  maximum: number,
): TrajectoryTimeRange {
  const bounded = orderedRange(
    Math.min(maximum, Math.max(minimum, range.start)),
    Math.min(maximum, Math.max(minimum, range.end)),
  )
  return {
    start: (bounded.start - start) / duration,
    end: (bounded.end - start) / duration,
  }
}

/** Visible domain of the overview (the full model or a zoomed viewport). */
export interface TrajectoryTimelineDomain {
  /** Full model duration (≥ 1). */
  readonly fullDuration: number
  readonly start: number
  readonly duration: number
  /** Whether a zoomed viewport is active. */
  readonly zoomed: boolean
}

/** Resolve the visible domain of a model under an optional viewport. */
export function timelineDomain(
  model: TrajectoryTimelineModel,
  viewport: TrajectoryTimeRange | null,
): TrajectoryTimelineDomain {
  const fullDuration = Math.max(1, model.end - model.start)
  if (viewport === null)
    return {
      fullDuration,
      start: model.start,
      duration: fullDuration,
      zoomed: false,
    }
  const duration = Math.min(
    fullDuration,
    Math.max(1, viewport.end - viewport.start),
  )
  const start = Math.min(
    Math.max(viewport.start, model.start),
    model.end - duration,
  )
  return { fullDuration, start, duration, zoomed: true }
}

/** Drop a viewport (or range) that no longer overlaps the model. */
export function retainTimelineRange(
  model: TrajectoryTimelineModel,
  range: TrajectoryTimeRange | null,
): TrajectoryTimeRange | null {
  if (range === null) return null
  return range.end < model.start || range.start > model.end ? null : range
}

/**
 * Wheel zoom around the pointer.
 * @param anchorFraction - Pointer position as a fraction of the track.
 * @param deltaY - Wheel delta (positive zooms out).
 * @returns The next viewport, or null when zoomed back out to the full model.
 */
export function zoomTimelineViewport(
  model: TrajectoryTimelineModel,
  domain: TrajectoryTimelineDomain,
  anchorFraction: number,
  deltaY: number,
  mode: TrajectoryTimelineMode,
): TrajectoryTimeRange | null {
  const minimum = Math.min(
    mode === 'sequence'
      ? TIMELINE_MINIMUM_ZOOM_OPERATIONS
      : TIMELINE_MINIMUM_ZOOM_MS,
    domain.fullDuration,
  )
  const nextDuration = Math.min(
    domain.fullDuration,
    Math.max(minimum, domain.duration * Math.exp(deltaY * WHEEL_ZOOM_RATE)),
  )
  if (nextDuration >= domain.fullDuration * 0.999) return null
  const fraction = clampFraction(anchorFraction)
  const anchorTime = domain.start + fraction * domain.duration
  const nextStart = Math.min(
    Math.max(anchorTime - fraction * nextDuration, model.start),
    model.end - nextDuration,
  )
  return { start: nextStart, end: nextStart + nextDuration }
}

/**
 * Right-button pan of a zoomed viewport.
 * @param anchorStart - Domain start when the pan began.
 * @param deltaFraction - Pointer travel as a fraction of the track width.
 */
export function panTimelineViewport(
  model: TrajectoryTimelineModel,
  anchorStart: number,
  duration: number,
  deltaFraction: number,
): TrajectoryTimeRange {
  const start = Math.min(
    Math.max(anchorStart - deltaFraction * duration, model.start),
    model.end - duration,
  )
  return { start, end: start + duration }
}

/**
 * Auto-pan while a range drag pushes against a track edge.
 * @param localX - Pointer x inside the track (px).
 * @param width - Track width (px).
 * @returns The next domain start (unchanged outside the edge zones).
 */
export function edgePanTimelineStart(
  model: TrajectoryTimelineModel,
  domain: TrajectoryTimelineDomain,
  localX: number,
  width: number,
): number {
  if (!domain.zoomed) return domain.start
  const edgeWidth = Math.min(
    MAXIMUM_EDGE_PAN_PX,
    Math.max(1, width * EDGE_PAN_ZONE_FRACTION),
  )
  const direction = localX < edgeWidth ? -1 : localX > width - edgeWidth ? 1 : 0
  if (direction === 0) return domain.start
  const edgeDistance =
    direction < 0 ? edgeWidth - localX : localX - (width - edgeWidth)
  const strength = clampFraction(edgeDistance / edgeWidth)
  const desired =
    domain.start +
    direction *
      domain.duration *
      EDGE_PAN_STEP_FRACTION *
      Math.max(0.2, strength)
  return Math.min(Math.max(desired, model.start), model.end - domain.duration)
}

/**
 * Pan a zoomed viewport just far enough to reveal a selected span.
 * @returns The same viewport when the span is visible (or no viewport).
 */
export function revealTimelineSpan(
  model: TrajectoryTimelineModel,
  viewport: TrajectoryTimeRange | null,
  span: TrajectoryTimeRange,
): TrajectoryTimeRange | null {
  if (viewport === null) return null
  if (span.end > viewport.start && span.start < viewport.end) return viewport
  const duration = Math.max(1, viewport.end - viewport.start)
  const desiredStart =
    span.end <= viewport.start ? span.start : span.end - duration
  const nextStart = Math.min(
    Math.max(desiredStart, model.start),
    Math.max(model.start, model.end - duration),
  )
  if (nextStart === viewport.start) return viewport
  return { start: nextStart, end: nextStart + duration }
}

/** Narrowest committed brush: one operation slot, capped by the domain. */
export function minimumTimelineSelection(
  model: TrajectoryTimelineModel,
  domain: TrajectoryTimelineDomain,
): number {
  return Math.min(domain.duration, domain.fullDuration / model.spans.length)
}

/**
 * Commit a brush gesture. A click (or a too-narrow drag) becomes a
 * minimum-width range centered on the press / drag midpoint.
 */
export function commitTimelineBrush(
  model: TrajectoryTimelineModel,
  domain: TrajectoryTimelineDomain,
  anchorTime: number,
  pointTime: number,
  click: boolean,
): TrajectoryTimeRange {
  const selected = orderedRange(anchorTime, pointTime)
  const minimum = minimumTimelineSelection(model, domain)
  return selected.end - selected.start < minimum
    ? centeredRange(
        click ? selected.start : (selected.start + selected.end) / 2,
        minimum,
        model.start,
        model.end,
      )
    : selected
}

/** Span nearest to a domain point (distance 0 inside a span). */
export function nearestTimelineSpan(
  model: TrajectoryTimelineModel,
  time: number,
): TrajectoryTimelineSpan | undefined {
  const distance = (span: TrajectoryTimeRange): number =>
    time < span.start
      ? span.start - time
      : time > span.end
        ? time - span.end
        : 0
  let nearest: TrajectoryTimelineSpan | undefined
  for (const span of model.spans) {
    if (nearest === undefined || distance(span) < distance(nearest))
      nearest = span
  }
  return nearest
}

/** Spans drawn in the visible domain (the selected record always included). */
export function visibleTimelineSpans(
  model: TrajectoryTimelineModel,
  domain: TrajectoryTimelineDomain,
  selectedIndex: number | null,
): readonly TrajectoryTimelineSpan[] {
  const end = domain.start + domain.duration
  return model.spans.filter(
    (span) =>
      span.index === selectedIndex ||
      (span.end >= domain.start && span.start <= end),
  )
}
