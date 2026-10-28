/**
 * What a member is handed when it is asked to speak (GRP-06): the messages
 * after its cursor that it may see, as timed lines naming sender and
 * audience. The scheduler sends this as one relay message to the member's
 * session and then records a `group/delivery` event.
 */
import { isPublic } from './digest'
import type { GroupState } from './events'
import type {
  ContactId,
  GroupMember,
  GroupMessage,
  GroupTaskAccess,
} from './types'
import { visibleTo } from './visibility'

export function pendingDelivery(
  state: GroupState,
  member: ContactId,
): GroupMessage[] {
  if (!state.members.includes(member)) return []
  const cursor = state.cursors.get(member)
  const start =
    cursor === undefined
      ? 0
      : state.messages.findIndex((m) => m.id === cursor) + 1
  return state.messages
    .slice(start)
    .filter((m) => visibleTo(m, member, state.revealed))
}

/** HH:MM in UTC+8, the product's clock for logs and memory. */
function clock(at: number): string {
  const d = new Date(at + 8 * 3_600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function who(
  id: string,
  roster: readonly GroupMember[],
  self: ContactId,
): string {
  if (id === 'user') return '用户'
  if (id === 'system') return '系统'
  if (id === self) return '你'
  return roster.find((m) => m.id === id)?.name ?? '已删除的联系人'
}

export const ACCESS_LABELS: Record<GroupTaskAccess, string> = {
  group_files: '可以读写群文件',
  readonly: '只读',
  isolated_worktree: '在独立的工作树里改',
}

/**
 * Lines like `[10:42] 审稿人 → @架构师：…`, written for member `self`: the
 * user is 「用户」 and `self` is 「你」.
 */
export function formatDelivery(
  messages: readonly GroupMessage[],
  roster: readonly GroupMember[],
  self: ContactId,
): string {
  return messages
    .map((m) => {
      const from = who(m.from, roster, self)
      const to =
        m.audience.kind === 'private'
          ? `${who(m.audience.to, roster, self)}（私信）`
          : m.audience.kind === 'members'
            ? m.audience.ids.map((id) => `@${who(id, roster, self)}`).join(' ')
            : '所有人'
      if (m.kind === 'task' && m.task) {
        // The whole task, not just its title (GRP-17): whoever reads it
        // before the task runs must not have to guess the job.
        const task = m.task
        const assignee =
          task.to === self ? '你' : ` ${who(task.to, roster, self)}`
        return [
          `[${clock(m.at)}] ${from} → ${to}（交办给${assignee}）：${task.title}`,
          `  交付物：${task.deliverable}`,
          ...(task.basis ? [`  依据：${task.basis}`] : []),
          `  权限：${ACCESS_LABELS[task.access]}`,
        ].join('\n')
      }
      const tag =
        m.kind === 'task' ? '（交办）' : m.kind === 'summary' ? '（结论）' : ''
      return `[${clock(m.at)}] ${from} → ${to}${tag}：${m.text}`
    })
    .join('\n')
}

export interface DeliveryPlan {
  /** The 群纪要 to hand over first, when the backlog is summarised. */
  digest: string | null
  messages: GroupMessage[]
  /** The backlog does not fit and no digest covers it: write one first. */
  needsDigest: boolean
}

/**
 * Deliver everything pending while it fits in `limit` tokens; otherwise use
 * the latest 群纪要 and what came after it, or say a digest is needed. The
 * digest holds public messages only, so a member's own private messages
 * (and its unrevealed answers) from before the cut are kept.
 */
export function planDelivery(
  state: GroupState,
  member: ContactId,
  estimateTokens: (text: string) => number,
  limit = 8_000,
): DeliveryPlan {
  const pending = pendingDelivery(state, member)
  const size = (list: readonly GroupMessage[]) =>
    estimateTokens(list.map((m) => m.text).join('\n'))
  if (size(pending) <= limit)
    return { digest: null, messages: pending, needsDigest: false }
  const digest = state.digest
  const cut = digest ? pending.findIndex((m) => m.id === digest.upTo) : -1
  if (!digest || cut < 0)
    return { digest: null, messages: pending, needsDigest: true }
  const after = pending.filter(
    (m, i) => i > cut || !isPublic(m, state.revealed),
  )
  if (estimateTokens(digest.text) + size(after) > limit)
    return { digest: null, messages: pending, needsDigest: true }
  return { digest: digest.text, messages: after, needsDigest: false }
}
