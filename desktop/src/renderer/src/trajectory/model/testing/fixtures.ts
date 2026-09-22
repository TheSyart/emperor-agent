// Test-only helpers for the trajectory model (node fs via the conversation
// fixtures). Imported by `*.test.ts` only.
import type { WireSessionEvent } from '@emperor/core/runtime-contract'
import type { ConversationAssembler } from '../../../conversation/assembler'
import type { TrajectorySnapshot } from '../contract'
import { createTrajectoryAssembler, trajectorySnapshotOf } from '../extension'
import type { TrajectoryTurnModel } from '../layout'

/** Assemble a complete event list in one replace + flush. */
export function replayTrajectory(events: readonly WireSessionEvent[]): {
  assembler: ConversationAssembler
  snapshot: TrajectorySnapshot
} {
  const assembler = createTrajectoryAssembler()
  assembler.replaceWindow(events, false)
  assembler.flush()
  return { assembler, snapshot: trajectorySnapshotOf(assembler) }
}

/** Append events one by one (live path), flushing after each. */
export function streamTrajectory(events: readonly WireSessionEvent[]): {
  assembler: ConversationAssembler
  snapshot: TrajectorySnapshot
} {
  const assembler = createTrajectoryAssembler()
  assembler.replaceWindow([], false)
  assembler.flush()
  for (const event of events) {
    assembler.append(event)
    assembler.flush()
  }
  return { assembler, snapshot: trajectorySnapshotOf(assembler) }
}

/** One readable line per record: `#index kind[group] text`. */
export function describeLayout(
  turns: readonly TrajectoryTurnModel[],
): string[] {
  return turns.flatMap((turn) => [
    turn.turn === null ? '== Between turns' : `== Turn ${turn.turn}`,
    ...turn.groups.flatMap((group) => [
      `-- ${group.title}${group.description === undefined ? '' : ` (${group.description})`}`,
      ...group.cells.map((cell) =>
        [
          `#${cell.index} ${cell.kind}${cell.requestOnly === true ? '(request)' : ''}:`,
          cell.text === '' ? undefined : cell.text,
          cell.previewMarkdown === undefined
            ? undefined
            : `| ${cell.previewMarkdown.replace(/\s+/g, ' ').slice(0, 40)}`,
        ]
          .filter((part) => part !== undefined)
          .join(' '),
      ),
    ]),
  ])
}
