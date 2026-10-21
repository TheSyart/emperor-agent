// REL-05: Stable is unsigned, like Preview (decided 2026-10-01). The same
// ad-hoc seal (after-pack, harden-package.cjs), no signing secret anywhere,
// macOS arm64 and x64 only, artifacts named
// Emperor-Agent-<version>-macos-<arch>.{dmg,zip}, notes that open with the
// unsigned statement, and SHA256SUMS, provenance and a CycloneDX SBOM.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const workflowsRoot = path.join(repoRoot, '.github', 'workflows')
const fixturesRoot = path.join(
  repoRoot,
  'scripts',
  'ci',
  'fixtures',
  'signed-release',
)
const require = createRequire(import.meta.url)

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface WorkflowJob {
  'runs-on'?: string
  needs?: string | string[]
  if?: string
  environment?: string
  permissions?: Record<string, string>
  strategy?: { matrix?: { include?: Array<Record<string, string>> } }
  env?: Record<string, string>
  steps?: WorkflowStep[]
}

interface Workflow {
  env?: Record<string, string>
  jobs: Record<string, WorkflowJob>
}

function readText(...parts: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

/** release.yml parsed by the same YAML package the workflow lint uses. */
function stableWorkflow(): Workflow {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import YAML from 'yaml'; import { readFileSync } from 'node:fs'; process.stdout.write(JSON.stringify(YAML.parse(readFileSync(process.argv[1], 'utf8'))))",
      path.join(workflowsRoot, 'release.yml'),
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as Workflow
}

function runs(job: WorkflowJob | undefined): string[] {
  return (job?.steps ?? [])
    .map((step) => (typeof step.run === 'string' ? step.run.trim() : ''))
    .filter(Boolean)
}

function needs(job: WorkflowJob): string[] {
  if (!job.needs) return []
  return Array.isArray(job.needs) ? job.needs : [job.needs]
}

function checkUnsigned(args: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'ci', 'check-unsigned-release.mjs'),
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

async function releaseContract(): Promise<{
  firstParagraph(markdown: string): string
  renderReleaseNotes(
    template: string,
    values: { tag: string; version: string },
  ): string
  UNSIGNED_NOTICE_MARKERS: readonly string[]
}> {
  return (await import(
    pathToFileURL(path.join(repoRoot, 'scripts', 'release-contract.mjs')).href
  )) as never
}

describe('unsigned Stable release: no signing anywhere (REL-05 test 1)', () => {
  it('passes the unsigned-release check that make check runs', () => {
    const result = checkUnsigned()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^unsigned releases: /)
    expect(readText('scripts', 'check.sh')).toContain(
      'node scripts/ci/check-unsigned-release.mjs',
    )
  })

  it('fails the signed fixture and names each kind of signing it finds', () => {
    const result = checkUnsigned([
      '--workflows',
      path.join(fixturesRoot, 'workflows'),
      '--builder',
      path.join(fixturesRoot, 'electron-builder.release.cjs'),
      '--script',
      path.join(fixturesRoot, 'build-release.sh'),
    ])

    expect(result.status).toBe(1)
    for (const problem of [
      'release.yml: references secrets.MACOS_CERTIFICATE',
      'release.yml: references secrets.APPLE_API_KEY_BASE64',
      'release.yml: uses the signing variable CSC_LINK',
      'release.yml: uses the signing variable APPLE_TEAM_ID',
      'release.yml: runs xcrun notarytool',
      'release.yml: does not turn off CSC_IDENTITY_AUTO_DISCOVERY',
      'electron-builder.release.cjs: mac.identity is not null',
      'electron-builder.release.cjs: sets forceCodeSigning',
      'electron-builder.release.cjs: sets mac.notarize',
      'electron-builder.release.cjs: sets win.azureSignOptions',
      'build-release.sh: runs security import',
      'build-release.sh: signs with an identity other than - (codesign --sign "Developer ID Application',
    ])
      expect(result.stderr).toContain(problem)
  })

  it('fails when a signing secret comes back into release.yml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-unsigned-'))
    for (const name of fs.readdirSync(workflowsRoot))
      fs.copyFileSync(path.join(workflowsRoot, name), path.join(dir, name))
    const file = path.join(dir, 'release.yml')
    const text = fs.readFileSync(file, 'utf8')
    const next = text.replace(
      '\njobs:\n',
      '\njobs:\n  sign:\n    runs-on: macos-15\n    env:\n      CSC_KEY_PASSWORD: ${{ secrets.MACOS_CERTIFICATE_PASSWORD }}\n    steps:\n      - run: echo sign\n',
    )
    expect(next).not.toBe(text)
    fs.writeFileSync(file, next)

    const result = checkUnsigned(['--workflows', dir])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'release.yml: references secrets.MACOS_CERTIFICATE_PASSWORD',
    )
    expect(result.stderr).toContain(
      'release.yml: uses the signing variable CSC_KEY_PASSWORD',
    )
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('unsigned Stable release: the workflow', () => {
  it('stays manual, tag-verified and environment-protected', () => {
    const workflow = readText('.github', 'workflows', 'release.yml')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*push:\s*$/m)
    expect(workflow).toContain('release-policy:')
    expect(workflow).toContain('git cat-file -t "refs/tags/$STABLE_TAG"')
    expect(workflow).toContain('git merge-base --is-ancestor')
    expect(workflow.indexOf('commit="$(git rev-parse')).toBeLessThan(
      workflow.indexOf('version="$(git show'),
    )
    expect(workflow).toContain(
      "if: inputs.publish == true && vars.EMPEROR_STABLE_RELEASE_ENABLED == 'true'",
    )
    expect(workflow).toContain('environment: stable-release')
  })

  it('checks the nightly first, and every job waits for that check', () => {
    const { jobs } = stableWorkflow()

    expect(runs(jobs['release-policy'])[0]).toBe(
      'node scripts/ci/require-green-nightly.mjs',
    )
    const reaches = (id: string, seen = new Set<string>()): boolean => {
      if (id === 'release-policy') return true
      if (seen.has(id)) return false
      seen.add(id)
      return needs(jobs[id]).some((parent) => reaches(parent, seen))
    }
    for (const id of Object.keys(jobs)) expect(reaches(id), id).toBe(true)
  })

  it('builds macOS arm64 and x64 only, with signing discovery off', () => {
    const workflow = stableWorkflow()
    const { jobs } = workflow

    expect(Object.keys(jobs).sort()).toEqual([
      'macos-candidate',
      'publish-release',
      'release-aggregate',
      'release-policy',
    ])
    expect(workflow.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
    expect(jobs['macos-candidate'].strategy?.matrix?.include).toEqual([
      { runner: 'macos-15', arch: 'arm64' },
      { runner: 'macos-15-intel', arch: 'x64' },
    ])
    const text = readText('.github', 'workflows', 'release.yml')
    for (const gone of [
      'windows-',
      'linux-',
      'ubuntu-22.04',
      'AppImage',
      'EMPEROR_RELEASE_TARGET',
      'secrets.',
    ])
      expect(text, gone).not.toContain(gone)
  })

  it('builds, verifies and probes each candidate before uploading it', () => {
    const candidate = stableWorkflow().jobs['macos-candidate']
    const commands = runs(candidate)
    const at = (command: string) =>
      commands.findIndex((run) => run.includes(command))

    expect(commands).toContain('scripts/ci/select-xcode.sh')
    expect(commands).toContain('make check')
    expect(at('scripts/build_desktop_release.sh')).toBeGreaterThan(
      at('make check'),
    )
    expect(at('scripts/verify-macos-release.sh "${{ matrix.arch }}"')).toBe(
      at('scripts/build_desktop_release.sh') + 1,
    )
    expect(at('scripts/ci/gate-negative-probe.mjs')).toBeGreaterThan(
      at('scripts/verify-macos-release.sh'),
    )
    const upload = candidate.steps?.find((step) =>
      String(step.uses).startsWith('actions/upload-artifact@'),
    )
    expect(String(upload?.with?.path).split('\n').filter(Boolean)).toEqual([
      'desktop/dist/Emperor-Agent-*-macos-${{ matrix.arch }}.dmg',
      'desktop/dist/Emperor-Agent-*-macos-${{ matrix.arch }}.zip',
      'desktop/dist/SHA256SUMS-macos-${{ matrix.arch }}.txt',
      'desktop/dist/packaged-smoke/darwin-${{ matrix.arch }}.json',
      'desktop/dist/release-receipts/macos-${{ matrix.arch }}.json',
    ])
  })

  it('attests the checksums and the SBOM before the one job that can write publishes', () => {
    const { jobs } = stableWorkflow()
    const aggregate = jobs['release-aggregate']
    const publish = jobs['publish-release']
    const text = readText('.github', 'workflows', 'release.yml')

    expect(needs(aggregate)).toEqual(['release-policy', 'macos-candidate'])
    expect(aggregate.permissions).toMatchObject({
      'id-token': 'write',
      attestations: 'write',
      'artifact-metadata': 'write',
    })
    const commands = runs(aggregate)
    const at = (command: string) =>
      commands.findIndex((run) => run.includes(command))
    expect(at('scripts/assemble-release-bundle.mjs')).toBeGreaterThanOrEqual(0)
    expect(at('scripts/generate-release-sbom.sh')).toBeGreaterThan(
      at('scripts/assemble-release-bundle.mjs'),
    )
    expect(at('scripts/release-contract.mjs checksums')).toBeGreaterThan(
      at('scripts/generate-release-sbom.sh'),
    )
    expect(at('scripts/release-contract.mjs publication')).toBeGreaterThan(
      at('scripts/release-contract.mjs checksums'),
    )
    const attests = (aggregate.steps ?? []).filter((step) =>
      String(step.uses).startsWith('actions/attest@'),
    )
    expect(attests.map((step) => step.with)).toEqual([
      { 'subject-checksums': 'release-bundle/SHA256SUMS.txt' },
      {
        'subject-checksums': 'release-bundle/ARTIFACT-SHA256SUMS.txt',
        'sbom-path':
          'release-bundle/emperor-agent-${{ needs.release-policy.outputs.tag }}.cdx.json',
      },
    ])
    expect(text).toContain('gh attestation verify')
    expect(readText('scripts', 'generate-release-sbom.sh')).toContain(
      '@cyclonedx/cyclonedx-npm@6.0.0',
    )

    expect(needs(publish)).toEqual(['release-policy', 'release-aggregate'])
    expect(publish.permissions).toEqual({
      contents: 'write',
      attestations: 'read',
    })
    expect(text.match(/contents: write/g)).toHaveLength(1)
    expect(runs(publish)).toContain('scripts/publish-release.sh release-bundle')
    expect(text).not.toContain('softprops/action-gh-release')
  })
})

describe('unsigned Stable release: the package', () => {
  it('3. names the artifacts Emperor-Agent-<version>-macos-<arch>.{dmg,zip}', () => {
    const config = require(
      path.join(desktopRoot, 'electron-builder.release.cjs'),
    ) as Record<string, unknown>

    expect(config).toEqual({
      extends: './electron-builder.yml',
      mac: {
        target: ['dmg', 'zip'],
        identity: null,
        artifactName: 'Emperor-Agent-${version}-macos-${arch}.${ext}',
      },
    })
  })

  it('2. is sealed exactly like Preview: no identity, so after-pack seals it ad hoc', () => {
    const stable = require(
      path.join(desktopRoot, 'electron-builder.release.cjs'),
    ) as { mac: Record<string, unknown> }
    const preview = require(
      path.join(desktopRoot, 'electron-builder.preview.cjs'),
    ) as { mac: Record<string, unknown> }
    const afterPack = fs.readFileSync(
      path.join(desktopRoot, 'scripts', 'after-pack.cjs'),
      'utf8',
    )

    expect(stable.mac.identity).toBeNull()
    expect(preview.mac.identity).toBeNull()
    expect(afterPack).toMatch(
      /context\.packager\.config\?\.mac\?\.identity === null[\s\S]{0,200}sealMacApp\(app, PREVIEW_ENTITLEMENTS\)[\s\S]{0,120}verifyMacHardening\(app\)/,
    )
  })

  it('builds the candidate with the Stable config and signing discovery off', () => {
    const script = readText('scripts', 'build_desktop_release.sh')

    expect(script).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false')
    expect(script).toContain('--config electron-builder.release.cjs')
    expect(script).toContain('--mac dmg zip')
    expect(script).toContain('--publish never')
    expect(script).not.toContain('EMPEROR_RELEASE_TARGET')
  })

  it('verifies the seal, the fuses, the DMG, the ZIP and the packaged smoke of each candidate', () => {
    const verifier = readText('scripts', 'verify-macos-release.sh')

    expect(verifier).toContain('Emperor-Agent-$VERSION-macos-$ARCH.dmg')
    expect(verifier).toContain('Emperor-Agent-$VERSION-macos-$ARCH.zip')
    expect(verifier).toContain('desktop/scripts/verify-unsigned-app.cjs')
    expect(verifier).toContain('hdiutil attach')
    expect(verifier).toContain('hdiutil detach')
    expect(verifier).toContain('ditto -x -k')
    expect(verifier).toContain('run -s package:smoke -- \\\n  --app "$MOUNTED_APP')
    expect(verifier).toContain('shasum -a 256')
    expect(verifier).toContain("signingStatus: 'unsigned'")
    for (const gone of [
      'spctl',
      'stapler',
      'TeamIdentifier=',
      'APPLE_TEAM_ID',
      'Developer ID',
    ])
      expect(verifier, gone).not.toContain(gone)
  })

  it('refuses a package any part of which carries a signing identity', () => {
    const { unsignedIdentityProblems } = require(
      path.join(desktopRoot, 'scripts', 'verify-unsigned-app.cjs'),
    ) as {
      unsignedIdentityProblems(
        entries: Array<{
          label: string
          adHoc: boolean
          authority: string | null
          teamId: string | null
        }>,
      ): string[]
    }
    const adHoc = { adHoc: true, authority: null, teamId: 'not set' }

    expect(
      unsignedIdentityProblems([
        { label: 'app', ...adHoc },
        { label: 'Computer Helper', ...adHoc },
      ]),
    ).toEqual([])
    expect(
      unsignedIdentityProblems([
        {
          label: 'app',
          adHoc: false,
          authority: 'Developer ID Application: Someone (ABCDE12345)',
          teamId: 'ABCDE12345',
        },
        {
          label: 'Computer Helper',
          adHoc: true,
          authority: null,
          teamId: null,
        },
      ]),
    ).toEqual([
      'app is signed by Developer ID Application: Someone (ABCDE12345); every release is sealed ad hoc only',
    ])
  })

  it('no longer carries the signed chain: no Developer ID entitlements, no Windows or Linux verifiers', () => {
    for (const gone of [
      path.join(desktopRoot, 'build', 'entitlements.mac.plist'),
      path.join(desktopRoot, 'build', 'entitlements.mac.inherit.plist'),
      path.join(repoRoot, 'scripts', 'verify-windows-release.ps1'),
      path.join(repoRoot, 'scripts', 'verify-linux-release.sh'),
    ])
      expect(fs.existsSync(gone), gone).toBe(false)
  })
})

describe('unsigned Stable release: notes and publication', () => {
  it('8. opens the release notes with the unsigned statement and the first-open steps', async () => {
    const { firstParagraph, renderReleaseNotes, UNSIGNED_NOTICE_MARKERS } =
      await releaseContract()
    const template = readText('docs', 'release', 'stable-release-notes.md')
    const notes = renderReleaseNotes(template, {
      tag: 'v0.2.0',
      version: '0.2.0',
    })
    const first = firstParagraph(notes)

    expect(UNSIGNED_NOTICE_MARKERS.length).toBeGreaterThan(0)
    for (const marker of UNSIGNED_NOTICE_MARKERS)
      expect(first, marker).toContain(marker)
    expect(first).toContain('未签名')
    expect(first).toContain('Apple 公证')
    expect(first).toContain('「应用程序」')
    expect(first).toContain('「系统设置 › 隐私与安全性」')
    expect(first).toContain('「仍要打开」')
    expect(first).toContain('0.2.0')
    expect(first).toContain('SHA256SUMS.txt')
    expect(notes.trimStart().startsWith(first)).toBe(true)
    expect(notes).not.toContain('{{')
    expect(notes).not.toContain('<!--')
    expect(notes).not.toMatch(/spctl\s+--master-disable/i)
    expect(notes).not.toMatch(/disable\s+Gatekeeper/i)
  })

  it('publishes draft first with the rendered notes and rolls back, or only plans it', () => {
    const publisher = readText('scripts', 'publish-release.sh')

    for (const part of [
      'scripts/release-contract.mjs',
      'gh release create "$TAG"',
      '--draft',
      '--verify-tag',
      '--notes-file "$NOTES"',
      'gh release upload "$TAG"',
      'gh release edit "$TAG" --draft=false',
      'gh release delete "$TAG"',
      '--dry-run',
    ])
      expect(publisher, part).toContain(part)
    expect(publisher).not.toContain('--generate-notes')
    expect(publisher).not.toContain('--prerelease')
  })

  it('keeps unsigned internal packages manual, short-lived and unpublishable', () => {
    const workflow = readText('.github', 'workflows', 'release-internal.yml')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('push:')
    expect(workflow).toContain('UNSIGNED-INTERNAL')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toContain('gh release')
  })
})
