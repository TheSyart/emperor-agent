// Pure projection from trajectory records to measurable virtual ledger rows
// (ported from the dsh trajectory-virtual-rows). Fixed row heights feed the
// RecycleScroller of the trajectory table.
import type { TrajectoryCellProps } from './record'
import { trajectoryRecordId } from './record'

/** Height of one content row (px). */
export const TRAJECTORY_CONTENT_ROW_HEIGHT = 30
/** Height of one folded summary row (px). */
export const TRAJECTORY_COLLAPSED_SUMMARY_HEIGHT = 20
/** Lower-marker clearance of a terminal request boundary (px). */
export const TRAJECTORY_TERMINAL_BOUNDARY_HEIGHT = 9

/** Minimal record shape required by the trajectory virtual-row projection. */
export interface VirtualizableTrajectoryRecord {
  cell: TrajectoryCellProps
  collapsedSummaryKind?: 'turn' | 'assistant'
}

/** One logical record retained inside a measurable virtual row. */
export interface TrajectoryVirtualRowEntry<
  T extends VirtualizableTrajectoryRecord,
> {
  logicalIndex: number
  record: T
}

/** One virtualizer item, which may carry zero-height request boundaries. */
export interface TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> {
  entries: readonly TrajectoryVirtualRowEntry<T>[]
  height: number
  key: string
}

/**
 * Derive the DOM-safe row identity shared by the view, the virtualizer and
 * scroll anchoring.
 * @param record - Display record whose identity is required.
 * @returns Stable record identity with a suffix for synthetic fold summaries.
 */
export function trajectoryVirtualRecordKey(
  record: VirtualizableTrajectoryRecord,
): string {
  const identity = encodeURIComponent(trajectoryRecordId(record.cell))
  return record.collapsedSummaryKind === undefined
    ? identity
    : `${identity}\u0000summary\u0000${record.collapsedSummaryKind}`
}

/**
 * Attach separator-only records to the next content row so the virtualizer
 * never owns a zero-height item. A terminal separator retains its
 * lower-marker clearance as a standalone item.
 * @param records - Final search/fold projection in ledger order.
 * @returns Measurable virtual rows with original logical positions retained.
 */
export function groupTrajectoryVirtualRows<
  T extends VirtualizableTrajectoryRecord,
>(records: readonly T[]): readonly TrajectoryVirtualRow<T>[] {
  const rows: TrajectoryVirtualRow<T>[] = []
  let pending: TrajectoryVirtualRowEntry<T>[] = []

  for (const [logicalIndex, record] of records.entries()) {
    const entry = { logicalIndex, record }
    if (record.cell.requestOnly === true) {
      pending.push(entry)
      continue
    }
    const entries = [...pending, entry]
    pending = []
    rows.push({
      entries,
      height:
        record.collapsedSummaryKind === undefined
          ? TRAJECTORY_CONTENT_ROW_HEIGHT
          : TRAJECTORY_COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRecordKey(record),
    })
  }

  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TRAJECTORY_TERMINAL_BOUNDARY_HEIGHT,
      key: pending
        .map((candidate) => trajectoryVirtualRecordKey(candidate.record))
        .join('|'),
    })
  }

  return rows
}
