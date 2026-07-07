import type { CompactionRange, CompactionTrigger, SessionMemoryCursor } from './compaction-models'

export interface HistoryCompactionIndex {
  lastCompletedTurnSeq(): number
  seqBeforeLastNTurns(n: number): number
  countCompletedTurns(fromSeq: number, toSeq: number): number
}

export interface SelectCompactionRangeInput {
  sessionId: string
  cursor: SessionMemoryCursor
  history: HistoryCompactionIndex
  trigger: CompactionTrigger
  keepTailTurns: number
}

export function selectCompactionRange(input: SelectCompactionRangeInput): CompactionRange | null {
  const fromSeq = Math.max(1, Math.trunc(Number(input.cursor.compactedUntilSeq) || 0) + 1)
  const stableBoundarySeq = Math.trunc(Number(input.history.lastCompletedTurnSeq()) || 0)
  if (stableBoundarySeq < fromSeq) return null

  const force = input.trigger.kind === 'manual' && input.trigger.force === true
  const keepTailFromSeq = force
    ? stableBoundarySeq + 1
    : Math.trunc(Number(input.history.seqBeforeLastNTurns(input.keepTailTurns)) || stableBoundarySeq + 1)
  const toSeq = force
    ? stableBoundarySeq
    : Math.min(stableBoundarySeq, keepTailFromSeq - 1)
  if (toSeq < fromSeq) return null

  const completedTurnCount = input.history.countCompletedTurns(fromSeq, toSeq)
  if (completedTurnCount < 1) return null

  return {
    sessionId: input.sessionId,
    fromSeq,
    toSeq,
    keepTailFromSeq,
    stableBoundarySeq,
    completedTurnCount,
    reason: input.trigger.kind,
  }
}
