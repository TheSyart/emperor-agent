import type { ChatMessage } from '../../types'

export function messageScrollSignature(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return '0'
  if (last.role === 'user') {
    return [
      messages.length,
      last.id,
      last.content.length,
      last.attachments?.length ?? 0,
      last.source ?? '',
    ].join(':')
  }
  return [
    messages.length,
    last.id,
    last.content.length,
    last.segments.length,
    last.todos?.length ?? 0,
    last.streaming ? 1 : 0,
  ].join(':')
}

export const FOLLOW_BOTTOM_THRESHOLD_PX = 80

/** 滚动锁定（Wave4.1）：离底部超过阈值即解锁自动跟随，回到底部附近重新锁定。 */
export function shouldFollowBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_THRESHOLD_PX
}
