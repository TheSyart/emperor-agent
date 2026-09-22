// Pure derivations of the trajectory inspector (ported from the dsh
// TrajectoryTable local inspector): tab sets per selection, the selected
// request's facts (status, counts, usage, timing, result record), record
// locations and the prompt diff lines.
import { structuredPatch } from 'diff'
import {
  TRAJECTORY_REQUEST_TABS,
  trajectoryDetailTabs,
  trajectoryRecordState,
  trajectoryRequestKey,
  trajectorySectionLabel,
  type TrajectoryDetailTabItem,
  type TrajectoryLedgerRecord,
  type TrajectoryRecordState,
  type TrajectoryRequestNumber,
  type TrajectoryUsage,
} from '../../../trajectory/model'
import { formatDurationMs, type InspectorRow } from '../trajectoryFormat'
import type { TrajectorySelection } from '../useTrajectory'

type RequestSelection = Extract<TrajectorySelection, { kind: 'request' }>

/** Inspector tabs of a record (compaction raw output relabelled as in dsh). */
export function recordInspectorTabs(
  record: TrajectoryLedgerRecord,
): readonly TrajectoryDetailTabItem[] {
  const tabs = trajectoryDetailTabs(record.cell)
  return record.cell.kind === 'compacted'
    ? tabs.map((tab) =>
        tab.id === 'raw' ? { id: 'raw', label: 'Raw Output' } : tab,
      )
    : tabs
}

/** `Turn N · Step M` / `Between turns` location of a record. */
export function recordLocation(record: TrajectoryLedgerRecord): string {
  if (record.cell.kind === 'compacted')
    return trajectorySectionLabel(record.turn)
  return `${trajectorySectionLabel(record.turn)} · ${record.group}`
}

/** Everything the request inspector shows for one selected request. */
export interface RequestInspection {
  readonly number: number | undefined
  readonly info: TrajectoryRequestNumber | undefined
  readonly state: TrajectoryRecordState
  readonly location: string
  readonly compaction: boolean
  readonly toolCalls: number
  readonly subtoolCalls: number
  /** Assistant message of the request (timing fallback, usage fallback). */
  readonly assistant: TrajectoryLedgerRecord | undefined
  /** First record of the request's group. */
  readonly anchor: TrajectoryLedgerRecord | undefined
  /** Assistant message / compacted summary the request produced. */
  readonly result: TrajectoryLedgerRecord | undefined
  readonly usage: TrajectoryUsage | undefined
  readonly cumulativeUsage: TrajectoryUsage | undefined
  readonly options: object | undefined
  readonly tabs: readonly TrajectoryDetailTabItem[]
}

/** Inputs of `inspectRequest` (controller state, live records). */
export interface RequestInspectionInput {
  readonly selection: RequestSelection
  /** Unfolded ledger records with live content applied. */
  readonly records: readonly TrajectoryLedgerRecord[]
  readonly requestNumbers: readonly TrajectoryRequestNumber[]
  readonly displayNumbers: ReadonlyMap<string, number>
}

/** Resolve the selected request's inspector facts. */
export function inspectRequest(
  input: RequestInspectionInput,
): RequestInspection {
  const { selection, records } = input
  const groupRecords = records.filter(
    (record) =>
      record.turn === selection.turn && record.group === selection.group,
  )
  const assistant = groupRecords.find(
    (record) => record.cell.kind === 'message',
  )
  const anchor = assistant ?? groupRecords[0]
  const number = input.displayNumbers.get(
    trajectoryRequestKey(selection.turn, selection.group),
  )
  const info = input.requestNumbers.find((request) =>
    selection.seq === undefined
      ? request.turn === selection.turn && request.group === selection.group
      : request.seq === selection.seq,
  )
  const state: TrajectoryRecordState =
    info?.status ??
    (assistant?.cell.assistantMetrics?.completedTime === null
      ? 'running'
      : assistant === undefined &&
          groupRecords.some(
            (record) => trajectoryRecordState(record.cell) === 'running',
          )
        ? 'running'
        : 'complete')
  const result =
    info?.resultSeq === undefined
      ? assistant
      : (records.find((record) => record.cell.sourceSeq === info.resultSeq) ??
        assistant)
  const cell = assistant?.cell
  const usage =
    info?.usage ??
    (cell === undefined
      ? undefined
      : {
          ...(cell.input === undefined ? {} : { input: cell.input }),
          ...(cell.cacheRead === undefined
            ? {}
            : { cacheRead: cell.cacheRead }),
          ...(cell.cacheWrite === undefined
            ? {}
            : { cacheWrite: cell.cacheWrite }),
          ...(cell.output === undefined ? {} : { output: cell.output }),
          ...(cell.think === undefined ? {} : { reasoning: cell.think }),
        })
  const compaction = info?.purpose === 'compaction'
  const options = info?.requestConfig as object | undefined
  return {
    number,
    info,
    state,
    location: compaction
      ? `Compaction · ${trajectorySectionLabel(selection.turn)}`
      : trajectorySectionLabel(selection.turn),
    compaction,
    toolCalls: groupRecords.filter((record) => record.cell.kind === 'tool')
      .length,
    subtoolCalls: groupRecords.filter(
      (record) => record.cell.kind === 'subtool',
    ).length,
    assistant,
    anchor,
    result,
    usage,
    cumulativeUsage: info?.cumulativeUsage ?? usage,
    options,
    tabs: TRAJECTORY_REQUEST_TABS.filter(
      (tab) => tab.id !== 'options' || options !== undefined,
    ),
  }
}

/** Request timing rows: Started is separate; TTFT / decode / tok/s. */
export function requestTimingRows(
  inspection: RequestInspection,
): readonly InspectorRow[] {
  const info = inspection.info
  const rows: InspectorRow[] = []
  if (info?.startedAt !== undefined) {
    const completed = info.completedAt
    rows.push({
      label: 'Duration',
      value:
        completed === null || completed === undefined
          ? 'Running'
          : formatDurationMs(Math.max(0, completed - info.startedAt)),
    })
  }
  const ttft = info?.timing?.ttftMs
  const decode = info?.timing?.decodeMs
  if (ttft !== undefined && ttft !== null)
    rows.push({ label: 'TTFT', value: formatDurationMs(ttft) })
  if (decode !== undefined && decode !== null)
    rows.push({ label: 'Decode', value: formatDurationMs(decode) })
  const output = inspection.usage?.output
  if (
    decode !== undefined &&
    decode !== null &&
    decode > 0 &&
    output !== undefined
  )
    rows.push({
      label: 'Throughput',
      value: `${(output / (decode / 1_000)).toFixed(1)} tok/s`,
    })
  if (info?.retry !== undefined)
    rows.push({
      label: 'Retry',
      value: `Scheduled ${info.retry}${info.maxRetries === undefined ? '' : ` of ${info.maxRetries}`}`,
    })
  if (info?.retryDelayMs !== undefined)
    rows.push({
      label: 'Retry delay',
      value: formatDurationMs(info.retryDelayMs),
    })
  return rows
}

/** One line of a unified prompt diff. */
export interface PromptDiffLine {
  readonly kind: 'meta' | 'context' | 'added' | 'removed'
  readonly text: string
}

/** Unified diff lines (3 lines of context) between two prompt texts. */
export function promptDiffLines(
  before: string,
  after: string,
): readonly PromptDiffLine[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, {
    context: 3,
  })
  return patch.hunks.flatMap((hunk, hunkIndex) => [
    ...(hunkIndex === 0 ? [] : [{ kind: 'meta' as const, text: '' }]),
    {
      kind: 'meta' as const,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    },
    ...hunk.lines.flatMap((line): PromptDiffLine[] => {
      if (line.startsWith('\\')) return []
      if (line.startsWith('+')) return [{ kind: 'added', text: line }]
      if (line.startsWith('-')) return [{ kind: 'removed', text: line }]
      return [{ kind: 'context', text: line }]
    }),
  ])
}
