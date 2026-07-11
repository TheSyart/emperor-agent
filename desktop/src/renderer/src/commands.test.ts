import { describe, expect, it } from 'vitest'

import {
  buildSlashPaletteItems,
  isPathLikeSlashToken,
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
  })
})
