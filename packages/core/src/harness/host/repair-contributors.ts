/**
 * Every crash-repair contributor the host registers, and the rule that
 * proves the set is complete (`repair-matrix.test.ts`): each start marker
 * in the session event vocabulary is closed by a contributor, by the
 * built-in turn closer (`TURN_REPAIR`), or is listed in `EXEMPT_OPENERS`
 * with the reason it needs no closer.
 */

import type { RepairContributor } from '../../session-log/store'
import { approvalRepair } from '../approval/service'
import { compactionRepair } from '../compaction/events'
import { computerUseRepair } from '../computer-use/events'
import { jobRepair } from '../jobs/registry'
import { questionRepair } from '../questions/service'
import { subagentRepair } from '../subagent/manager'
import { workflowRepair } from '../workflow/records'

export const REPAIR_CONTRIBUTORS: readonly RepairContributor[] = [
  approvalRepair,
  questionRepair,
  computerUseRepair,
  compactionRepair,
  workflowRepair,
  jobRepair,
  subagentRepair,
]

/** Start markers that need no closer, and why. */
export const EXEMPT_OPENERS: Readonly<Record<string, string>> = {
  'llm/retry-started':
    'marks a retry attempt inside a step; the turn closer ends the step',
}

const OPENER =
  /(?:^|-)(?:start|started|begin|asked|requested|opened|prepared|dispatched)$/

/** Event types whose last path segment reads as the start of a pair. */
export function lifecycleOpeners(types: readonly string[]): string[] {
  return types.filter((type) => OPENER.test(type.split('/').at(-1) ?? ''))
}

/** Start markers no contributor closes and no exemption covers. */
export function unrepairedOpeners(
  types: readonly string[],
  contributors: ReadonlyArray<Pick<RepairContributor, 'pairs'>>,
): string[] {
  const closed = new Set(
    contributors.flatMap((contributor) =>
      contributor.pairs.map(([start]) => start),
    ),
  )
  return lifecycleOpeners(types).filter(
    (type) => !closed.has(type) && !(type in EXEMPT_OPENERS),
  )
}
