import { describe, expect, it } from 'vitest'
import { usageTypeLabel } from './format'

describe('usageTypeLabel', () => {
  it('names every usage type the ledger writes in Chinese', () => {
    expect(usageTypeLabel('main_agent')).toBe('主 Agent')
    expect(usageTypeLabel('subagent')).toBe('子智能体')
    expect(usageTypeLabel('compaction')).toBe('上下文压缩')
    expect(usageTypeLabel('watchlist_check')).toBe('Watchlist 检查')
    // SET-01: external runs land in the ledger too.
    expect(usageTypeLabel('executor')).toBe('Claude Code、Codex')
  })
})
