import { describe, expect, it, vi } from 'vitest'
import { enforceAgentCompletionContract } from './completion-contract'

describe('AgentDefinition completion contract', () => {
  it('requests at most one repair for missing required sections', async () => {
    const runRepair = vi.fn(async (_prompt: string) =>
      ['## 结论', '完成。', '## 证据', '测试通过。'].join('\n'),
    )

    const result = await enforceAgentCompletionContract({
      final: '完成。',
      requiredSections: ['结论', '证据'],
      runRepair,
    })

    expect(result).toContain('## 结论')
    expect(runRepair).toHaveBeenCalledTimes(1)
    expect(runRepair.mock.calls[0]?.[0]).toMatch(/结论.*证据/s)
  })

  it('returns an explicit partial failure when the one repair is still incomplete', async () => {
    const runRepair = vi.fn(async (_prompt: string) => '仍然没有结构化章节。')

    const result = await enforceAgentCompletionContract({
      final: '完成。',
      requiredSections: ['结论', '证据'],
      runRepair,
    })

    expect(result).toContain('[ERR] AgentDefinition completion contract')
    expect(result).toContain('结论, 证据')
    expect(runRepair).toHaveBeenCalledTimes(1)
  })
})
