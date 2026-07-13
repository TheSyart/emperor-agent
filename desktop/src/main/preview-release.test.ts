import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const workflowsRoot = path.join(repoRoot, '.github', 'workflows')
const require = createRequire(import.meta.url)

const signingSecretNames = [
  'MACOS_CERTIFICATE',
  'MACOS_CERTIFICATE_PASSWORD',
  'APPLE_API_KEY_BASE64',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_TEAM_ID',
  'WINDOWS_SIGNING_ENDPOINT',
  'WINDOWS_SIGNING_PROFILE',
  'WINDOWS_SIGNING_ACCOUNT',
  'WINDOWS_SIGNING_PUBLISHER',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
] as const

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(workflowsRoot, name), 'utf8')
}

function runContract(...args: string[]) {
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'preview-release-contract.mjs'), ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

describe('unsigned preview release channel', () => {
  it('routes Preview tags away from the trusted Stable workflow', () => {
    const stable = readWorkflow('release.yml')
    const preview = readWorkflow('release-preview.yml')

    expect(stable).toContain("- 'v*'")
    expect(stable).toContain("- '!v*-*'")
    expect(stable).toContain("- '!v*-preview.*'")
    expect(preview).toContain("- 'v*-preview.*'")
    expect(preview).not.toContain("- 'v*'")
    expect(preview).not.toContain('workflow_dispatch:')
  })

  it('builds the fixed cross-platform matrix without signing credentials', () => {
    const workflow = readWorkflow('release-preview.yml')

    expect(workflow).toContain('macos-15')
    expect(workflow).toContain('macos-15-intel')
    expect(workflow).toContain('windows-2022')
    expect(workflow).toContain('ubuntu-22.04')
    expect(workflow).toContain('ubuntu-24.04')
    expect(workflow).toContain('arch: arm64')
    expect(workflow).toContain('arch: x64')
    expect(workflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(workflow).toContain('contents: read')
    expect(workflow).not.toContain('forceCodeSigning')
    expect(workflow).not.toContain('notarize')
    expect(workflow).not.toContain('azureSignOptions')
    for (const name of signingSecretNames) {
      expect(workflow, name).not.toContain(name)
    }
  })

  it('uses an isolated unsigned builder configuration for all seven files', () => {
    const config = require(
      path.join(desktopRoot, 'electron-builder.preview.cjs'),
    ) as Record<string, unknown>

    expect(config).toMatchObject({
      extends: './electron-builder.yml',
      mac: {
        target: ['dmg', 'zip'],
        identity: null,
        artifactName:
          'Emperor-Agent-${version}-UNSIGNED-PREVIEW-macos-${arch}.${ext}',
      },
      win: {
        target: ['nsis'],
        artifactName:
          'Emperor-Agent-${version}-UNSIGNED-PREVIEW-windows-${arch}.${ext}',
      },
      linux: {
        target: ['AppImage', 'deb'],
        artifactName:
          'Emperor-Agent-${version}-UNSIGNED-PREVIEW-linux-${arch}.${ext}',
      },
    })

    const serialized = JSON.stringify(config)
    expect(serialized).not.toContain('forceCodeSigning')
    expect(serialized).not.toContain('notarize')
    expect(serialized).not.toContain('azureSignOptions')
  })

  it('keeps internal artifacts manual and excluded from Preview', () => {
    const internal = readWorkflow('release-internal.yml')
    const preview = readWorkflow('release-preview.yml')

    expect(internal).toContain('workflow_dispatch:')
    expect(internal).toContain('UNSIGNED-INTERNAL')
    expect(internal).not.toContain('push:')
    expect(preview).not.toContain('UNSIGNED-INTERNAL')
  })

  it('attests only after all candidates pass and publishes from a separate job', () => {
    const workflow = readWorkflow('release-preview.yml')

    expect(workflow).toContain('preview-aggregate:')
    expect(workflow).toContain('preview-publish:')
    expect(workflow).toMatch(
      /needs:\s*\[macos-preview, windows-preview, linux-preview-build, linux-preview-smoke\]/,
    )
    expect(workflow).toContain('needs: preview-aggregate')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('attestations: write')
    expect(workflow).toContain('artifact-metadata: write')
    expect(workflow.match(/actions\/attest@v4/g)?.length).toBe(2)
    expect(workflow).toContain('@cyclonedx/cyclonedx-npm@6.0.0')
    expect(workflow).toContain('assemble-preview-release-bundle.mjs')
    expect(workflow).toContain('publish-preview-release.sh')
    expect(workflow).toContain('gh attestation verify')
  })

  it('limits write permission to the Preview publish job', () => {
    const workflow = readWorkflow('release-preview.yml')
    const writeMatches = workflow.match(/contents: write/g) ?? []

    expect(writeMatches).toHaveLength(1)
    expect(workflow).toContain('UNSIGNED-PREVIEW-release-bundle')
    expect(workflow).not.toContain('softprops/action-gh-release')
  })

  it('uses draft-first atomic Pre-release publication with rollback', () => {
    const publisher = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'publish-preview-release.sh'),
      'utf8',
    )

    expect(publisher).toContain('preview-publication-contract.mjs')
    expect(publisher).toContain('merge-base --is-ancestor')
    expect(publisher).toContain('gh release view')
    expect(publisher).toContain('gh release create')
    expect(publisher).toContain('--draft')
    expect(publisher).toContain('--prerelease')
    expect(publisher).toContain('--notes-file')
    expect(publisher).toContain('gh release upload')
    expect(publisher).toContain('gh release edit')
    expect(publisher).toContain('--draft=false')
    expect(publisher).toContain('gh release delete')
    expect(publisher).toContain('UNSIGNED-PREVIEW')
  })

  it('strictly classifies Stable, Preview and unsupported tags', () => {
    const preview = runContract('classify', 'v0.1.0-preview.1')
    const stable = runContract('classify', 'v0.1.0')
    const unsupported = runContract('classify', 'v0.1.0-beta.1')

    expect(preview.status).toBe(0)
    expect(preview.stdout.trim()).toBe('preview')
    expect(stable.status).toBe(0)
    expect(stable.stdout.trim()).toBe('stable')
    expect(unsupported.status).toBe(0)
    expect(unsupported.stdout.trim()).toBe('none')
  })

  it('writes a fail-closed unsigned candidate receipt with artifact hashes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-preview-'))
    const dist = path.join(root, 'dist')
    const tag = 'v0.1.0-preview.1'
    const commit = 'a'.repeat(40)
    const runId = '123456'
    const artifactNames = [
      'Emperor-Agent-0.1.0-preview.1-UNSIGNED-PREVIEW-linux-x64.AppImage',
      'Emperor-Agent-0.1.0-preview.1-UNSIGNED-PREVIEW-linux-x64.deb',
    ]
    fs.mkdirSync(path.join(dist, 'packaged-smoke'), { recursive: true })
    for (const name of artifactNames) {
      fs.writeFileSync(path.join(dist, name), `fixture:${name}\n`)
    }
    fs.writeFileSync(
      path.join(dist, 'packaged-smoke', 'linux-x64.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        appVersion: '0.1.0-preview.1',
        commit,
        platform: 'linux',
        arch: 'x64',
        exitCode: 0,
      })}\n`,
    )

    const result = runContract(
      'candidate',
      dist,
      tag,
      commit,
      runId,
      'linux',
      'x64',
    )
    expect(result.status, result.stderr).toBe(0)

    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(dist, 'preview-receipts', 'candidate-linux-x64.json'),
        'utf8',
      ),
    ) as Record<string, unknown>
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      marker: 'UNSIGNED-PREVIEW',
      channel: 'preview',
      signingStatus: 'unsigned',
      tag,
      commit,
      runId,
      platform: 'linux',
      arch: 'x64',
      resourceInspection: true,
    })
    expect(receipt.artifacts).toHaveLength(2)
    expect(
      fs.readFileSync(
        path.join(
          dist,
          'preview-receipts',
          'UNSIGNED-PREVIEW-linux-x64.marker.json',
        ),
        'utf8',
      ),
    ).toContain('UNSIGNED-PREVIEW')
    expect(
      fs.readFileSync(path.join(dist, 'SHA256SUMS-linux-x64.txt'), 'utf8'),
    ).toContain('UNSIGNED-PREVIEW')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('rejects internal markers and Stable artifact names as candidate input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-preview-'))
    const dist = path.join(root, 'dist')
    fs.mkdirSync(path.join(dist, 'packaged-smoke'), { recursive: true })
    fs.writeFileSync(path.join(dist, 'UNSIGNED-INTERNAL.txt'), 'blocked\n')
    fs.writeFileSync(
      path.join(dist, 'Emperor-Agent-0.1.0-linux-x64.AppImage'),
      'stable\n',
    )

    const result = runContract(
      'candidate',
      dist,
      'v0.1.0-preview.1',
      'a'.repeat(40),
      '123456',
      'linux',
      'x64',
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/UNSIGNED-INTERNAL|non-Preview/i)

    fs.rmSync(root, { recursive: true, force: true })
  })
})
