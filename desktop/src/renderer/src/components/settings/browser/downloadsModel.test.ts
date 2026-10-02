import { describe, expect, it } from 'vitest'
import type { AgentDownloadView } from '../../../api/backend'
import { agentDownloadDescription } from './downloadsModel'

const now = new Date(2026, 9, 1, 15, 0).getTime()
const time = new Date(2026, 9, 1, 14, 5).getTime()

function view(fields: Partial<AgentDownloadView>): AgentDownloadView {
  return {
    id: 'dl_0123456789ab',
    name: 'report.pdf',
    site: 'https://files.example',
    sessionId: 's1',
    time,
    bytes: 2_048,
    exists: true,
    ...fields,
  }
}

describe('Emperor’s downloads (下载历史记录)', () => {
  it('reads 网站 · 时间 · 大小 for a file in the inbox', () => {
    expect(agentDownloadDescription(view({}), now)).toBe(
      'files.example · 10月1日 14:05 · 2.0 KB',
    )
  })

  it('says which browser a Chrome/Edge download was in, and how it ended (RV-09)', () => {
    const external = { exists: false, sessionId: null }
    expect(
      agentDownloadDescription(
        view({ ...external, browser: 'chrome', state: 'completed' }),
        now,
      ),
    ).toBe('来自 Chrome · files.example · 10月1日 14:05 · 2.0 KB')
    expect(
      agentDownloadDescription(
        view({
          ...external,
          browser: 'edge',
          state: 'refused',
          reason: 'executable',
          bytes: 0,
        }),
        now,
      ),
    ).toBe('来自 Edge · files.example · 10月1日 14:05 · 已拦截：可执行文件')
    expect(
      agentDownloadDescription(
        view({
          ...external,
          browser: 'chrome',
          state: 'refused',
          reason: 'blocked',
        }),
        now,
      ),
    ).toBe(
      '来自 Chrome · files.example · 10月1日 14:05 · 已拦截：这个网站不允许下载',
    )
    expect(
      agentDownloadDescription(
        view({
          ...external,
          browser: 'chrome',
          state: 'refused',
          reason: 'denied',
        }),
        now,
      ),
    ).toBe('来自 Chrome · files.example · 10月1日 14:05 · 未批准')
    expect(
      agentDownloadDescription(
        view({ ...external, browser: 'edge', state: 'interrupted' }),
        now,
      ),
    ).toBe('来自 Edge · files.example · 10月1日 14:05 · 下载中断')
  })
})
