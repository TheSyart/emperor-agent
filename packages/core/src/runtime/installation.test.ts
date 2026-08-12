import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_STATE_LAYOUT_VERSION,
  InstallationBootstrapError,
  bootstrapEmperorHome,
} from './installation'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('bootstrapEmperorHome', () => {
  it('creates the minimal private skeleton and canonical ledgers for a fresh release', () => {
    const parent = tmp('emperor-installation-fresh-')
    const emperorHome = join(parent, '.emperor')

    const result = bootstrapEmperorHome({
      emperorHome,
      source: 'default',
      legacyHome: join(parent, '.emperor-agent'),
      appVersion: '1.2.3',
      runtimeRevision: 'runtime-1',
      now: () => '2026-08-10T00:00:00.000Z',
    })

    expect(result.status).toBe('ready')
    expect(result.migration).toBe('fresh')
    for (const relative of [
      'settings.json',
      'skills',
      'memory/profile',
      'sessions',
      'migrations',
      'environment/bin',
      'environment/registry.v1.json',
      'plugins/cache',
      'plugins/data',
      'plugins/staging',
      'plugins/marketplaces',
      'plugins/known_marketplaces.json',
      'plugins/installed_plugins.json',
    ])
      expect(existsSync(join(emperorHome, relative)), relative).toBe(true)

    expect(existsSync(join(emperorHome, 'skills', 'installed.v1.json'))).toBe(
      false,
    )
    expect(existsSync(join(emperorHome, 'skills', '.staging'))).toBe(false)

    expect(
      JSON.parse(readFileSync(join(emperorHome, 'installation.json'), 'utf8')),
    ).toMatchObject({
      stateLayoutVersion: CURRENT_STATE_LAYOUT_VERSION,
      appVersion: '1.2.3',
      runtimeRevision: 'runtime-1',
      initializedAt: '2026-08-10T00:00:00.000Z',
    })
    if (process.platform !== 'win32') {
      expect(statSync(emperorHome).mode & 0o777).toBe(0o700)
      expect(statSync(join(emperorHome, 'settings.json')).mode & 0o777).toBe(
        0o600,
      )
      expect(
        statSync(join(emperorHome, 'plugins', 'installed_plugins.json')).mode &
          0o777,
      ).toBe(0o600)
    }
  })

  it('atomically renames the default legacy root and records prepared/applied migration receipts', () => {
    const parent = tmp('emperor-installation-migrate-')
    const legacyHome = join(parent, '.emperor-agent')
    const emperorHome = join(parent, '.emperor')
    mkdirSync(join(legacyHome, 'sessions', 's1'), { recursive: true })
    writeFileSync(
      join(legacyHome, 'emperor.local.json'),
      '{"prompt":{"profile":"classic"}}\n',
    )
    writeFileSync(join(legacyHome, 'sessions', 's1', 'history.jsonl'), '{}\n')

    const result = bootstrapEmperorHome({
      emperorHome,
      legacyHome,
      source: 'default',
      appVersion: '2.0.0',
      runtimeRevision: 'runtime-2',
      now: () => '2026-08-10T01:00:00.000Z',
    })

    expect(result.migration).toBe('renamed_legacy')
    expect(existsSync(legacyHome)).toBe(false)
    expect(existsSync(join(emperorHome, 'settings.json'))).toBe(true)
    expect(existsSync(join(emperorHome, 'emperor.local.json'))).toBe(false)
    expect(
      existsSync(join(emperorHome, 'sessions', 's1', 'history.jsonl')),
    ).toBe(true)
    expect(
      existsSync(
        join(emperorHome, 'migrations', 'home-layout-v1.prepared.json'),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(emperorHome, 'migrations', 'home-layout-v1.applied.json'),
      ),
    ).toBe(true)
  })

  it('keeps the new root authoritative and leaves a coexisting legacy root byte-for-byte untouched', () => {
    const parent = tmp('emperor-installation-conflict-')
    const legacyHome = join(parent, '.emperor-agent')
    const emperorHome = join(parent, '.emperor')
    mkdirSync(legacyHome, { recursive: true })
    mkdirSync(emperorHome, { recursive: true })
    writeFileSync(join(legacyHome, 'sentinel'), 'do-not-touch')
    writeFileSync(
      join(emperorHome, 'settings.json'),
      '{"prompt":{"profile":"technical"}}\n',
    )

    const before = readFileSync(join(legacyHome, 'sentinel'), 'utf8')
    const result = bootstrapEmperorHome({
      emperorHome,
      legacyHome,
      source: 'default',
      appVersion: '2.0.0',
      runtimeRevision: 'runtime-2',
    })

    expect(result.migration).toBe('legacy_conflict')
    expect(result.legacyHome).toBe(legacyHome)
    expect(readFileSync(join(legacyHome, 'sentinel'), 'utf8')).toBe(before)
    expect(existsSync(legacyHome)).toBe(true)
  })

  it('moves a conflicting legacy config into the migration conflict area without reading it', () => {
    const parent = tmp('emperor-installation-settings-conflict-')
    const emperorHome = join(parent, '.emperor')
    mkdirSync(emperorHome, { recursive: true })
    writeFileSync(
      join(emperorHome, 'settings.json'),
      '{"prompt":{"profile":"technical"}}\n',
    )
    writeFileSync(
      join(emperorHome, 'emperor.local.json'),
      '{"prompt":{"profile":"classic"}}\n',
    )

    bootstrapEmperorHome({
      emperorHome,
      source: 'explicit',
      appVersion: '2.0.0',
      runtimeRevision: 'runtime-2',
      now: () => '2026-08-10T02:03:04.000Z',
    })

    expect(readFileSync(join(emperorHome, 'settings.json'), 'utf8')).toContain(
      'technical',
    )
    expect(existsSync(join(emperorHome, 'emperor.local.json'))).toBe(false)
    expect(
      existsSync(
        join(
          emperorHome,
          'migrations',
          'conflicts',
          'emperor.local.2026-08-10T02-03-04-000Z.json',
        ),
      ),
    ).toBe(true)
  })

  it('refuses to write a Home created by a newer state layout', () => {
    const parent = tmp('emperor-installation-newer-')
    const emperorHome = join(parent, '.emperor')
    mkdirSync(emperorHome, { recursive: true })
    writeFileSync(
      join(emperorHome, 'installation.json'),
      JSON.stringify({ stateLayoutVersion: CURRENT_STATE_LAYOUT_VERSION + 1 }),
    )

    expect(() =>
      bootstrapEmperorHome({
        emperorHome,
        source: 'explicit',
        appVersion: '1.0.0',
        runtimeRevision: 'runtime-1',
      }),
    ).toThrowError(InstallationBootstrapError)
    expect(
      readFileSync(join(emperorHome, 'installation.json'), 'utf8'),
    ).toContain(String(CURRENT_STATE_LAYOUT_VERSION + 1))
  })

  it('removes only expired, well-formed Skill previews during bootstrap recovery', () => {
    const parent = tmp('emperor-installation-staging-')
    const emperorHome = join(parent, '.emperor')
    const staging = join(emperorHome, 'skills', '.staging')
    const expired = join(staging, 'preview_aaaaaaaaaaaaaaaaaaaaaaaa')
    const active = join(staging, 'preview_bbbbbbbbbbbbbbbbbbbbbbbb')
    const corrupt = join(staging, 'preview_cccccccccccccccccccccccc')
    for (const root of [expired, active, corrupt])
      mkdirSync(root, { recursive: true })
    writeFileSync(
      join(expired, 'preview.json'),
      JSON.stringify({ expiresAt: '2026-08-09T00:00:00.000Z' }),
    )
    writeFileSync(
      join(active, 'preview.json'),
      JSON.stringify({ expiresAt: '2026-08-11T00:00:00.000Z' }),
    )
    writeFileSync(join(corrupt, 'preview.json'), '{')

    bootstrapEmperorHome({
      emperorHome,
      source: 'explicit',
      appVersion: '2.0.0',
      runtimeRevision: 'runtime-2',
      now: () => '2026-08-10T00:00:00.000Z',
    })

    expect(existsSync(expired)).toBe(false)
    expect(existsSync(active)).toBe(true)
    expect(existsSync(corrupt)).toBe(true)
    expect(lstatSync(staging).isDirectory()).toBe(true)
  })

  it('classifies only an existing bootstrap lock as lock contention', () => {
    const parent = tmp('emperor-installation-lock-')
    const emperorHome = join(parent, '.emperor')
    writeFileSync(join(parent, '.emperor.bootstrap.lock'), 'occupied')

    try {
      bootstrapEmperorHome({
        emperorHome,
        source: 'explicit',
        appVersion: '2.0.0',
        runtimeRevision: 'runtime-2',
      })
      throw new Error('expected bootstrap lock failure')
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationBootstrapError)
      expect((error as InstallationBootstrapError).code).toBe(
        'installation_lock_busy',
      )
    }
  })
})
