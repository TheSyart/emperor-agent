// REL-03: data migrations (`migrations/<from>-<to>.ts`) copy the files they
// may change to `<home>/migrations/backup-<ts>/` first, record each run in
// `<home>/migrations/log.jsonl`, and put the backup back when a step fails.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_DATA_VERSION,
  bootstrapEmperorHome,
  readInstalledDataVersion,
  runPendingDataMigrations,
} from '../runtime/installation'
import { DATA_MIGRATIONS, type DataMigration } from './index'
import { runDataMigrations } from './runner'

const NOW = () => new Date('2026-10-20T08:30:00.000Z')

/** An Emperor Home as 0.1 left it: no data version, unversioned files. */
function legacyHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), 'emperor-migrations-')), 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'installation.json'),
    JSON.stringify({
      schemaVersion: 1,
      stateLayoutVersion: 1,
      appVersion: '0.1.0',
      runtimeRevision: 'r',
      initializedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      emperorHomeSource: 'explicit',
      migration: 'existing',
    }),
  )
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ webui: { port: 9001 }, enabledPlugins: { a: true } }),
  )
  writeFileSync(
    join(home, 'mcp_config.json'),
    JSON.stringify({ servers: { fs: { command: 'npx' } } }),
  )
  writeFileSync(
    join(home, 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'true' }] }] } }),
  )
  return home
}

function read(home: string, name: string): string {
  return readFileSync(join(home, name), 'utf8')
}

function logOf(home: string): Array<Record<string, unknown>> {
  const file = join(home, 'migrations', 'log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function backups(home: string): string[] {
  const root = join(home, 'migrations')
  return existsSync(root)
    ? readdirSync(root).filter((name) => name.startsWith('backup-'))
    : []
}

describe('data migrations', () => {
  it('are named <from>-<to> and form one chain up to the current version', () => {
    let version = 0
    for (const step of DATA_MIGRATIONS) {
      expect(step.id).toBe(`${step.from}-${step.to}`)
      expect(step.from).toBe(version)
      version = step.to
    }
    expect(version).toBe(CURRENT_DATA_VERSION)
  })

  it('back the files up first and log the run (4)', () => {
    const home = legacyHome()
    const originals = { 'settings.json': read(home, 'settings.json') }

    const result = runDataMigrations({ home, now: NOW, appVersion: '0.2.0' })
    expect(result).toMatchObject({
      from: 0,
      to: CURRENT_DATA_VERSION,
      applied: ['0-1'],
      failed: null,
    })

    // 0-1 gives Emperor's own settings.json a version (FIX-08: the user's
    // mcp_config.json and hooks.json are not Emperor's to stamp).
    expect(JSON.parse(read(home, 'settings.json'))).toMatchObject({
      version: 1,
    })
    expect(
      JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')),
    ).toMatchObject({ webui: { port: 9001 }, enabledPlugins: { a: true } })

    const [backup] = backups(home)
    expect(backup).toMatch(/^backup-2026-10-20T08-30-00/)
    for (const [name, text] of Object.entries(originals))
      expect(
        readFileSync(join(home, 'migrations', backup!, name), 'utf8'),
      ).toBe(text)

    expect(logOf(home)).toEqual([
      expect.objectContaining({
        kind: 'migration',
        migration: '0-1',
        from: 0,
        to: 1,
        status: 'applied',
        appVersion: '0.2.0',
        backup: `migrations/${backup}`,
        files: ['settings.json'],
      }),
    ])
    expect(readInstalledDataVersion(home)).toBe(CURRENT_DATA_VERSION)

    // Nothing is pending any more: a second run changes nothing.
    expect(runDataMigrations({ home, now: NOW }).applied).toEqual([])
    expect(logOf(home)).toHaveLength(1)
  })

  // FIX-08 (PL-10): the user's own MCP and Hook files are theirs; no
  // migration writes, backs up or moves them, whatever they hold.
  it('leave the user files mcp_config.json and hooks.json byte for byte', async () => {
    const home = legacyHome()
    const user = {
      'mcp_config.json': '{"servers":{}}\n',
      'hooks.json': '{"hooks":{}}\n',
    }
    for (const [name, text] of Object.entries(user))
      writeFileSync(join(home, name), text)
    const stamps = Object.fromEntries(
      Object.keys(user).map((name) => [
        name,
        statSync(join(home, name)).mtimeMs,
      ]),
    )

    const ran = await runPendingDataMigrations(home, { appVersion: '0.2.0' })
    expect(ran?.applied).toEqual(['0-1'])

    for (const [name, text] of Object.entries(user)) {
      expect(read(home, name)).toBe(text)
      expect(statSync(join(home, name)).mtimeMs).toBe(stamps[name])
    }
    const [backup] = backups(home)
    for (const name of Object.keys(user))
      expect(existsSync(join(home, 'migrations', backup!, name))).toBe(false)
    expect(DATA_MIGRATIONS[0]!.files(legacyHome())).toEqual(['settings.json'])
  })

  it('puts the backup back when a step fails (5)', () => {
    const home = legacyHome()
    const before = readFileSync(join(home, 'settings.json'), 'utf8')
    const broken: DataMigration = {
      id: '0-1',
      from: 0,
      to: 1,
      files: () => ['settings.json', 'created-by-step.json'],
      run(target) {
        writeFileSync(join(target, 'settings.json'), '{"half": "written"}')
        writeFileSync(join(target, 'created-by-step.json'), '{}')
        throw new Error('the step broke halfway')
      },
    }

    const result = runDataMigrations({ home, now: NOW, steps: [broken] })
    expect(result.applied).toEqual([])
    expect(result.failed).toMatchObject({
      migration: '0-1',
      error: 'the step broke halfway',
      rolledBack: true,
    })
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe(before)
    expect(existsSync(join(home, 'created-by-step.json'))).toBe(false)
    expect(readInstalledDataVersion(home)).toBe(0)
    expect(logOf(home)).toEqual([
      expect.objectContaining({
        kind: 'migration',
        migration: '0-1',
        status: 'rolled_back',
        error: 'the step broke halfway',
      }),
    ])
    // The backup it was put back from stays for a person to look at.
    expect(backups(home)).toHaveLength(1)
  })

  it('leave a home of a newer data version alone', () => {
    const home = legacyHome()
    const file = join(home, 'installation.json')
    writeFileSync(
      file,
      JSON.stringify({
        ...JSON.parse(readFileSync(file, 'utf8')),
        dataVersion: 99,
      }),
    )
    const settings = readFileSync(join(home, 'settings.json'), 'utf8')
    expect(runDataMigrations({ home, now: NOW }).applied).toEqual([])
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe(settings)
    expect(logOf(home)).toEqual([])
  })

  it('run from startup only when the home is behind', async () => {
    const fresh = join(mkdtempSync(join(tmpdir(), 'emperor-mig-fresh-')), 'h')
    bootstrapEmperorHome({
      emperorHome: fresh,
      source: 'explicit',
      legacyHome: null,
      appVersion: '0.2.0',
      runtimeRevision: 'r',
    })
    // A new home starts at the current data version: nothing to migrate.
    expect(await runPendingDataMigrations(fresh)).toBeNull()
    expect(backups(fresh)).toEqual([])

    const old = legacyHome()
    const ran = await runPendingDataMigrations(old, { appVersion: '0.2.0' })
    expect(ran?.applied).toEqual(['0-1'])
    expect(readInstalledDataVersion(old)).toBe(CURRENT_DATA_VERSION)
  })
})
