// The recorded raw kernel log (core raw-golden.test.ts) as a gallery
// scenario: root session + its delegated child.
import type { SessionHistoryPage } from '@emperor/core/runtime-contract'
import kernelLog from '../../../../../../../packages/core/src/harness/projection/__golden__/kernel-turn.log.json'
import type { Scenario } from './scenarios'

interface KernelLog {
  readonly root: SessionHistoryPage
  readonly children: readonly SessionHistoryPage[]
}

export function kernelScenario(): Scenario {
  const log = kernelLog as unknown as KernelLog
  return {
    id: 'kernel',
    label: '录制内核日志',
    sessions: [
      { id: 'kernel', events: [...log.root.events] },
      ...log.children.map((child) => ({
        id: child.header.id,
        events: [...child.events],
        origin: 'subagent' as const,
      })),
    ],
  }
}
