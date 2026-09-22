import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillManager, replaceFileAtomic } from './manager'
import { LEGACY_SKILL_STATE_FILE } from '../runtime/resources'

function fixture(): {
  manager: SkillManager
  runtimeRoot: string
  stateRoot: string
} {
  const root = mkdtempSync(join(tmpdir(), 'emperor-skill-manager-'))
  const runtimeRoot = join(root, 'runtime')
  const stateRoot = join(root, 'state')
  mkdirSync(join(runtimeRoot, 'skills'), { recursive: true })
  return {
    manager: new SkillManager({ runtimeRoot, stateRoot }),
    runtimeRoot,
    stateRoot,
  }
}

describe('SkillManager', () => {
  it('resolves a user override with an explicit builtin-to-user trace', () => {
    const { manager, runtimeRoot, stateRoot } = fixture()
    for (const [root, description] of [
      [join(runtimeRoot, 'skills'), 'builtin'],
      [join(stateRoot, 'skills'), 'user'],
    ] as const) {
      const skill = join(root, 'same-skill')
      mkdirSync(skill, { recursive: true })
      writeFileSync(
        join(skill, 'SKILL.md'),
        `---\nname: same-skill\ndescription: ${description}\n---\n`,
      )
    }

    const resolved = manager.resolveWithProvenance('same-skill')

    expect(resolved.value).toMatchObject({
      name: 'same-skill',
      source: 'user',
    })
    expect(resolved.source).toMatchObject({ kind: 'user', trust: 'trusted' })
    expect(resolved.overridden).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ kind: 'builtin' }),
        value: expect.objectContaining({ source: 'builtin' }),
      }),
    ])
    expect(manager.resolve('same-skill')).toEqual(resolved.value)
  })

  it('creates stable snapshots for arbitrary staging directories', () => {
    const { manager, stateRoot } = fixture()
    const staged = join(stateRoot, 'staged-source')
    mkdirSync(join(staged, 'scripts'), { recursive: true })
    writeFileSync(
      join(staged, 'SKILL.md'),
      [
        '---',
        'name: staged-skill',
        'description: staged',
        'metadata:',
        '  emperor:',
        '    requires:',
        '      bins: [git]',
        '---',
        '',
        '# Staged',
      ].join('\n'),
    )
    writeFileSync(join(staged, 'scripts', 'run.sh'), '#!/bin/sh\n')

    const first = manager.snapshotDirectory(staged, 'staged-skill')
    const second = manager.snapshotDirectory(staged, 'staged-skill')

    expect(first).toMatchObject({
      name: 'staged-skill',
      valid: true,
      requirements: { bins: ['git'], runtimes: [], env: [] },
      files: [{ path: 'SKILL.md' }, { path: 'scripts/run.sh' }],
    })
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(second.digest).toBe(first.digest)
  })

  it('ignores legacy dependency state markers as resolver authority', () => {
    const { manager, stateRoot } = fixture()
    const skill = join(stateRoot, 'skills', 'blocked-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: blocked-skill\ndescription: blocked\n---\n',
    )
    writeFileSync(
      join(skill, LEGACY_SKILL_STATE_FILE),
      JSON.stringify({ schemaVersion: 1, status: 'blocked' }),
    )

    expect(manager.resolve('blocked-skill')?.status).toBe('active')
    expect(manager.validate({ name: 'blocked-skill' })).toMatchObject({
      valid: true,
      status: 'active',
      files: ['blocked-skill/SKILL.md'],
    })
  })

  it('creates a valid user Skill with only requested resource directories', () => {
    const { manager, stateRoot } = fixture()

    const created = manager.create({
      name: 'release-audit',
      description: 'Audit release artifacts and report integrity failures.',
      resources: ['references', 'assets'],
    })

    expect(created).toMatchObject({
      name: 'release-audit',
      source: 'user',
      status: 'active',
      readOnly: false,
    })
    expect(created.files).toEqual(['release-audit/SKILL.md'])
    expect(
      existsSync(
        join(stateRoot, 'skills', 'release-audit', 'references', '.gitkeep'),
      ),
    ).toBe(true)
    expect(
      readFileSync(
        join(stateRoot, 'skills', 'release-audit', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('name: release-audit')
    expect(
      existsSync(join(stateRoot, 'skills', 'release-audit', 'scripts')),
    ).toBe(false)
  })

  it('rejects unsafe or non-canonical names and existing targets', () => {
    const { manager } = fixture()
    for (const name of [
      'Release Audit',
      'Release-audit',
      '../escape',
      '-release-audit',
      'a'.repeat(65),
    ]) {
      expect(() =>
        manager.create({ name, description: 'A complete description.' }),
      ).toThrow(/name/i)
    }

    manager.create({
      name: 'release-audit',
      description: 'A complete description.',
    })
    expect(() =>
      manager.create({
        name: 'release-audit',
        description: 'A complete description.',
      }),
    ).toThrow(/already exists/i)
  })

  it('validates frontmatter and requirements while allowing auxiliary files', () => {
    const { manager, stateRoot } = fixture()
    const skillRoot = join(stateRoot, 'skills', 'environment-report')
    mkdirSync(join(skillRoot, 'scripts'), { recursive: true })
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      [
        '---',
        'name: environment-report',
        'description: Inspect the local development environment.',
        'metadata:',
        '  emperor:',
        '    requires:',
        '      bins: [git, rg]',
        '      runtimes: [node]',
        '      env: [GITHUB_TOKEN]',
        '---',
        '',
        '# Environment Report',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(join(skillRoot, 'scripts', 'inspect.mjs'), 'export {}\n')

    expect(manager.validate({ name: 'environment-report' })).toEqual(
      expect.objectContaining({
        valid: true,
        requirements: {
          bins: ['git', 'rg'],
          runtimes: ['node'],
          env: ['GITHUB_TOKEN'],
        },
        files: ['environment-report/SKILL.md'],
      }),
    )

    mkdirSync(join(skillRoot, 'docs'))
    writeFileSync(join(skillRoot, 'docs', 'notes.md'), 'notes\n')
    writeFileSync(join(skillRoot, 'SKILL_en.md'), '# English instructions\n')
    const withAuxiliaryFiles = manager.validate({
      name: 'environment-report',
    })
    expect(withAuxiliaryFiles.valid).toBe(true)
    expect(withAuxiliaryFiles.errors).toEqual([])

    const renamed = manager.validate({
      name: 'wrong-name',
      content: '---\nname: another\ndescription: Valid text\n---\n',
    })
    expect(renamed).toMatchObject({ valid: true, name: 'another' })
    expect(renamed.warnings.join('\n')).toMatch(/differs from frontmatter/)
    expect(
      manager
        .validate({
          name: 'missing-description',
          content: '---\nname: missing-description\n---\n',
        })
        .errors.join('\n'),
    ).toMatch(/description/i)
  })

  it('reads legacy nanobot bin requirements without trusting install commands', () => {
    const { manager } = fixture()
    const result = manager.validate({
      name: 'legacy-weather',
      content: [
        '---',
        'name: legacy-weather',
        'description: Read public weather data.',
        "metadata: { 'nanobot': { 'requires': { 'bins': ['curl'] }, 'install': [{ 'kind': 'shell', 'command': 'unsafe' }] } }",
        '---',
        '',
      ].join('\n'),
    })

    expect(result.valid).toBe(true)
    expect(result.requirements).toEqual({
      bins: ['curl'],
      runtimes: [],
      env: [],
    })
    expect(JSON.stringify(result)).not.toContain('unsafe')
  })

  it('allows internal symlinks and rejects links that leave the Skill folder', () => {
    const { manager, stateRoot } = fixture()
    manager.create({
      name: 'linked-skill',
      description: 'Exercise symlink validation.',
      resources: ['assets'],
    })
    const skillRoot = join(stateRoot, 'skills', 'linked-skill')
    writeFileSync(join(skillRoot, 'assets', 'logo.txt'), 'logo\n')
    symlinkSync(join('assets', 'logo.txt'), join(skillRoot, 'logo.txt'))
    expect(manager.validate({ name: 'linked-skill' }).valid).toBe(true)

    const outside = join(stateRoot, 'outside.txt')
    writeFileSync(outside, 'secret\n')
    symlinkSync(outside, join(skillRoot, 'assets', 'secret.txt'))
    const result = manager.validate({ name: 'linked-skill' })
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/absolute target/i)
  })

  it('rejects symlinked managed directories before create writes', () => {
    const createFixture = fixture()
    const createOutside = join(createFixture.stateRoot, '..', 'create-outside')
    mkdirSync(createFixture.stateRoot, { recursive: true })
    mkdirSync(createOutside)
    symlinkDirectory(createOutside, join(createFixture.stateRoot, 'skills'))

    expect(() =>
      createFixture.manager.create({
        name: 'escaped-skill',
        description: 'Must remain inside the private state root.',
      }),
    ).toThrow(/symbolic link|managed directory/i)
    expect(existsSync(join(createOutside, 'escaped-skill'))).toBe(false)
  })

  it('uses a recoverable Windows replacement fallback for existing packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-skill-replace-'))
    const target = join(root, 'same.skill')
    const temp = join(root, 'same.skill.tmp')
    writeFileSync(target, 'old')
    writeFileSync(temp, 'new')
    let simulatedWindowsConflict = true

    replaceFileAtomic(temp, target, {
      platform: 'win32',
      rename: (source, destination) => {
        if (
          simulatedWindowsConflict &&
          source === temp &&
          destination === target
        ) {
          simulatedWindowsConflict = false
          throw Object.assign(new Error('destination exists'), {
            code: 'EEXIST',
          })
        }
        renameSync(source, destination)
      },
    })

    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(existsSync(`${target}.replace-backup`)).toBe(false)
  })

  it('stops validation at the bounded directory depth', () => {
    const { manager, stateRoot } = fixture()
    manager.create({
      name: 'deep-skill',
      description: 'Exercise bounded recursive validation.',
      resources: ['references'],
    })
    let current = join(stateRoot, 'skills', 'deep-skill', 'references')
    for (let depth = 0; depth < 40; depth += 1) {
      current = join(current, `d${depth}`)
      mkdirSync(current)
    }
    writeFileSync(join(current, 'bottom.md'), 'too deep\n')

    const result = manager.validate({ name: 'deep-skill' })
    expect(result.valid).toBe(true)
    expect(result.warnings.join('\n')).toMatch(/deeper than 32 levels/i)
  })
})

function symlinkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}
