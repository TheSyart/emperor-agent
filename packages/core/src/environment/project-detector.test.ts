import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectEnvironmentDetector } from './project-detector'
import { versionSatisfies } from './version'

const fallbacks = {
  node: '24.18.0',
  python: '3.12.13',
  go: '1.26.5',
  rust: '1.97.0',
}

function project(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-project-environment-'))
}

function write(root: string, name: string, content: string): void {
  writeFileSync(join(root, name), content, 'utf8')
}

describe('ProjectEnvironmentDetector', () => {
  it('honors Node and Python declaration priority using root files only', () => {
    const root = project()
    write(
      root,
      'package.json',
      JSON.stringify({
        volta: { node: '22.5.0' },
        engines: { node: '>=20' },
      }),
    )
    write(root, '.node-version', '21.0.0\n')
    write(root, '.nvmrc', '20.0.0\n')
    write(root, '.python-version', '3.12.8\n')
    write(root, 'pyproject.toml', '[project]\nrequires-python = ">=3.11"\n')
    write(root, 'Pipfile', '[requires]\npython_version = "3.10"\n')

    const result = new ProjectEnvironmentDetector({ fallbacks }).detect(root)
    expect(result.declarations.node).toMatchObject({
      status: 'declared',
      source: 'package.json#volta.node',
      rawRequirement: '22.5.0',
      normalizedRequirement: '=22.5.0',
    })
    expect(result.declarations.python).toMatchObject({
      status: 'declared',
      source: '.python-version',
      normalizedRequirement: '=3.12.8',
    })

    mkdirSync(join(root, 'nested'))
    write(join(root, 'nested'), 'package.json', '{"volta":{"node":"1.0.0"}}')
    expect(
      new ProjectEnvironmentDetector({ fallbacks }).detect(root).declarations
        .node.source,
    ).toBe('package.json#volta.node')
  })

  it('honors Go and Rust structured declaration priority', () => {
    const root = project()
    write(
      root,
      'go.mod',
      'module example.com/app\n\ngo 1.24.0\ntoolchain go1.26.5\n',
    )
    write(root, 'rust-toolchain.toml', '[toolchain]\nchannel = "stable"\n')
    write(root, 'rust-toolchain', '1.90.0\n')
    write(
      root,
      'Cargo.toml',
      '[package]\nname = "app"\nrust-version = "1.80"\n',
    )

    const result = new ProjectEnvironmentDetector({ fallbacks }).detect(root)
    expect(result.declarations.go).toMatchObject({
      status: 'declared',
      source: 'go.mod#toolchain',
      normalizedRequirement: '=1.26.5',
    })
    expect(result.declarations.rust).toMatchObject({
      status: 'declared',
      source: 'rust-toolchain.toml#toolchain.channel',
      normalizedRequirement: '=1.97.0',
    })

    const minimums = project()
    write(minimums, 'go.mod', 'module example.com/app\n\ngo 1.24\n')
    write(
      minimums,
      'Cargo.toml',
      '[package]\nname = "app"\nrust-version = "1.80"\n',
    )
    const minimumResult = new ProjectEnvironmentDetector({ fallbacks }).detect(
      minimums,
    )
    expect(minimumResult.declarations.go.normalizedRequirement).toBe('>=1.24.0')
    expect(minimumResult.declarations.rust.normalizedRequirement).toBe(
      '>=1.80.0',
    )
    expect(
      versionSatisfies(
        '1.26.5',
        minimumResult.declarations.go.normalizedRequirement!,
      ),
    ).toBe(true)
    expect(
      versionSatisfies(
        '1.97.0',
        minimumResult.declarations.rust.normalizedRequirement!,
      ),
    ).toBe(true)
  })

  it('uses reviewed catalog fallbacks when an ecosystem has no declaration', () => {
    const root = project()
    write(root, 'package.json', '{"name":"app"}\n')
    write(root, 'pyproject.toml', '[project]\nname = "app"\n')
    write(root, 'go.mod', 'module example.com/app\n')
    write(root, 'Cargo.toml', '[package]\nname = "app"\n')

    const result = new ProjectEnvironmentDetector({ fallbacks }).detect(root)
    expect(result.declarations.node).toMatchObject({
      status: 'default',
      normalizedRequirement: '=24.18.0',
    })
    expect(result.declarations.python.normalizedRequirement).toBe('=3.12.13')
    expect(result.declarations.go.normalizedRequirement).toBe('=1.26.5')
    expect(result.declarations.rust.normalizedRequirement).toBe('=1.97.0')

    const requirementsOnly = project()
    write(requirementsOnly, 'requirements.txt', 'httpx==0.28.0\n')
    expect(
      new ProjectEnvironmentDetector({ fallbacks }).detect(requirementsOnly)
        .declarations.python,
    ).toMatchObject({ status: 'default', normalizedRequirement: '=3.12.13' })
  })

  it('marks invalid and unsupported declarations without falling through', () => {
    const malformed = project()
    write(malformed, 'package.json', '{"secret":"must-not-leak",broken')
    write(malformed, '.node-version', '22.0.0\n')
    const invalid = new ProjectEnvironmentDetector({ fallbacks }).detect(
      malformed,
    )
    expect(invalid.declarations.node).toMatchObject({
      status: 'invalid',
      source: 'package.json',
    })
    expect(JSON.stringify(invalid)).not.toContain('must-not-leak')

    const invalidType = project()
    write(
      invalidType,
      'package.json',
      '{"volta":{"node":24},"engines":{"node":">=22"}}',
    )
    expect(
      new ProjectEnvironmentDetector({ fallbacks }).detect(invalidType)
        .declarations.node,
    ).toMatchObject({ status: 'invalid', source: 'package.json#volta.node' })

    const invalidTomlType = project()
    write(
      invalidTomlType,
      'pyproject.toml',
      '[project]\nrequires-python = 312\n',
    )
    expect(
      new ProjectEnvironmentDetector({ fallbacks }).detect(invalidTomlType)
        .declarations.python,
    ).toMatchObject({
      status: 'invalid',
      source: 'pyproject.toml#project.requires-python',
    })

    const invalidGo = project()
    write(invalidGo, 'go.mod', 'module example.com/app\ngo banana\n')
    expect(
      new ProjectEnvironmentDetector({ fallbacks }).detect(invalidGo)
        .declarations.go,
    ).toMatchObject({ status: 'invalid', source: 'go.mod#go' })

    const unsupported = project()
    write(unsupported, '.nvmrc', 'lts/*\n')
    expect(
      new ProjectEnvironmentDetector({ fallbacks }).detect(unsupported)
        .declarations.node,
    ).toMatchObject({ status: 'unsupported', source: '.nvmrc' })

    const multiple = project()
    write(multiple, '.python-version', '3.12.13\n3.13.0\n')
    expect(
      new ProjectEnvironmentDetector({ fallbacks }).detect(multiple)
        .declarations.python,
    ).toMatchObject({ status: 'invalid', source: '.python-version' })
  })

  it('changes its stable fingerprint only when root declarations change', () => {
    const root = project()
    write(root, 'package.json', '{"engines":{"node":">=22"}}\n')
    const detector = new ProjectEnvironmentDetector({ fallbacks })
    const first = detector.detect(root)
    const second = detector.detect(root)
    expect(second.fingerprint).toBe(first.fingerprint)

    write(root, 'README.md', 'ignored\n')
    expect(detector.detect(root).fingerprint).toBe(first.fingerprint)
    write(root, '.node-version', '24.18.0\n')
    const changed = detector.detect(root)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    expect(readFileSync(join(root, '.node-version'), 'utf8')).toBe('24.18.0\n')
  })
})
