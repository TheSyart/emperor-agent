import { describe, expect, it } from 'vitest'
import type { WsEvent } from '../../types'
import { sessionLogNotice } from './sessionLog'

const event = (fields: Record<string, unknown>) =>
  ({ event: 'session_log_state', session_id: 's1', ...fields }) as WsEvent

describe('session log notices', () => {
  it('says an unfinished tail was set aside and the session still works', () => {
    expect(
      sessionLogNotice(
        event({ state: 'repaired', kind: 'tail', dropped_bytes: 12 }),
      ),
    ).toBe('会话记录末尾有一段没写完的内容，已移出另存，会话可以继续使用')
  })

  it('names the damaged line of a salvaged log', () => {
    expect(
      sessionLogNotice(event({ state: 'repaired', kind: 'corrupt', line: 7 })),
    ).toBe('会话记录第 7 行已损坏：保留了此前的内容，原文件已另存')
  })

  it('explains an unreadable header leaves the file alone', () => {
    expect(sessionLogNotice(event({ state: 'unrecoverable' }))).toBe(
      '这个会话的记录头已损坏，无法打开；原文件保持不动',
    )
  })

  it('calls a full disk by its name', () => {
    expect(
      sessionLogNotice(event({ state: 'write_paused', error: 'ENOSPC' })),
    ).toBe('磁盘已满，会话暂停保存；内容先留在内存里，腾出空间后会自动补写')
    expect(
      sessionLogNotice(event({ state: 'write_paused', error: 'EIO' })),
    ).toBe('会话记录暂时写不进磁盘；内容先留在内存里，恢复后会自动补写')
  })

  it('confirms writes resumed and ignores other events', () => {
    expect(sessionLogNotice(event({ state: 'write_resumed' }))).toBe(
      '会话记录已恢复保存',
    )
    expect(
      sessionLogNotice({ event: 'prompt_queued', prompt_id: 'p' } as WsEvent),
    ).toBeNull()
  })
})
