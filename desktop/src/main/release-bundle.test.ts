import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..', '..', '..')
const assembler = join(repoRoot, 'scripts', 'assemble-release-bundle.mjs')
const commit = 'a'.repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('trusted release bundle assembler', () => {
  it('assembles exactly seven artifacts after validating every receipt', () => {
    const fixture = createFixture()
    const result = runAssembler(fixture)

    expect(result.status).toBe(0)
    const manifest = JSON.parse(
      readFileSync(join(fixture.output, 'release-manifest.json'), 'utf8'),
    ) as { commit: string; artifacts: unknown[] }
    expect(manifest.commit).toBe(commit)
    expect(manifest.artifacts).toHaveLength(7)
    expect(
      readFileSync(join(fixture.output, 'ARTIFACT-SHA256SUMS.txt'), 'utf8'),
    ).toContain('Emperor-Agent-0.1.0-win-x64.exe')
  })

  it('rejects a candidate whose platform checksum does not match', () => {
    const fixture = createFixture()
    writeFileSync(
      join(fixture.input, 'SHA256SUMS-windows-x64.txt'),
      `${'0'.repeat(64)} *Emperor-Agent-0.1.0-win-x64.exe\n`,
    )

    const result = runAssembler(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('checksum mismatch')
  })

  it('rejects any unsigned internal marker', () => {
    const fixture = createFixture()
    writeFileSync(join(fixture.input, 'UNSIGNED-INTERNAL.txt'), 'blocked\n')

    const result = runAssembler(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UNSIGNED-INTERNAL')
  })
})

function createFixture(): { root: string; input: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'emperor-release-bundle-'))
  roots.push(root)
  const input = join(root, 'input')
  const output = join(root, 'output')
  mkdirSync(input)

  const artifactGroups = {
    'SHA256SUMS-macos-arm64.txt': [
      'Emperor-Agent-0.1.0-mac-arm64.dmg',
      'Emperor-Agent-0.1.0-mac-arm64.zip',
    ],
    'SHA256SUMS-macos-x64.txt': [
      'Emperor-Agent-0.1.0-mac-x64.dmg',
      'Emperor-Agent-0.1.0-mac-x64.zip',
    ],
    'SHA256SUMS-windows-x64.txt': ['Emperor-Agent-0.1.0-win-x64.exe'],
    'SHA256SUMS-linux-x64.txt': [
      'Emperor-Agent-0.1.0-linux-x64.AppImage',
      'Emperor-Agent-0.1.0-linux-x64.deb',
    ],
  }
  for (const [checksumName, artifacts] of Object.entries(artifactGroups)) {
    for (const name of artifacts)
      writeFileSync(join(input, name), `fixture:${name}\n`)
    writeFileSync(
      join(input, checksumName),
      `${artifacts
        .map((name) => `${sha256(join(input, name))} *${name}`)
        .join('\n')}\n`,
    )
  }

  writeJson(
    input,
    'macos-arm64.json',
    macReceipt('arm64', artifactGroups['SHA256SUMS-macos-arm64.txt']),
  )
  writeJson(
    input,
    'macos-x64.json',
    macReceipt('x64', artifactGroups['SHA256SUMS-macos-x64.txt']),
  )
  writeJson(input, 'windows-x64.json', {
    ...receiptBase('windows', 'x64'),
    publisher: 'Emperor Agent LLC',
    authenticode: true,
    installedExecutableSigned: true,
    uninstallerSigned: true,
    installExitCode: 0,
    smokeExitCode: 0,
    uninstallExitCode: 0,
    artifacts: artifactGroups['SHA256SUMS-windows-x64.txt'],
  })
  writeJson(input, 'linux-x64-build.json', {
    ...receiptBase('linux', 'x64'),
    debArchitecture: 'amd64',
    metadataVerified: true,
    artifacts: artifactGroups['SHA256SUMS-linux-x64.txt'],
  })

  for (const name of [
    'darwin-arm64.json',
    'darwin-x64.json',
    'win32-x64.json',
  ]) {
    writeJson(input, name, smokeReceipt())
  }
  for (const version of ['22.04', '24.04']) {
    writeJson(input, `${version}-appimage.json`, smokeReceipt())
    writeJson(input, `${version}-deb.json`, smokeReceipt())
    writeJson(input, `${version}-lifecycle.json`, {
      ...receiptBase('linux', 'x64'),
      ubuntuVersion: version,
      appImageSmoke: true,
      debInstall: true,
      debSmoke: true,
      debRemove: true,
    })
  }
  return { root, input, output }
}

function runAssembler(fixture: { input: string; output: string }) {
  return spawnSync(
    process.execPath,
    [assembler, fixture.input, fixture.output, 'v0.1.0', commit],
    { encoding: 'utf8' },
  )
}

function receiptBase(platform: string, arch: string) {
  return { schemaVersion: 1, commit, platform, arch }
}

function macReceipt(arch: string, artifacts: string[]) {
  return {
    ...receiptBase('macos', arch),
    teamId: 'ABCDE12345',
    signed: true,
    gatekeeper: true,
    notarized: true,
    dmgMounted: true,
    artifacts,
  }
}

function smokeReceipt() {
  return {
    schemaVersion: 1,
    commit,
    exitCode: 0,
    stateRoot: '$TEMP/stateRoot',
    runtimeManifestHash: 'b'.repeat(64),
    runtimeRevision: 'c'.repeat(64),
    installJobs: { before: 0, after: 0 },
    operations: Object.fromEntries(
      ['bootstrap', 'diagnostics', 'environment', 'glob', 'grep'].map(
        (name) => [name, { ok: true }],
      ),
    ),
  }
}

function writeJson(root: string, name: string, value: unknown) {
  writeFileSync(join(root, name), `${JSON.stringify(value)}\n`)
}

function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
