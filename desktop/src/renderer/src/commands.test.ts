import { describe, expect, it } from 'vitest'

import {
  buildSlashPaletteItems,
  isPathLikeSlashToken,
  parseGoalSlashCommand,
  parseSkillSlashCommand,
  parseSlashCommand,
} from './commands'
import type { SkillInfo } from './types'

const skills: SkillInfo[] = [
  {
    name: 'code-audit',
    path: 'skills/code-audit/SKILL.md',
    description: 'Audit code',
  },
]

describe('slash command parsing', () => {
  it('parses the strict Goal command grammar without prefix collisions', () => {
    expect(parseGoalSlashCommand('/goals')).toEqual({ kind: 'list' })
    expect(parseGoalSlashCommand('/goal')).toEqual({ kind: 'missing' })
    expect(parseGoalSlashCommand('/goal status')).toEqual({ kind: 'status' })
    expect(parseGoalSlashCommand('/goal pause')).toEqual({ kind: 'pause' })
    expect(parseGoalSlashCommand('/goal resume')).toEqual({ kind: 'resume' })
    expect(parseGoalSlashCommand('/goal cancel')).toEqual({ kind: 'cancel' })
    expect(parseGoalSlashCommand('/goal start 完成迁移')).toEqual({
      kind: 'start',
      outcome: '完成迁移',
    })
    expect(parseGoalSlashCommand('/goal start status')).toEqual({
      kind: 'start',
      outcome: 'status',
    })
    expect(parseGoalSlashCommand('/goal 完成迁移')).toEqual({
      kind: 'start',
      outcome: '完成迁移',
    })
    expect(parseGoalSlashCommand('/goalxxx')).toBeNull()
    expect(parseGoalSlashCommand('/plan status')).toBeNull()
  })

  it('does not treat absolute filesystem paths as slash commands', () => {
    const input =
      '/Users/anhuike/Documents/workspace/claude-code-source-code/给你源码 你去看看'

    expect(isPathLikeSlashToken('/Users/anhuike/Documents')).toBe(true)
    expect(parseSlashCommand(input)).toBeNull()
    expect(parseSkillSlashCommand(input, skills)).toBeNull()
  })

  it('still parses known commands and skill shortcuts', () => {
    expect(parseSlashCommand('/help')?.command?.name).toBe('/help')
    expect(parseSlashCommand('/missing')?.command).toBeUndefined()
    expect(
      parseSkillSlashCommand('/code-audit 检查项目', skills)?.requestedSkill
        .name,
    ).toBe('code-audit')
  })

  it('advertises Plan separately from the three permission modes', () => {
    const mode = buildSlashPaletteItems().find(
      (item) => item.id === 'command:/mode',
    )
    const plan = buildSlashPaletteItems().find(
      (item) => item.id === 'command:/plan',
    )

    expect(mode?.usage).toBe('/mode ask|edits|auto|status')
    expect(mode?.usage).not.toContain('plan')
    expect(plan?.usage).toBe('/plan on|off|status')
  })

  it('keeps blocked Skills out of callable shortcuts', () => {
    const blocked: SkillInfo = {
      name: 'legacy-script',
      path: 'skills/legacy-script/SKILL.md',
      status: 'blocked_pending_review',
    }

    expect(
      buildSlashPaletteItems([...skills, blocked]).some(
        (item) => item.id === 'skill:legacy-script',
      ),
    ).toBe(false)
    expect(
      parseSkillSlashCommand('/legacy-script run', [...skills, blocked]),
    ).toBeNull()
    expect(
      buildSlashPaletteItems([
        ...skills,
        { ...blocked, name: 'missing-deps', status: 'blocked' },
      ]).some((item) => item.id === 'skill:missing-deps'),
    ).toBe(false)
  })
})
