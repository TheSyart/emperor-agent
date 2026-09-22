// Keyboard model of the trajectory ledger (pure). The table is a listbox:
// Up/Down/Home/End move the focused row (selection follows focus on record
// rows), Enter/Space select a record or toggle a folded summary, Left folds
// (assistant tool run first, then the whole turn), Right unfolds, Escape
// clears the inspector selection.
import {
  trajectoryAssistantToolCalls,
  trajectoryRecordId,
  type TrajectoryLedgerRecord,
} from '../../trajectory/model'

/** What a key press asks the table to do. */
export type LedgerKeyAction =
  | { readonly kind: 'move'; readonly position: number }
  | { readonly kind: 'select'; readonly index: number }
  | { readonly kind: 'toggle-turn'; readonly turn: number }
  | { readonly kind: 'toggle-assistant'; readonly id: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'none' }

/** Ledger state the key model reads. */
export interface LedgerKeyContext {
  /** Focusable display rows (request-only markers excluded), in order. */
  readonly rows: readonly TrajectoryLedgerRecord[]
  /** Focused position in `rows` (-1 when nothing is focused). */
  readonly position: number
  /** Unfolded ledger records (fold eligibility). */
  readonly records: readonly TrajectoryLedgerRecord[]
  readonly collapsedTurns: ReadonlySet<number>
  readonly collapsedAssistants: ReadonlySet<string>
}

const NONE: LedgerKeyAction = { kind: 'none' }

/** Whether a turn has more than one content record (can fold). */
export function turnCollapsible(
  records: readonly TrajectoryLedgerRecord[],
  turn: number,
): boolean {
  let count = 0
  for (const record of records) {
    if (
      record.turn === turn &&
      record.cell.requestOnly !== true &&
      record.cell.kind !== 'system'
    )
      count++
    if (count > 1) return true
  }
  return false
}

function summaryToggle(record: TrajectoryLedgerRecord): LedgerKeyAction {
  if (record.collapsedSummaryKind === 'turn' && record.turn !== null)
    return { kind: 'toggle-turn', turn: record.turn }
  return { kind: 'toggle-assistant', id: trajectoryRecordId(record.cell) }
}

/** Resolve one key press into a table action. */
export function ledgerKeyAction(
  key: string,
  context: LedgerKeyContext,
): LedgerKeyAction {
  const { rows, position } = context
  if (rows.length === 0) return NONE
  const last = rows.length - 1
  switch (key) {
    case 'ArrowDown':
      return {
        kind: 'move',
        position: position < 0 ? 0 : Math.min(last, position + 1),
      }
    case 'ArrowUp':
      return {
        kind: 'move',
        position: position < 0 ? last : Math.max(0, position - 1),
      }
    case 'Home':
      return { kind: 'move', position: 0 }
    case 'End':
      return { kind: 'move', position: last }
    case 'Escape':
      return { kind: 'clear' }
  }
  const record = rows[position]
  if (record === undefined) return NONE
  const summary = record.collapsedSummary !== undefined
  switch (key) {
    case 'Enter':
    case ' ':
      return summary
        ? summaryToggle(record)
        : { kind: 'select', index: record.cell.index }
    case 'ArrowLeft': {
      if (summary) return NONE
      const id = trajectoryRecordId(record.cell)
      if (
        record.cell.kind === 'message' &&
        !context.collapsedAssistants.has(id) &&
        trajectoryAssistantToolCalls(context.records, record.cell.index)
          .length > 0
      )
        return { kind: 'toggle-assistant', id }
      if (
        record.turn !== null &&
        !context.collapsedTurns.has(record.turn) &&
        turnCollapsible(context.records, record.turn)
      )
        return { kind: 'toggle-turn', turn: record.turn }
      return NONE
    }
    case 'ArrowRight': {
      if (summary) return summaryToggle(record)
      if (record.turn !== null && context.collapsedTurns.has(record.turn))
        return { kind: 'toggle-turn', turn: record.turn }
      const id = trajectoryRecordId(record.cell)
      if (record.cell.kind === 'message' && context.collapsedAssistants.has(id))
        return { kind: 'toggle-assistant', id }
      return NONE
    }
  }
  return NONE
}
