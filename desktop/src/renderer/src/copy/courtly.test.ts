// BRD-06: 宫廷用语 — off by default; on, a few words turn courtly, and every
// action keeps its plain meaning in sight and in its accessible name.
import { describe, expect, it } from 'vitest'
import {
  COURTLY,
  COURTLY_ENTRIES,
  courtlyAction,
  courtlyHeadline,
} from './courtly'

describe('宫廷用语', () => {
  it('keeps to a short list (≤ 12)', () => {
    expect(COURTLY_ENTRIES).toBeLessThanOrEqual(12)
  })

  it('asks on the three homes in court words', () => {
    expect(courtlyHeadline('chat')).toBe('朕今日要办何事？')
    expect(courtlyHeadline('build')).toBe('今日推进哪桩差事？')
    expect(courtlyHeadline('group')).toBe('今日宣谁议事？')
  })

  it('says 准奏 / 驳回 with what the button does', () => {
    expect(courtlyAction('允许本次', false)).toBe('准奏（允许本次）')
    expect(courtlyAction('以后都允许', false)).toBe('准奏（以后都允许）')
    expect(courtlyAction('拒绝', true)).toBe('驳回（拒绝）')
  })

  it('names plan mode and a new group chat the court way, plain meaning kept', () => {
    expect(COURTLY.planMode).toBe('内阁票拟（计划模式）')
    expect(COURTLY.newGroup).toBe('召集议事')
  })
})
