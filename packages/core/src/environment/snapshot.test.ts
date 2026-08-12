import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBundledToolCatalog } from './catalog'
import type { EnvironmentProbeStatus } from './probe'
import {
  ExecutionEnvironmentService,
  type ExecutionEnvironmentProbe,
} from './snapshot'

function status(
  pathEntries = ['/opt/volta/bin', '/usr/bin'],
): EnvironmentProbeStatus {
  const catalog = loadBundledToolCatalog()
  return {
    cacheKey: 'a'.repeat(64),
    catalogRevision: catalog.revision,
    projectFingerprint: 'b'.repeat(64),
    project: {
      projectRoot: '/workspace',
      fingerprint: 'b'.repeat(64),
      declarations: {
        node: {
          ecosystem: 'node',
          detected: false,
          status: 'absent',
          source: null,
          rawRequirement: null,
          normalizedRequirement: null,
          reason: null,
        },
        python: {
          ecosystem: 'python',
          detected: false,
          status: 'absent',
          source: null,
          rawRequirement: null,
          normalizedRequirement: null,
          reason: null,
        },
        go: {
          ecosystem: 'go',
          detected: false,
          status: 'absent',
          source: null,
          rawRequirement: null,
          normalizedRequirement: null,
          reason: null,
        },
        rust: {
          ecosystem: 'rust',
          detected: false,
          status: 'absent',
          source: null,
          rawRequirement: null,
          normalizedRequirement: null,
          reason: null,
        },
      },
      files: [],
      diagnostics: [],
    },
    platform: 'darwin',
    arch: 'arm64',
    pathEntries,
    tools: catalog.catalog.tools.map((tool) => ({
      id: tool.id,
      category: tool.category === 'base' ? 'base' : 'project',
      required: tool.id === 'node',
      reason: 'test',
      declarationSource: null,
      status: tool.id === 'node' ? 'ready' : 'missing',
      detectedVersion: tool.id === 'node' ? '24.18.0' : null,
      versionSummary: tool.id === 'node' ? 'v24.18.0' : null,
      requiredVersion: tool.version.requirement,
      executablePath: tool.id === 'node' ? '/opt/volta/bin/node' : null,
      installStrategy: null,
      sourceUrl: null,
      requiresElevation: false,
      requiresSeparateConfirmation: false,
    })),
    skills: [],
    diagnostics: [],
  }
}

class FakeProbe implements ExecutionEnvironmentProbe {
  calls = 0
  current = status()
  onGetStatus: (() => void) | null = null
  lastRequest: Parameters<ExecutionEnvironmentProbe['getStatus']>[0] | null =
    null

  async getStatus(
    request: Parameters<ExecutionEnvironmentProbe['getStatus']>[0],
  ): Promise<EnvironmentProbeStatus> {
    this.calls += 1
    this.lastRequest = request
    this.onGetStatus?.()
    return structuredClone(this.current)
  }
}

describe('ExecutionEnvironmentService', () => {
  it('puts the managed bin first and exposes only active managed command entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-managed-env-'))
    const managedBinRoot = join(root, 'environment', 'bin')
    const registryFile = join(root, 'environment', 'registry.v1.json')
    mkdirSync(managedBinRoot, { recursive: true })
    writeFileSync(
      registryFile,
      `${JSON.stringify({
        schemaVersion: 1,
        tools: {
          'agent-reach': {
            placement: 'managed',
            activeVersion: '1.2.3',
            commands: { 'agent-reach': 'agent-reach' },
          },
          external: {
            placement: 'external',
            activeVersion: '4.0.0',
            commands: { external: '/usr/local/bin/external' },
          },
          broken: {
            placement: 'managed',
            activeVersion: null,
            commands: { broken: '../escape' },
          },
        },
      })}\n`,
    )
    const probe = new FakeProbe()
    const service = new ExecutionEnvironmentService({
      probe,
      env: { HOME: '/Users/tester', PATH: '/host/bin' },
      managedBinRoot,
      managedRegistryFile: registryFile,
      now: () => new Date('2026-07-11T02:00:00.000Z'),
    })

    const snapshot = await service.create({ projectRoot: '/workspace' })

    expect(snapshot.pathEntries).toEqual([
      managedBinRoot,
      '/opt/volta/bin',
      '/usr/bin',
    ])
    expect(snapshot.env.PATH).toBe(`${managedBinRoot}:/opt/volta/bin:/usr/bin`)
    expect(snapshot.hostProcessEnv().PATH).toBe(snapshot.env.PATH)
    expect(snapshot.managedBinRoot).toBe(managedBinRoot)
    expect(snapshot.managedCommands).toEqual({
      'agent-reach': join(managedBinRoot, 'agent-reach'),
      external: '/usr/local/bin/external',
    })
    expect(snapshot.managedSources).toEqual({
      'agent-reach': { placement: 'managed', version: '1.2.3' },
      external: { placement: 'external', version: '4.0.0' },
    })
    expect(probe.lastRequest?.envOverride?.PATH).toBe(
      `${managedBinRoot}:/host/bin`,
    )
    expect(Object.isFrozen(snapshot.managedCommands)).toBe(true)
    expect(Object.isFrozen(snapshot.managedSources)).toBe(true)
  })

  it('creates a deeply immutable minimal snapshot without serializing secrets', async () => {
    const probe = new FakeProbe()
    const service = new ExecutionEnvironmentService({
      probe,
      env: {
        HOME: '/Users/tester',
        PATH: '/host/bin',
        LANG: 'zh_CN.UTF-8',
        TERM: 'xterm-256color',
        API_TOKEN: 'secret-value',
        HTTP_PROXY: 'http://user:password@example.test',
      },
      now: () => new Date('2026-07-11T02:00:00.000Z'),
    })

    const snapshot = await service.create({ projectRoot: '/workspace' })
    expect(snapshot.createdAt).toBe('2026-07-11T02:00:00.000Z')
    expect(snapshot.pathEntries).toEqual(['/opt/volta/bin', '/usr/bin'])
    expect(snapshot.env).toEqual({
      HOME: '/Users/tester',
      LANG: 'zh_CN.UTF-8',
      PATH: '/opt/volta/bin:/usr/bin',
      TERM: 'xterm-256color',
    })
    expect(snapshot.toolPaths).toEqual({ node: '/opt/volta/bin/node' })
    expect(snapshot.selectEnv(['API_TOKEN', 'MISSING'])).toEqual({
      API_TOKEN: 'secret-value',
    })
    expect(snapshot.selectEnv(['PATH'])).toEqual({
      PATH: '/opt/volta/bin:/usr/bin',
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret-value')
    expect(JSON.stringify(snapshot)).not.toContain('password')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.env)).toBe(true)
    expect(Object.isFrozen(snapshot.pathEntries)).toBe(true)
    expect(Object.isFrozen(snapshot.toolPaths)).toBe(true)
  })

  it('injects Emperor-owned paths and a verified CA bundle into the private host environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-env-paths-'))
    const caBundle = join(root, 'cert.pem')
    writeFileSync(caBundle, 'test certificate bundle', 'utf8')
    const probe = new FakeProbe()
    const service = new ExecutionEnvironmentService({
      probe,
      env: {
        HOME: '/Users/tester',
        PATH: '/host/bin',
        HTTPS_PROXY: 'http://proxy.test:7890',
      },
      emperorHome: root,
      userSkillsRoot: join(root, 'skills'),
      environmentRoot: join(root, 'environment'),
      scratchRoot: join(root, 'sessions', '.scratch'),
      systemCaBundle: caBundle,
    })

    const snapshot = await service.create({ projectRoot: '/workspace' })
    expect(snapshot.hostProcessEnv()).toMatchObject({
      EMPEROR_HOME: root,
      EMPEROR_SKILLS_DIR: join(root, 'skills'),
      EMPEROR_ENVIRONMENT_DIR: join(root, 'environment'),
      EMPEROR_SCRATCH_DIR: join(root, 'sessions', '.scratch'),
      NODE_EXTRA_CA_CERTS: caBundle,
      HTTPS_PROXY: 'http://proxy.test:7890',
    })
    expect(snapshot.caSource).toBe('system_bundle')
    expect(snapshot.emperorPaths).toEqual({
      home: root,
      skills: join(root, 'skills'),
      environment: join(root, 'environment'),
      scratch: join(root, 'sessions', '.scratch'),
    })
  })

  it('preserves an explicit NODE_EXTRA_CA_CERTS value', async () => {
    const probe = new FakeProbe()
    const service = new ExecutionEnvironmentService({
      probe,
      env: {
        HOME: '/Users/tester',
        PATH: '/host/bin',
        NODE_EXTRA_CA_CERTS: '/custom/ca.pem',
      },
      systemCaBundle: '/system/ca.pem',
    })

    const snapshot = await service.create({ projectRoot: '/workspace' })
    expect(snapshot.hostProcessEnv().NODE_EXTRA_CA_CERTS).toBe('/custom/ca.pem')
    expect(snapshot.caSource).toBe('user')
  })

  it('keeps revisions stable for identical inputs and changes on executable environment changes', async () => {
    const probe = new FakeProbe()
    let env = { HOME: '/Users/tester', PATH: '/host/bin', TOKEN: 'one' }
    const service = new ExecutionEnvironmentService({
      probe,
      env: () => env,
      now: () => new Date('2026-07-11T02:00:00.000Z'),
    })

    const first = await service.create({ projectRoot: '/workspace' })
    const second = await service.create({ projectRoot: '/workspace' })
    expect(second.revision).toBe(first.revision)

    env = { ...env, TOKEN: 'two' }
    const secretChanged = await service.create({ projectRoot: '/workspace' })
    expect(secretChanged.revision).not.toBe(first.revision)
    expect(secretChanged.selectEnv(['TOKEN'])).toEqual({ TOKEN: 'two' })

    probe.current = status(['/new/bin', '/usr/bin'])
    const pathChanged = await service.create({ projectRoot: '/workspace' })
    expect(pathChanged.revision).not.toBe(secretChanged.revision)
    expect(pathChanged.env.PATH).toBe('/new/bin:/usr/bin')

    probe.current = {
      ...probe.current,
      projectFingerprint: 'c'.repeat(64),
      project: {
        ...probe.current.project,
        projectRoot: '/other-workspace',
        fingerprint: 'c'.repeat(64),
      },
    }
    const projectChanged = await service.create({
      projectRoot: '/other-workspace',
    })
    expect(projectChanged.revision).not.toBe(pathChanged.revision)
    expect(projectChanged.projectFingerprint).toBe('c'.repeat(64))
  })

  it('uses Windows case-insensitive selection and platform separators', async () => {
    const probe = new FakeProbe()
    probe.current = {
      ...status(['C:\\Volta\\bin', 'C:\\Windows\\System32']),
      platform: 'win32',
      arch: 'x64',
    }
    const service = new ExecutionEnvironmentService({
      probe,
      env: {
        USERPROFILE: 'C:\\Users\\Tester',
        SystemRoot: 'C:\\Windows',
        Path: 'C:\\host',
        Hook_Secret: 'visible',
      },
      now: () => new Date('2026-07-11T02:00:00.000Z'),
    })

    const snapshot = await service.create({ projectRoot: 'C:\\workspace' })
    expect(snapshot.env.PATH).toBe('C:\\Volta\\bin;C:\\Windows\\System32')
    expect(snapshot.env.USERPROFILE).toBe('C:\\Users\\Tester')
    expect(snapshot.selectEnv(['HOOK_SECRET'])).toEqual({
      HOOK_SECRET: 'visible',
    })
  })

  it('captures Probe PATH inputs and private values from one instant', async () => {
    const probe = new FakeProbe()
    let env = { HOME: '/Users/tester', PATH: '/first', TOKEN: 'first' }
    probe.onGetStatus = () => {
      env = { HOME: '/Users/tester', PATH: '/second', TOKEN: 'second' }
    }
    const service = new ExecutionEnvironmentService({
      probe,
      env: () => env,
      now: () => new Date('2026-07-11T02:00:00.000Z'),
    })

    const snapshot = await service.create({ projectRoot: '/workspace' })

    expect(probe.lastRequest?.envOverride).toMatchObject({
      PATH: '/first',
      TOKEN: 'first',
    })
    expect(snapshot.selectEnv(['TOKEN'])).toEqual({ TOKEN: 'first' })
  })
})
