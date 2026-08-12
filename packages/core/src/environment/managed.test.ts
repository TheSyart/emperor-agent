import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssetDownloader } from './download'
import {
  ManagedEnvironmentService,
  type ManagedEnvironmentInstallEvent,
} from './managed'
import type {
  OwnedProcessRequest,
  OwnedProcessResult,
  OwnedProcessRunner,
} from './process-runner'
import { ExecutionEnvironment } from './snapshot'
import { SkillManager } from '../skills/manager'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-managed-service-'))
}

describe('ManagedEnvironmentService', () => {
  it('repairs managed command activation from the registry after an interrupted switch', async () => {
    const stateRoot = tempRoot()
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const skillManager = new SkillManager({ stateRoot, runtimeRoot })
    const executable = join(
      stateRoot,
      'environment',
      'tools',
      'agent-reach',
      '1.2.3-aaaaaaaaaaaa',
      'bin',
      'agent-reach',
    )
    mkdirSync(join(executable, '..'), { recursive: true })
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 })
    const binRoot = join(stateRoot, 'environment', 'bin')
    mkdirSync(binRoot, { recursive: true })
    symlinkSync('/missing/previous-version', join(binRoot, 'agent-reach'))
    writeFileSync(
      join(stateRoot, 'environment', 'registry.v1.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        tools: {
          'agent-reach': {
            toolId: 'agent-reach',
            placement: 'managed',
            activeVersion: '1.2.3',
            activeKey: '1.2.3-aaaaaaaaaaaa',
            sourceDigest: 'a'.repeat(64),
            recipeTrust: 'installed_skill_source',
            dataRootMode: 'external_disclosed',
            dataRootEnvironmentVariable: null,
            commands: { 'agent-reach': 'agent-reach' },
            commandTargets: {
              'agent-reach':
                'tools/agent-reach/1.2.3-aaaaaaaaaaaa/bin/agent-reach',
            },
            versions: {},
            updatedAt: '2026-08-10T06:00:00.000Z',
          },
        },
      })}\n`,
    )
    const service = new ManagedEnvironmentService({
      stateRoot,
      skillManager,
      processRunner: new RecordingInstallerRunner(),
    })

    await service.initialize()

    expect(readlinkSync(join(binRoot, 'agent-reach'))).toBe(executable)
    expect(existsSync(executable)).toBe(true)
  })

  it('derives a Python recipe from an installed Skill source and activates it through exact owned-process requests', async () => {
    const stateRoot = tempRoot()
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const skillManager = new SkillManager({ stateRoot, runtimeRoot })
    const skillRoot = join(stateRoot, 'skills', 'agent-reach')
    mkdirSync(skillRoot, { recursive: true })
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      '---\nname: agent-reach\ndescription: Network research\n---\n',
    )
    const archive = zip([
      {
        name: 'agent-reach-main/pyproject.toml',
        data: [
          '[project]',
          'name = "agent-reach"',
          'version = "1.2.3"',
          'license = { text = "MIT" }',
          '[project.scripts]',
          'agent-reach = "agent_reach.cli:main"',
          '[build-system]',
          'requires = ["hatchling"]',
          'build-backend = "hatchling.build"',
        ].join('\n'),
      },
      {
        name: 'agent-reach-main/agent_reach/__init__.py',
        data: '__version__ = "1.2.3"\n',
      },
    ])
    const archiveDigest = createHash('sha256').update(archive).digest('hex')
    writeFileSync(
      join(stateRoot, 'skills', 'installed.v1.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        skills: {
          'agent-reach': {
            name: 'agent-reach',
            status: 'active',
            sourceDigest: archiveDigest,
            source: {
              kind: 'github_repo',
              resolvedUrl: `https://codeload.github.com/Panniantong/agent-reach/zip/${'a'.repeat(40)}`,
              repository: 'Panniantong/agent-reach',
              ref: 'a'.repeat(40),
            },
          },
        },
      })}\n`,
    )
    const downloader: AssetDownloader = {
      async download(request) {
        writeFileSync(request.destination, archive)
      },
    }
    const runner = new RecordingInstallerRunner()
    const events: ManagedEnvironmentInstallEvent[] = []
    const service = new ManagedEnvironmentService({
      stateRoot,
      skillManager,
      downloader,
      processRunner: runner,
      now: () => new Date('2026-08-10T06:00:00.000Z'),
      idFactory: () => 'managed_plan_aaaaaaaaaaaaaaaa',
      onInstallEvent: async (event) => {
        events.push(structuredClone(event))
      },
    })
    const executionEnvironment = executionEnvironmentFixture()

    const preview = await service.previewInstall({
      source: { kind: 'skill', value: 'agent-reach' },
      sessionId: 'session-01',
    })

    expect(preview).toMatchObject({
      planId: 'managed_plan_aaaaaaaaaaaaaaaa',
      placement: 'managed',
      recipeTrust: 'installed_skill_source',
      source: {
        kind: 'skill',
        value: 'agent-reach',
        digest: archiveDigest,
      },
      candidates: [
        {
          toolId: 'agent-reach',
          version: '1.2.3',
          recipeKind: 'python_venv',
          entrypoints: ['agent-reach'],
          license: 'MIT',
          potentialInstallScripts: ['python_build_backend:hatchling.build'],
          dataRootMode: 'external_disclosed',
        },
      ],
    })
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(
      existsSync(
        join(stateRoot, 'environment', 'downloads', `${archiveDigest}.zip`),
      ),
    ).toBe(true)

    await expect(
      service.confirmInstall({
        planId: preview.planId,
        digest: preview.digest,
        sessionId: 'session-01',
        permissionConfirmed: false,
        executionEnvironment,
      }),
    ).rejects.toThrow(/permission|confirmation/i)

    const result = await service.confirmInstall({
      planId: preview.planId,
      digest: preview.digest,
      sessionId: 'session-01',
      permissionConfirmed: true,
      executionEnvironment,
    })

    expect(result).toMatchObject({
      toolId: 'agent-reach',
      version: '1.2.3',
      placement: 'managed',
      status: 'active',
      commands: ['agent-reach'],
      verification: { command: 'agent-reach doctor --json', exitCode: 0 },
    })
    expect(events).toEqual([
      expect.objectContaining({
        phase: 'started',
        status: 'running',
        source: 'skill',
        placement: 'managed',
        recipeTrust: 'installed_skill_source',
      }),
      expect.objectContaining({
        phase: 'completed',
        status: 'completed',
        source: 'skill',
        placement: 'managed',
        recipeTrust: 'installed_skill_source',
      }),
    ])
    expect(runner.requests).toHaveLength(3)
    expect(runner.requests.map((request) => request.args)).toEqual([
      [
        '-m',
        'venv',
        expect.stringContaining('/environment/tools/agent-reach/'),
      ],
      [
        '-m',
        'pip',
        '--disable-pip-version-check',
        '--no-input',
        'install',
        expect.stringContaining('/environment/jobs/managed/'),
      ],
      ['doctor', '--json'],
    ])
    for (const request of runner.requests) {
      expect(request.execution).toMatchObject({
        kind: 'host',
        authorization: {
          toolName: 'manage_environment',
          planId: preview.planId,
          recipeDigest: preview.digest,
          toolId: 'agent-reach',
          toolVersion: '1.2.3',
          sessionId: 'session-01',
        },
      })
      expect(request.owner).toEqual({
        kind: 'environment',
        id: preview.planId,
        sessionId: 'session-01',
      })
    }
    const registry = JSON.parse(
      readFileSync(join(stateRoot, 'environment', 'registry.v1.json'), 'utf8'),
    )
    expect(registry).toMatchObject({
      schemaVersion: 1,
      tools: {
        'agent-reach': {
          placement: 'managed',
          activeVersion: '1.2.3',
          sourceDigest: archiveDigest,
          recipeTrust: 'installed_skill_source',
          dataRootMode: 'external_disclosed',
          commands: { 'agent-reach': 'agent-reach' },
        },
      },
    })
    const command = join(stateRoot, 'environment', 'bin', 'agent-reach')
    expect(existsSync(command)).toBe(true)
    expect(lstatSync(command).isSymbolicLink()).toBe(true)
  })

  it('recognizes npm and verified archive recipes without accepting arbitrary shell metadata', async () => {
    const stateRoot = tempRoot()
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const skillManager = new SkillManager({ stateRoot, runtimeRoot })
    const archives = [
      zip([
        {
          name: 'tool/package.json',
          data: JSON.stringify({
            name: '@acme/tool',
            version: '4.5.6',
            license: 'Apache-2.0',
            bin: { acme: './cli.js' },
            scripts: { postinstall: 'node setup.js' },
          }),
        },
        { name: 'tool/cli.js', data: '#!/usr/bin/env node\n' },
      ]),
      zip([
        {
          name: 'portable/emperor-environment.json',
          data: JSON.stringify({
            schemaVersion: 1,
            toolId: 'portable-tool',
            version: '7.0.0',
            publisher: 'Acme',
            license: 'MIT',
            commands: { portable: 'bin/portable' },
            dataRoot: { mode: 'managed', env: 'PORTABLE_HOME' },
          }),
        },
        { name: 'portable/bin/portable', data: '#!/bin/sh\nexit 0\n' },
      ]),
    ]
    let downloadIndex = 0
    const runner = new RecordingInstallerRunner()
    const service = new ManagedEnvironmentService({
      stateRoot,
      skillManager,
      downloader: {
        async download(request) {
          writeFileSync(request.destination, archives[downloadIndex++]!)
        },
      },
      processRunner: runner,
      idFactory: () =>
        downloadIndex === 0
          ? 'managed_plan_bbbbbbbbbbbbbbbb'
          : 'managed_plan_cccccccccccccccc',
    })

    const npmPreview = await service.previewInstall({
      source: { kind: 'url', value: 'https://example.com/acme-tool-4.5.6.zip' },
      sessionId: 'session-01',
    })
    expect(npmPreview.candidates[0]).toMatchObject({
      recipeKind: 'npm_prefix',
      toolId: 'acme-tool',
      version: '4.5.6',
      entrypoints: ['acme'],
      potentialInstallScripts: ['npm:postinstall'],
      dataRootMode: 'external_disclosed',
    })
    await expect(
      service.confirmInstall({
        planId: npmPreview.planId,
        digest: npmPreview.digest,
        sessionId: 'session-01',
        permissionConfirmed: true,
        executionEnvironment: executionEnvironmentFixture(),
      }),
    ).resolves.toMatchObject({
      toolId: 'acme-tool',
      version: '4.5.6',
      placement: 'managed',
    })
    expect(runner.requests[0]?.args).toEqual([
      'install',
      '--global',
      '--prefix',
      expect.stringContaining('/environment/tools/acme-tool/'),
      '--no-audit',
      '--no-fund',
      expect.stringContaining('/environment/jobs/managed/'),
    ])

    const archivePreview = await service.previewInstall({
      source: {
        kind: 'url',
        value: 'https://example.com/portable-tool-7.0.0.zip',
      },
      sessionId: 'session-01',
    })
    expect(archivePreview.candidates[0]).toMatchObject({
      recipeKind: 'verified_archive',
      toolId: 'portable-tool',
      version: '7.0.0',
      entrypoints: ['portable'],
      potentialInstallScripts: [],
      dataRootMode: 'managed',
      dataRootEnvironmentVariable: 'PORTABLE_HOME',
    })
    expect(JSON.stringify(archivePreview)).not.toContain('shell')
  })

  it('resolves GitHub URLs whose branch names contain slashes to an immutable commit', async () => {
    const stateRoot = tempRoot()
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const archive = zip([
      {
        name: 'tool/package.json',
        data: JSON.stringify({
          name: 'branch-tool',
          version: '1.0.0',
          license: 'MIT',
          bin: { 'branch-tool': './cli.js' },
        }),
      },
      { name: 'tool/cli.js', data: '#!/usr/bin/env node\n' },
    ])
    const commit = 'd'.repeat(40)
    const urls: string[] = []
    const service = new ManagedEnvironmentService({
      stateRoot,
      skillManager: new SkillManager({ stateRoot, runtimeRoot }),
      downloader: {
        async download(request) {
          urls.push(request.url)
          if (request.url.endsWith('/commits/feature%2Fagent'))
            writeFileSync(request.destination, JSON.stringify({ sha: commit }))
          else if (request.url.includes('/commits/'))
            writeFileSync(request.destination, '{}')
          else writeFileSync(request.destination, archive)
        },
      },
      processRunner: new RecordingInstallerRunner(),
      idFactory: () => 'managed_plan_eeeeeeeeeeeeeeee',
    })

    const preview = await service.previewInstall({
      source: {
        kind: 'url',
        value:
          'https://github.com/acme/branch-tool/tree/feature/agent/docs/install',
      },
      sessionId: 'session-01',
    })

    expect(preview.source).toMatchObject({
      repository: 'acme/branch-tool',
      ref: commit,
      resolvedUrl: `https://codeload.github.com/acme/branch-tool/zip/${commit}`,
    })
    expect(urls).toContain(
      'https://api.github.com/repos/acme/branch-tool/commits/feature%2Fagent',
    )
    expect(urls.at(-1)).toBe(
      `https://codeload.github.com/acme/branch-tool/zip/${commit}`,
    )
  })

  it('reuses a matching verified external command instead of copying it into managed tools', async () => {
    const stateRoot = tempRoot()
    const runtimeRoot = join(stateRoot, 'runtime')
    mkdirSync(runtimeRoot)
    const externalBin = join(stateRoot, 'external-bin')
    mkdirSync(externalBin)
    const externalCommand = join(externalBin, 'agent-reach')
    writeFileSync(externalCommand, '#!/bin/sh\n', { mode: 0o700 })
    const archive = zip([
      {
        name: 'agent-reach/pyproject.toml',
        data: [
          '[project]',
          'name = "agent-reach"',
          'version = "1.2.3"',
          'license = "MIT"',
          '[project.scripts]',
          'agent-reach = "agent_reach.cli:main"',
        ].join('\n'),
      },
    ])
    const runner = new RecordingInstallerRunner()
    const service = new ManagedEnvironmentService({
      stateRoot,
      skillManager: new SkillManager({ stateRoot, runtimeRoot }),
      downloader: {
        async download(request) {
          writeFileSync(request.destination, archive)
        },
      },
      processRunner: runner,
      idFactory: () => 'managed_plan_dddddddddddddddd',
    })
    const environment = executionEnvironmentFixture([externalBin, '/usr/bin'])

    const preview = await service.previewInstall({
      source: {
        kind: 'url',
        value: 'https://example.com/agent-reach-1.2.3.zip',
      },
      sessionId: 'session-01',
      executionEnvironment: environment,
    })

    expect(preview.placement).toBe('external')
    expect(preview.candidates[0]).toMatchObject({
      placement: 'external',
      externalCommandAvailable: true,
    })
    const result = await service.confirmInstall({
      planId: preview.planId,
      digest: preview.digest,
      sessionId: 'session-01',
      permissionConfirmed: true,
      executionEnvironment: environment,
    })
    expect(result).toMatchObject({
      placement: 'external',
      status: 'active',
      verification: { command: 'agent-reach doctor --json', exitCode: 0 },
    })
    expect(runner.requests.map((request) => request.args)).toEqual([
      ['--version'],
      ['doctor', '--json'],
    ])
    expect(
      existsSync(join(stateRoot, 'environment', 'tools', 'agent-reach')),
    ).toBe(false)
    const registry = JSON.parse(
      readFileSync(join(stateRoot, 'environment', 'registry.v1.json'), 'utf8'),
    )
    expect(registry.tools['agent-reach']).toMatchObject({
      placement: 'external',
      activeVersion: '1.2.3',
      commands: { 'agent-reach': externalCommand },
    })
  })
})

class RecordingInstallerRunner implements OwnedProcessRunner {
  readonly requests: OwnedProcessRequest[] = []

  capability() {
    return {
      platform: 'darwin' as const,
      backend: 'none' as const,
      status: 'available' as const,
      filesystem: 'workspace-write' as const,
      network: 'policy-controlled' as const,
      processTree: true,
      reason: 'test',
    }
  }

  async run(request: OwnedProcessRequest): Promise<OwnedProcessResult> {
    this.requests.push(structuredClone(request))
    if (request.args[0] === '-m' && request.args[1] === 'venv') {
      const target = request.args[2]!
      mkdirSync(join(target, 'bin'), { recursive: true })
      writeFileSync(join(target, 'bin', 'python'), '#!/bin/sh\n', {
        mode: 0o700,
      })
    } else if (request.args[0] === '-m' && request.args[1] === 'pip') {
      const bin = join(request.executable, '..', 'agent-reach')
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o700 })
    } else if (request.args[0] === 'install') {
      const prefix = request.args[request.args.indexOf('--prefix') + 1]!
      mkdirSync(join(prefix, 'bin'), { recursive: true })
      writeFileSync(join(prefix, 'bin', 'acme'), '#!/bin/sh\n', {
        mode: 0o700,
      })
    }
    const doctor = request.args[0] === 'doctor'
    const version = request.args[0] === '--version'
    return {
      status: 'completed',
      exitCode: 0,
      stdout: doctor ? '{"status":"ok"}' : version ? 'agent-reach 1.2.3' : '',
      stderr: '',
      durationMs: 1,
      error: null,
      containment: {
        decision: 'unsandboxed',
        backend: 'none',
        capabilityStatus: 'not_required',
        filesystem: 'unrestricted',
        network: 'unrestricted',
        processTree: true,
        policyHash: 'a'.repeat(64),
        reason: 'authorized managed environment install',
      },
    }
  }
}

function executionEnvironmentFixture(
  pathEntries: string[] = ['/usr/bin'],
): ExecutionEnvironment {
  return new ExecutionEnvironment(
    {
      revision: 'a'.repeat(64),
      catalogRevision: 'b'.repeat(64),
      projectFingerprint: 'c'.repeat(64),
      createdAt: '2026-08-10T06:00:00.000Z',
      platform: 'darwin',
      pathEntries,
      env: { PATH: pathEntries.join(':'), HOME: '/Users/tester' },
      toolPaths: { python: '/usr/bin/python3', npm: '/usr/bin/npm' },
    },
    { PATH: pathEntries.join(':'), HOME: '/Users/tester' },
  )
}

function zip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.byteLength, 18)
    local.writeUInt32LE(data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    localParts.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.byteLength, 20)
    central.writeUInt32LE(data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.byteLength + name.byteLength + data.byteLength
  }
  const centralSize = centralParts.reduce(
    (total, part) => total + part.byteLength,
    0,
  )
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
