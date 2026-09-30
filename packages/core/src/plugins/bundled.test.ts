import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPluginLogo } from './logo'
import { resolvePluginPackage } from './manifest-resolver'

const BUNDLED = join(__dirname, '..', '..', 'bundled-plugins')

describe('packages shipped with Emperor', () => {
  it('are two valid portable packages named as the contract says', () => {
    expect(readdirSync(BUNDLED).sort()).toEqual(['computer-use', 'github'])
    const resolved = ['computer-use', 'github'].map((name) =>
      resolvePluginPackage(join(BUNDLED, name), { strict: true }),
    )
    expect(
      resolved.map(
        ({ pluginId, format, displayName, developerName, description }) => ({
          pluginId,
          format,
          displayName,
          developerName,
          description,
        }),
      ),
    ).toEqual([
      {
        pluginId: 'computer-use',
        format: 'portable',
        displayName: 'Computer Use',
        developerName: 'Emperor Agent',
        description: '让 Emperor 操作浏览器和 Mac 上的应用',
      },
      {
        pluginId: 'github',
        format: 'portable',
        displayName: 'GitHub',
        developerName: 'Emperor Agent',
        description: '与 GitHub 集成',
      },
    ])
  })

  it('give GitHub a read-only Skill, example prompts and its gh connection', () => {
    const github = resolvePluginPackage(join(BUNDLED, 'github'), {
      strict: true,
    })
    expect(
      github.components.map(({ kind, id, title, state }) => [
        kind,
        id,
        title,
        state,
      ]),
    ).toEqual([
      ['skill', 'github', 'github', 'available'],
      ['app', 'github', 'GitHub（本机 gh）', 'unsupported'],
    ])
    expect(github.prompts).toHaveLength(3)
    const skill = readFileSync(
      join(BUNDLED, 'github', 'skills', 'github', 'SKILL.md'),
      'utf8',
    )
    expect(skill).toContain('--method GET')
    expect(skill).toContain('只读')
  })

  it('make Computer Use the only home of its Skill, with one member per driver', () => {
    const computerUse = resolvePluginPackage(join(BUNDLED, 'computer-use'), {
      strict: true,
    })
    expect(
      computerUse.components.map(({ kind, id, title, state }) => [
        kind,
        id,
        title,
        state,
      ]),
    ).toEqual([
      ['skill', 'computer-use', 'computer-use', 'available'],
      ['app', 'desktop', 'macOS 桌面', 'unsupported'],
      ['app', 'embedded-browser', '内置浏览器', 'unsupported'],
      ['app', 'external-browser', 'Chrome/Edge 连接', 'unsupported'],
    ])
    // Not a built-in any more: one physical copy, in the package.
    const repo = join(__dirname, '..', '..', '..', '..')
    expect(existsSync(join(repo, 'skills', 'computer-use'))).toBe(false)
    expect(readdirSync(join(repo, 'skills')).sort()).toEqual(['skill-creator'])
  })

  it('carry their logo as a small PNG under assets/', () => {
    for (const name of ['computer-use', 'github']) {
      const resolved = resolvePluginPackage(join(BUNDLED, name), {
        strict: true,
      })
      expect(resolved.logoPath).toBe(join(BUNDLED, name, 'assets', 'logo.png'))
      expect(resolved.logoIssue).toBeNull()
      expect(checkPluginLogo(resolved.logoPath!)).toEqual({ mime: 'image/png' })
      const png = readFileSync(resolved.logoPath!)
      // IHDR width and height; the art is scaled down only, never redrawn.
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([384, 384])
      expect(statSync(resolved.logoPath!).size).toBeLessThan(256 * 1024)
    }
  })
})
