// View-level derivations of the dsh TrajectoryView, framework-free: the
// finalized layout (streaming partial reduced to a stable anchor), the
// streamed tail appended to it, request numbering, fold targets and search
// matches. The Vue view memoizes these on the snapshot fields they read.
import type {
  TrajectoryAssistantBlock,
  TrajectoryPartialAssistant,
  TrajectorySnapshot,
} from './contract'
import {
  appendTrajectoryPartialLayout,
  deriveTrajectoryLayout,
  type TrajectoryTurnModel,
} from './layout'
import { trajectoryRecordId } from './record'
import {
  deriveTrajectoryRequestNumbers,
  type TrajectoryRequestNumber,
} from './requests'

/** Highest record index of a layout (0 when empty). */
export function trajectoryLastCellIndex(
  turns: readonly TrajectoryTurnModel[],
): number {
  let last = 0
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) last = Math.max(last, cell.index)
    }
  }
  return last
}

function structureBlock(
  block: TrajectoryAssistantBlock,
): TrajectoryAssistantBlock {
  switch (block.kind) {
    case 'text':
      return { kind: 'text', text: '' }
    case 'reasoning':
      return { kind: 'reasoning', text: '' }
    case 'image':
      return block
    case 'tool-call':
      return {
        kind: 'tool-call',
        callId: block.callId,
        name: block.name,
        argsRaw: '',
      }
    case 'other':
      return { kind: 'other', block: null }
  }
}

/**
 * Structural signature of a streaming partial: changes only when a block is
 * added or a tool call is named, not on every text delta.
 */
export function trajectoryPartialSignature(
  partial: TrajectoryPartialAssistant | null,
): string {
  if (partial === null) return ''
  return partial.blocks
    .map((block) =>
      block.kind === 'tool-call'
        ? `${block.kind}:${block.callId}:${block.name}`
        : block.kind,
    )
    .join('\u0000')
}

/** The partial with its text emptied (timeline only needs its structure). */
export function trajectoryTimelinePartial(
  partial: TrajectoryPartialAssistant | null,
): TrajectoryPartialAssistant | null {
  return partial === null
    ? null
    : {
        turn: partial.turn,
        step: partial.step,
        blocks: partial.blocks.map(structureBlock),
      }
}

/** Finalized layout plus its last record index. */
export interface TrajectoryFinalizedLayout {
  readonly turns: readonly TrajectoryTurnModel[]
  readonly lastIndex: number
}

/**
 * Layout of the finalized records. The partial is reduced to an empty
 * anchor so streaming deltas never invalidate it.
 */
export function deriveTrajectoryFinalizedLayout(
  snapshot: TrajectorySnapshot,
): TrajectoryFinalizedLayout {
  const partial = snapshot.partial
  const turns = deriveTrajectoryLayout({
    nodes: snapshot.eventNodes,
    eventLocations: snapshot.eventLocations,
    partial:
      partial === null
        ? null
        : { turn: partial.turn, step: partial.step, blocks: [] },
    runningCalls: snapshot.runningCalls,
    requests: snapshot.requests,
    callSchemas: snapshot.callSchemas,
  })
  return { turns, lastIndex: trajectoryLastCellIndex(turns) }
}

/** Complete view model of one trajectory snapshot. */
export interface TrajectoryViewModel {
  /** Finalized layout with the streamed tail appended. */
  readonly turns: readonly TrajectoryTurnModel[]
  /** Finalized layout only. */
  readonly finalized: TrajectoryFinalizedLayout
  /** Streaming records only (for search while streaming). */
  readonly streamingTurns: readonly TrajectoryTurnModel[]
  readonly requestNumbers: readonly TrajectoryRequestNumber[]
}

/** Derive the full view model of a snapshot in one pass (tests, exports). */
export function deriveTrajectoryViewModel(
  snapshot: TrajectorySnapshot,
): TrajectoryViewModel {
  const finalized = deriveTrajectoryFinalizedLayout(snapshot)
  return {
    finalized,
    turns: appendTrajectoryPartialLayout(
      finalized.turns,
      snapshot.partial,
      finalized.lastIndex,
    ),
    streamingTurns: appendTrajectoryPartialLayout(
      [],
      snapshot.partial,
      finalized.lastIndex,
    ),
    requestNumbers: deriveTrajectoryRequestNumbers(
      snapshot.eventNodes,
      snapshot.requests,
    ),
  }
}

/** Turns with more than one content record (collapsible). */
export function trajectoryCollapsibleTurnIds(
  turns: readonly TrajectoryTurnModel[],
): readonly number[] {
  return turns.flatMap((turn) => {
    if (turn.turn === null) return []
    const content = turn.groups.reduce(
      (count, group) =>
        count +
        group.cells.filter(
          (cell) => cell.requestOnly !== true && cell.kind !== 'system',
        ).length,
      0,
    )
    return content > 1 ? [turn.turn] : []
  })
}

/** Assistant records directly followed by tool rows (collapsible). */
export function trajectoryCollapsibleAssistantIds(
  turns: readonly TrajectoryTurnModel[],
): readonly string[] {
  const ids: string[] = []
  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) => group.cells)
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index]
      if (cell?.kind !== 'message') continue
      const next = cells[index + 1]
      if (next?.kind === 'tool' || next?.kind === 'subtool')
        ids.push(trajectoryRecordId(cell))
    }
  }
  return ids
}

/** Record indexes of the layouts whose identity matched a search. */
export function trajectorySearchMatchIndexes(
  layouts: readonly (readonly TrajectoryTurnModel[])[],
  matches: ReadonlySet<string> | null,
): ReadonlySet<number> | null {
  if (matches === null) return null
  const indexes = new Set<number>()
  for (const turns of layouts) {
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const cell of group.cells) {
          if (matches.has(trajectoryRecordId(cell))) indexes.add(cell.index)
        }
      }
    }
  }
  return indexes
}

/** Find the record of a tool call (Inspect deep link `?call=`). */
export function findTrajectoryCallRecord(
  turns: readonly TrajectoryTurnModel[],
  callId: string,
): { turn: number | null; group: string; index: number } | undefined {
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) {
        if (cell.callId === callId)
          return { turn: turn.turn, group: group.title, index: cell.index }
      }
    }
  }
  return undefined
}
