import { describe, expect, it } from 'vitest'
import {
  loadBundledToolCatalog,
  parseToolCatalog,
  toolCatalogRevision,
} from './catalog'

function fixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    catalogId: 'test-catalog',
    release: '2026.07-test',
    licenses: [
      {
        id: 'git-license',
        name: 'GNU General Public License v2.0',
        spdx: 'GPL-2.0-only',
        url: 'https://git-scm.com/about/free-and-open-source',
      },
    ],
    tools: [
      {
        id: 'git',
        displayName: 'Git',
        category: 'base',
        version: { pinned: '2.50.1', requirement: '>=2.40.0' },
        licenseId: 'git-license',
        dependencies: [],
        targets: [{ platform: 'darwin', arch: 'arm64' }],
        probe: {
          executables: ['git'],
          args: ['--version'],
          versionPattern: '^git version\\s+([0-9]+(?:\\.[0-9]+)+)',
        },
        strategies: [
          {
            id: 'homebrew',
            kind: 'package_manager',
            targets: [{ platform: 'darwin', arch: 'arm64' }],
            executable: 'brew',
            args: ['install', 'git'],
            source: {
              url: 'https://formulae.brew.sh/formula/git',
              publisher: 'Homebrew',
            },
            estimatedBytes: 50_000_000,
            requiresElevation: false,
            requiresSeparateConfirmation: false,
          },
        ],
      },
    ],
  }
}

describe('signed ToolCatalog', () => {
  it('loads a strict valid catalog and computes a stable revision', () => {
    const parsed = parseToolCatalog(fixture())
    const original = fixture()
    const reordered = {
      tools: original.tools,
      licenses: original.licenses,
      release: original.release,
      catalogId: original.catalogId,
      schemaVersion: original.schemaVersion,
    }

    expect(parsed.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(parsed.revision).toBe(toolCatalogRevision(parsed.catalog))
    expect(toolCatalogRevision(original)).toBe(toolCatalogRevision(reordered))
    expect(parseToolCatalog(reordered).revision).toBe(parsed.revision)
  })

  it('fails closed for unknown schema versions and duplicate tools', () => {
    expect(() => parseToolCatalog({ ...fixture(), schemaVersion: 2 })).toThrow(
      /catalog/i,
    )
    const duplicate = fixture()
    duplicate.tools = [
      ...(duplicate.tools as unknown[]),
      (duplicate.tools as unknown[])[0],
    ]
    expect(() => parseToolCatalog(duplicate)).toThrow(/duplicate_tool/i)
  })

  it('rejects unknown dependencies, unsupported targets, and unsafe process fields', () => {
    const dependency = fixture()
    ;(dependency.tools as Array<Record<string, unknown>>)[0]!.dependencies = [
      'missing-tool',
    ]
    expect(() => parseToolCatalog(dependency)).toThrow(/dependency/i)

    const target = fixture()
    ;(target.tools as Array<Record<string, unknown>>)[0]!.targets = [
      { platform: 'win32', arch: 'arm64' },
    ]
    expect(() => parseToolCatalog(target)).toThrow(/platform|arch|target/i)

    const executable = fixture()
    ;(
      (executable.tools as Array<Record<string, unknown>>)[0]!.probe as Record<
        string,
        unknown
      >
    ).executables = ['git; rm -rf /']
    expect(() => parseToolCatalog(executable)).toThrow(/executable/i)

    const args = fixture()
    ;(
      (args.tools as Array<Record<string, unknown>>)[0]!.strategies as Array<
        Record<string, unknown>
      >
    )[0]!.args = ['install\n--unsafe']
    expect(() => parseToolCatalog(args)).toThrow(/argument|args/i)

    const shell = fixture()
    ;(
      (shell.tools as Array<Record<string, unknown>>)[0]!.strategies as Array<
        Record<string, unknown>
      >
    )[0]!.executable = 'powershell.exe'
    expect(() => parseToolCatalog(shell)).toThrow(/executable|shell/i)

    const launcher = fixture()
    const launcherStrategy = (
      (launcher.tools as Array<Record<string, unknown>>)[0]!
        .strategies as Array<Record<string, unknown>>
    )[0]!
    launcherStrategy.executable = '/usr/bin/env'
    launcherStrategy.args = ['sh', '-c', 'touch /tmp/catalog-bypass']
    expect(() => parseToolCatalog(launcher)).toThrow(
      /command|executable|shell/i,
    )
  })

  it('requires exact pinned versions, parseable ranges, and nonblank publishers', () => {
    const floating = fixture()
    ;(
      (floating.tools as Array<Record<string, unknown>>)[0]!.version as Record<
        string,
        unknown
      >
    ).pinned = 'latest'
    expect(() => parseToolCatalog(floating)).toThrow(/version/i)

    const invalidRange = fixture()
    ;(
      (invalidRange.tools as Array<Record<string, unknown>>)[0]!
        .version as Record<string, unknown>
    ).requirement = 'invalid range'
    expect(() => parseToolCatalog(invalidRange)).toThrow(/version/i)

    const malformedComparator = fixture()
    ;(
      (malformedComparator.tools as Array<Record<string, unknown>>)[0]!
        .version as Record<string, unknown>
    ).requirement = '=>2.40.0'
    expect(() => parseToolCatalog(malformedComparator)).toThrow(/version/i)

    const outsideRange = fixture()
    ;(
      (outsideRange.tools as Array<Record<string, unknown>>)[0]!
        .version as Record<string, unknown>
    ).requirement = '>=3.0.0'
    expect(() => parseToolCatalog(outsideRange)).toThrow(/version/i)

    const blankPublisher = fixture()
    ;(
      (
        (blankPublisher.tools as Array<Record<string, unknown>>)[0]!
          .strategies as Array<Record<string, unknown>>
      )[0]!.source as Record<string, unknown>
    ).publisher = '   '
    expect(() => parseToolCatalog(blankPublisher)).toThrow(/publisher/i)
  })

  it('rejects dependency cycles', () => {
    const cyclic = fixture()
    const git = (cyclic.tools as Array<Record<string, unknown>>)[0]!
    const ripgrep = structuredClone(git)
    ripgrep.id = 'ripgrep'
    ripgrep.displayName = 'ripgrep'
    ripgrep.dependencies = ['git']
    git.dependencies = ['ripgrep']
    cyclic.tools = [git, ripgrep]

    expect(() => parseToolCatalog(cyclic)).toThrow(/dependency_cycle/i)
  })

  it('rejects ambiguous relations and uncovered targets', () => {
    const duplicateDependency = fixture()
    const git = (
      duplicateDependency.tools as Array<Record<string, unknown>>
    )[0]!
    const ripgrep = structuredClone(git)
    ripgrep.id = 'ripgrep'
    ripgrep.displayName = 'ripgrep'
    ripgrep.dependencies = []
    git.dependencies = ['ripgrep', 'ripgrep']
    duplicateDependency.tools = [git, ripgrep]
    expect(() => parseToolCatalog(duplicateDependency)).toThrow(
      /duplicate_dependency/i,
    )

    const uncovered = fixture()
    ;(uncovered.tools as Array<Record<string, unknown>>)[0]!.targets = [
      { platform: 'darwin', arch: 'arm64' },
      { platform: 'win32', arch: 'x64' },
    ]
    expect(() => parseToolCatalog(uncovered)).toThrow(/target_uncovered/i)

    const incompatibleDependency = fixture()
    ;(
      incompatibleDependency.tools as Array<Record<string, unknown>>
    )[0]!.targets = [{ platform: 'darwin', arch: 'arm64' }]
    const dependent = structuredClone(
      (incompatibleDependency.tools as Array<Record<string, unknown>>)[0]!,
    )
    dependent.id = 'ripgrep'
    dependent.displayName = 'ripgrep'
    dependent.dependencies = ['git']
    dependent.targets = [{ platform: 'win32', arch: 'x64' }]
    dependent.strategies = [
      {
        ...(dependent.strategies as Array<Record<string, unknown>>)[0],
        targets: [{ platform: 'win32', arch: 'x64' }],
      },
    ]
    incompatibleDependency.tools = [
      (incompatibleDependency.tools as Array<Record<string, unknown>>)[0],
      dependent,
    ]
    expect(() => parseToolCatalog(incompatibleDependency)).toThrow(
      /dependency_target/i,
    )
  })

  it('rejects unsafe URLs and requires digest/publisher for direct assets', () => {
    const unsafeUrl = fixture()
    ;(
      (
        (unsafeUrl.tools as Array<Record<string, unknown>>)[0]!
          .strategies as Array<Record<string, unknown>>
      )[0]!.source as Record<string, unknown>
    ).url = 'http://127.0.0.1/tool.zip'
    expect(() => parseToolCatalog(unsafeUrl)).toThrow(/url|https|public/i)

    for (const url of [
      'https://100.64.0.1/tool.zip',
      'https://198.18.0.1/tool.zip',
      'https://203.0.113.1/tool.zip',
      'https://[::ffff:127.0.0.1]/tool.zip',
      'https://[fc00::1]/tool.zip',
      'https://[2001:db8::1]/tool.zip',
    ]) {
      const specialAddress = fixture()
      ;(
        (
          (specialAddress.tools as Array<Record<string, unknown>>)[0]!
            .strategies as Array<Record<string, unknown>>
        )[0]!.source as Record<string, unknown>
      ).url = url
      expect(() => parseToolCatalog(specialAddress), url).toThrow(
        /url|https|public/i,
      )
    }

    const direct = fixture()
    const strategy = (
      (direct.tools as Array<Record<string, unknown>>)[0]!.strategies as Array<
        Record<string, unknown>
      >
    )[0]!
    strategy.kind = 'direct_archive'
    strategy.source = {
      url: 'https://example.com/git.zip',
      publisher: 'Example Publisher',
    }
    expect(() => parseToolCatalog(direct)).toThrow(/sha-?256|digest/i)

    const directBinary = fixture()
    const binaryStrategy = (
      (directBinary.tools as Array<Record<string, unknown>>)[0]!
        .strategies as Array<Record<string, unknown>>
    )[0]!
    binaryStrategy.kind = 'direct_binary'
    binaryStrategy.source = {
      url: 'https://example.com/git',
      publisher: 'Example Publisher',
    }
    expect(() => parseToolCatalog(directBinary)).toThrow(/sha-?256|digest/i)

    ;(strategy.source as Record<string, unknown>).sha256 = 'a'.repeat(64)
    strategy.kind = 'windows_installer'
    strategy.targets = [{ platform: 'win32', arch: 'x64' }]
    delete (strategy.source as Record<string, unknown>).publisher
    expect(() => parseToolCatalog(direct)).toThrow(/publisher/i)

    const mismatchedKind = fixture()
    const mismatchedStrategy = (
      (mismatchedKind.tools as Array<Record<string, unknown>>)[0]!
        .strategies as Array<Record<string, unknown>>
    )[0]!
    mismatchedStrategy.kind = 'windows_installer'
    ;(mismatchedStrategy.source as Record<string, unknown>).sha256 = 'b'.repeat(
      64,
    )
    expect(() => parseToolCatalog(mismatchedKind)).toThrow(/target|platform/i)
  })

  it('ships an immutable catalog covering every planned tool id', () => {
    const bundled = loadBundledToolCatalog()
    expect(bundled.revision).toBe(
      'd925f4b1601eb50738cb71c6c0019521c2603f1695bdecc4e5ce659e8257d3bf',
    )
    expect(bundled.catalog.release).toBe('2026.09-github-cli')
    expect(bundled.catalog.tools.map((tool) => tool.id)).toEqual([
      'cargo',
      'gh',
      'git',
      'go',
      'msvc-build-tools',
      'node',
      'npm',
      'python',
      'ripgrep',
      'rust',
      'rustup',
      'uv',
      'volta',
    ])
    expect(Object.isFrozen(bundled)).toBe(true)
    expect(Object.isFrozen(bundled.catalog.tools)).toBe(true)
    expect(
      bundled.catalog.tools.every((tool) => tool.strategies.length > 0),
    ).toBe(true)
    expect(
      Object.fromEntries(
        bundled.catalog.tools.map((tool) => [tool.id, tool.version.pinned]),
      ),
    ).toMatchObject({
      gh: '2.101.0',
      git: '2.55.0',
      go: '1.26.5',
      node: '24.18.0',
      npm: '12.0.1',
      python: '3.12.13',
      ripgrep: '15.1.0',
      rust: '1.97.0',
      rustup: '1.29.0',
      uv: '0.11.28',
      volta: '2.0.2',
    })
    expect(
      bundled.catalog.tools
        .find((tool) => tool.id === 'msvc-build-tools')
        ?.strategies.every(
          (strategy) =>
            strategy.requiresElevation &&
            strategy.requiresSeparateConfirmation &&
            strategy.source.publisher === 'Microsoft Corporation',
        ),
    ).toBe(true)
    const wingetStrategies = bundled.catalog.tools.flatMap((tool) =>
      tool.strategies.filter((strategy) => strategy.id === 'winget'),
    )
    expect(wingetStrategies.length).toBeGreaterThan(0)
    expect(
      wingetStrategies.every(
        (strategy) =>
          strategy.executable === 'winget.exe' &&
          strategy.args.includes('--exact') &&
          strategy.args.includes('--source') &&
          strategy.args.includes('winget') &&
          strategy.args.includes('--accept-package-agreements') &&
          strategy.args.includes('--accept-source-agreements') &&
          strategy.args.includes('--disable-interactivity'),
      ),
    ).toBe(true)
    expect(
      Object.fromEntries(
        bundled.catalog.tools
          .filter((tool) => ['go', 'rustup', 'uv', 'volta'].includes(tool.id))
          .map((tool) => {
            const strategy = tool.strategies.find((candidate) =>
              candidate.targets.some(
                (target) =>
                  target.platform === 'linux' && target.arch === 'x64',
              ),
            )
            return [
              tool.id,
              {
                id: strategy?.id,
                kind: strategy?.kind,
                sha256: strategy?.source.sha256,
              },
            ]
          }),
      ),
    ).toEqual({
      go: {
        id: 'official-archive',
        kind: 'direct_archive',
        sha256:
          '5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053',
      },
      rustup: {
        id: 'official-binary',
        kind: 'direct_binary',
        sha256:
          '4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10',
      },
      uv: {
        id: 'official-archive',
        kind: 'direct_archive',
        sha256:
          'e490a6464492183c5d4534a5527fb4440f7f2bb2f228162ad7e4afe076dc0224',
      },
      volta: {
        id: 'official-archive',
        kind: 'direct_archive',
        sha256:
          '6cec054c911fb925b629a09455775af6e95dc0f5694a4c28b63979ab9ef18037',
      },
    })
  })
  it('ships GitHub CLI with fixed probe and install argv only', () => {
    const gh = loadBundledToolCatalog().catalog.tools.find(
      (tool) => tool.id === 'gh',
    )!
    expect(gh).toMatchObject({
      displayName: 'GitHub CLI',
      category: 'project',
      licenseId: 'mit',
      dependencies: [],
      version: { pinned: '2.101.0', requirement: '>=2.40.0' },
      probe: {
        executables: ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
        args: ['--version'],
      },
    })
    expect(
      new RegExp(gh.probe.versionPattern).exec(
        'gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases/tag/v2.101.0',
      )?.[1],
    ).toBe('2.101.0')
    expect(
      gh.strategies.map((strategy) => ({
        id: strategy.id,
        kind: strategy.kind,
        executable: strategy.executable,
        args: strategy.args,
        targets: strategy.targets.map(
          (target) => `${target.platform}/${target.arch}`,
        ),
      })),
    ).toEqual([
      {
        id: 'homebrew',
        kind: 'package_manager',
        executable: 'brew',
        args: ['install', 'gh'],
        targets: ['darwin/arm64', 'darwin/x64'],
      },
      {
        id: 'winget',
        kind: 'package_manager',
        executable: 'winget.exe',
        args: [
          'install',
          '--exact',
          '--id',
          'GitHub.cli',
          '--source',
          'winget',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--disable-interactivity',
        ],
        targets: ['win32/x64'],
      },
      {
        id: 'official-guided',
        kind: 'system_prompt',
        executable: 'gh',
        args: ['--version'],
        targets: ['linux/x64'],
      },
    ])
    // The Linux entry only guides the user to the official instructions; it
    // never runs an installer.
    expect(
      gh.strategies.find((strategy) => strategy.id === 'official-guided')
        ?.source,
    ).toEqual({
      url: 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md',
      publisher: 'GitHub, Inc.',
    })
  })

  it('rejects GitHub CLI commands outside the static allowlist', () => {
    const ghTool = () => {
      const catalog = fixture()
      catalog.licenses = [
        {
          id: 'mit',
          name: 'MIT License',
          spdx: 'MIT',
          url: 'https://opensource.org/license/mit',
        },
      ]
      catalog.tools = [
        {
          id: 'gh',
          displayName: 'GitHub CLI',
          category: 'base',
          version: { pinned: '2.101.0', requirement: '>=2.40.0' },
          licenseId: 'mit',
          dependencies: [],
          targets: [{ platform: 'darwin', arch: 'arm64' }],
          probe: {
            executables: ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
            args: ['--version'],
            versionPattern: '^gh version\\s+([0-9]+(?:\\.[0-9]+)+)',
          },
          strategies: [
            {
              id: 'homebrew',
              kind: 'package_manager',
              targets: [{ platform: 'darwin', arch: 'arm64' }],
              executable: 'brew',
              args: ['install', 'gh'],
              source: {
                url: 'https://formulae.brew.sh/formula/gh',
                publisher: 'Homebrew',
              },
              estimatedBytes: 16_000_000,
              requiresElevation: false,
              requiresSeparateConfirmation: false,
            },
          ],
        },
      ]
      return catalog
    }
    expect(parseToolCatalog(ghTool()).catalog.tools[0]?.id).toBe('gh')

    const tool = (catalog: Record<string, unknown>) =>
      (catalog.tools as Array<Record<string, unknown>>)[0]!
    const probe = (catalog: Record<string, unknown>) =>
      tool(catalog).probe as Record<string, unknown>
    const strategy = (catalog: Record<string, unknown>) =>
      (tool(catalog).strategies as Array<Record<string, unknown>>)[0]!

    for (const args of [
      ['auth', 'status'],
      ['--version', '--hostname', 'example.com'],
      ['api', 'user'],
    ]) {
      const catalog = ghTool()
      probe(catalog).args = args
      expect(() => parseToolCatalog(catalog), args.join(' ')).toThrow(
        /command/i,
      )
    }
    for (const executable of ['/tmp/gh', 'gh.exe', '/usr/bin/gh']) {
      const catalog = ghTool()
      probe(catalog).executables = [executable]
      expect(() => parseToolCatalog(catalog), executable).toThrow(/command/i)
    }
    for (const args of [
      ['install', 'gh', '--HEAD'],
      ['install', '--cask', 'gh'],
      ['reinstall', 'gh'],
      ['install', 'gh-dash'],
    ]) {
      const catalog = ghTool()
      strategy(catalog).args = args
      expect(() => parseToolCatalog(catalog), args.join(' ')).toThrow(
        /command/i,
      )
    }
    const winget = ghTool()
    tool(winget).targets = [{ platform: 'win32', arch: 'x64' }]
    Object.assign(strategy(winget), {
      id: 'winget',
      targets: [{ platform: 'win32', arch: 'x64' }],
      executable: 'winget.exe',
      args: [
        'install',
        '--exact',
        '--id',
        'GitHub.cli',
        '--source',
        'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      source: { url: 'https://github.com/cli/cli', publisher: 'GitHub, Inc.' },
    })
    expect(parseToolCatalog(winget).catalog.tools[0]?.id).toBe('gh')
    for (const args of [
      ['install', '--exact', '--id', 'GitHub.cli', '--source', 'msstore'],
      [
        'install',
        '--exact',
        '--id',
        'GitHub.cli',
        '--version',
        '2.0.0',
        '--source',
        'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      [
        'install',
        '--id',
        'GitHub.cli',
        '--source',
        'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
    ]) {
      const catalog = structuredClone(winget)
      strategy(catalog).args = args
      expect(() => parseToolCatalog(catalog), args.join(' ')).toThrow(
        /command/i,
      )
    }
  })
})
