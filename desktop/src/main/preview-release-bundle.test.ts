import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..', '..', '..')
const assembler = join(
  repoRoot,
  'scripts',
  'assemble-preview-release-bundle.mjs',
)
const publicationContract = join(
  repoRoot,
  'scripts',
  'preview-publication-contract.mjs',
)
const tag = 'v0.1.0-preview.1'
const version = tag.slice(1)
const commit = 'a'.repeat(40)
const runId = '123456'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('unsigned Preview release bundle assembler', () => {
  it('assembles exactly seven artifacts with explicit unsigned metadata', () => {
    const fixture = createFixture()
    const result = runAssembler(fixture)

    expect(result.status, result.stderr).toBe(0)
    const manifest = readJson(
      join(fixture.output, 'preview-release-manifest.json'),
    ) as {
      marker: string
      channel: string
      signingStatus: string
      notarized: boolean
      tag: string
      commit: string
      runId: string
      artifacts: unknown[]
    }
    expect(manifest).toMatchObject({
      marker: 'UNSIGNED-PREVIEW',
      channel: 'preview',
      signingStatus: 'unsigned',
      notarized: false,
      tag,
      commit,
      runId,
    })
    expect(manifest.artifacts).toHaveLength(7)
  })

  it('copies bilingual risk disclosure with official single-app paths', () => {
    const fixture = createFixture()
    expect(runAssembler(fixture).status).toBe(0)

    const notice = readFileSync(
      join(fixture.output, 'UNSIGNED-PREVIEW-NOTICE.md'),
      'utf8',
    )
    expect(notice).toContain(tag)
    expect(notice).toContain('未签名预览版')
    expect(notice).toContain('Unsigned Preview')
    expect(notice).toContain('signingStatus: unsigned')
    expect(notice).toContain('https://support.apple.com/en-us/102445')
    expect(notice).toContain(
      'https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app',
    )
    expect(notice).toContain('More info')
    expect(notice).toContain('Open Anyway')
    expect(notice).not.toMatch(/spctl\s+--master-disable/i)
    expect(notice).not.toMatch(/disable\s+(Gatekeeper|SmartScreen|Defender)/i)
  })

  it('produces deterministic manifests for identical input', () => {
    const fixture = createFixture()
    expect(runAssembler(fixture).status).toBe(0)
    const first = readFileSync(
      join(fixture.output, 'preview-release-manifest.json'),
      'utf8',
    )
    const secondOutput = join(fixture.root, 'second-output')

    expect(runAssembler({ ...fixture, output: secondOutput }).status).toBe(0)
    expect(
      readFileSync(join(secondOutput, 'preview-release-manifest.json'), 'utf8'),
    ).toBe(first)
  })

  it('rejects a missing or duplicate deliverable', () => {
    const fixture = createFixture()
    rmSync(join(fixture.input, artifactNames()[0]))
    const missing = runAssembler(fixture)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toMatch(/expected exactly one|missing/i)

    const duplicateFixture = createFixture()
    const nested = join(duplicateFixture.input, 'nested')
    mkdirSync(nested)
    copyFileSync(
      join(duplicateFixture.input, artifactNames()[1]),
      join(nested, artifactNames()[1]),
    )
    const duplicate = runAssembler(duplicateFixture)
    expect(duplicate.status).toBe(1)
    expect(duplicate.stderr).toContain('duplicate')
  })

  it('rejects checksum and candidate receipt hash mismatches', () => {
    const checksumFixture = createFixture()
    writeFileSync(
      join(checksumFixture.input, 'SHA256SUMS-windows-x64.txt'),
      `${'0'.repeat(64)}  ${artifactNames()[4]}\n`,
    )
    const checksum = runAssembler(checksumFixture)
    expect(checksum.status).toBe(1)
    expect(checksum.stderr).toContain('checksum mismatch')

    const receiptFixture = createFixture()
    const receiptPath = join(
      receiptFixture.input,
      'preview-receipts',
      'candidate-linux-x64.json',
    )
    const receipt = readJson(receiptPath) as {
      artifacts: Array<{ sha256: string }>
    }
    receipt.artifacts[0].sha256 = '0'.repeat(64)
    writeJson(receiptPath, receipt)
    const candidate = runAssembler(receiptFixture)
    expect(candidate.status).toBe(1)
    expect(candidate.stderr).toContain('candidate artifact record mismatch')
  })

  it('rejects cross-commit and cross-run receipts', () => {
    const commitFixture = createFixture()
    mutateReceipt(
      commitFixture.input,
      'candidate-macos-arm64.json',
      (receipt) => {
        receipt.commit = 'b'.repeat(40)
      },
    )
    const wrongCommit = runAssembler(commitFixture)
    expect(wrongCommit.status).toBe(1)
    expect(wrongCommit.stderr).toContain('macos/arm64')

    const runFixture = createFixture()
    mutateReceipt(runFixture.input, 'candidate-windows-x64.json', (receipt) => {
      receipt.runId = '654321'
    })
    const wrongRun = runAssembler(runFixture)
    expect(wrongRun.status).toBe(1)
    expect(wrongRun.stderr).toContain('windows/x64')
  })

  it('rejects Stable, Internal and unrecognized input files', () => {
    for (const name of [
      'UNSIGNED-INTERNAL.txt',
      'release-manifest.json',
      'unexpected.txt',
    ]) {
      const fixture = createFixture()
      writeFileSync(join(fixture.input, name), 'blocked\n')
      const result = runAssembler(fixture)
      expect(result.status, name).toBe(1)
      expect(result.stderr, name).toMatch(/INTERNAL|Stable|unexpected/i)
    }
  })

  it('rejects a non-Preview tag or a tag outside the desktop base version', () => {
    const fixture = createFixture()
    const stable = runAssembler(fixture, 'v0.1.0')
    expect(stable.status).toBe(1)
    expect(stable.stderr).toMatch(/Preview tag/i)

    const wrongVersion = runAssembler(fixture, 'v9.9.9-preview.1')
    expect(wrongVersion.status).toBe(1)
    expect(wrongVersion.stderr).toMatch(/desktop version/i)
  })

  it('passes publication preflight only with complete checksums and disclosure', () => {
    const fixture = createFixture()
    expect(runAssembler(fixture).status).toBe(0)
    finalizeBundle(fixture.output)

    const result = runPublicationContract(fixture.output)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      'UNSIGNED-PREVIEW publication preflight passed',
    )
  })

  it('rejects forged signing status and incomplete risk disclosure', () => {
    const signedFixture = createFixture()
    expect(runAssembler(signedFixture).status).toBe(0)
    const manifestPath = join(
      signedFixture.output,
      'preview-release-manifest.json',
    )
    const manifest = readJson(manifestPath) as Record<string, unknown>
    manifest.signingStatus = 'signed'
    writeJson(manifestPath, manifest)
    finalizeBundle(signedFixture.output)
    const signed = runPublicationContract(signedFixture.output)
    expect(signed.status).toBe(1)
    expect(signed.stderr).toMatch(/signingStatus|unsigned/i)

    const noticeFixture = createFixture()
    expect(runAssembler(noticeFixture).status).toBe(0)
    writeFileSync(
      join(noticeFixture.output, 'UNSIGNED-PREVIEW-NOTICE.md'),
      '# UNSIGNED-PREVIEW\n',
    )
    finalizeBundle(noticeFixture.output)
    const notice = runPublicationContract(noticeFixture.output)
    expect(notice.status).toBe(1)
    expect(notice.stderr).toMatch(/risk disclosure|official/i)
  })

  it('rejects partial or stale full-bundle checksums', () => {
    const fixture = createFixture()
    expect(runAssembler(fixture).status).toBe(0)
    finalizeBundle(fixture.output)
    writeFileSync(
      join(fixture.output, 'SHA256SUMS.txt'),
      `${'0'.repeat(64)}  UNSIGNED-PREVIEW.json\n`,
    )

    const result = runPublicationContract(fixture.output)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/checksum|coverage/i)
  })
})

function createFixture(): { root: string; input: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'emperor-preview-bundle-'))
  roots.push(root)
  const input = join(root, 'input')
  const output = join(root, 'output')
  mkdirSync(input)
  mkdirSync(join(input, 'packaged-smoke'), { recursive: true })
  mkdirSync(join(input, 'preview-receipts'), { recursive: true })
  mkdirSync(join(input, 'preview-linux-receipts'), { recursive: true })

  for (const name of artifactNames())
    writeFileSync(join(input, name), `fixture:${name}\n`)

  const groups = candidateGroups()
  for (const group of groups) {
    writeFileSync(
      join(input, `SHA256SUMS-${group.platform}-${group.arch}.txt`),
      `${group.artifacts
        .map((name) => `${sha256(join(input, name))}  ${name}`)
        .join('\n')}\n`,
    )
    const smokeName = `${group.smokePlatform}-${group.arch}.json`
    const smokePath = join(input, 'packaged-smoke', smokeName)
    writeJson(smokePath, smokeReceipt(group.smokePlatform, group.arch))
    const common = receiptBase(group.platform, group.arch)
    writeJson(
      join(
        input,
        'preview-receipts',
        `candidate-${group.platform}-${group.arch}.json`,
      ),
      {
        ...common,
        resourceInspection: true,
        packagedSmoke: fileRecord(smokePath),
        artifacts: group.artifacts.map((name) => fileRecord(join(input, name))),
      },
    )
    writeJson(
      join(
        input,
        'preview-receipts',
        `UNSIGNED-PREVIEW-${group.platform}-${group.arch}.marker.json`,
      ),
      common,
    )
  }

  for (const ubuntuVersion of ['22.04', '24.04']) {
    writeJson(
      join(
        input,
        'preview-linux-receipts',
        `UNSIGNED-PREVIEW-ubuntu-${ubuntuVersion}.json`,
      ),
      {
        ...receiptBase('linux', 'x64'),
        ubuntuVersion,
        appImageSmoke: true,
        debInstall: true,
        debSmoke: true,
        debRemove: true,
        sourceReceipts: [
          `${ubuntuVersion}-appimage.json`,
          `${ubuntuVersion}-deb.json`,
          `${ubuntuVersion}-lifecycle.json`,
        ].map((name) => ({ name, sha256: 'b'.repeat(64), size: 100 })),
      },
    )
  }
  return { root, input, output }
}

function runAssembler(
  fixture: { input: string; output: string },
  releaseTag = tag,
) {
  return spawnSync(
    process.execPath,
    [assembler, fixture.input, fixture.output, releaseTag, commit, runId],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

function runPublicationContract(bundle: string) {
  return spawnSync(
    process.execPath,
    [publicationContract, bundle, tag, commit, runId],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

function finalizeBundle(bundle: string) {
  writeFileSync(
    join(bundle, `emperor-agent-${tag}.cdx.json`),
    '{"bomFormat":"CycloneDX","specVersion":"1.6"}\n',
  )
  const files = readdirSync(bundle).sort()
  writeFileSync(
    join(bundle, 'SHA256SUMS.txt'),
    `${files
      .map((name) => `${sha256(join(bundle, name))}  ${name}`)
      .join('\n')}\n`,
  )
}

function artifactNames(): string[] {
  return [
    `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-arm64.dmg`,
    `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-arm64.zip`,
    `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-x64.dmg`,
    `Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-x64.zip`,
    `Emperor-Agent-${version}-UNSIGNED-PREVIEW-windows-x64.exe`,
    `Emperor-Agent-${version}-UNSIGNED-PREVIEW-linux-x64.AppImage`,
    `Emperor-Agent-${version}-UNSIGNED-PREVIEW-linux-x64.deb`,
  ]
}

function candidateGroups() {
  const artifacts = artifactNames()
  return [
    {
      platform: 'macos',
      arch: 'arm64',
      smokePlatform: 'darwin',
      artifacts: artifacts.slice(0, 2),
    },
    {
      platform: 'macos',
      arch: 'x64',
      smokePlatform: 'darwin',
      artifacts: artifacts.slice(2, 4),
    },
    {
      platform: 'windows',
      arch: 'x64',
      smokePlatform: 'win32',
      artifacts: artifacts.slice(4, 5),
    },
    {
      platform: 'linux',
      arch: 'x64',
      smokePlatform: 'linux',
      artifacts: artifacts.slice(5, 7),
    },
  ]
}

function receiptBase(platform: string, arch: string) {
  return {
    schemaVersion: 1,
    marker: 'UNSIGNED-PREVIEW',
    channel: 'preview',
    signingStatus: 'unsigned',
    tag,
    commit,
    runId,
    platform,
    arch,
  }
}

function smokeReceipt(platform: string, arch: string) {
  return {
    schemaVersion: 1,
    appVersion: version,
    commit,
    platform,
    arch,
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

function mutateReceipt(
  input: string,
  name: string,
  mutate: (receipt: Record<string, string>) => void,
) {
  const file = join(input, 'preview-receipts', name)
  const receipt = readJson(file) as Record<string, string>
  mutate(receipt)
  writeJson(file, receipt)
}

function fileRecord(file: string) {
  const body = readFileSync(file)
  return { name: basename(file), sha256: digest(body), size: body.length }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(file: string) {
  return digest(readFileSync(file))
}

function digest(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}
