// A subagent's result (AGT-06): `delegation/result` records, written when a
// write run's result is recorded and whenever it is applied, undone or
// discarded. One card per delegation, at the time its current run's result
// arrived, showing the latest state.
import type { DelegationResultRecord } from '@emperor/core/runtime-contract'
import type {
  ConversationDefinition,
  ConversationNodeContext,
} from '../assembler'
import { isEvent } from '../events'
import type { DelegationResultChatData } from '../types'
import { chatNode } from './common'

function viewData(record: DelegationResultRecord): DelegationResultChatData {
  return {
    delegationId: record.delegation_id,
    runId: record.run_id,
    backend: record.backend,
    ...(record.title ? { title: record.title } : {}),
    state: record.state,
    files: record.files,
    totals: record.totals,
    truncated: record.truncated === true,
    conflicts: record.conflicts ?? [],
    at: record.at,
    ...(record.by ? { by: record.by } : {}),
    undoable: record.undoable === true,
    verifyFirst: record.verify_first === true,
    ...(record.reverted ? { reverted: record.reverted } : {}),
  }
}

function latest(
  context: ConversationNodeContext,
): { record: DelegationResultRecord; anchor: number } | null {
  let record: DelegationResultRecord | null = null
  let anchor = 0
  for (const match of context.matches) {
    const event = match.event
    if (!isEvent(event, 'delegation/result')) continue
    // A later run's result moves the card to when it arrived.
    if (record === null || record.run_id !== event.data.run_id)
      anchor = event.seq
    record = event.data
  }
  return record === null ? null : { record, anchor }
}

/** The 「Codex 改了 N 个文件」 card of one delegation. */
export const delegationResultDefinition: ConversationDefinition<null> = {
  kind: 'delegationResult',
  target: 'chat',
  match: (event) =>
    isEvent(event, 'delegation/result')
      ? { id: String(event.data.delegation_id), role: 'update' }
      : null,
  start: () => null,
  update: () => null,
  buildViewNode: (context) => {
    const found = latest(context)
    if (found === null || found.record.totals.files === 0) return null
    return chatNode(
      context,
      'delegationResult',
      found.anchor,
      viewData(found.record),
      { location: { kind: 'unresolved' } },
    )
  },
}
