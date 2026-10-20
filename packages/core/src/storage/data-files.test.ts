// REL-03 card test 1: every persistent file of the inventory carries a
// version — written by the stores themselves on a new home, and stamped by
// migration 0-1 on a home an older Emperor left behind.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from '../api/core-api'
import { makeApi } from '../api/test-helpers'
import { runDataMigrations } from '../migrations/runner'
import { declaredVersion } from '../store/persistence'
import { DATA_FILES, inspectDataFiles } from './data-files'

const VIEW = { sessionId: null }
const apis: CoreApi[] = []
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()))
})

/** The inventory files Core writes (vault and browser files are main's). */
const CORE_FILES = DATA_FILES.filter((file) => file.owner === 'core')

describe('the data file inventory', () => {
  it('names every file of the card, each with its version key', () => {
    expect(DATA_FILES.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'installation.json',
        'settings.json',
        'model_config.json',
        'mcp_config.json',
        'hooks.json',
        'scheduler/jobs.json',
        'computer-use/vault.json',
        'sessions/index.json',
        'plugins/installed_plugins.json',
        'browser/user-downloads.json',
        'browser/downloads/.index.json',
        'delegations/config.json',
        'delegations/consent.json',
      ]),
    )
    for (const file of DATA_FILES) {
      expect(['version', 'schemaVersion']).toContain(file.key)
      expect(file.supported).toBeGreaterThanOrEqual(1)
      expect(file.label.length).toBeGreaterThan(0)
    }
  })

  it('every file the stores write on a new home carries a version (1)', async () => {
    const fixture = await makeApi()
    apis.push(fixture.api)
    const { api, stateRoot } = fixture

    await api.browser.setPreferences({ showFullUrl: false }, VIEW)
    await api.model.saveEntry(
      {
        provider: 'openai',
        protocol: 'openai',
        modelId: 'gpt-5.2',
        displayName: 'Scan',
        apiKey: 'sk-rel03-scan',
        apiBase: 'https://api.openai.com/v1',
        maxTokens: 8192,
        reasoningEffort: 'high',
        contextWindowTokens: 128000,
      } as never,
      VIEW,
    )
    await api.mcp.saveConfig(
      { servers: { fs: { command: 'npx', args: ['server'], enabled: false } } },
      VIEW,
    )
    await api.hooks.saveConfig(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
      VIEW,
    )
    api.scheduler.createJob(
      {
        name: 'scan',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agent_turn', message: 'scan', deliver: false },
        deleteAfterRun: false,
      },
      VIEW,
    )
    api.sessions.create({ title: 'scan' })
    api.sessions.list()
    api.host.delegationConsent.store!.grant('codex-default')
    const listed = api.executors.list()
    await api.executors.configure(
      { expectedRevision: listed.config!.revision, config: listed.config! },
      VIEW,
    )

    const states = inspectDataFiles(stateRoot)
    for (const file of CORE_FILES) {
      const path = join(stateRoot, file.path)
      expect(existsSync(path), file.path).toBe(true)
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
      expect(declaredVersion(value, file.key), file.path).toBe(file.supported)
      expect(
        states.find((state) => state.path === file.path),
        file.path,
      ).toMatchObject({ state: 'ok', version: file.supported })
    }
  })

  it('migration 0-1 versions what an older Emperor left (1)', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'emperor-scan-old-')), 'home')
    mkdirSync(join(home, 'scheduler'), { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{}')
    writeFileSync(join(home, 'mcp_config.json'), '{"servers": {}}')
    writeFileSync(join(home, 'hooks.json'), '{"Stop": []}')
    writeFileSync(
      join(home, 'scheduler', 'jobs.json'),
      '{"version": 1, "jobs": []}',
    )
    expect(
      inspectDataFiles(home)
        .filter((state) => state.state === 'unversioned')
        .map((state) => state.path)
        .sort(),
    ).toEqual(['hooks.json', 'mcp_config.json', 'settings.json'])

    runDataMigrations({ home })

    const states = inspectDataFiles(home)
    expect(states.filter((state) => state.state !== 'ok')).toEqual([])
    expect(states.map((state) => state.path).sort()).toEqual([
      'hooks.json',
      'mcp_config.json',
      'scheduler/jobs.json',
      'settings.json',
    ])
  })

  it('tells a newer, an unreadable and an unversioned file apart', () => {
    const home = mkdtempSync(join(tmpdir(), 'emperor-scan-states-'))
    writeFileSync(join(home, 'settings.json'), '{"version": 4}')
    writeFileSync(join(home, 'model_config.json'), '{"schemaVersion": 2,')
    writeFileSync(join(home, 'mcp_config.json'), '{"servers": {}}')
    const byPath = Object.fromEntries(
      inspectDataFiles(home).map((state) => [state.path, state]),
    )
    expect(byPath['settings.json']).toMatchObject({
      state: 'newer',
      version: 4,
      supported: 1,
    })
    expect(byPath['model_config.json']).toMatchObject({ state: 'unreadable' })
    expect(byPath['mcp_config.json']).toMatchObject({
      state: 'unversioned',
      version: null,
    })
    expect(byPath['hooks.json']).toBeUndefined()
  })
})
