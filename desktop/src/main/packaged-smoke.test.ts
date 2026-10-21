import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PACKAGED_SMOKE_REFUSED_EXIT,
  packagedSmokeLaunch,
  parsePackagedSmokeArgs,
  runPackagedSmoke,
  systemTempRoots,
  type PackagedSmokeCore,
} from './packaged-smoke'

function rendererReceipt() {
  return {
    ok: true as const,
    nodeGlobalsAbsent: true,
    coreBridge: true,
    coreBootstrap: true,
    // REL-05: the renderer saw the app's own version (appVersion below).
    appVersion: '0.1.0',
    deepLinkRenders: true,
    attachment: { ok: true, bytes: 34 },
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
    chromiumSandbox: 'enabled' as const,
    security: {
      cspHeader: true,
      cspMeta: true,
      evalBlocked: true,
      microphoneDenied: true,
      devToolsDisabled: true,
      productionMenu: true,
      rendererUrlPinned: true,
      protocolTraversalRefused: true,
    },
  }
}

function windowsReceipt() {
  return {
    ok: true as const,
    opened: true,
    closed: true,
    reopened: true,
    distinctWindow: true,
    coreAfterReopen: true,
  }
}

function helpersReceipt() {
  return {
    ok: true as const,
    mode: 'macos' as const,
    computerUse: { handshake: true, hardenedCopy: true },
    dictation: { available: true },
  }
}

function makeCore(overrides: Partial<PackagedSmokeCore> = {}) {
  const getStatus = vi.fn(async () => ({
    status: {
      platform: process.platform,
      arch: process.arch,
      tools: [],
      skills: [],
      diagnostics: [],
    },
    activeJob: null,
    recentJobs: [],
  }))
  const core: PackagedSmokeCore = {
    bootstrap: vi.fn(async () => ({
      app: 'Emperor Agent',
      // computer-use ships in its plugin, which starts off with its
      // master switch, so a fresh packaged runtime does not list it.
      skills: [
        { name: 'skill-creator', source: 'builtin' },
        { name: 'github', source: 'plugin' },
      ],
    })),
    diagnostics: {
      get: vi.fn(async () => ({
        root: '/signed/runtime-defaults',
        sandbox: {
          backend: 'macos-seatbelt',
          status: 'available',
        },
        kernel: {
          lifecycle: {
            state: 'ready',
            services: [
              { id: 'process-runtime', required: true, state: 'ready' },
              { id: 'harness-kernel', required: true, state: 'ready' },
              { id: 'mcp', required: true, state: 'ready' },
              { id: 'scheduler', required: true, state: 'ready' },
            ],
          },
        },
      })),
    },
    environment: { getStatus },
    sessions: {
      create: vi.fn(() => ({ id: 'packaged-smoke-build' })),
    },
    terminals: {
      create: vi.fn(() => ({ id: 'terminal-smoke' })),
      write: vi.fn(),
      read: vi.fn(() => ({
        chunks: [{ seq: 1, data: 'emperor-pty-smoke\r\n' }],
        latestSeq: 1,
      })),
      close: vi.fn(),
    },
    ...overrides,
  }
  return { core, getStatus }
}

function smokeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-smoke-unit-'))
  const runtimeRoot = path.join(root, 'runtime-defaults')
  const stateRoot = path.join(root, 'state')
  const receiptPath = path.join(root, 'receipt.json')
  fs.mkdirSync(runtimeRoot, { recursive: true })
  fs.writeFileSync(
    path.join(runtimeRoot, 'runtime-manifest.json'),
    JSON.stringify({ schemaVersion: 1, appVersion: '0.1.0' }),
  )
  return { root, runtimeRoot, stateRoot, receiptPath }
}

describe('packaged smoke launch guard (SEC-04, MAIN-28)', () => {
  const smoke = (receipt = path.join(os.tmpdir(), 'emperor-smoke.json')) => [
    'Emperor Agent',
    '--emperor-packaged-smoke',
    '--emperor-smoke-receipt',
    receipt,
  ]
  const realHome = os.userInfo().homedir

  it('exits 64 (EX_USAGE) when it refuses', () => {
    expect(PACKAGED_SMOKE_REFUSED_EXIT).toBe(64)
  })

  it('does nothing without the smoke flag', () => {
    expect(
      packagedSmokeLaunch(['Emperor Agent'], {
        stateRoot: path.join(realHome, '.emperor'),
      }),
    ).toEqual({ kind: 'none' })
  })

  it('runs with a state root inside the system temp directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-smoke-guard-'))
    try {
      const receipt = path.join(root, 'receipt.json')
      expect(
        packagedSmokeLaunch(smoke(receipt), {
          stateRoot: path.join(root, 'state'),
        }),
      ).toEqual({ kind: 'run', receiptPath: receipt, scenario: 'fresh' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('7. refuses the real ~/.emperor and any state root outside temp', () => {
    for (const stateRoot of [
      path.join(realHome, '.emperor'),
      path.join(realHome, 'Documents', 'emperor-smoke'),
      '/opt/emperor-state',
    ]) {
      const launch = packagedSmokeLaunch(smoke(), { stateRoot })
      expect(launch).toMatchObject({ kind: 'refuse' })
      expect(
        fs.existsSync(path.join(stateRoot, 'packaged-smoke-workspace')),
      ).toBe(false)
    }
  })

  it('refuses a temp path that leads out of temp through a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-smoke-guard-'))
    try {
      fs.symlinkSync(realHome, path.join(root, 'home'))
      expect(
        packagedSmokeLaunch(smoke(), {
          stateRoot: path.join(root, 'home', '.emperor'),
        }),
      ).toMatchObject({ kind: 'refuse' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses the temp directory itself, the real home inside temp, and a bad receipt', () => {
    const tempRoot = systemTempRoots(process.platform)[0]!
    expect(packagedSmokeLaunch(smoke(), { stateRoot: tempRoot })).toMatchObject(
      { kind: 'refuse' },
    )
    // Even a home under temp: its own ~/.emperor is never a smoke target.
    expect(
      packagedSmokeLaunch(smoke(), {
        stateRoot: path.join(tempRoot, 'someone', '.emperor'),
        userHome: path.join(tempRoot, 'someone'),
      }),
    ).toMatchObject({ kind: 'refuse' })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-smoke-guard-'))
    try {
      for (const argv of [
        ['Emperor Agent', '--emperor-packaged-smoke'],
        smoke('relative.json'),
      ])
        expect(
          packagedSmokeLaunch(argv, { stateRoot: path.join(root, 'state') }),
        ).toMatchObject({ kind: 'refuse' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('knows the system temp directories of each platform', () => {
    expect(systemTempRoots('darwin')).toEqual([
      '/private/tmp',
      '/private/var/folders',
    ])
    expect(systemTempRoots('linux')).toEqual(['/tmp', '/var/tmp', '/dev/shm'])
  })
})

describe('packaged smoke contract', () => {
  it('only enables the fixed packaged smoke mode with an absolute receipt path', () => {
    const receiptPath = path.join(os.tmpdir(), 'emperor-smoke.json')

    expect(parsePackagedSmokeArgs(['Emperor Agent'])).toBeNull()
    expect(() =>
      parsePackagedSmokeArgs([
        'Emperor Agent',
        '--emperor-packaged-smoke',
        '--emperor-smoke-receipt',
        'relative.json',
      ]),
    ).toThrow(/absolute/i)
    expect(
      parsePackagedSmokeArgs([
        'Emperor Agent',
        '--emperor-packaged-smoke',
        '--emperor-smoke-receipt',
        receiptPath,
      ]),
    ).toEqual({ receiptPath, scenario: 'fresh' })
    // REL-04: the second launch of the runner, on a 0.1.0-preview.4 home.
    expect(
      parsePackagedSmokeArgs([
        'Emperor Agent',
        '--emperor-packaged-smoke',
        '--emperor-smoke-receipt',
        receiptPath,
        '--emperor-smoke-scenario',
        'upgrade',
      ]),
    ).toEqual({ receiptPath, scenario: 'upgrade' })
    expect(() =>
      parsePackagedSmokeArgs([
        'Emperor Agent',
        '--emperor-packaged-smoke',
        '--emperor-smoke-receipt',
        receiptPath,
        '--emperor-smoke-scenario',
        'real-home',
      ]),
    ).toThrow(/scenario/i)
  })

  it('closes the main window and opens it again, on every platform (REL-04)', async () => {
    for (const verifyWindows of [
      undefined,
      async () => ({ ...windowsReceipt(), distinctWindow: false }),
      async () => {
        throw new Error('the reopened main window did not load')
      },
    ]) {
      const fixture = smokeFixture()
      const { core } = makeCore()
      await expect(
        runPackagedSmoke({
          core,
          runtimeRoot: fixture.runtimeRoot,
          stateRoot: fixture.stateRoot,
          receiptPath: fixture.receiptPath,
          appVersion: '0.1.0',
          runtimeRevision: 'a'.repeat(64),
          commit: 'b'.repeat(40),
          platform: 'darwin',
          arch: 'arm64',
          verifySeatbelt: async () => ({
            ok: true as const,
            mode: 'workspace-write' as const,
            commands: 18,
            protectedStateDenied: true as const,
          }),
          verifyRenderer: async () => rendererReceipt(),
          verifyHelpers: async () => helpersReceipt(),
          ...(verifyWindows ? { verifyWindows } : {}),
        } as Parameters<typeof runPackagedSmoke>[0]),
      ).rejects.toThrow(/window/i)
      expect(
        JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8')).operations
          .windows,
      ).toMatchObject({ ok: false })
    }
  })

  it('runs bootstrap, diagnostics, environment and native search without installing', async () => {
    const fixture = smokeFixture()
    const { core, getStatus } = makeCore()
    const verifySeatbelt = vi.fn(async () => ({
      ok: true as const,
      mode: 'workspace-write' as const,
      commands: 18,
      protectedStateDenied: true as const,
    }))
    const verifyHelpers = vi.fn(async () => helpersReceipt())

    const receipt = await runPackagedSmoke({
      core,
      runtimeRoot: fixture.runtimeRoot,
      stateRoot: fixture.stateRoot,
      receiptPath: fixture.receiptPath,
      appVersion: '0.1.0',
      runtimeRevision: 'a'.repeat(64),
      commit: 'b'.repeat(40),
      platform: 'darwin',
      arch: 'arm64',
      verifySeatbelt,
      verifyRenderer: async () => rendererReceipt(),
      verifyWindows: async () => windowsReceipt(),
      verifyHelpers,
    })

    expect(core.bootstrap).toHaveBeenCalledOnce()
    expect(core.diagnostics.get).toHaveBeenCalledOnce()
    expect(getStatus).toHaveBeenCalledWith(
      { forceRefresh: true },
      { sessionId: null },
    )
    expect(receipt.operations).toMatchObject({
      bootstrap: {
        ok: true,
        builtInSkills: ['skill-creator'],
        pluginSkills: ['github'],
      },
      diagnostics: {
        ok: true,
        sandbox: {
          backend: 'macos-seatbelt',
          status: 'available',
          provenance: 'host-os',
        },
        lifecycle: {
          state: 'ready',
          readyServices: [
            'harness-kernel',
            'mcp',
            'process-runtime',
            'scheduler',
          ],
        },
      },
      environment: { ok: true },
      glob: { ok: true },
      grep: { ok: true },
      terminal: { ok: true, outputBytes: 19 },
      seatbelt: {
        ok: true,
        mode: 'workspace-write',
        commands: 18,
        protectedStateDenied: true,
      },
      renderer: rendererReceipt(),
      windows: windowsReceipt(),
      helpers: helpersReceipt(),
    })
    expect(verifyHelpers).toHaveBeenCalledOnce()
    expect(verifySeatbelt).toHaveBeenCalledWith(
      path.join(fixture.stateRoot, 'packaged-smoke-workspace'),
      fixture.stateRoot,
    )
    expect(receipt.installJobs).toEqual({ before: 0, after: 0 })
    expect(receipt.exitCode).toBe(0)
    expect(JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8'))).toEqual(
      receipt,
    )
    expect(
      fs.readdirSync(fixture.root).some((name) => name.includes('.tmp-')),
    ).toBe(false)
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain(os.homedir())
    expect(serialized).not.toContain(process.env.PATH || '__missing_path__')
    expect(serialized).not.toContain(fixture.stateRoot)
  })

  it.each([
    [
      'without the GitHub plugin Skill',
      [{ name: 'skill-creator', source: 'builtin' }],
    ],
    [
      'with computer-use back among the built-ins',
      [
        { name: 'skill-creator', source: 'builtin' },
        { name: 'computer-use', source: 'builtin' },
        { name: 'github', source: 'plugin' },
      ],
    ],
    [
      'with a Skill from another source',
      [
        { name: 'skill-creator', source: 'builtin' },
        { name: 'github', source: 'plugin' },
        { name: 'mine', source: 'user' },
      ],
    ],
  ])('fails closed %s', async (_name, skills) => {
    const fixture = smokeFixture()
    const { core } = makeCore({
      bootstrap: vi.fn(async () => ({ app: 'Emperor Agent', skills })),
    })
    await expect(
      runPackagedSmoke({
        core,
        runtimeRoot: fixture.runtimeRoot,
        stateRoot: fixture.stateRoot,
        receiptPath: fixture.receiptPath,
        appVersion: '0.1.0',
        runtimeRevision: 'a'.repeat(64),
        commit: 'local',
        platform: 'linux',
        arch: 'x64',
        verifyRenderer: async () => rendererReceipt(),
        verifyWindows: async () => windowsReceipt(),
      }),
    ).rejects.toThrow(/skills/i)
    expect(
      JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8')),
    ).toMatchObject({ exitCode: 1, error: { code: 'smoke_failed' } })
  })

  it('fails closed when the packaged main window lacks a renderer defense (SEC-05)', async () => {
    const fixture = smokeFixture()
    const { core } = makeCore()
    const receipt = rendererReceipt()
    await expect(
      runPackagedSmoke({
        core,
        runtimeRoot: fixture.runtimeRoot,
        stateRoot: fixture.stateRoot,
        receiptPath: fixture.receiptPath,
        appVersion: '0.1.0',
        runtimeRevision: 'a'.repeat(64),
        commit: 'b'.repeat(40),
        platform: 'darwin',
        arch: 'arm64',
        verifySeatbelt: async () => ({
          ok: true as const,
          mode: 'workspace-write' as const,
          commands: 18,
          protectedStateDenied: true as const,
        }),
        verifyRenderer: async () => ({
          ...receipt,
          security: { ...receipt.security, cspHeader: false },
        }),
        verifyWindows: async () => windowsReceipt(),
      }),
    ).rejects.toThrow(/renderer sandbox receipt/i)
  })

  it('5. fails closed when the renderer saw another version than the app (REL-05)', async () => {
    for (const appVersion of ['0.2.0', null]) {
      const fixture = smokeFixture()
      const { core } = makeCore()
      await expect(
        runPackagedSmoke({
          core,
          runtimeRoot: fixture.runtimeRoot,
          stateRoot: fixture.stateRoot,
          receiptPath: fixture.receiptPath,
          appVersion: '0.1.0',
          runtimeRevision: 'a'.repeat(64),
          commit: 'b'.repeat(40),
          platform: 'darwin',
          arch: 'arm64',
          verifySeatbelt: async () => ({
            ok: true as const,
            mode: 'workspace-write' as const,
            commands: 18,
            protectedStateDenied: true as const,
          }),
          verifyRenderer: async () => ({ ...rendererReceipt(), appVersion }),
          verifyWindows: async () => windowsReceipt(),
          verifyHelpers: async () => helpersReceipt(),
        }),
      ).rejects.toThrow(/renderer sandbox receipt/i)
    }
  })

  it('fails closed when bootstrap exposes anything beyond the built-in skills', async () => {
    const fixture = smokeFixture()
    const { core } = makeCore({
      bootstrap: vi.fn(async () => ({
        app: 'Emperor Agent',
        skills: [
          { name: 'skill-creator', source: 'builtin' },
          { name: 'unexpected', source: 'builtin' },
        ],
      })),
    })

    await expect(
      runPackagedSmoke({
        core,
        runtimeRoot: fixture.runtimeRoot,
        stateRoot: fixture.stateRoot,
        receiptPath: fixture.receiptPath,
        appVersion: '0.1.0',
        runtimeRevision: 'a'.repeat(64),
        commit: 'local',
        platform: 'linux',
        arch: 'x64',
        verifyRenderer: async () => rendererReceipt(),
        verifyWindows: async () => windowsReceipt(),
      }),
    ).rejects.toThrow(/skill-creator/i)
    expect(
      JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8')),
    ).toMatchObject({ exitCode: 1, error: { code: 'smoke_failed' } })
  })

  it('fails closed when packaged diagnostics omit the sandbox capability receipt', async () => {
    const fixture = smokeFixture()
    const { core } = makeCore({
      diagnostics: { get: vi.fn(async () => ({ root: '/runtime' })) },
    })

    await expect(
      runPackagedSmoke({
        core,
        runtimeRoot: fixture.runtimeRoot,
        stateRoot: fixture.stateRoot,
        receiptPath: fixture.receiptPath,
        appVersion: '0.1.0',
        runtimeRevision: 'a'.repeat(64),
        commit: 'b'.repeat(40),
        platform: 'darwin',
        arch: 'arm64',
        verifyRenderer: async () => rendererReceipt(),
        verifyWindows: async () => windowsReceipt(),
      }),
    ).rejects.toThrow(/sandbox/i)
  })

  it('fails closed when a macOS package has no real Seatbelt command probe', async () => {
    const fixture = smokeFixture()
    const { core } = makeCore()

    await expect(
      runPackagedSmoke({
        core,
        runtimeRoot: fixture.runtimeRoot,
        stateRoot: fixture.stateRoot,
        receiptPath: fixture.receiptPath,
        appVersion: '0.1.0',
        runtimeRevision: 'a'.repeat(64),
        commit: 'b'.repeat(40),
        platform: 'darwin',
        arch: 'arm64',
        verifyRenderer: async () => rendererReceipt(),
        verifyWindows: async () => windowsReceipt(),
      }),
    ).rejects.toThrow(/Seatbelt command probe/)
    expect(
      JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8')).operations
        .seatbelt,
    ).toMatchObject({ ok: false, protectedStateDenied: false })
  })

  it('fails closed when a macOS package does not prove its helpers (SEC-04)', async () => {
    const seatbelt = async () => ({
      ok: true as const,
      mode: 'workspace-write' as const,
      commands: 18,
      protectedStateDenied: true as const,
    })
    for (const verifyHelpers of [
      undefined,
      async () => ({
        ...helpersReceipt(),
        computerUse: { handshake: true, hardenedCopy: false },
      }),
    ]) {
      const fixture = smokeFixture()
      const { core } = makeCore()
      await expect(
        runPackagedSmoke({
          core,
          runtimeRoot: fixture.runtimeRoot,
          stateRoot: fixture.stateRoot,
          receiptPath: fixture.receiptPath,
          appVersion: '0.1.0',
          runtimeRevision: 'a'.repeat(64),
          commit: 'b'.repeat(40),
          platform: 'darwin',
          arch: 'arm64',
          verifySeatbelt: seatbelt,
          verifyRenderer: async () => rendererReceipt(),
          verifyWindows: async () => windowsReceipt(),
          ...(verifyHelpers ? { verifyHelpers } : {}),
        }),
      ).rejects.toThrow(/helper/i)
      expect(
        JSON.parse(fs.readFileSync(fixture.receiptPath, 'utf8')).operations
          .helpers,
      ).toMatchObject({ ok: false })
    }
  })

  it('fails closed when a required lifecycle service is not ready', async () => {
    const fixture = smokeFixture()
    const { core } = makeCore({
      diagnostics: {
        get: vi.fn(async () => ({
          sandbox: { backend: 'macos-seatbelt', status: 'available' },
          kernel: {
            lifecycle: {
              state: 'degraded',
              services: [
                { id: 'process-runtime', required: true, state: 'ready' },
                { id: 'harness-kernel', required: true, state: 'ready' },
                { id: 'mcp', required: true, state: 'unavailable' },
                { id: 'scheduler', required: true, state: 'ready' },
              ],
            },
          },
        })),
      },
    })

    await expect(
      runPackagedSmoke({
        core,
        runtimeRoot: fixture.runtimeRoot,
        stateRoot: fixture.stateRoot,
        receiptPath: fixture.receiptPath,
        appVersion: '0.1.0',
        runtimeRevision: 'a'.repeat(64),
        commit: 'b'.repeat(40),
        platform: 'darwin',
        arch: 'arm64',
        verifyRenderer: async () => rendererReceipt(),
        verifyWindows: async () => windowsReceipt(),
      }),
    ).rejects.toThrow(/lifecycle/i)
  })
})
