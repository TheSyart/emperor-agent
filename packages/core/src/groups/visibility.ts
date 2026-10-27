/**
 * Whether a member has a group message in its context (GRP-06). The user
 * always sees everything; this only decides what each agent is delivered.
 */
import type { ContactId, GroupMessage } from './types'

export function visibleTo(
  message: Pick<GroupMessage, 'audience' | 'from' | 'batchId'>,
  member: ContactId,
  revealed: ReadonlySet<string>,
): boolean {
  if (message.audience.kind === 'private')
    return message.audience.to === member || message.from === member
  // An independent answer stays with its author until the batch is revealed.
  if (message.batchId && !revealed.has(message.batchId))
    return message.from === member
  return true
}
