// REL-05 test 7: a dry run of the Stable release assembles, into one folder,
// exactly what the release would upload (the assets, the notes body, the
// checksums) and the gh commands it would run, and runs none of them.
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
  sha256File,
  stableArtifactNames,
  writeSbomFixture,
  writeStableCandidate,
  type StableArch,
} from './test-fixtures/stable-release'

const repoRoot = resolve(__dirname, '..', '..', '..')
const dryRun = join(repoRoot, 'scripts', 'release-dry-run.mjs')
const contract = join(repoRoot, 'scripts', 'release-contract.mjs')
const publisher = join(repoRoot, 'scripts', 'publish-release.sh')
const commit = 'c'.repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/** A dist with candidates, an SBOM to use and a gh that must never run. */
function createFixture(arches: StableArch[] = ['arm64', 'x64']) {
  const root = mkdtempSync(join(tmpdir(), 'emperor-release-dry-run-'))
  roots.push(root)
  const dist = join(root, 'dist')
  for (const arch of arches) writeStableCandidate(dist, arch, commit)
  const sbom = join(root, 'fixture.cdx.json')
  writeSbomFixture(sbom)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const ghMarker = join(root, 'gh-ran')
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$@" >> '${ghMarker}'\nexit 0\n`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  return { root, dist, sbom, bin, ghMarker, out: join(root, 'out') }
}

function env(fixture: { bin: string }) {
  return { ...process.env, PATH: `${fixture.bin}:${process.env.PATH ?? ''}` }
}

function runDryRun(
  fixture: ReturnType<typeof createFixture>,
  extra: string[] = [],
) {
  return spawnSync(
    process.execPath,
    [
      dryRun,
      '--dist',
      fixture.dist,
      '--out',
      fixture.out,
      '--tag',
      STABLE_TAG,
      '--commit',
      commit,
      '--sbom',
      fixture.sbom,
      ...extra,
    ],
    { cwd: repoRoot, encoding: 'utf8', env: env(fixture) },
  )
}

interface DraftPlan {
  dryRun: boolean
  tag: string
  commit: string
  title: string
  draft: boolean
  prerelease: boolean
  partial: boolean
  platforms: string[]
  notes: string
  assets: Array<{ name: string; size: number; sha256: string }>
  commands: string[][]
  tagRequired: string
}

describe('release dry run (REL-05 test 7)', () => {
  it('assembles what the release would upload and plans the draft, without running gh', () => {
    const fixture = createFixture()
    const result = runDryRun(fixture)

    expect(result.status, result.stderr).toBe(0)
    const bundle = join(fixture.out, 'release-bundle')
    const sbomName = `emperor-agent-${STABLE_TAG}.cdx.json`
    const expected = [
      ...stableArtifactNames('arm64'),
      ...stableArtifactNames('x64'),
      'ARTIFACT-SHA256SUMS.txt',
      'RELEASE-NOTES.md',
      'SHA256SUMS.txt',
      'release-manifest.json',
      sbomName,
    ].sort()
    expect(readdirSync(bundle).sort()).toEqual(expected)

    // 4: SHA256SUMS.txt covers every other file, each with its own digest.
    const sums = readFileSync(join(bundle, 'SHA256SUMS.txt'), 'utf8')
      .trim()
      .split('\n')
    expect(sums).toEqual(
      expected
        .filter((name) => name !== 'SHA256SUMS.txt')
        .map((name) => `${sha256File(join(bundle, name))}  ${name}`),
    )

    const plan = JSON.parse(
      readFileSync(join(fixture.out, 'draft-release.json'), 'utf8'),
    ) as DraftPlan
    const notes = readFileSync(join(bundle, 'RELEASE-NOTES.md'), 'utf8')
    expect(plan).toMatchObject({
      dryRun: true,
      tag: STABLE_TAG,
      commit,
      title: `Emperor Agent ${STABLE_TAG}`,
      draft: true,
      prerelease: false,
      partial: false,
      platforms: ['macos-arm64', 'macos-x64'],
      notes,
      tagRequired: `refs/tags/${STABLE_TAG} → ${commit}`,
    })
    expect(plan.assets.map((asset) => asset.name)).toEqual(expected)
    for (const asset of plan.assets)
      expect(asset.sha256, asset.name).toBe(
        sha256File(join(bundle, asset.name)),
      )
    expect(plan.commands).toEqual([
      [
        'gh',
        'release',
        'create',
        STABLE_TAG,
        '--draft',
        '--verify-tag',
        '--title',
        `Emperor Agent ${STABLE_TAG}`,
        '--notes-file',
        join(bundle, 'RELEASE-NOTES.md'),
      ],
      [
        'gh',
        'release',
        'upload',
        STABLE_TAG,
        ...expected.map((name) => join(bundle, name)),
      ],
      ['gh', 'release', 'edit', STABLE_TAG, '--draft=false'],
    ])
    expect(
      readFileSync(join(fixture.out, 'draft-release-notes.md'), 'utf8'),
    ).toBe(notes)
    expect(notes.split('\n\n')[0]).toContain('未签名')
    expect(existsSync(fixture.ghMarker)).toBe(false)
  })

  it('names the candidate that is missing and the script that makes it', () => {
    const fixture = createFixture()
    rmSync(join(fixture.dist, 'release-receipts'), { recursive: true })

    const result = runDryRun(fixture)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('scripts/verify-macos-release.sh arm64')
    expect(existsSync(fixture.ghMarker)).toBe(false)
  })

  it('marks a one-architecture dry run partial, and the real publisher refuses it before gh', () => {
    const fixture = createFixture(['arm64'])
    const result = runDryRun(fixture, ['--arches', 'arm64'])
    expect(result.status, result.stderr).toBe(0)
    const plan = JSON.parse(
      readFileSync(join(fixture.out, 'draft-release.json'), 'utf8'),
    ) as DraftPlan
    expect(plan).toMatchObject({ partial: true, platforms: ['macos-arm64'] })

    const publish = spawnSync(
      'bash',
      [publisher, join(fixture.out, 'release-bundle')],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...env(fixture),
          EMPEROR_RELEASE_TAG: STABLE_TAG,
          EMPEROR_RELEASE_COMMIT: commit,
        },
      },
    )
    expect(publish.status).toBe(1)
    expect(publish.stderr).toMatch(/partial/)
    expect(existsSync(fixture.ghMarker)).toBe(false)
  })
})

describe('Stable publication contract (REL-05)', () => {
  function bundleFixture() {
    const fixture = createFixture()
    expect(runDryRun(fixture).status).toBe(0)
    return { ...fixture, bundle: join(fixture.out, 'release-bundle') }
  }

  function publication(bundle: string, ...extra: string[]) {
    return spawnSync(
      process.execPath,
      [contract, 'publication', bundle, STABLE_TAG, commit, ...extra],
      { encoding: 'utf8' },
    )
  }

  function checksums(bundle: string) {
    return spawnSync(process.execPath, [contract, 'checksums', bundle], {
      encoding: 'utf8',
    })
  }

  it('passes a complete bundle', () => {
    const { bundle } = bundleFixture()
    const result = publication(bundle)
    expect(result.status, result.stderr).toBe(0)
  })

  it('refuses notes that do not open with the unsigned statement', () => {
    const { bundle } = bundleFixture()
    const notesPath = join(bundle, 'RELEASE-NOTES.md')
    const notes = readFileSync(notesPath, 'utf8')
    writeFileSync(
      notesPath,
      `Emperor Agent ${STABLE_VERSION} 来了。\n\n${notes}`,
    )
    expect(checksums(bundle).status).toBe(0)

    const result = publication(bundle)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/first paragraph/)
  })

  it('4. refuses a bundle whose SHA256SUMS.txt no longer matches a file', () => {
    const { bundle } = bundleFixture()
    writeFileSync(join(bundle, stableArtifactNames('x64')[1]), 'tampered\n')

    const result = publication(bundle)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/checksum/)
  })

  it('refuses an extra or a missing asset, and an SBOM that is not CycloneDX 1.6', () => {
    const extra = bundleFixture()
    writeFileSync(join(extra.bundle, 'notes.txt'), 'extra\n')
    expect(checksums(extra.bundle).status).toBe(0)
    const unexpected = publication(extra.bundle)
    expect(unexpected.status).toBe(1)
    expect(unexpected.stderr).toContain('notes.txt')

    const missing = bundleFixture()
    rmSync(join(missing.bundle, 'release-manifest.json'))
    expect(checksums(missing.bundle).status).toBe(0)
    expect(publication(missing.bundle).status).toBe(1)

    const sbom = bundleFixture()
    writeFileSync(
      join(sbom.bundle, `emperor-agent-${STABLE_TAG}.cdx.json`),
      JSON.stringify({ bomFormat: 'SPDX' }),
    )
    expect(checksums(sbom.bundle).status).toBe(0)
    const wrongSbom = publication(sbom.bundle)
    expect(wrongSbom.status).toBe(1)
    expect(wrongSbom.stderr).toContain('CycloneDX')
  })
})
