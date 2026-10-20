// REL-03: installation.json records which Emperor ran last, so a run of an
// older Emperor is noticed (the startup banner), and the data version the
// migrations advance. A newer installation.json is never rewritten.
import {
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
  CURRENT_DATA_VERSION,
  bootstrapEmperorHome,
  compareAppVersions,
  readInstalledDataVersion,
} from './installation'

function home(): string {
  return join(mkdtempSync(join(tmpdir(), 'emperor-install-versions-')), 'home')
}

function boot(emperorHome: string, appVersion: string) {
  return bootstrapEmperorHome({
    emperorHome,
    source: 'explicit',
    legacyHome: null,
    appVersion,
    runtimeRevision: 'runtime-1',
  })
}

function installation(emperorHome: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(emperorHome, 'installation.json'), 'utf8'),
  ) as Record<string, unknown>
}

describe('compareAppVersions', () => {
  it('orders releases, previews and leaves unknown shapes out', () => {
    expect(compareAppVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareAppVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareAppVersions('0.10.0', '0.9.3')).toBeGreaterThan(0)
    expect(compareAppVersions('0.1.0-preview.4', '0.1.0')).toBeLessThan(0)
    expect(
      compareAppVersions('0.1.0-preview.10', '0.1.0-preview.4'),
    ).toBeGreaterThan(0)
    expect(compareAppVersions('development', '0.1.0')).toBeNull()
    expect(compareAppVersions('0.0.0-headless', '0.1.0')).toBeNull()
  })
})

describe('installation.json versions', () => {
  it('records the version that ran, and the one before it', () => {
    const emperorHome = home()
    expect(boot(emperorHome, '0.2.0').downgradedFrom).toBeNull()
    expect(installation(emperorHome)).toMatchObject({
      lastRunVersion: '0.2.0',
      previousRunVersion: null,
      dataVersion: CURRENT_DATA_VERSION,
    })
    expect(boot(emperorHome, '0.2.1').downgradedFrom).toBeNull()
    expect(installation(emperorHome)).toMatchObject({
      lastRunVersion: '0.2.1',
      previousRunVersion: '0.2.0',
    })
  })

  it('notices a run of an older Emperor than last time (3)', () => {
    const emperorHome = home()
    boot(emperorHome, '0.3.0')
    const older = boot(emperorHome, '0.2.0')
    expect(older.downgradedFrom).toBe('0.3.0')
    expect(installation(emperorHome)).toMatchObject({
      lastRunVersion: '0.2.0',
      previousRunVersion: '0.3.0',
    })
    // The next start of the same build is not a downgrade any more.
    expect(boot(emperorHome, '0.2.0').downgradedFrom).toBeNull()
  })

  it('reads the version an older installation.json kept as appVersion', () => {
    const emperorHome = home()
    mkdirSync(emperorHome, { recursive: true })
    writeFileSync(
      join(emperorHome, 'installation.json'),
      JSON.stringify({
        schemaVersion: 1,
        stateLayoutVersion: 1,
        appVersion: '0.4.0',
        runtimeRevision: 'r',
        initializedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        emperorHomeSource: 'explicit',
        migration: 'existing',
      }),
    )
    expect(boot(emperorHome, '0.2.0').downgradedFrom).toBe('0.4.0')
    // An older home has data version 0: its migrations have not run.
    expect(readInstalledDataVersion(emperorHome)).toBe(0)
  })

  it('does not record a build without a release version', () => {
    const emperorHome = home()
    boot(emperorHome, '0.2.0')
    expect(boot(emperorHome, '0.0.0-headless').downgradedFrom).toBeNull()
    expect(installation(emperorHome)).toMatchObject({
      lastRunVersion: '0.2.0',
    })
    expect(boot(emperorHome, '0.1.0').downgradedFrom).toBe('0.2.0')
  })

  it('keeps the data version a newer run left (never lowers it)', () => {
    const emperorHome = home()
    boot(emperorHome, '0.2.0')
    const file = join(emperorHome, 'installation.json')
    writeFileSync(
      file,
      JSON.stringify({ ...installation(emperorHome), dataVersion: 5 }),
    )
    boot(emperorHome, '0.2.0')
    expect(installation(emperorHome).dataVersion).toBe(5)
    expect(readInstalledDataVersion(emperorHome)).toBe(5)
  })

  it('never rewrites an installation.json of a newer schema', () => {
    const emperorHome = home()
    boot(emperorHome, '0.2.0')
    const file = join(emperorHome, 'installation.json')
    const newer = `${JSON.stringify({
      ...installation(emperorHome),
      schemaVersion: 2,
      lastRunVersion: '0.5.0',
      futureField: { kept: true },
    })}\n`
    writeFileSync(file, newer)
    const before = statSync(file).mtimeMs
    const result = boot(emperorHome, '0.2.0')
    expect(result.downgradedFrom).toBe('0.5.0')
    expect(readFileSync(file, 'utf8')).toBe(newer)
    expect(statSync(file).mtimeMs).toBe(before)
  })
})
