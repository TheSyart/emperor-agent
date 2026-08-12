import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PluginStore } from './store'
import type { InstalledPluginEntry } from './models'

function fixture() {
  const emperorHome = mkdtempSync(join(tmpdir(), 'emperor-plugin-store-'))
  return {
    emperorHome,
    pluginsRoot: join(emperorHome, 'plugins'),
  }
}

function entry(
  root: string,
  scope: InstalledPluginEntry['scope'],
): InstalledPluginEntry {
  return {
    pluginId: 'official/agent-reach',
    scope,
    version: '1.2.3',
    digest: 'a'.repeat(64),
    installPath: join(root, 'cache', 'official', 'agent-reach', '1.2.3'),
    source: { kind: 'marketplace', marketplace: 'official' },
    installedAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  }
}

describe('PluginStore', () => {
  it('atomically persists materialized versions per scope with private modes', () => {
    const { pluginsRoot } = fixture()
    const store = new PluginStore({ pluginsRoot })
    store.upsert(entry(pluginsRoot, 'user'))
    store.upsert(entry(pluginsRoot, 'project'))

    expect(store.list('official/agent-reach')).toHaveLength(2)
    expect(existsSync(store.installedFile)).toBe(true)
    expect(JSON.parse(readFileSync(store.installedFile, 'utf8'))).toMatchObject(
      { schemaVersion: 1 },
    )
    if (process.platform !== 'win32')
      expect(statSync(store.installedFile).mode & 0o777).toBe(0o600)
  })

  it('rejects materialized paths outside the canonical Plugin cache', () => {
    const { emperorHome, pluginsRoot } = fixture()
    const store = new PluginStore({ pluginsRoot })
    expect(() =>
      store.upsert({
        ...entry(pluginsRoot, 'user'),
        installPath: join(emperorHome, 'skills', 'agent-reach'),
      }),
    ).toThrow(/cache/i)
    expect(store.list()).toEqual([])
  })

  it('replaces only the matching scope and removes materialization without deleting files', () => {
    const { pluginsRoot } = fixture()
    const store = new PluginStore({ pluginsRoot })
    store.upsert(entry(pluginsRoot, 'user'))
    store.upsert({ ...entry(pluginsRoot, 'project'), version: '2.0.0' })
    store.upsert({ ...entry(pluginsRoot, 'user'), version: '1.3.0' })

    expect(store.list().map((item) => `${item.scope}:${item.version}`)).toEqual(
      ['project:2.0.0', 'user:1.3.0'],
    )
    expect(store.remove('official/agent-reach', 'user')).toBe(true)
    expect(store.list()).toMatchObject([{ scope: 'project', version: '2.0.0' }])
  })
})
