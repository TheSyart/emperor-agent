import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateSkillPluginSemantics } from './migrate-skill-plugin-semantics'

describe('migrateSkillPluginSemantics', () => {
  it('records filesystem truth without materializing stale registry entries', () => {
    const emperorHome = mkdtempSync(join(tmpdir(), 'emperor-skill-migration-'))
    const active = join(emperorHome, 'skills', 'agent-reach')
    const managedBin = join(emperorHome, 'environment', 'bin')
    mkdirSync(active, { recursive: true })
    mkdirSync(managedBin, { recursive: true })
    writeFileSync(
      join(active, 'SKILL.md'),
      '---\nname: agent-reach\ndescription: Reach\n---\n',
    )
    writeFileSync(join(managedBin, 'agent-reach'), 'existing binary')
    writeFileSync(
      join(emperorHome, 'skills', 'installed.v1.json'),
      JSON.stringify({
        schemaVersion: 1,
        skills: {
          'agent-reach': { name: 'agent-reach', status: 'blocked' },
          stale: { name: 'stale', status: 'active' },
        },
      }),
    )

    const receipt = migrateSkillPluginSemantics({
      emperorHome,
      now: () => '2026-08-11T00:00:00.000Z',
    })
    const second = migrateSkillPluginSemantics({ emperorHome })

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      discoveredSkillDirectories: 1,
      legacyRegistryEntries: 2,
      staleLegacyRegistryEntries: 1,
    })
    expect(second).toEqual(receipt)
    expect(existsSync(join(emperorHome, 'skills', 'stale'))).toBe(false)
    expect(readFileSync(join(managedBin, 'agent-reach'), 'utf8')).toBe(
      'existing binary',
    )
  })

  it('does not inspect or alter other Agent homes', () => {
    const parent = mkdtempSync(
      join(tmpdir(), 'emperor-skill-migration-sentinel-'),
    )
    const emperorHome = join(parent, '.emperor')
    const sentinel = join(parent, '.claude', 'skills', 'sentinel', 'SKILL.md')
    mkdirSync(join(emperorHome, 'skills'), { recursive: true })
    mkdirSync(join(parent, '.claude', 'skills', 'sentinel'), {
      recursive: true,
    })
    writeFileSync(sentinel, 'do not touch')

    migrateSkillPluginSemantics({ emperorHome })

    expect(readFileSync(sentinel, 'utf8')).toBe('do not touch')
  })
})
