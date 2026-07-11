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

    ;(strategy.source as Record<string, unknown>).sha256 = 'a'.repeat(64)
    strategy.kind = 'windows_installer'
    strategy.targets = [{ platform: 'win32', arch: 'x64' }]
    delete (strategy.source as Record<string, unknown>).publisher
    expect(() => parseToolCatalog(direct)).toThrow(/publisher/i)
  })

  it('ships an immutable catalog covering every planned tool id', () => {
    const bundled = loadBundledToolCatalog()
    expect(bundled.revision).toBe(
      'dc95b1f423e1b8ccde50c66c06fa172f9226b95be7f15e10799ac2a4fefc7ffe',
    )
    expect(bundled.catalog.tools.map((tool) => tool.id)).toEqual([
      'cargo',
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
  })
})
