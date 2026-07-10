import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_SKILL_STATE_FILE,
  migrateLegacyRuntimeSkills,
  validateRuntimeManifest,
} from './resources'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function manifestRevision(
  files: Array<{ path: string; sha256: string; size: number }>,
): string {
  return sha256(
    files
      .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
      .join(''),
  )
}

function createRuntimeFixture(appVersion = '0.1.0'): {
  root: string
  manifestPath: string
} {
  const root = tmp('emperor-runtime-manifest-')
  const content = new Map<string, string>([
    ['skills/skill-creator/SKILL.md', '# Skill Creator\n'],
    ['templates/SOUL.md', '# Soul\n'],
  ])
  for (const [relativePath, value] of content) {
    const path = join(root, ...relativePath.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, value, 'utf8')
  }
  const files = [...content.entries()]
    .map(([path, value]) => ({
      path,
      sha256: sha256(value),
      size: Buffer.byteLength(value),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
  const manifestPath = join(root, 'runtime-manifest.json')
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appVersion,
        runtimeRevision: manifestRevision(files),
        builtInSkills: ['skill-creator'],
        files,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return { root, manifestPath }
}

function writeLegacySkill(root: string, name: string, content: string): string {
  const skillRoot = join(root, 'skills', name)
  mkdirSync(skillRoot, { recursive: true })
  writeFileSync(join(skillRoot, 'SKILL.md'), content, 'utf8')
  return skillRoot
}

describe('signed runtime manifest', () => {
  it('validates an exact read-only runtime resource tree', () => {
    const fixture = createRuntimeFixture()
    chmodSync(join(fixture.root, 'templates', 'SOUL.md'), 0o444)
    chmodSync(join(fixture.root, 'skills', 'skill-creator', 'SKILL.md'), 0o444)
    chmodSync(fixture.root, 0o555)

    try {
      expect(
        validateRuntimeManifest(fixture.root, {
          expectedAppVersion: '0.1.0',
        }),
      ).toMatchObject({
        schemaVersion: 1,
        appVersion: '0.1.0',
        builtInSkills: ['skill-creator'],
        files: [
          { path: 'skills/skill-creator/SKILL.md' },
          { path: 'templates/SOUL.md' },
        ],
      })
    } finally {
      chmodSync(fixture.root, 0o755)
    }
  })

  it('rejects missing, changed, extra, and wrong-version resources', () => {
    const changed = createRuntimeFixture()
    writeFileSync(join(changed.root, 'templates', 'SOUL.md'), 'tampered')
    expect(() => validateRuntimeManifest(changed.root)).toThrow(
      /size|sha-?256/i,
    )

    const extra = createRuntimeFixture()
    writeFileSync(join(extra.root, 'unexpected.txt'), 'extra')
    expect(() => validateRuntimeManifest(extra.root)).toThrow(/unexpected/i)

    const wrongVersion = createRuntimeFixture('0.2.0')
    expect(() =>
      validateRuntimeManifest(wrongVersion.root, {
        expectedAppVersion: '0.1.0',
      }),
    ).toThrow(/version/i)

    expect(() =>
      validateRuntimeManifest(tmp('emperor-runtime-missing-')),
    ).toThrow(/manifest/i)

    const duplicateSkills = createRuntimeFixture()
    const duplicateManifest = JSON.parse(
      readFileSync(duplicateSkills.manifestPath, 'utf8'),
    )
    duplicateManifest.builtInSkills = ['skill-creator', 'skill-creator']
    writeFileSync(
      duplicateSkills.manifestPath,
      `${JSON.stringify(duplicateManifest, null, 2)}\n`,
      'utf8',
    )
    expect(() => validateRuntimeManifest(duplicateSkills.root)).toThrow(
      /builtInSkills.*unique|sorted/i,
    )
  })
})

describe('legacy packaged runtime Skill migration', () => {
  it('handles a missing legacy runtime without creating package resources', () => {
    const legacyRuntimeRoot = join(tmp('emperor-legacy-parent-'), 'runtime')
    const stateRoot = tmp('emperor-legacy-state-')

    const result = migrateLegacyRuntimeSkills({
      legacyRuntimeRoot,
      stateRoot,
      builtInSkills: ['skill-creator'],
      runtimeRevision: 'rev-1',
      now: () => '2026-07-10T00:00:00.000Z',
    })

    expect(result.entries).toEqual([])
    expect(existsSync(legacyRuntimeRoot)).toBe(false)
    expect(existsSync(result.receiptPath)).toBe(true)
  })

  it('copies only unknown Skills and marks them blocked pending review', () => {
    const legacyRuntimeRoot = tmp('emperor-legacy-runtime-')
    const stateRoot = tmp('emperor-legacy-state-')
    writeLegacySkill(legacyRuntimeRoot, 'skill-creator', '# Old built-in\n')
    const customSource = writeLegacySkill(
      legacyRuntimeRoot,
      'custom-review',
      '# Custom Review\n',
    )
    writeLegacySkill(
      join(legacyRuntimeRoot, '.emperor'),
      'private-review',
      '# Private Review\n',
    )
    mkdirSync(join(legacyRuntimeRoot, 'templates'), { recursive: true })
    writeFileSync(
      join(legacyRuntimeRoot, 'templates', 'SOUL.md'),
      'legacy template',
    )

    const result = migrateLegacyRuntimeSkills({
      legacyRuntimeRoot,
      stateRoot,
      builtInSkills: ['skill-creator'],
      runtimeRevision: 'rev-2',
      now: () => '2026-07-10T00:00:00.000Z',
    })

    const migrated = join(stateRoot, 'skills', 'custom-review')
    expect(readFileSync(join(migrated, 'SKILL.md'), 'utf8')).toBe(
      '# Custom Review\n',
    )
    expect(
      readFileSync(
        join(stateRoot, 'skills', 'private-review', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# Private Review\n')
    expect(
      JSON.parse(readFileSync(join(migrated, LEGACY_SKILL_STATE_FILE), 'utf8')),
    ).toMatchObject({
      status: 'blocked_pending_review',
      source: 'legacy_runtime',
      runtimeRevision: 'rev-2',
    })
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'custom-review',
          action: 'copied_blocked',
          status: 'blocked_pending_review',
        }),
        expect.objectContaining({
          name: 'skill-creator',
          action: 'skipped_builtin',
        }),
        expect.objectContaining({
          name: 'private-review',
          action: 'copied_blocked',
        }),
      ]),
    )
    expect(readFileSync(join(customSource, 'SKILL.md'), 'utf8')).toBe(
      '# Custom Review\n',
    )
    expect(
      readFileSync(join(legacyRuntimeRoot, 'templates', 'SOUL.md'), 'utf8'),
    ).toBe('legacy template')
  })

  it('is idempotent and never overwrites a user Skill collision', () => {
    const legacyRuntimeRoot = tmp('emperor-legacy-runtime-repeat-')
    const stateRoot = tmp('emperor-legacy-state-repeat-')
    writeLegacySkill(legacyRuntimeRoot, 'migrated', '# Legacy\n')
    writeLegacySkill(legacyRuntimeRoot, 'collision', '# Legacy collision\n')
    writeLegacySkill(stateRoot, 'collision', '# User version\n')
    const options = {
      legacyRuntimeRoot,
      stateRoot,
      builtInSkills: [] as string[],
      runtimeRevision: 'rev-repeat',
      now: () => '2026-07-10T00:00:00.000Z',
    }

    migrateLegacyRuntimeSkills(options)
    writeFileSync(
      join(stateRoot, 'skills', 'migrated', 'SKILL.md'),
      '# Reviewed locally\n',
    )
    const second = migrateLegacyRuntimeSkills(options)

    expect(
      readFileSync(join(stateRoot, 'skills', 'migrated', 'SKILL.md'), 'utf8'),
    ).toBe('# Reviewed locally\n')
    expect(
      readFileSync(join(stateRoot, 'skills', 'collision', 'SKILL.md'), 'utf8'),
    ).toBe('# User version\n')
    expect(second.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'migrated',
          action: 'already_migrated',
        }),
        expect.objectContaining({
          name: 'collision',
          action: 'skipped_collision',
        }),
      ]),
    )
  })

  it('quarantines a corrupt receipt and rejects symlinked legacy Skills', () => {
    const legacyRuntimeRoot = tmp('emperor-legacy-runtime-corrupt-')
    const stateRoot = tmp('emperor-legacy-state-corrupt-')
    const outside = writeLegacySkill(
      tmp('emperor-legacy-outside-'),
      'outside',
      '# Outside\n',
    )
    mkdirSync(join(legacyRuntimeRoot, 'skills'), { recursive: true })
    symlinkSync(
      outside,
      join(legacyRuntimeRoot, 'skills', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const receiptDir = join(stateRoot, 'migrations')
    mkdirSync(receiptDir, { recursive: true })
    writeFileSync(
      join(receiptDir, 'legacy-runtime-skills.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        runtimeRevision: 'wrong-revision',
        entries: [],
      })}\n`,
    )

    const result = migrateLegacyRuntimeSkills({
      legacyRuntimeRoot,
      stateRoot,
      builtInSkills: [],
      runtimeRevision: 'rev-corrupt',
      now: () => '2026-07-10T00:00:00.000Z',
    })

    expect(result.entries).toEqual([
      expect.objectContaining({ name: 'linked', action: 'skipped_unsafe' }),
    ])
    expect(existsSync(join(stateRoot, 'skills', 'linked'))).toBe(false)
    expect(
      readdirSync(receiptDir).some((name) =>
        name.startsWith('legacy-runtime-skills.json.corrupt-'),
      ),
    ).toBe(true)
  })
})
