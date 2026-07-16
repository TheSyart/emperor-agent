import { describe, expect, it } from 'vitest'
import type { BootstrapPayload, CompactResult } from '../types'
import {
  inlineCode,
  renderCommandHelp,
  renderCompactResult,
  renderMemoryInfo,
  renderModeStatus,
  renderModelInfo,
  renderStats,
  renderStatus,
  renderTokenInfo,
} from './statusRender'

function bootStub(): BootstrapPayload {
  return {
    app: 'Emperor Agent',
    model: 'main-model',
    provider: 'prov',
    skills: [{ name: 's1', path: 'skills/s1' }],
    tools: [
      {
        name: 'grep',
        description: '搜索',
        read_only: true,
        concurrency_safe: true,
      },
    ],
    control: { mode: 'auto', pending: null },
    memory: { tokenTotals: { total: 1234, calls: 5 } },
    unarchivedHistory: [{ role: 'user', content: 'x' }],
    modelConfig: {
      current: {
        entryId: 'e',
        provider: 'prov',
        protocol: 'openai',
        modelId: 'main-model',
        capabilities: { toolCall: true, vision: false, reasoning: true },
      },
    },
  } as unknown as BootstrapPayload
}

describe('statusRender pure formatters (W6)', () => {
  it('renders status from explicit inputs without touching component scope', () => {
    const text = renderStatus({
      boot: bootStub(),
      busy: false,
      runtimeText: '桌面 IPC 在线',
      eventTransportText: '桌面 IPC：ready',
      routeName: 'chat',
    })
    expect(text).toContain('## 当前状态')
    expect(text).toContain('桌面 IPC 在线')
    expect(text).toContain('`auto`')
    expect(text).toContain('1,234')
  })

  it('renders model, tokens, memory, mode, compact and help sections', () => {
    const boot = bootStub()
    expect(renderModelInfo(boot)).toContain('`main-model`')
    expect(renderTokenInfo(boot)).toContain('Token 消耗')
    expect(renderMemoryInfo(boot)).toContain('记忆状态')
    expect(renderModeStatus(boot.control)).toContain('`auto`')
    expect(
      renderModeStatus({ mode: 'plan', previous_mode: 'accept_edits' }),
    ).toContain('当前权限：`accept_edits`')
    expect(renderCommandHelp()).toContain('斜杠命令')
    expect(
      renderCompactResult({
        status: 'compacted',
        count: 3,
        message: 'ok',
        unarchivedHistory: [],
        compaction: {
          cursor: { compactedUntilSeq: 8, archivedUntilSeq: 8 },
          applied: [
            {
              scope: { kind: 'project', projectId: 'project_1' },
              path: '/state/projects/project_1/AGENTS.local.md',
              operationCount: 2,
            },
          ],
          discarded: [{ reason: 'duplicate' }],
        },
      } as unknown as CompactResult),
    ).toContain('全局私有项目记忆')
    expect(
      renderCompactResult({
        status: 'degraded',
        count: 3,
        message: '记忆压缩失败，已保留当前会话历史。',
        error: 'invalid draft',
        unarchivedHistory: [],
      } as unknown as CompactResult),
    ).toContain('失败但已保留历史')
    expect(renderStats({ m1: { total: 10, calls: 2 } }, 'model')).toContain(
      'm1',
    )
    expect(renderStats(undefined, 'date')).toBe('- 暂无记录')
    expect(inlineCode('x')).toBe('`x`')
  })
})
