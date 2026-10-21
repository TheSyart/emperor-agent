import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
      '代码库理解',
      '功能开发',
      '重构排错',
      '测试补全',
      '文档检索',
    ])
    expect(executorSpecialties(config.profiles[1]!)).toEqual([
      '功能开发',
      '代码审查',
      '测试排错',
      '联网调研',
      '图像生成',
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
  it('uses both local CLI logins without secret fields, off until the user turns them on', () => {
    const store = setup()
    const config = store.read()
    expect(config.profiles.map((p) => [p.backend, p.enabled])).toEqual([
      ['claude-code', false],
      ['codex', false],
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
  it('7. ignores and clears the legacy pinned expectedVersion when reading', () => {
    const store = setup()
    const legacy = store.read() as unknown as {
      revision: number
      profiles: Record<string, unknown>[]
    }
    legacy.revision = 4
    legacy.profiles[0]!.expectedVersion = '2.1.281'
    legacy.profiles[0]!.executablePath = '/opt/homebrew/bin/claude'
    legacy.profiles[1]!.expectedVersion = '0.153.4'
    writeFileSync(store.file, JSON.stringify(legacy))
    const loaded = store.read()
    for (const profile of loaded.profiles)
      expect(profile).not.toHaveProperty('expectedVersion')
    expect(loaded.revision).toBe(4)
    expect(loaded.profiles[0]!.executablePath).toBe('/opt/homebrew/bin/claude')
    const onDisk = readFileSync(store.file, 'utf8')
    expect(onDisk).not.toContain('expectedVersion')
    expect(JSON.parse(onDisk).revision).toBe(4)
    // A renderer still holding the legacy field can save it once more.
    expect(store.update(4, legacy).profiles[1]).not.toHaveProperty(
      'expectedVersion',
    )
  })
  it('defaults Claude Code to the bundled binary and keeps Codex on the installed CLI', () => {
    const store = setup()
    const [claude, codex] = store.read().profiles
    expect(claude!.executableSource).toBe('bundled')
    expect(codex!.executableSource).toBeUndefined()
    const config = store.read()
    config.profiles[1]!.executableSource = 'bundled'
    expect(() => store.update(0, config)).toThrow(/EXECUTOR_CONFIG_INVALID/)
    const local = store.read()
    local.profiles[0]!.executableSource = 'system'
    expect(store.update(0, local).profiles[0]!.executableSource).toBe('system')
  })
  it('rejects quotas that exceed the architectural bounds', () => {
    const store = setup()
    const config = store.read()
    // 同时运行 is 1–4 (AGT-10): two executors of up to two runs each.
    config.limits.globalConcurrency = 5
    expect(() => store.update(0, config)).toThrow(/EXECUTOR_CONFIG_INVALID/)
    config.limits.globalConcurrency = 4
    expect(store.update(0, config).limits.globalConcurrency).toBe(4)
  })
})

describe('external executors are opt-in (AGT-05)', () => {
  const branchDefault = (revision: number, extra: object = {}) => ({
    schemaVersion: 1,
    revision,
    profiles: [
      {
        id: 'claude-default',
        backend: 'claude-code',
        enabled: true,
        executableSource: 'bundled',
        executablePath: 'claude',
        authRef: { kind: 'managed-cli-login' },
        stateDirectoryId: 'claude-default',
        concurrencyLimit: 1,
      },
      {
        id: 'codex-default',
        backend: 'codex',
        enabled: true,
        executablePath: 'codex',
        authRef: { kind: 'managed-cli-login' },
        stateDirectoryId: 'codex-default',
        concurrencyLimit: 1,
      },
    ],
    limits: {
      globalConcurrency: 2,
      maxQueuedMessages: 16,
      maxRunsPerTask: 32,
      maxDepth: 3,
      runTimeoutMs: 1_800_000,
      questionTimeoutMs: 900_000,
      estimatedBudgetUsd: 10,
    },
    ...extra,
  })
  it('a fresh install has both external executors off and nothing to explain', () => {
    const config = setup().read()
    expect(config.profiles.map((p) => [p.backend, p.enabled])).toEqual([
      ['claude-code', false],
      ['codex', false],
    ])
    expect(config.upgradeNotice).toBeUndefined()
  })
  it('turns off a branch default the user never saved, once, and says so', () => {
    const store = setup()
    writeFileSync(store.file, JSON.stringify(branchDefault(4)))
    const config = store.read()
    expect(config.profiles.every((p) => !p.enabled)).toBe(true)
    expect(config.upgradeNotice).toBe('external-default-off')
    expect(config.revision).toBe(4)
    const file = JSON.parse(readFileSync(store.file, 'utf8'))
    expect(file.profiles.every((p: { enabled: boolean }) => !p.enabled)).toBe(
      true,
    )
    expect(file.upgradeNotice).toBe('external-default-off')
    expect(file.touchedAt).toBeUndefined()
  })
  it('keeps an executor the user turned on in settings', () => {
    const store = setup()
    writeFileSync(
      store.file,
      JSON.stringify(branchDefault(7, { touchedAt: 1_760_000_000_000 })),
    )
    const config = store.read()
    expect(config.profiles.every((p) => p.enabled)).toBe(true)
    expect(config.upgradeNotice).toBeUndefined()
  })
  it('saving records that the user touched the settings and clears the notice', () => {
    const store = setup()
    writeFileSync(store.file, JSON.stringify(branchDefault(4)))
    const config = store.read()
    config.profiles[1]!.enabled = true
    const saved = store.update(4, config)
    expect(saved.touchedAt).toEqual(expect.any(Number))
    expect(saved.upgradeNotice).toBeUndefined()
    const again = new ExecutorConfigStore(store.root).read()
    expect(again.profiles[1]!.enabled).toBe(true)
    expect(again.upgradeNotice).toBeUndefined()
  })
  it('explains the change to someone who ran external tasks without ever saving settings', () => {
    const store = setup()
    mkdirSync(join(store.root, 'conversations', 'dlg-earlier'), {
      recursive: true,
    })
    const config = store.read()
    expect(config.profiles.every((p) => !p.enabled)).toBe(true)
    expect(config.upgradeNotice).toBe('external-default-off')
  })
})
it('keeps diagnostics mode off unless saved on, and writes the flag only when on', async () => {
  const { defaultExecutorConfig } = await import('./config')
  const root = mkdtempSync(join(tmpdir(), 'executor-diagnostics-'))
  try {
    const store = new ExecutorConfigStore(root)
    expect(store.read().diagnosticsMode).toBeUndefined()
    const on = store.update(store.read().revision, {
      ...defaultExecutorConfig(),
      diagnosticsMode: true,
    })
    expect(on.diagnosticsMode).toBe(true)
    const off = store.update(on.revision, { ...on, diagnosticsMode: false })
    expect(off.diagnosticsMode).toBeUndefined()
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain(
      'diagnosticsMode',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('验证后再应用 is off by default and stored only when on (AGT-06)', async () => {
  const { defaultExecutorConfig } = await import('./config')
  const root = mkdtempSync(join(tmpdir(), 'executor-verify-first-'))
  try {
    const store = new ExecutorConfigStore(root)
    expect(store.read().verifyBeforeApply).toBeUndefined()
    const on = store.update(store.read().revision, {
      ...defaultExecutorConfig(),
      verifyBeforeApply: true,
    })
    expect(on.verifyBeforeApply).toBe(true)
    const off = store.update(on.revision, { ...on, verifyBeforeApply: false })
    expect(off.verifyBeforeApply).toBeUndefined()
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain(
      'verifyBeforeApply',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('子智能体 settings (AGT-10)', () => {
  it('stores the local subagent model only when one is chosen', async () => {
    const { defaultExecutorConfig, localSubagentModelOf } =
      await import('./config')
    const root = mkdtempSync(join(tmpdir(), 'executor-local-model-'))
    roots.push(root)
    const store = new ExecutorConfigStore(root)
    expect(localSubagentModelOf(store.read())).toBeUndefined()
    const chosen = store.update(store.read().revision, {
      ...defaultExecutorConfig(),
      localSubagentModel: 'entry-fast',
    })
    expect(localSubagentModelOf(chosen)).toBe('entry-fast')
    const following = store.update(chosen.revision, {
      ...chosen,
      localSubagentModel: undefined,
    })
    expect(localSubagentModelOf(following)).toBeUndefined()
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain(
      'localSubagentModel',
    )
  })

  it('stores where external tasks change code only when it is not the worktree default', async () => {
    const { defaultExecutorConfig, defaultWorkspaceOf } =
      await import('./config')
    const root = mkdtempSync(join(tmpdir(), 'executor-workspace-'))
    roots.push(root)
    const store = new ExecutorConfigStore(root)
    expect(defaultWorkspaceOf(store.read())).toBe('isolated-worktree')
    const shared = store.update(store.read().revision, {
      ...defaultExecutorConfig(),
      defaultWorkspace: 'shared-exclusive',
    })
    expect(defaultWorkspaceOf(shared)).toBe('shared-exclusive')
    const back = store.update(shared.revision, {
      ...shared,
      defaultWorkspace: 'isolated-worktree',
    })
    expect(back.defaultWorkspace).toBeUndefined()
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain(
      'defaultWorkspace',
    )
  })

  it('rejects a read-only review as the place to change code, and an empty model id', async () => {
    const { defaultExecutorConfig } = await import('./config')
    const store = setup()
    expect(() =>
      store.update(0, {
        ...defaultExecutorConfig(),
        defaultWorkspace: 'shared-readonly' as never,
      }),
    ).toThrow(/EXECUTOR_CONFIG_INVALID/)
    expect(() =>
      store.update(0, { ...defaultExecutorConfig(), localSubagentModel: '' }),
    ).toThrow(/EXECUTOR_CONFIG_INVALID/)
  })
})
