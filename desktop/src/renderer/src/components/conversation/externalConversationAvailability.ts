import type { CoreOperationResult } from '@emperor/core/api'

export type OwningRootAvailability =
  'loading' | 'available' | 'archived' | 'missing' | 'error'
export type ExternalConversationAvailability =
  | 'loading'
  | 'ready'
  | 'missing_root'
  | 'missing_delegation'
  | 'unreadable'
  | 'corrupt_public_log'
  | 'error'

export function owningRootAvailability(
  id: string,
  sessions: CoreOperationResult<'sessions.list'>,
): OwningRootAvailability {
  const root = sessions.find((session) => session.id === id)
  return !root ? 'missing' : root.archived_at ? 'archived' : 'available'
}
export function externalConversationFailure(
  cause: unknown,
): ExternalConversationAvailability {
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : undefined
  if (code === 'ROOT_NOT_FOUND') return 'missing_root'
  if (code === 'TRANSCRIPT_CORRUPT') return 'corrupt_public_log'
  if (code === 'DELEGATION_NOT_FOUND') return 'missing_delegation'
  if (code === 'PERMISSION_DENIED' || code === 'PERMISSION_REVOKED')
    return 'unreadable'
  return 'error'
}
export const externalConversationMessages: Record<
  ExternalConversationAvailability,
  string
> = {
  loading: '正在读取子智能体对话…',
  ready: '',
  missing_root: '主会话不存在，无法读取此子智能体。',
  missing_delegation: '子智能体不存在，无法读取对话记录。',
  unreadable: '子智能体不可读取，可能属于其他主会话或当前没有读取权限。',
  corrupt_public_log: '公开记录损坏，无法读取此轮公开输出。',
  error: '暂时无法读取子智能体对话，请重试。',
}
