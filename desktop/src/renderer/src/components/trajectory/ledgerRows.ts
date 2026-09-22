// Display projection of the trajectory table (pure): search / fold state →
// ledger records → fixed-height virtual rows with their pixel offsets, plus
// the per-record request-boundary marker facts. Mirrors the record pipeline
// of the dsh TrajectoryTable so the Vue table only renders rows.
import {
  collapseTrajectoryAssistants,
  collapseTrajectoryTurns,
  filterTrajectoryRecords,
  groupTrajectoryVirtualRows,
  trajectoryRequestKey,
  type TrajectoryLedgerRecord,
  type TrajectoryRequestNumber,
  type TrajectoryVirtualRow,
} from '../../trajectory/model'

/** Fold / search state applied to the unfolded ledger records. */
export interface LedgerDisplayState {
  readonly collapsedTurns: ReadonlySet<number>
  readonly collapsedAssistants: ReadonlySet<string>
  /** Record indexes matching the live search (null without a query). */
  readonly searchMatches: ReadonlySet<number> | null
}

/**
 * Display records: a search shows only its matches (folds ignored, as in
 * dsh); otherwise collapsed turns and assistant tool runs fold into
 * summary rows.
 */
export function deriveLedgerDisplay(
  records: readonly TrajectoryLedgerRecord[],
  state: LedgerDisplayState,
): TrajectoryLedgerRecord[] {
  if (state.searchMatches !== null)
    return filterTrajectoryRecords(records, state.searchMatches)
  const turns =
    state.collapsedTurns.size === 0
      ? [...records]
      : collapseTrajectoryTurns(records, state.collapsedTurns)
  return state.collapsedAssistants.size === 0
    ? turns
    : collapseTrajectoryAssistants(turns, state.collapsedAssistants)
}

/** One measured virtual row with its offset from the list top. */
export interface LedgerRow extends TrajectoryVirtualRow<TrajectoryLedgerRecord> {
  readonly top: number
  /** The content record (absent for a terminal request-only row). */
  readonly content?: TrajectoryLedgerRecord
}

/** Rows plus their total height. */
export interface LedgerRowLayout {
  readonly rows: readonly LedgerRow[]
  readonly height: number
  /** Row position of every content record id (summaries excluded). */
  readonly rowByRecordIndex: ReadonlyMap<number, number>
}

/** Group display records into fixed-height rows with offsets. */
export function layoutLedgerRows(
  display: readonly TrajectoryLedgerRecord[],
): LedgerRowLayout {
  let top = 0
  const rowByRecordIndex = new Map<number, number>()
  const rows = groupTrajectoryVirtualRows(display).map((row, position) => {
    const last = row.entries.at(-1)?.record
    const content = last?.cell.requestOnly === true ? undefined : last
    if (content !== undefined && content.collapsedSummary === undefined)
      rowByRecordIndex.set(content.cell.index, position)
    const laid: LedgerRow = {
      ...row,
      top,
      ...(content === undefined ? {} : { content }),
    }
    top += row.height
    return laid
  })
  return { rows, height: top, rowByRecordIndex }
}

/** Request boundary marker drawn on one record. */
export interface RequestMarker {
  readonly number: number
  readonly label: string
  readonly status?: 'complete' | 'running' | 'error'
  readonly runIndex: number
  readonly turn: number | null
  readonly group: string
  readonly seq?: number
  readonly compaction: boolean
}

/** Inputs of `requestMarkerOf` (controller maps). */
export interface RequestMarkerContext {
  readonly boundaries: ReadonlyMap<string, number>
  readonly displayNumbers: ReadonlyMap<string, number>
  /** Session request facts by display number. */
  readonly requestsByNumber: ReadonlyMap<number, TrajectoryRequestNumber>
  readonly collapsedTurns: ReadonlySet<number>
  readonly runIndexes: ReadonlyMap<number, number>
}

/** The request marker a display record carries, if it is a boundary. */
export function requestMarkerOf(
  record: TrajectoryLedgerRecord,
  context: RequestMarkerContext,
): RequestMarker | undefined {
  if (record.collapsedSummary !== undefined) return undefined
  if (record.turn !== null && context.collapsedTurns.has(record.turn))
    return undefined
  const key = trajectoryRequestKey(record.turn, record.group)
  if (context.boundaries.get(key) !== record.cell.index) return undefined
  const number = context.displayNumbers.get(key)
  if (number === undefined) return undefined
  const info = context.requestsByNumber.get(number)
  const compaction = info?.purpose === 'compaction'
  const status =
    info?.status ?? (record.cell.isError === true ? 'error' : undefined)
  return {
    number,
    label: `Request #${number}${compaction ? ' · Compaction' : ''}`,
    ...(status === undefined ? {} : { status }),
    runIndex: context.runIndexes.get(record.cell.index) ?? 0,
    turn: record.turn,
    group: record.group,
    ...(info?.seq === undefined ? {} : { seq: info.seq }),
    compaction,
  }
}

/** Last row whose top is at or above `offset` (binary search). */
export function rowAtOffset(
  rows: readonly LedgerRow[],
  offset: number,
): number {
  let low = 0
  let high = rows.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    const row = rows[middle]
    if (row === undefined) break
    if (row.top <= offset) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** Token / time totals of one turn (sticky turn header columns). */
export interface TurnTotals {
  readonly input?: number
  readonly output?: number
  readonly think?: number
  /** Wall span from the first record start to the last record end (s). */
  readonly timeSeconds: number | null
}

/** Sum the assistant usage and wall span of one ledger section. */
export function turnTotals(
  records: readonly TrajectoryLedgerRecord[],
  section: number,
): TurnTotals {
  let input: number | undefined
  let output: number | undefined
  let think: number | undefined
  let start: number | null = null
  let end: number | null = null
  for (const record of records) {
    if (record.section !== section) continue
    const cell = record.cell
    if (cell.kind === 'message') {
      const prompt =
        cell.input === undefined &&
        cell.cacheRead === undefined &&
        cell.cacheWrite === undefined
          ? undefined
          : (cell.input ?? 0) + (cell.cacheRead ?? 0) + (cell.cacheWrite ?? 0)
      if (prompt !== undefined) input = (input ?? 0) + prompt
      if (cell.output !== undefined) output = (output ?? 0) + cell.output
      if (cell.think !== undefined) think = (think ?? 0) + cell.think
    }
    const began = cell.startedAt
    if (began === undefined || began === null || !Number.isFinite(began))
      continue
    start = start === null ? began : Math.min(start, began)
    const finished = began + Math.max(0, (cell.timeSeconds ?? 0) * 1_000)
    end = end === null ? finished : Math.max(end, finished)
  }
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(think === undefined ? {} : { think }),
    timeSeconds:
      start === null || end === null
        ? null
        : Math.max(0, (end - start) / 1_000),
  }
}
