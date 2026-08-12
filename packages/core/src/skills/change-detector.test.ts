import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SkillChangeDetector } from './change-detector'

describe('SkillChangeDetector', () => {
  it('debounces Skill tree writes and increments a catalog version', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-skill-watch-'))
    const userSkills = join(root, 'skills')
    mkdirSync(userSkills, { recursive: true })
    const changes: number[] = []
    const detector = new SkillChangeDetector(
      [userSkills],
      ({ catalogVersion }) => {
        changes.push(catalogVersion)
      },
      20,
    )
    await detector.start()
    try {
      const skillDir = join(userSkills, 'news')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '# one\n', 'utf8')
      writeFileSync(join(skillDir, 'SKILL.md'), '# two\n', 'utf8')
      await vi.waitFor(() => expect(changes).toEqual([1]), { timeout: 2_000 })
    } finally {
      await detector.close()
    }
  })
})
