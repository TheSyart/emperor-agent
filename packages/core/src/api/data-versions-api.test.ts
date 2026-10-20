// REL-03 on CoreApi: files a newer Emperor wrote are read-only here — read
// as well as this build can, never rewritten, never quarantined — and
// `storage.versions` names them for 设置 › 高级 › 存储 (card test 2).
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from './core-api'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp } from './test-helpers'
import { NEWER_FILE_MESSAGE } from '../store/persistence'

const VIEW = { sessionId: null }
const apis: CoreApi[] = []
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()))
})

async function open(stateRoot: string, appVersion?: string): Promise<CoreApi> {
  const { api } = await makeApi({
    root: dirname(stateRoot),
    stateRoot,
    extra: appVersion ? { appVersion } : {},
  })
  apis.push(api)
  return api
}

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

/** Rewrite `file` as a newer Emperor would: a higher version, a new key. */
function bump(home: string, file: string, key: string, version: number): void {
  const path = join(home, file)
  const value = json(path)
  writeFileSync(
    path,
    `${JSON.stringify({ ...value, [key]: version, futureOnly: { kept: true } }, null, 2)}\n`,
  )
}

function snapshot(home: string, files: string[]) {
  return Object.fromEntries(
    files.map((file) => {
      const path = join(home, file)
      return [
        file,
        { text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs },
      ]
    }),
  )
}

/** Siblings an isolation would have left (`*.corrupt-*`, `index.corrupt-*`). */
function quarantined(home: string, files: string[]): string[] {
  return files.flatMap((file) =>
    readdirSync(dirname(join(home, file))).filter((name) =>
      name.includes('corrupt'),
    ),
  )
}

describe('settings.json from a newer Emperor (2)', () => {
  it('is read but never rewritten, and the settings page is told', async () => {
    const root = tmp('emperor-rel03-settings-')
    const home = join(root, 'home')
    const first = await open(home)
    await first.browser.setPreferences(
      { showFullUrl: false, history: false },
      VIEW,
    )
    await first.close()
    apis.splice(0)

    bump(home, 'settings.json', 'version', 99)
    const before = snapshot(home, ['settings.json'])

    const api = await open(home)
    // What this build understands is still read.
    expect(await api.browser.preferences()).toMatchObject({
      showFullUrl: false,
      history: false,
    })
    await expect(
      api.browser.setPreferences({ showFullUrl: true }, VIEW),
    ).rejects.toMatchObject({
      code: 'data_file_newer',
      message: `${NEWER_FILE_MESSAGE}：settings.json`,
    })
    await expect(api.tasks.setBudget({ maxSteps: 12 }, VIEW)).rejects.toThrow(
      NEWER_FILE_MESSAGE,
    )

    expect(snapshot(home, ['settings.json'])).toEqual(before)
    expect(quarantined(home, ['settings.json'])).toEqual([])

    const report = await invokeCoreOperation(api, 'storage.versions', [])
    expect(report.files).toContainEqual(
      expect.objectContaining({
        path: 'settings.json',
        state: 'newer',
        version: 99,
        supported: 1,
      }),
    )
  })
})

describe('the other stores and a file from a newer Emperor', () => {
  it('keep every newer file byte for byte and refuse to change it', async () => {
    const root = tmp('emperor-rel03-stores-')
    const home = join(root, 'home')
    const first = await open(home)
    await first.model.saveEntry(
      {
        provider: 'openai',
        protocol: 'openai',
        modelId: 'gpt-5.2',
        displayName: 'Kept model',
        apiKey: 'sk-rel03-newer',
        apiBase: 'https://api.openai.com/v1',
        maxTokens: 8192,
        reasoningEffort: 'high',
        contextWindowTokens: 128000,
      } as never,
      VIEW,
    )
    await first.mcp.saveConfig(
      { servers: { fs: { command: 'npx', enabled: false } } },
      VIEW,
    )
    await first.hooks.saveConfig(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } },
      VIEW,
    )
    first.scheduler.createJob(
      {
        name: 'kept job',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        payload: { kind: 'agent_turn', message: 'hi', deliver: false },
        deleteAfterRun: false,
      },
      VIEW,
    )
    const kept = String(first.sessions.create({ title: 'kept session' }).id)
    first.sessions.list()
    first.host.delegationConsent.store!.grant('codex-default')
    const listed = first.executors.list()
    await first.executors.configure(
      { expectedRevision: listed.config!.revision, config: listed.config! },
      VIEW,
    )
    await first.close()
    apis.splice(0)

    bump(home, 'model_config.json', 'schemaVersion', 3)
    bump(home, 'mcp_config.json', 'version', 2)
    bump(home, 'hooks.json', 'version', 2)
    bump(home, 'scheduler/jobs.json', 'version', 2)
    bump(home, 'plugins/installed_plugins.json', 'schemaVersion', 2)
    bump(home, 'delegations/consent.json', 'schemaVersion', 2)
    bump(home, 'delegations/config.json', 'schemaVersion', 2)
    const indexPath = join(home, 'sessions', 'index.json')
    writeFileSync(
      indexPath,
      `${JSON.stringify(
        (JSON.parse(readFileSync(indexPath, 'utf8')) as object[]).map(
          (entry) => ({ ...entry, version: 2 }),
        ),
      )}\n`,
    )
    const files = [
      'model_config.json',
      'mcp_config.json',
      'hooks.json',
      'scheduler/jobs.json',
      'plugins/installed_plugins.json',
      'delegations/consent.json',
      'delegations/config.json',
      'sessions/index.json',
    ]
    const before = snapshot(home, files)

    const api = await open(home)
    // Read as well as this build can.
    const config = await api.model.getConfig()
    expect(
      (config.models as Array<{ displayName?: string }>).map(
        (entry) => entry.displayName,
      ),
    ).toContain('Kept model')
    expect(api.sessions.list().map((item) => item.id)).toContain(kept)

    // Every write is refused with the read-only message.
    await expect(
      api.model.saveEntry(
        {
          provider: 'openai',
          protocol: 'openai',
          modelId: 'gpt-5.2-mini',
          displayName: 'Refused',
          apiKey: 'sk-refused',
          apiBase: 'https://api.openai.com/v1',
          maxTokens: 4096,
          reasoningEffort: 'low',
          contextWindowTokens: 128000,
        } as never,
        VIEW,
      ),
    ).rejects.toMatchObject({ code: 'data_file_newer' })
    await expect(
      api.mcp.saveConfig({ servers: {} }, VIEW),
    ).rejects.toMatchObject({ code: 'data_file_newer' })
    await expect(
      api.hooks.saveConfig({ hooks: {} }, VIEW),
    ).rejects.toMatchObject({ code: 'data_file_newer' })
    expect(() =>
      api.scheduler.createJob(
        {
          name: 'refused',
          schedule: { kind: 'every', everyMs: 60_000 },
          payload: { kind: 'agent_turn', message: 'no', deliver: false },
          deleteAfterRun: false,
        },
        VIEW,
      ),
    ).toThrow(NEWER_FILE_MESSAGE)
    api.host.delegationConsent.store!.grant('claude-default')
    expect(() => api.executors.list().config).not.toThrow()

    // A new conversation still works; only the index on disk stays as it was.
    const added = String(api.sessions.create({ title: 'added' }).id)
    expect(api.sessions.list().map((item) => item.id)).toContain(added)

    expect(snapshot(home, files)).toEqual(before)
    expect(quarantined(home, files)).toEqual([])
    expect(existsSync(join(home, 'scheduler', 'jobs.rejected.json'))).toBe(
      false,
    )

    const report = await api.storage.versions()
    expect(
      report.files
        .filter((file) => file.state === 'newer')
        .map((file) => file.path)
        .sort(),
    ).toEqual([...files].sort())
  })
})

describe('storage.versions', () => {
  it('reports the run before this one and a downgrade (3)', async () => {
    const root = tmp('emperor-rel03-downgrade-')
    const home = join(root, 'home')
    await (await open(home, '0.3.0')).close()
    apis.splice(0)
    const api = await open(home, '0.2.0')
    // makeApi bootstraps the home itself (emperorHomePrepared: false).
    const report = await invokeCoreOperation(api, 'storage.versions', [])
    expect(report).toMatchObject({
      appVersion: '0.2.0',
      previousRunVersion: '0.3.0',
      downgradedFrom: '0.3.0',
      dataVersion: 1,
      supportedDataVersion: 1,
    })
    expect(report.files.every((file) => file.state === 'ok')).toBe(true)
  })
})
