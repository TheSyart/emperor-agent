import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBundledToolCatalog, type ToolCatalogEntry } from './catalog'
import {
  EnvironmentProbe,
  missingSkillRequirementsFromStatus,
  readWindowsNpmVersion,
  resolveCatalogExecutable,
  type EnvironmentExecutableResolver,
  type SkillEnvironmentRequirement,
  type EnvironmentProbeStatus,
} from './probe'
import type {
  EnvironmentProcessRequest,
  EnvironmentProcessResult,
  EnvironmentProcessRunner,
} from './process-runner'

function project(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-environment-probe-'))
}

const outputs: Record<string, string> = {
  gh: 'gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases/tag/v2.101.0',
  git: 'git version 2.55.0',
  ripgrep: 'ripgrep 15.1.0',
  volta: '2.0.2',
  node: 'v24.18.0',
  npm: '12.0.1',
  uv: 'uv 0.11.28',
  python: 'Python 3.12.13',
  go: 'go version go1.26.5 darwin/arm64',
  rustup: 'rustup 1.29.0',
  rust: 'rustc 1.97.0',
  cargo: 'cargo 1.97.0',
  'msvc-build-tools': '17.14.37411.7',
}

class FakeRunner implements EnvironmentProcessRunner {
  readonly requests: EnvironmentProcessRequest[] = []
  readonly versions = { ...outputs }

  async run(
    request: EnvironmentProcessRequest,
  ): Promise<EnvironmentProcessResult> {
    this.requests.push(request)
    const id = request.executable.split('/').at(-1) ?? ''
    const stdout = this.versions[id] ?? ''
    return {
      status: 'completed',
      exitCode: stdout ? 0 : 1,
      stdout,
      stderr: '',
      durationMs: 1,
      error: null,
    }
  }
}

function resolver(missing: string[] = []): EnvironmentExecutableResolver {
  const absent = new Set(missing)
  return (tool: ToolCatalogEntry) =>
    absent.has(tool.id) ? null : `/fake/${tool.id}`
}

function createProbe(
  opts: {
    runner?: FakeRunner
    missing?: string[]
    env?: Record<string, string | undefined>
    catalogProvider?: () => ReturnType<typeof loadBundledToolCatalog>
  } = {},
): { probe: EnvironmentProbe; runner: FakeRunner } {
  const runner = opts.runner ?? new FakeRunner()
  return {
    runner,
    probe: new EnvironmentProbe({
      catalog: opts.catalogProvider ?? loadBundledToolCatalog,
      platform: 'darwin',
      arch: 'arm64',
      env: opts.env ?? { PATH: '/fake', HOME: '/Users/tester' },
      homeDir: '/Users/tester',
      runner,
      resolveExecutable: resolver(opts.missing),
    }),
  }
}

describe('EnvironmentProbe', () => {
  it('reports ready, missing, version mismatch, and unsupported requirements', async () => {
    const root = project()
    writeFileSync(
      join(root, 'package.json'),
      '{"engines":{"node":">=24 <25"}}\n',
      'utf8',
    )
    writeFileSync(join(root, '.python-version'), '3.12 || 3.13\n', 'utf8')
    const runner = new FakeRunner()
    runner.versions.ripgrep = 'ripgrep 14.1.1'
    const { probe } = createProbe({ runner, missing: ['volta'] })

    const status = await probe.getStatus({ projectRoot: root })
    expect(status.tools.find((tool) => tool.id === 'git')).toMatchObject({
      status: 'ready',
      detectedVersion: '2.55.0',
      versionSummary: 'git version 2.55.0',
      required: true,
    })
    // gh is optional: only a project or Skill that needs it makes it required,
    // so machines without it don't report a missing base tool.
    expect(status.tools.find((tool) => tool.id === 'gh')).toMatchObject({
      status: 'ready',
      category: 'project',
      required: false,
      detectedVersion: '2.101.0',
      requiredVersion: '>=2.40.0',
      versionSummary: 'gh version 2.101.0',
      installStrategy: 'homebrew',
      sourceUrl: 'https://formulae.brew.sh/formula/gh',
    })
    expect(status.tools.find((tool) => tool.id === 'ripgrep')).toMatchObject({
      status: 'version_mismatch',
      detectedVersion: '14.1.1',
    })
    expect(status.tools.find((tool) => tool.id === 'volta')).toMatchObject({
      status: 'missing',
    })
    expect(status.tools.find((tool) => tool.id === 'python')).toMatchObject({
      status: 'unsupported',
      declarationSource: '.python-version',
    })
    expect(status.projectFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(
      runner.requests.every(
        (request) =>
          Object.keys(request.env).every(
            (key) =>
              [
                'PATH',
                'HOME',
                'LANG',
                'LC_ALL',
                'USER',
                'SystemRoot',
                'TEMP',
              ].includes(key) ||
              [
                'USERNAME',
                'TMP',
                'USERPROFILE',
                'LOCALAPPDATA',
                'VOLTA_HOME',
                'CARGO_HOME',
                'RUSTUP_HOME',
                'UV_PYTHON_INSTALL_DIR',
              ].includes(key),
          ) &&
          request.timeoutMs === 5_000 &&
          request.maxOutputBytes === 64 * 1024,
      ),
    ).toBe(true)
    for (const request of runner.requests) {
      const id = request.executable.split('/').at(-1)
      const catalogArgs = loadBundledToolCatalog().catalog.tools.find(
        (tool) => tool.id === id,
      )?.probe.args
      expect(request.args).toEqual(catalogArgs)
    }
  })

  it('maps Skill bins/runtimes, blocks missing requirements, and never reads env values', async () => {
    const root = project()
    const requirements: SkillEnvironmentRequirement[] = [
      {
        skillName: 'release-audit',
        skillStatus: 'active',
        requirements: {
          bins: ['go', 'unknown-cli'],
          runtimes: ['python'],
          env: ['RELEASE_TOKEN', '__proto__', 'BAD-NAME'],
        },
      },
    ]
    const { probe } = createProbe({
      missing: ['go'],
      env: {
        PATH: '/fake',
        HOME: '/Users/tester',
        RELEASE_TOKEN: '',
        SECRET_VALUE: 'must-not-be-copied',
      },
    })
    const status = await probe.getStatus({
      projectRoot: root,
      skillRequirements: requirements,
    })

    expect(status.tools.find((tool) => tool.id === 'go')).toMatchObject({
      required: true,
      category: 'skill',
      status: 'missing',
    })
    expect(status.skills).toEqual([
      expect.objectContaining({
        skillName: 'release-audit',
        status: 'unsupported',
        missing: expect.arrayContaining([
          'go',
          'env:RELEASE_TOKEN',
          'env:__proto__',
        ]),
        unsupported: expect.arrayContaining([
          'bin:unknown-cli',
          'env:BAD-NAME',
        ]),
      }),
    ])
    expect(JSON.stringify(status)).not.toContain('must-not-be-copied')
  })

  it('includes transitive catalog dependencies in Skill readiness', async () => {
    const root = project()
    const { probe } = createProbe({ missing: ['rust'] })
    const status = await probe.getStatus({
      projectRoot: root,
      skillRequirements: [
        {
          skillName: 'cargo-audit',
          skillStatus: 'active',
          requirements: { bins: ['cargo'], runtimes: [], env: [] },
        },
      ],
    })
    expect(status.skills).toEqual([
      {
        skillName: 'cargo-audit',
        status: 'blocked',
        requiredTools: ['cargo', 'rust', 'rustup'],
        missing: ['rust'],
        unsupported: [],
      },
    ])
    expect(status.tools.find((tool) => tool.id === 'rust')).toMatchObject({
      required: true,
      category: 'skill',
    })
  })

  it('maps a Skill gh requirement to the signed GitHub CLI catalog entry', async () => {
    const root = project()
    const { probe } = createProbe({ missing: ['gh'] })
    const status = await probe.getStatus({
      projectRoot: root,
      skillRequirements: [
        {
          skillName: 'github-triage',
          skillStatus: 'active',
          requirements: { bins: ['gh'], runtimes: [], env: [] },
        },
      ],
    })
    expect(status.skills).toEqual([
      {
        skillName: 'github-triage',
        status: 'blocked',
        requiredTools: ['gh'],
        missing: ['gh'],
        unsupported: [],
      },
    ])
    expect(status.tools.find((tool) => tool.id === 'gh')).toMatchObject({
      required: true,
      status: 'missing',
      executablePath: null,
    })
  })

  it('caches by project/catalog/PATH/Skill fingerprint and supports forced refresh', async () => {
    const root = project()
    writeFileSync(join(root, 'package.json'), '{"name":"app"}\n', 'utf8')
    const runner = new FakeRunner()
    let revision = loadBundledToolCatalog().revision
    const catalogProvider = () => ({
      ...loadBundledToolCatalog(),
      revision,
    })
    const { probe } = createProbe({ runner, catalogProvider })

    const first = await probe.getStatus({ projectRoot: root })
    const calls = runner.requests.length
    const cached = await probe.getStatus({ projectRoot: root })
    expect(cached.cacheKey).toBe(first.cacheKey)
    expect(runner.requests).toHaveLength(calls)

    await probe.getStatus({ projectRoot: root, forceRefresh: true })
    expect(runner.requests.length).toBeGreaterThan(calls)
    const refreshedCalls = runner.requests.length

    writeFileSync(join(root, '.node-version'), '24.18.0\n', 'utf8')
    const changed = await probe.getStatus({ projectRoot: root })
    expect(changed.projectFingerprint).not.toBe(first.projectFingerprint)
    expect(runner.requests.length).toBeGreaterThan(refreshedCalls)

    const catalogCalls = runner.requests.length
    revision = 'f'.repeat(64)
    const catalogChanged = await probe.getStatus({ projectRoot: root })
    expect(catalogChanged.catalogRevision).toBe(revision)
    expect(runner.requests.length).toBeGreaterThan(catalogCalls)

    probe.invalidate()
    const invalidatedCalls = runner.requests.length
    await probe.getStatus({ projectRoot: root })
    expect(runner.requests.length).toBeGreaterThan(invalidatedCalls)

    const secondProject = project()
    const projectCalls = runner.requests.length
    const switched = await probe.getStatus({ projectRoot: secondProject })
    expect(switched.projectFingerprint).not.toBe(changed.projectFingerprint)
    expect(runner.requests.length).toBeGreaterThan(projectCalls)
  })

  // FIX-08: the execution environment (managed bin on PATH, no Skills) and
  // the Git / gh runtime check (process PATH, every Skill) asked one after
  // the other for every Git command; a one-entry cache made each of them
  // probe the whole catalog again (about 400 `--version` runs per 审查
  // refresh).
  it('keeps a result per question: two callers taking turns probe once each', async () => {
    const root = project()
    const { probe, runner } = createProbe()
    const skill: SkillEnvironmentRequirement = {
      skillName: 'needs-gh',
      skillStatus: 'active',
      requirements: { bins: ['gh'], runtimes: [], env: [] },
    }
    const environment = () =>
      probe.getStatus({
        projectRoot: root,
        envOverride: { PATH: '/managed/bin:/fake', HOME: '/Users/tester' },
      })
    const runtime = () =>
      probe.getStatus({ projectRoot: root, skillRequirements: [skill] })

    const a = await environment()
    const b = await runtime()
    expect(a.cacheKey).not.toBe(b.cacheKey)
    const probed = runner.requests.length
    for (let turn = 0; turn < 5; turn += 1) {
      expect((await environment()).cacheKey).toBe(a.cacheKey)
      expect((await runtime()).cacheKey).toBe(b.cacheKey)
    }
    expect(runner.requests).toHaveLength(probed)

    // invalidate() still forgets every answer.
    probe.invalidate()
    await environment()
    expect(runner.requests.length).toBeGreaterThan(probed)
  })

  // FIX-15: macOS holds a new build's first processes in a Desktop project
  // until the user answers the folder-access prompt. The version checks ran
  // into their 5 s limit, and that non-answer was kept for the whole session:
  // Git stayed "unavailable" for the project until Emperor was restarted.
  it('FIX-15 · 6 · keeps a check that did not finish only briefly, then asks again', async () => {
    const root = project()
    let held = true
    let clock = 1_000_000
    const runner = new FakeRunner()
    const run = runner.run.bind(runner)
    runner.run = async (request) => {
      if (!held) return run(request)
      runner.requests.push(request)
      return {
        status: 'timeout',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 5_000,
        error: null,
      }
    }
    const probe = new EnvironmentProbe({
      catalog: loadBundledToolCatalog,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/fake', HOME: '/Users/tester' },
      homeDir: '/Users/tester',
      runner,
      resolveExecutable: resolver(),
      now: () => clock,
    })
    const git = (status: EnvironmentProbeStatus) =>
      status.tools.find((tool) => tool.id === 'git')
    const first = await probe.getStatus({ projectRoot: root })
    expect(git(first)).toMatchObject({
      status: 'failed',
      reason: '探测失败：timeout',
    })
    // The user allows the folder; a moment later the answer is still the
    // remembered one (no probe storm while the prompt is up)…
    held = false
    const probed = runner.requests.length
    clock += 1_000
    expect(git(await probe.getStatus({ projectRoot: root }))?.status).toBe(
      'failed',
    )
    expect(runner.requests).toHaveLength(probed)
    // …and once it has expired, the next question probes again: Git is ready.
    clock += 60_000
    const again = await probe.getStatus({ projectRoot: root })
    expect(git(again)).toMatchObject({ status: 'ready' })
    expect(runner.requests.length).toBeGreaterThan(probed)
    // A complete answer is remembered for the session, as before (FIX-08).
    const complete = runner.requests.length
    clock += 24 * 60 * 60_000
    await probe.getStatus({ projectRoot: root })
    expect(runner.requests).toHaveLength(complete)
  })

  it('FIX-15 · 6 · a tool that could not start counts as unfinished; one that answered with an error does not', async () => {
    const root = project()
    let clock = 1_000_000
    let mode: 'spawn' | 'exit' = 'spawn'
    const runner = new FakeRunner()
    const run = runner.run.bind(runner)
    runner.run = async (request) => {
      if (!request.executable.endsWith('/git')) return run(request)
      runner.requests.push(request)
      if (mode === 'spawn') throw new Error('spawn EAGAIN')
      return {
        status: 'completed',
        exitCode: 1,
        stdout: '',
        stderr: 'broken',
        durationMs: 1,
        error: null,
      }
    }
    const probe = new EnvironmentProbe({
      catalog: loadBundledToolCatalog,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/fake', HOME: '/Users/tester' },
      homeDir: '/Users/tester',
      runner,
      resolveExecutable: resolver(),
      now: () => clock,
    })
    await probe.getStatus({ projectRoot: root })
    const afterSpawnFailure = runner.requests.length
    mode = 'exit'
    clock += 60_000
    await probe.getStatus({ projectRoot: root })
    expect(runner.requests.length).toBeGreaterThan(afterSpawnFailure)
    const afterExit = runner.requests.length
    clock += 60_000
    await probe.getStatus({ projectRoot: root })
    expect(runner.requests).toHaveLength(afterExit)
  })

  it('FIX-15 · asks a check that keeps not finishing less and less often', async () => {
    const root = project()
    let clock = 1_000_000
    const runner = new FakeRunner()
    const run = runner.run.bind(runner)
    // A tool that hangs on every run (its limit always hits).
    runner.run = async (request) => {
      if (!request.executable.endsWith('/go')) return run(request)
      runner.requests.push(request)
      return {
        status: 'timeout',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 5_000,
        error: null,
      }
    }
    const probe = new EnvironmentProbe({
      catalog: loadBundledToolCatalog,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/fake', HOME: '/Users/tester' },
      homeDir: '/Users/tester',
      runner,
      resolveExecutable: resolver(),
      now: () => clock,
    })
    const probes = () =>
      runner.requests.filter((r) => r.executable.endsWith('/go')).length
    await probe.getStatus({ projectRoot: root })
    expect(probes()).toBe(1)
    const after = async (ms: number) => {
      clock += ms
      await probe.getStatus({ projectRoot: root })
      return probes()
    }
    expect(await after(30_001)).toBe(2) // kept 30 s
    expect(await after(30_001)).toBe(2) // now kept 60 s
    expect(await after(30_000)).toBe(3)
    expect(await after(119_999)).toBe(3) // now kept 120 s
    expect(await after(2)).toBe(4)
    for (let n = 0; n < 6; n++) await after(5 * 60_000 + 1)
    const capped = probes()
    expect(await after(5 * 60_000 + 1)).toBe(capped + 1) // at most 5 min
  })

  it('runs one probe for callers asking the same question at once', async () => {
    const root = project()
    const { probe, runner } = createProbe()
    await probe.getStatus({ projectRoot: project() })
    const perProbe = runner.requests.length
    runner.requests.length = 0

    const answers = await Promise.all(
      [1, 2, 3, 4].map(() => probe.getStatus({ projectRoot: root })),
    )
    expect(new Set(answers.map((answer) => answer.cacheKey)).size).toBe(1)
    expect(runner.requests).toHaveLength(perProbe)
    // Each caller gets its own copy.
    answers[0]!.tools.length = 0
    expect(answers[1]!.tools.length).toBeGreaterThan(0)
  })

  it('remembers a bounded number of answers', async () => {
    const { probe, runner } = createProbe()
    const first = project()
    await probe.getStatus({ projectRoot: first })
    for (let index = 0; index < 40; index += 1)
      await probe.getStatus({ projectRoot: project() })
    const before = runner.requests.length
    await probe.getStatus({ projectRoot: first })
    expect(runner.requests.length).toBeGreaterThan(before)
  })

  it('invalidates naturally when the effective process PATH changes', async () => {
    const root = project()
    const runner = new FakeRunner()
    let env = { PATH: '/first', HOME: '/Users/tester' }
    const probe = new EnvironmentProbe({
      catalog: loadBundledToolCatalog,
      platform: 'darwin',
      arch: 'arm64',
      env: () => env,
      homeDir: '/Users/tester',
      runner,
      resolveExecutable: resolver(),
    })
    const first = await probe.getStatus({ projectRoot: root })
    const calls = runner.requests.length
    env = { ...env, PATH: '/second' }
    const second = await probe.getStatus({ projectRoot: root })
    expect(second.cacheKey).not.toBe(first.cacheKey)
    expect(runner.requests.length).toBeGreaterThan(calls)
  })

  it('uses bounded concurrency while preserving catalog result order', async () => {
    const root = project()
    let active = 0
    let maximum = 0
    const runner: EnvironmentProcessRunner = {
      async run(request) {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        const id = request.executable.split('/').at(-1) ?? ''
        return {
          status: 'completed',
          exitCode: 0,
          stdout: outputs[id] ?? '',
          stderr: '',
          durationMs: 5,
          error: null,
        }
      },
    }
    const probe = new EnvironmentProbe({
      catalog: loadBundledToolCatalog,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/fake', HOME: '/Users/tester' },
      homeDir: '/Users/tester',
      runner,
      resolveExecutable: resolver(),
    })
    const status = await probe.getStatus({ projectRoot: root })
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(4)
    expect(status.tools.map((tool) => tool.id)).toEqual(
      loadBundledToolCatalog().catalog.tools.map((tool) => tool.id),
    )
  })

  it('marks unsupported platform/architecture pairs without executing tools', async () => {
    const root = project()
    const runner = new FakeRunner()
    const probe = new EnvironmentProbe({
      catalog: loadBundledToolCatalog,
      platform: 'win32',
      arch: 'arm64',
      env: { PATH: 'C:\\fake', USERPROFILE: 'C:\\Users\\Tester' },
      homeDir: 'C:\\Users\\Tester',
      runner,
      resolveExecutable: resolver(),
      windowsPathProvider: async () => ({
        machinePath: '',
        userPath: '',
        diagnostics: [],
      }),
    })
    const status = await probe.getStatus({ projectRoot: root })
    expect(status.tools.every((tool) => tool.status === 'unsupported')).toBe(
      true,
    )
    expect(runner.requests).toHaveLength(0)
  })

  it('fails closed for unsupported host platform and architecture values', () => {
    expect(
      () =>
        new EnvironmentProbe({
          catalog: loadBundledToolCatalog,
          platform: 'aix' as 'darwin',
        }),
    ).toThrow(/操作系统|platform/i)
    expect(
      () =>
        new EnvironmentProbe({
          catalog: loadBundledToolCatalog,
          arch: 'ia32' as 'x64',
        }),
    ).toThrow(/处理器|arch/i)
  })

  it('isolates resolver and runner failures to failed tool states', async () => {
    const root = project()
    const throwingRunner: EnvironmentProcessRunner = {
      async run() {
        throw new Error('secret internal runner failure')
      },
    }
    const probe = new EnvironmentProbe({
      catalog: loadBundledToolCatalog,
      platform: 'darwin',
      arch: 'arm64',
      env: { PATH: '/fake', HOME: '/Users/tester' },
      homeDir: '/Users/tester',
      runner: throwingRunner,
      resolveExecutable: (tool) => {
        if (tool.id === 'go') throw new Error('resolver failed')
        return `/fake/${tool.id}`
      },
    })
    const status = await probe.getStatus({ projectRoot: root })
    expect(status.tools.find((tool) => tool.id === 'git')?.status).toBe(
      'failed',
    )
    expect(status.tools.find((tool) => tool.id === 'go')?.status).toBe('failed')
    expect(JSON.stringify(status)).not.toContain('secret internal')
  })

  it('does not cache an explicitly cancelled refresh', async () => {
    const root = project()
    const { probe, runner } = createProbe()
    const controller = new AbortController()
    controller.abort()
    await expect(
      probe.getStatus({ projectRoot: root, signal: controller.signal }),
    ).rejects.toMatchObject({ environmentCode: 'cancelled' })
    expect(runner.requests).toHaveLength(0)

    await probe.getStatus({ projectRoot: root })
    expect(runner.requests.length).toBeGreaterThan(0)
  })

  it('reads Windows npm metadata without executing a cmd shim', () => {
    const root = project()
    const npmDir = join(root, 'node_modules', 'npm')
    mkdirSync(npmDir, { recursive: true })
    const shim = join(root, 'npm.cmd')
    writeFileSync(shim, '@echo off\r\n', 'utf8')
    writeFileSync(join(npmDir, 'package.json'), '{"version":"12.0.1"}', 'utf8')
    expect(readWindowsNpmVersion(shim)).toBe('12.0.1')
    writeFileSync(join(npmDir, 'package.json'), '{broken', 'utf8')
    expect(readWindowsNpmVersion(shim)).toBeNull()
  })

  it('maps probe Skill state back to the original requirement vocabulary', () => {
    const status = {
      skills: [
        {
          skillName: 'candidate',
          status: 'blocked',
          requiredTools: ['ripgrep', 'node'],
          missing: ['ripgrep', 'node', 'env:API_TOKEN'],
          unsupported: ['bin:custom-tool'],
        },
      ],
    } as unknown as EnvironmentProbeStatus

    expect(
      missingSkillRequirementsFromStatus(status, 'candidate', {
        bins: ['rg', 'custom-tool', 'git'],
        runtimes: ['node'],
        env: ['API_TOKEN', 'READY_TOKEN'],
      }),
    ).toEqual({
      bins: ['rg', 'custom-tool'],
      runtimes: ['node'],
      env: ['API_TOKEN'],
    })

    const dependencyOnly = {
      ...status,
      skills: [
        {
          skillName: 'candidate',
          status: 'blocked',
          requiredTools: ['volta', 'node'],
          missing: ['volta'],
          unsupported: [],
        },
      ],
    } as EnvironmentProbeStatus
    expect(
      missingSkillRequirementsFromStatus(dependencyOnly, 'candidate', {
        bins: [],
        runtimes: ['node'],
        env: [],
      }),
    ).toEqual({ bins: [], runtimes: ['node'], env: [] })
  })

  it.skipIf(process.platform === 'win32')(
    'records the canonical executable target and rejects non-executable files',
    () => {
      const root = project()
      const target = join(root, 'git-real')
      const alias = join(root, 'git')
      writeFileSync(target, '#!/bin/sh\nexit 0\n', 'utf8')
      chmodSync(target, 0o755)
      symlinkSync(target, alias)
      const git = loadBundledToolCatalog().catalog.tools.find(
        (tool) => tool.id === 'git',
      )!
      const gitOnly = {
        ...git,
        probe: { ...git.probe, executables: ['git'] },
      }
      expect(resolveCatalogExecutable(gitOnly, [root], 'darwin')).toBe(
        realpathSync(target),
      )

      chmodSync(target, 0o644)
      expect(resolveCatalogExecutable(gitOnly, [root], 'darwin')).toBeNull()
    },
  )
})
