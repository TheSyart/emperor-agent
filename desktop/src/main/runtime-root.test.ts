import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runtimeRevision } from '@emperor/core'
import {
  legacyPackagedRuntimeRoot,
  preparePackagedRuntime,
  runtimeDefaultsRoot,
} from './runtime-root'

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function writeRuntimeDefaults(resourcesPath: string): string {
  const root = runtimeDefaultsRoot(resourcesPath)
  const content = new Map<string, string>([
    ['skills/skill-creator/SKILL.md', '# Skill Creator\n'],
    ['templates/SOUL.md', '# Soul\n'],
  ])
  for (const [relativePath, value] of content) {
    const target = path.join(root, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value, 'utf8')
  }
  const files = [...content.entries()]
    .map(([relativePath, value]) => ({
      path: relativePath,
      sha256: sha256(value),
      size: Buffer.byteLength(value),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
  fs.writeFileSync(
    path.join(root, 'runtime-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appVersion: '0.1.0',
        runtimeRevision: runtimeRevision(files),
        builtInSkills: ['skill-creator'],
        files,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return root
}

describe('packaged runtime paths', () => {
  it('keeps signed defaults and the legacy writable runtime as separate roots', () => {
    expect(
      legacyPackagedRuntimeRoot(
        '/Users/me/Library/Application Support/Emperor Agent',
      ),
    ).toBe('/Users/me/Library/Application Support/Emperor Agent/runtime')
    expect(runtimeDefaultsRoot('/App/Contents/Resources')).toBe(
      '/App/Contents/Resources/runtime-defaults',
    )
  })
})

describe('preparePackagedRuntime', () => {
  it('validates signed resources in place and migrates from userData without copying defaults', () => {
    const root = tmp('emperor-packaged-runtime-')
    const resourcesPath = path.join(root, 'resources')
    const userDataPath = path.join(root, 'user-data')
    const stateRoot = path.join(root, 'state')
    const signedRoot = writeRuntimeDefaults(resourcesPath)
    const legacyRoot = legacyPackagedRuntimeRoot(userDataPath)
    const legacySkill = path.join(legacyRoot, 'skills', 'custom')
    fs.mkdirSync(legacySkill, { recursive: true })
    fs.writeFileSync(
      path.join(legacySkill, 'SKILL.md'),
      '# Legacy Custom\n',
      'utf8',
    )

    const prepared = preparePackagedRuntime({
      resourcesPath,
      userDataPath,
      stateRoot,
      appVersion: '0.1.0',
      now: () => '2026-07-10T00:00:00.000Z',
    })

    expect(prepared.runtimeRoot).toBe(signedRoot)
    expect(prepared.legacyRuntimeRoot).toBe(legacyRoot)
    expect(prepared.manifest.runtimeRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.migration.entries).toEqual([
      expect.objectContaining({
        name: 'custom',
        action: 'copied_blocked',
      }),
    ])
    expect(
      fs.readFileSync(path.join(signedRoot, 'templates', 'SOUL.md'), 'utf8'),
    ).toBe('# Soul\n')
    expect(fs.existsSync(path.join(legacyRoot, 'templates'))).toBe(false)
    expect(fs.existsSync(path.join(legacySkill, 'SKILL.md'))).toBe(true)
  })

  it('fails before migration when the signed manifest is invalid', () => {
    const root = tmp('emperor-packaged-runtime-invalid-')
    const resourcesPath = path.join(root, 'resources')
    const userDataPath = path.join(root, 'user-data')
    const stateRoot = path.join(root, 'state')
    const signedRoot = writeRuntimeDefaults(resourcesPath)
    fs.writeFileSync(path.join(signedRoot, 'templates', 'SOUL.md'), 'tampered')

    expect(() =>
      preparePackagedRuntime({
        resourcesPath,
        userDataPath,
        stateRoot,
        appVersion: '0.1.0',
      }),
    ).toThrow(/runtime resource/i)
    expect(fs.existsSync(stateRoot)).toBe(false)
  })

  it('rejects a stateRoot that overlaps signed runtime resources', () => {
    const root = tmp('emperor-packaged-runtime-overlap-')
    const resourcesPath = path.join(root, 'resources')
    const signedRoot = writeRuntimeDefaults(resourcesPath)
    const stateRoot = path.join(signedRoot, 'private-state')

    expect(() =>
      preparePackagedRuntime({
        resourcesPath,
        userDataPath: path.join(root, 'user-data'),
        stateRoot,
        appVersion: '0.1.0',
      }),
    ).toThrow(/separate|overlap/i)
    expect(fs.existsSync(stateRoot)).toBe(false)
  })
})
