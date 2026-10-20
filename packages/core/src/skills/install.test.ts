import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillManager } from './manager'
import { SkillInstallService, type SkillMissingRequirements } from './install'

// SkillInstallService keeps only the reconcile of legacy blocked receipts
// and the installation record; Skills are installed by `skills.import`
// (the preview/confirm installer was removed in KRN-13).
describe('SkillInstallService', () => {
  it('ignores a legacy blocked receipt while the filesystem Skill stays active', async () => {
    let missing: SkillMissingRequirements = {
      bins: ['git'],
      runtimes: [],
      env: [],
    }
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-skill-install-'))
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const manager = new SkillManager({ stateRoot, runtimeRoot })
    const service = new SkillInstallService({
      manager,
      stateRoot,
      resolveMissing: async () => missing,
    })
    const folder = join(manager.userSkillsDirectory(), 'dependency-skill')
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, 'SKILL.md'),
      [
        '---',
        'name: dependency-skill',
        'description: dependency-skill description',
        'metadata:',
        '  emperor:',
        '    requires:',
        '      bins: [git]',
        '---',
        '',
        '# Skill',
        '',
      ].join('\n'),
    )
    expect(manager.resolve('dependency-skill')?.status).toBe('active')

    missing = { bins: [], runtimes: [], env: [] }
    await expect(service.reconcileBlocked()).resolves.toEqual({
      activated: [],
      blocked: [],
    })
    expect(manager.resolve('dependency-skill')?.status).toBe('active')
  })

  it('refuses an installation record name that is not a Skill name', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-skill-install-'))
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const manager = new SkillManager({ stateRoot, runtimeRoot })
    const service = new SkillInstallService({ manager, stateRoot })
    expect(() => service.removeInstallationRecord('../escape')).toThrow(
      /Invalid Skill installation record name/,
    )
    // No registry yet: nothing to remove, no error.
    expect(() => service.removeInstallationRecord('fine-skill')).not.toThrow()
  })
})
