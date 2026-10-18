import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutorConfigStore, executorSpecialties } from './config'
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
  it('uses researched defaults and persists independent overrides or an explicit empty list', () => {
    const store = setup(),
      config = store.read()
    expect(executorSpecialties(config.profiles[0]!)).toEqual([
      '代码理解',
      '重构调试',
      '测试补全',
    ])
    expect(executorSpecialties(config.profiles[1]!)).toEqual([
      '工程实现',
      '代码审查',
      '资料调研',
    ])
    config.profiles[0]!.specialties = ['接口设计', '排错']
    config.profiles[1]!.specialties = []
    store.update(0, config)
    const loaded = new ExecutorConfigStore(store.root).read()
    expect(executorSpecialties(loaded.profiles[0]!)).toEqual([
      '接口设计',
      '排错',
    ])
    expect(executorSpecialties(loaded.profiles[1]!)).toEqual([])
  })
  it('bounds specialties by six entries and twenty-four Unicode characters without rewriting invalid input', () => {
    const store = setup()
    for (const specialties of [
      Array(7).fill('编码'),
      ['字'.repeat(25)],
      [''],
      ['   '],
    ]) {
      const config = store.read()
      config.profiles[0]!.specialties = specialties
      expect(() => store.update(0, config)).toThrow(/EXECUTOR_CONFIG_INVALID/)
    }
    const config = store.read()
    config.profiles[0]!.specialties = ['🦊'.repeat(24)]
    expect(store.update(0, config).profiles[0]!.specialties).toEqual([
      '🦊'.repeat(24),
    ])
  })
  it('keeps delegation state lazy and outside the Build workspace', () => {
    const store = setup()
    const paths = resolveRuntimePaths('/runtime', {
      stateRoot: store.root,
      workspaceRoot: '/project',
    })
    expect(paths.delegationsRoot).toBe(join(store.root, 'delegations'))
    expect(paths.pathCatalog.get('delegations').createPolicy).toBe('lazy')
  })
  it('makes both local CLI logins available for direct delegation without secret fields', () => {
    const store = setup()
    const config = store.read()
    expect(config.profiles.map((p) => [p.backend, p.enabled])).toEqual([
      ['claude-code', true],
      ['codex', true],
    ])
    expect(config.profiles.map((p) => p.authRef)).toEqual([
      { kind: 'managed-cli-login' },
      { kind: 'managed-cli-login' },
    ])
    expect(JSON.stringify(config)).not.toMatch(/apiKey|accessToken/)
  })
  it('resolves empty legacy credential references locally while retaining saved choices and bytes', () => {
    const store = setup()
    const config = store.read()
    config.profiles[0]!.enabled = false
    config.profiles[0]!.executablePath = '/custom/claude'
    config.profiles[0]!.authRef = { kind: 'model-route', routeId: '' }
    config.profiles[1]!.authRef = {
      kind: 'model-route',
      routeId: 'chosen-route',
    }
    writeFileSync(store.file, JSON.stringify(config))
    const before = readFileSync(store.file, 'utf8')
    const loaded = store.read()
    expect(loaded.profiles[0]).toMatchObject({
      enabled: false,
      executablePath: '/custom/claude',
      authRef: { kind: 'managed-cli-login' },
    })
    expect(loaded.profiles[1]!.authRef).toEqual({
      kind: 'model-route',
      routeId: 'chosen-route',
    })
    expect(readFileSync(store.file, 'utf8')).toBe(before)
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
