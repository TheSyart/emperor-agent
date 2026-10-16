import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutorConfigStore } from './config'
import { resolveRuntimePaths } from '../../runtime/paths'

const roots: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-delegation-config-'))
  roots.push(root)
  return new ExecutorConfigStore(root)
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)

describe('executor configuration', () => {
  it('keeps delegation state lazy and outside the Build workspace', () => {
    const store = setup()
    const paths = resolveRuntimePaths('/runtime', {
      stateRoot: store.root,
      workspaceRoot: '/project',
    })
    expect(paths.delegationsRoot).toBe(join(store.root, 'delegations'))
    expect(paths.pathCatalog.get('delegations').createPolicy).toBe('lazy')
  })
  it('starts with both external profiles disabled and no secret fields', () => {
    const store = setup()
    const config = store.read()
    expect(config.profiles.map((p) => [p.backend, p.enabled])).toEqual([
      ['claude-code', false],
      ['codex', false],
    ])
    expect(JSON.stringify(config)).not.toMatch(/apiKey|accessToken/)
  })
  it('roundtrips a profile and advances the revision', () => {
    const store = setup()
    const config = store.read()
    config.profiles[0]!.enabled = true
    const saved = store.update(config.revision, config)
    expect(saved.revision).toBe(1)
    expect(new ExecutorConfigStore(store.root).read()).toEqual(saved)
  })
  it('rejects stale revisions without changing the file', () => {
    const store = setup()
    const config = store.read()
    store.update(0, config)
    const before = readFileSync(store.file, 'utf8')
    expect(() => store.update(0, config)).toThrow(/STALE_REVISION/)
    expect(readFileSync(store.file, 'utf8')).toBe(before)
  })
  it('preserves corrupt and future configuration instead of overwriting', () => {
    const store = setup()
    store.update(0, store.read())
    for (const raw of ['{broken', '{"schemaVersion":2}']) {
      writeFileSync(store.file, raw)
      expect(() => store.read()).toThrow(/EXECUTOR_CONFIG_INVALID/)
      expect(readFileSync(store.file, 'utf8')).toBe(raw)
    }
  })
  it('rejects duplicate profile ids, escaped state directories, and injected credentials', () => {
    const store = setup()
    for (const mutate of [
      (c: any) => {
        c.profiles[1].id = c.profiles[0].id
      },
      (c: any) => {
        c.profiles[0].stateDirectoryId = '../foreign'
      },
      (c: any) => {
        c.profiles[0].apiKey = 'private-value'
      },
    ]) {
      const config = store.read()
      mutate(config)
      expect(() => store.update(0, config)).toThrow(/EXECUTOR_CONFIG_INVALID/)
    }
  })
  it('rejects quotas that exceed the architectural bounds', () => {
    const store = setup()
    const config = store.read()
    config.limits.globalConcurrency = 3
    expect(() => store.update(0, config)).toThrow(/EXECUTOR_CONFIG_INVALID/)
  })
})
