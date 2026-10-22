// REL-05: the Stable bundle the release job attests and publishes: the four
// unsigned macOS artifacts, their checksums, a manifest that says unsigned,
// and the release notes. Anything else, or anything signed, fails closed.
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  STABLE_TAG,
  STABLE_VERSION,
  candidatePaths,
  readCandidateReceipt,
  sha256File,
  stableArtifactNames,
  writeCandidateReceipt,
  writeStableCandidate,
  type StableArch,
} from './test-fixtures/stable-release'

const repoRoot = resolve(__dirname, '..', '..', '..')
const assembler = join(repoRoot, 'scripts', 'assemble-release-bundle.mjs')
const commit = 'a'.repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function createFixture(arches: StableArch[] = ['arm64', 'x64']) {
  const root = mkdtempSync(join(tmpdir(), 'emperor-stable-bundle-'))
  roots.push(root)
  const input = join(root, 'input')
  for (const arch of arches) writeStableCandidate(input, arch, commit)
  return { root, input, output: join(root, 'output') }
}

function runAssembler(
  fixture: { input: string; output: string },
  extra: string[] = [],
  tag = STABLE_TAG,
) {
  return spawnSync(
    process.execPath,
    [assembler, fixture.input, fixture.output, tag, commit, ...extra],
    { encoding: 'utf8' },
  )
}

const allArtifacts = [
  ...stableArtifactNames('arm64'),
  ...stableArtifactNames('x64'),
]

describe('Stable release bundle assembler (REL-05)', () => {
  it('3. assembles the four unsigned macOS artifacts, their checksums, the manifest and the notes', () => {
    const fixture = createFixture()
    const result = runAssembler(fixture)

    expect(result.status, result.stderr).toBe(0)
    expect(readdirSync(fixture.output).sort()).toEqual(
      [
        ...allArtifacts,
        'ARTIFACT-SHA256SUMS.txt',
        'RELEASE-NOTES.md',
        'release-manifest.json',
      ].sort(),
    )
    const manifest = JSON.parse(
      readFileSync(join(fixture.output, 'release-manifest.json'), 'utf8'),
    ) as Record<string, unknown> & { artifacts: Array<{ name: string }> }
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      channel: 'stable',
      signingStatus: 'unsigned',
      notarized: false,
      seal: 'ad-hoc',
      tag: STABLE_TAG,
      commit,
      version: STABLE_VERSION,
      platforms: ['macos-arm64', 'macos-x64'],
      partial: false,
    })
    expect(manifest.artifacts.map((item) => item.name)).toEqual(
      [...allArtifacts].sort(),
    )
    const notes = readFileSync(join(fixture.output, 'RELEASE-NOTES.md'), 'utf8')
    expect(notes.split('\n\n')[0]).toContain('未签名')
    expect(notes).toContain(STABLE_VERSION)
    expect(notes).not.toContain('{{')
    // REL-02: the notes record the bundled Electron for the update check's
    // reminder (desktop/package-lock.json), as their one HTML comment.
    const lock = JSON.parse(
      readFileSync(join(repoRoot, 'desktop', 'package-lock.json'), 'utf8'),
    ) as { packages: Record<string, { version?: string }> }
    const electron = lock.packages['node_modules/electron']!.version
    expect(notes.trim().split('\n').at(-1)).toBe(
      `<!-- emperor-release electron=${electron} -->`,
    )
  })

  it('4. lists every artifact with its own SHA-256 in ARTIFACT-SHA256SUMS.txt', () => {
    const fixture = createFixture()
    expect(runAssembler(fixture).status).toBe(0)

    const lines = readFileSync(
      join(fixture.output, 'ARTIFACT-SHA256SUMS.txt'),
      'utf8',
    )
      .trim()
      .split('\n')
    expect(lines).toEqual(
      [...allArtifacts]
        .sort()
        .map((name) => `${sha256File(join(fixture.output, name))}  ${name}`),
    )
  })

  it('4. rejects a candidate whose checksums do not match its artifacts', () => {
    const fixture = createFixture()
    const [dmg, zip] = stableArtifactNames('x64')
    writeFileSync(
      candidatePaths(fixture.input, 'x64').checksums,
      `${'0'.repeat(64)}  ${dmg}\n${sha256File(join(fixture.input, zip))}  ${zip}\n`,
    )

    const result = runAssembler(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`checksum mismatch: ${dmg}`)
  })

  it.each([
    ['signed', { signingStatus: 'signed' }],
    ['notarized', { notarized: true }],
    ['carrying a team ID', { teamId: 'ABCDE12345' }],
    ['from another channel', { channel: 'preview' }],
    ['from another commit', { commit: 'b'.repeat(40) }],
  ])('rejects a candidate receipt that is %s', (_name, change) => {
    const fixture = createFixture()
    writeCandidateReceipt(fixture.input, 'arm64', {
      ...readCandidateReceipt(fixture.input, 'arm64'),
      ...change,
    })

    const result = runAssembler(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('macos/arm64')
  })

  it.each([
    ['not sealed ad hoc', { adHoc: false }],
    ['without the hardened runtime', { hardenedRuntime: false }],
    ['with unchecked fuses', { fusesVerified: false }],
    ['whose seal does not verify', { codesignStrict: false }],
  ])('rejects a candidate %s', (_name, change) => {
    const fixture = createFixture()
    const receipt = readCandidateReceipt(fixture.input, 'x64')
    writeCandidateReceipt(fixture.input, 'x64', {
      ...receipt,
      seal: { ...receipt.seal, ...change },
    })

    const result = runAssembler(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('macos/x64')
  })

  it('rejects a packaged smoke receipt that does not prove the seal or the version', () => {
    for (const mutate of [
      (smoke: Record<string, unknown>) => {
        Reflect.deleteProperty(smoke, 'package')
      },
      (smoke: Record<string, unknown>) => {
        smoke.appVersion = '0.1.0'
      },
    ]) {
      const fixture = createFixture()
      const path = candidatePaths(fixture.input, 'arm64').smoke
      const smoke = JSON.parse(readFileSync(path, 'utf8')) as Record<
        string,
        unknown
      >
      mutate(smoke)
      writeFileSync(path, JSON.stringify(smoke))

      const result = runAssembler(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/packaged smoke/)
    }
  })

  it('3. rejects Preview, Internal, other-platform, old-name and unexpected inputs', () => {
    for (const name of [
      'UNSIGNED-INTERNAL.txt',
      `Emperor-Agent-${STABLE_VERSION}-UNSIGNED-PREVIEW-macos-arm64.dmg`,
      'preview-release-manifest.json',
      `Emperor-Agent-${STABLE_VERSION}-mac-arm64.dmg`,
      `Emperor-Agent-${STABLE_VERSION}-win-x64.exe`,
      `Emperor-Agent-${STABLE_VERSION}-linux-x64.AppImage`,
      'unexpected.txt',
    ]) {
      const fixture = createFixture()
      writeFileSync(join(fixture.input, name), 'blocked\n')
      const result = runAssembler(fixture)
      expect(result.status, name).toBe(1)
      expect(result.stderr, name).toMatch(/INTERNAL|PREVIEW|Preview|unexpected/)
    }
  })

  it('rejects a tag that is not v<desktop version>', () => {
    const fixture = createFixture()
    for (const tag of ['v0.2.0-preview.1', 'v9.9.9', '0.2.0']) {
      const result = runAssembler(fixture, [], tag)
      expect(result.status, tag).toBe(1)
      expect(result.stderr, tag).toMatch(/tag/)
    }
  })

  it('needs both architectures unless a dry run names fewer, and then says it is partial', () => {
    const fixture = createFixture(['arm64'])
    const full = runAssembler(fixture)
    expect(full.status).toBe(1)
    expect(full.stderr).toContain(stableArtifactNames('x64')[0])

    const partial = runAssembler(fixture, ['--arches', 'arm64'])
    expect(partial.status, partial.stderr).toBe(0)
    const manifest = JSON.parse(
      readFileSync(join(fixture.output, 'release-manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(manifest).toMatchObject({
      platforms: ['macos-arm64'],
      partial: true,
    })

    const unknown = runAssembler(fixture, ['--arches', 'arm64,ppc'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('ppc')
  })

  it('writes the same manifest for the same input', () => {
    const fixture = createFixture()
    expect(runAssembler(fixture).status).toBe(0)
    const first = readFileSync(
      join(fixture.output, 'release-manifest.json'),
      'utf8',
    )
    const second = { ...fixture, output: join(fixture.root, 'second') }
    expect(runAssembler(second).status).toBe(0)
    expect(
      readFileSync(join(second.output, 'release-manifest.json'), 'utf8'),
    ).toBe(first)
  })
})
