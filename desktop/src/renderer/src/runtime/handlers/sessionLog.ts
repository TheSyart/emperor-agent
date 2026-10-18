import type { WsEvent } from '../../types'

/**
 * `session_log_state` (host-only): the session log store repaired a damaged
 * log on open, refused one it cannot read, or paused / resumed writing.
 * The renderer only turns it into a toast; nothing is projected.
 */
export function sessionLogNotice(event: WsEvent): string | null {
  if (event.event !== 'session_log_state') return null
  switch (event.state) {
    case 'repaired':
      return event.kind === 'corrupt'
        ? `会话记录第 ${event.line ?? '?'} 行已损坏：保留了此前的内容，原文件已另存`
        : '会话记录末尾有一段没写完的内容，已移出另存，会话可以继续使用'
    case 'unrecoverable':
      return '这个会话的记录头已损坏，无法打开；原文件保持不动'
    case 'write_paused':
      return event.error === 'ENOSPC'
        ? '磁盘已满，会话暂停保存；内容先留在内存里，腾出空间后会自动补写'
        : '会话记录暂时写不进磁盘；内容先留在内存里，恢复后会自动补写'
    case 'write_resumed':
      return '会话记录已恢复保存'
    default:
      return null
  }
}
