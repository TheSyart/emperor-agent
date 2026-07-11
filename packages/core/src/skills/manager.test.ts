import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillManager, replaceFileAtomic } from './manager'

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
    expect(created.files).toEqual([
      'release-audit/SKILL.md',
      'release-audit/assets/.gitkeep',
      'release-audit/references/.gitkeep',
    ])
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
      '../escape',
      '-release-audit',
      'release_audit',
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

  it('validates frontmatter, directory structure, and requirements metadata', () => {
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
        files: [
          'environment-report/SKILL.md',
          'environment-report/scripts/inspect.mjs',
        ],
      }),
    )

    mkdirSync(join(skillRoot, 'docs'))
    writeFileSync(join(skillRoot, 'docs', 'unexpected.md'), 'bad\n')
    const invalid = manager.validate({ name: 'environment-report' })
    expect(invalid.valid).toBe(false)
    expect(invalid.errors.join('\n')).toMatch(
      /unsupported top-level entry.*docs/i,
    )

    expect(
      manager.validate({
        name: 'wrong-name',
        content: '---\nname: another\ndescription: Valid text\n---\n',
      }),
    ).toMatchObject({ valid: false })
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

  it('packages sorted regular files into reproducible .skill archives', () => {
    const { manager, stateRoot } = fixture()
    manager.create({
      name: 'release-audit',
      description: 'Audit release artifacts and report integrity failures.',
      resources: ['scripts', 'references'],
    })
    writeFileSync(
      join(stateRoot, 'skills', 'release-audit', 'references', 'policy.md'),
      '# Policy\n',
    )
    writeFileSync(
      join(stateRoot, 'skills', 'release-audit', 'scripts', 'verify.mjs'),
      'export {}\n',
    )

    const first = manager.package({ name: 'release-audit' })
    const firstBytes = readFileSync(first.path)
    const second = manager.package({ name: 'release-audit' })
    const secondBytes = readFileSync(second.path)

    expect(first.files).toEqual([
      'release-audit/SKILL.md',
      'release-audit/references/.gitkeep',
      'release-audit/references/policy.md',
      'release-audit/scripts/.gitkeep',
      'release-audit/scripts/verify.mjs',
    ])
    expect(secondBytes).toEqual(firstBytes)
    expect(first.sha256).toBe(
      createHash('sha256').update(firstBytes).digest('hex'),
    )
    expect(second.sha256).toBe(first.sha256)
    expect(first.path).toBe(
      join(realpathSync(stateRoot), 'skill-packages', 'release-audit.skill'),
    )
  })

  it('rejects symlinks during validation and packaging', () => {
    const { manager, stateRoot } = fixture()
    manager.create({
      name: 'unsafe-skill',
      description: 'Exercise unsafe filesystem validation.',
      resources: ['assets'],
    })
    const outside = join(stateRoot, 'outside.txt')
    writeFileSync(outside, 'secret\n')
    symlinkSync(
      outside,
      join(stateRoot, 'skills', 'unsafe-skill', 'assets', 'secret.txt'),
    )

    const result = manager.validate({ name: 'unsafe-skill' })
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/symbolic link/i)
    expect(() => manager.package({ name: 'unsafe-skill' })).toThrow(
      /validation failed/i,
    )
  })

  it('rejects symlinked managed directories before create or package writes', () => {
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

    const packageFixture = fixture()
    packageFixture.manager.create({
      name: 'package-safe',
      description: 'Package without escaping the private state root.',
    })
    const packageOutside = join(
      packageFixture.stateRoot,
      '..',
      'package-outside',
    )
    mkdirSync(packageOutside)
    symlinkDirectory(
      packageOutside,
      join(packageFixture.stateRoot, 'skill-packages'),
    )

    expect(() =>
      packageFixture.manager.package({ name: 'package-safe' }),
    ).toThrow(/symbolic link|managed directory/i)
    expect(existsSync(join(packageOutside, 'package-safe.skill'))).toBe(false)
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
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/directory depth/i)
  })
})

function symlinkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}
