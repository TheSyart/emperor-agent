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
    // fs.watch (FSEvents on macOS) can miss changes made right after it attaches.
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      const skillDir = join(userSkills, 'news')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '# one\n', 'utf8')
      writeFileSync(join(skillDir, 'SKILL.md'), '# two\n', 'utf8')
      await vi.waitFor(() => expect(changes).toEqual([1]), { timeout: 5_000 })
    } finally {
      await detector.close()
    }
  })

  it('coalesces in-process notifications and skips dependency folders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-skill-watch-notify-'))
    const changes: number[] = []
    const detector = new SkillChangeDetector(
      [root],
      ({ catalogVersion }) => {
        changes.push(catalogVersion)
      },
      20,
    )
    detector.notify()
    detector.notify()
    await vi.waitFor(() => expect(changes).toEqual([1]), { timeout: 2_000 })
    await detector.close()
    detector.notify()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(changes).toEqual([1])
  })
})
