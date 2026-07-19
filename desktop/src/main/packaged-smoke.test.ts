import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parsePackagedSmokeArgs,
  runPackagedSmoke,
  type PackagedSmokeCore,
} from './packaged-smoke'

function rendererReceipt() {
  return {
    ok: true as const,
    nodeGlobalsAbsent: true,
    coreBridge: true,
    coreBootstrap: true,
    attachment: { ok: true, bytes: 34 },
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
    chromiumSandbox: 'enabled' as const,
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
      skills: [{ name: 'skill-creator', source: 'builtin' }],
    })),
    diagnostics: {
      get: vi.fn(async () => ({
        root: '/signed/runtime-defaults',
        sandbox: {
          backend: 'macos-seatbelt',
          status: 'available',
        },
        lifecycle: {
          state: 'ready',
          failedServiceId: null,
          failedPhase: null,
          services: [
            { id: 'process-runtime', required: true, state: 'ready' },
            { id: 'code-intelligence', required: true, state: 'ready' },
            { id: 'task-runtime', required: true, state: 'ready' },
            { id: 'subagent-supervisor', required: true, state: 'ready' },
            { id: 'session-runtime', required: true, state: 'ready' },
            { id: 'mcp', required: true, state: 'ready' },
            { id: 'scheduler', required: true, state: 'ready' },
          ],
        },
      })),
    },
    environment: { getStatus },
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
    ).toEqual({ receiptPath })
  })

  it('runs bootstrap, diagnostics, environment and native search without installing', async () => {
    const fixture = smokeFixture()
    const { core, getStatus } = makeCore()

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
      verifyRenderer: async () => rendererReceipt(),
    })

    expect(core.bootstrap).toHaveBeenCalledOnce()
    expect(core.diagnostics.get).toHaveBeenCalledOnce()
    expect(getStatus).toHaveBeenCalledWith({
      forceRefresh: true,
      projectRoot: path.join(fixture.stateRoot, 'packaged-smoke-workspace'),
    })
    expect(receipt.operations).toMatchObject({
      bootstrap: { ok: true, builtInSkills: ['skill-creator'] },
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
            'code-intelligence',
            'mcp',
            'process-runtime',
            'scheduler',
            'session-runtime',
            'subagent-supervisor',
            'task-runtime',
          ],
        },
      },
      environment: { ok: true },
      glob: { ok: true },
      grep: { ok: true },
      renderer: rendererReceipt(),
    })
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

  it('fails closed when bootstrap exposes anything beyond skill-creator', async () => {
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
      }),
    ).rejects.toThrow(/sandbox/i)
  })

  it('fails closed when a required lifecycle service is not ready', async () => {
    const fixture = smokeFixture()
    const { core } = makeCore({
      diagnostics: {
        get: vi.fn(async () => ({
          sandbox: { backend: 'macos-seatbelt', status: 'available' },
          lifecycle: {
            state: 'starting',
            services: [
              { id: 'process-runtime', required: true, state: 'ready' },
              { id: 'code-intelligence', required: true, state: 'ready' },
              { id: 'task-runtime', required: true, state: 'ready' },
              {
                id: 'subagent-supervisor',
                required: true,
                state: 'ready',
              },
              { id: 'session-runtime', required: true, state: 'starting' },
              { id: 'mcp', required: true, state: 'pending' },
              { id: 'scheduler', required: true, state: 'pending' },
            ],
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
      }),
    ).rejects.toThrow(/lifecycle/i)
  })
})
