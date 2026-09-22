/** StateDot semantic: green done / amber attention / gold running chase / red error. */
export type StateDotState = 'ok' | 'warn' | 'error' | 'ongoing'

/** Outer 3x3 matrix cells (2px pixels on a 10px grid), clockwise from top-left. */
export const CHASE_CELLS: readonly (readonly [number, number])[] = [
  [0, 0],
  [4, 0],
  [8, 0],
  [8, 4],
  [8, 8],
  [4, 8],
  [0, 8],
  [0, 4],
]

/** Negative delays phase the chase so every cell animates from mount. */
export function chaseDelayMs(index: number): number {
  return (index - CHASE_CELLS.length) * 125
}

/** Class list for a solid dot (the ongoing state renders the SVG chase instead). */
export function stateDotClasses(state: StateDotState): string[] {
  return ['ds-state-dot', `ds-state-dot--${state}`]
}

/** Map arbitrary run/tool status strings onto the four dot states. */
export function stateFromStatus(status: string | undefined): StateDotState {
  switch (status) {
    case 'running':
    case 'pending':
    case 'streaming':
    case 'ongoing':
      return 'ongoing'
    case 'error':
    case 'failed':
    case 'denied':
      return 'error'
    case 'warning':
    case 'warn':
    case 'waiting':
    case 'interrupted':
      return 'warn'
    default:
      return 'ok'
  }
}
